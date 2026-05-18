import path from "node:path";
import type { ToolUseContext } from "../../Tool.ts";
import type { PermissionResult } from "../../utils/permissions/PermissionResult.ts";

const HARD_DENY_PATTERNS = [
  "rm -rf /",
  "sudo ",
  "shutdown",
  "reboot",
  "format ",
  "mkfs",
  "diskpart",
  "cipher /w",
];

const DESTRUCTIVE_COMMANDS = new Set([
  "rm",
  "del",
  "erase",
  "rmdir",
  "rd",
  "remove-item",
  "mv",
  "move",
  "cp",
  "copy",
]);

const READ_ONLY_PREFIXES = [
  "pwd",
  "ls",
  "dir",
  "rg",
  "cat",
  "type",
  "git status",
  "git diff",
  "git log",
  "get-childitem",
  "get-content",
];

const SENSITIVE_PATH_SEGMENTS = new Set([".env", ".git", ".claude", ".ssh"]);

/**
 * 把 shell 命令切分成粗粒度 token，用于后续安全规则判断。
 * @param command 原始 shell 命令文本。
 * @returns 去掉外层引号后的 token 列表。
 */
function tokenize(command: string): string[] {
  return (
    command
      .match(/"[^"]*"|'[^']*'|\S+/g)
      ?.map((token) => token.replace(/^['"]|['"]$/g, "")) ?? []
  );
}

/**
 * 判断目标路径是否仍位于指定工作区目录内部。
 * @param baseDir 允许访问的工作区根目录。
 * @param target 待检查的目标路径。
 * @returns 目标路径在工作区内时返回 true。
 */
function isInside(baseDir: string, target: string): boolean {
  const relative = path.relative(baseDir, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

//L03-S14 建立 workspace path guard：Claude Code 的 Bash 权限会检查路径约束；mini-cc 先用 cwd 边界拦住工作区外路径，避免只读命令意外读到外部文件。
/**
 * 检查命令参数是否显式引用了工作区外路径。
 * @param command 原始 shell 命令文本。
 * @param cwd 当前允许访问的工作区目录。
 * @returns 命令引用工作区外路径时返回 true。
 */
function referencesOutsideWorkspace(command: string, cwd: string): boolean {
  const tokens = tokenize(command);
  return tokens.some((token) => {
    if (token === ".." || token.startsWith("../") || token.startsWith("..\\")) {
      return true;
    }
    if (!path.isAbsolute(token)) {
      return false;
    }
    return !isInside(cwd, path.resolve(token));
  });
}

//L03-S15 标记敏感路径：`.env`、`.git`、`.claude`、`.ssh` 即使在工作区内也不自动放行，对应 Claude Code 中 safetyCheck 优先于普通 allow 的思想。
/**
 * 检查命令是否引用 `.env`、`.git`、`.claude`、`.ssh` 等敏感路径。
 * @param command 原始 shell 命令文本。
 * @returns 命令引用敏感路径时返回 true。
 */
function referencesSensitivePath(command: string): boolean {
  return tokenize(command).some((token) => {
    const normalized = token.replace(/\\/g, "/");
    const parts = normalized.split("/").filter(Boolean);
    return parts.some(
      (part) =>
        part === ".env" ||
        part.startsWith(".env.") ||
        SENSITIVE_PATH_SEGMENTS.has(part),
    );
  });
}

/**
 * 提取 shell 命令中的第一个命令词，供破坏性命令集合判断。
 * @param command 原始 shell 命令文本。
 * @returns 小写后的第一个命令词；命令为空时返回空字符串。
 */
function firstCommand(command: string): string {
  return tokenize(command)[0]?.toLowerCase() ?? "";
}

/**
 * 判断命令中是否包含 shell 组合、管道、重定向或命令替换操作符。
 * @param command 原始 shell 命令文本。
 * @returns 包含 shell 操作符时返回 true。
 */
function hasShellOperator(command: string): boolean {
  return /(\$\(|`|[;&|<>])/.test(command);
}

//L03-S16 收敛只读白名单：只有明确的read only命令可以静默 allow；未知命令默认 ask，这是权限系统的 fail-closed 教学版本。
/**
 * 判断命令是否匹配 mini-cc 当前允许静默执行的只读命令白名单。
 * @param command 原始 shell 命令文本。
 * @returns 命令是只读白名单命令时返回 true。
 */
function isReadOnlyCommand(command: string): boolean {
  const lower = command.trim().toLowerCase();
  return READ_ONLY_PREFIXES.some((prefix) => lower === prefix || lower.startsWith(`${prefix} `));
}

/**
 * 把 bash 工具输入压缩成 allow、ask 或 deny 的结构化权限结果。
 * @param input 模型提供的 bash 工具输入。
 * @param context 工具运行上下文，主要使用 cwd 做路径边界检查。
 * @returns bash 命令对应的权限判断结果。
 */
export function evaluateBashPermission(
  input: Record<string, unknown>,
  context: ToolUseContext,
): PermissionResult {
  //L03-S17 进入 Bash 风险分类：BashTool 只传入 input 和上下文，独立安全模块负责把命令压成 allow / ask / deny / passthrough。
  const command = String(input.command ?? "").trim();
  if (!command) {
    return {
      behavior: "deny",
      message: "Permission denied: empty bash command.",
      reason: "Empty command is not executable.",
    };
  }

  const lower = command.toLowerCase();

  //L03-S18 hard deny fast fail：hard deny先于 permission mode 判断，所以后面的 bypass 模式也不能绕过这类命令。
  const hardDeny = HARD_DENY_PATTERNS.find((pattern) => lower.includes(pattern));
  if (hardDeny) {
    return {
      behavior: "deny",
      message: `Permission denied: command matches hard deny pattern "${hardDeny}".`,
      reason: "Hard-deny rules are checked before permission mode.",
    };
  }

  //L03 涉及到外部目录：ask
  if (referencesOutsideWorkspace(command, context.cwd)) {
    return {
      behavior: "ask",
      message: `Bash command references a path outside the workspace: ${command}`,
      reason: "Workspace path guard requires explicit approval.",
    };
  }

  //L03 涉及到敏感文件：ask
  if (referencesSensitivePath(command)) {
    return {
      behavior: "ask",
      message: `Bash command references a sensitive path and requires approval: ${command}`,
      reason: "Sensitive paths such as .env, .git, .claude, and .ssh are not auto-allowed.",
    };
  }

  //L03-S19 涉及到指令组合：ask。shell operator 可能导致单条命令的安全判断失效，比如 `&&` 后面接个 harmless 命令就能绕过前面的 allow 规则，所以一律要求确认。
  if (hasShellOperator(command)) {
    return {
      behavior: "ask",
      message: `Bash command uses shell operators and requires approval: ${command}`,
      reason: "Shell operators can combine commands, redirect output, or hide side effects.",
    };
  }

  //L03-S20 涉及到破坏性命令：ask。即使是单条命令，如果是明显的文件操作（mv、cp、rm等），也要求确认，避免模型误用。
  if (DESTRUCTIVE_COMMANDS.has(firstCommand(command))) {
    return {
      behavior: "ask",
      message: `Potentially destructive command requires approval: ${command}`,
      reason: "Destructive file operations must not run silently.",
    };
  }

  //L03-S21 read only命令自动放行：明确在白名单里的命令可以直接 allow，鼓励模型使用安全的命令来检查工作区状态。
  if (isReadOnlyCommand(command)) {
    return {
      behavior: "allow",
      updatedInput: { command },
      reason: "Read-only workspace inspection is allowed.",
    };
  }

  //L03 其他命令默认 ask
  return {
    behavior: "ask",
    message: `Bash command requires approval: ${command}`,
    reason: "No allow rule matched this command.",
  };
}
