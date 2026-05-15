import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { QueryEngine } from "./QueryEngine.ts";
import { createAnthropicProviderFromEnv } from "./services/api/anthropicMessages.ts";
// import { MockClaudeProvider } from "./services/api/mockClaude.ts";
import { getDefaultTools } from "./tools.ts";
import { loadDotEnv } from "./utils/dotenv.ts";
import type { PermissionMode } from "./utils/permissions/PermissionResult.ts";

//L01-S01 启动入口：main.ts 只负责启动 mini-cc 应用；用户消息统一从交互式提示符进入。

const systemPrompt = [
  "You are mini-cc, a small coding agent used for a Claude Code build-along lesson.",
  "Use the bash tool when you need to inspect or operate on the local workspace.",
  "Prefer small read-only commands before asking to run commands with side effects.",
  "Keep commands small and explain the result after the tool returns.",
].join("\n");

function permissionModeFromEnv(): PermissionMode {
  //L03-S01 从应用入口选择权限模式：保持单一 main.ts 入口，通过 MINI_CC_PERMISSION_MODE 切换 default / deny / bypass，而不是为课程另起 CLI。
  const mode = process.env.MINI_CC_PERMISSION_MODE;
  return mode === "deny" || mode === "bypass" ? mode : "default";
}

async function main() {
  loadDotEnv({ override: true });

  const repl = createInterface({ input, output });

  //L01-S02 创建入口包装：创建 QueryEngine，把启动入口和核心 agent loop 分开，贴近 Claude Code 的入口包装边界。
  const engine = new QueryEngine({
    //L02-S04 接入真实 provider：mock 已完成教学使命，入口默认使用 Anthropic Messages adapter 驱动真实模型。
    provider: createAnthropicProviderFromEnv(),
    // provider: new MockClaudeProvider(),
    tools: getDefaultTools(),
    cwd: process.cwd(),
    permissionContext: {
      mode: permissionModeFromEnv(),
      async requestApproval(request) {
        //L03-S02 在入口层提供 ask 能力：默认模式下权限确认回到 REPL 询问用户，工具执行层只消费最终 allow/deny 结果。
        console.log(`\n[permission:${request.toolName}] ${request.message}`);
        if (request.reason) {
          console.log(`[permission:reason] ${request.reason}`);
        }
        const answer = await repl.question("Allow this tool use? [y/N] ");
        const normalized = answer.trim().toLowerCase();
        return normalized === "y" || normalized === "yes";
      },
    },
    systemPrompt,
    maxTurns: 6,
  });

  try {
    while (true) {
      //L02-S07 交互式 harness：进程启动一次后反复读取用户输入，每次输入都复用 QueryEngine 中保存的 transcript。
      const prompt = await repl.question("\x1b[36mmini-cc >> \x1b[0m");
      const trimmed = prompt.trim();
      if (!trimmed || trimmed.toLowerCase() === "q" || trimmed.toLowerCase() === "exit") {
        break;
      }
      //L01-S03 提交消息：提交用户消息，后续由 QueryEngine 进入 query() / queryLoop()。
      //L02-S05 运行真实工具闭环：同一个入口、同一个 queryLoop，由真实模型决定是否发起 bash tool_use。
      await engine.submitMessage(trimmed);
      console.log();
    }
  } finally {
    repl.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
