import type { Tool, ToolUseContext } from "../../Tool.ts";
import type { PermissionDecision, PermissionResult } from "./PermissionResult.ts";

/**
 * 把工具返回的 passthrough 结果归一成需要人工确认的 ask 决策。
 * @param toolName 请求执行的工具名。
 * @param result 工具级权限检查返回的 passthrough 结果。
 * @returns 标准化后的 ask 权限决策。
 */
function askFromPassthrough(toolName: string, result: PermissionResult): PermissionDecision {
  return {
    behavior: "ask",
    message: result.message ?? `Permission required to use ${toolName}.`,
    updatedInput: "updatedInput" in result ? result.updatedInput : undefined,
    reason: result.reason,
  };
}

/**
 * 把 ask 决策转换成拒绝决策，用于 deny 模式或缺少审批回调时 fail closed。
 * @param toolName 请求执行的工具名。
 * @param decision 已标准化的 ask 权限决策。
 * @returns 标准化后的 deny 权限决策。
 */
function denyFromAsk(toolName: string, decision: Extract<PermissionDecision, { behavior: "ask" }>): PermissionDecision {
  return {
    behavior: "deny",
    message: `Permission denied for ${toolName}: ${decision.message}`,
    reason: decision.reason,
  };
}

/**
 * 合成工具级检查、运行模式和人工审批结果，得出最终工具权限决策。
 * @param options 工具、工具输入和工具运行上下文。
 * @returns 最终 allow 或 deny 权限决策。
 */
export async function hasPermissionToUseTool(options: {
  tool: Tool;
  input: Record<string, unknown>;
  context: ToolUseContext;
}): Promise<PermissionDecision> {
  //L03-S07 调用工具级权限检查：统一 permission 层不理解 Bash 语法，只消费 Tool.checkPermissions() 给出的结构化结果。
  const toolResult =
    (await options.tool.checkPermissions?.(options.input, options.context)) ??
    ({
      behavior: "passthrough",
      message: `Permission required to use ${options.tool.name}.`,
    } satisfies PermissionResult); // 没有就降级成这个了

  //L03-S08 尊重工具硬结论：deny 和 allow 是工具已经判定清楚的结果，直接返回，确保 hard deny 不会被后续 permission mode 覆盖。
  if (toolResult.behavior === "deny" || toolResult.behavior === "allow") {
    return toolResult;
  }

  //L03-S09 把 passthrough 归一成 ask：Claude Code 会把工具无法自行放行的请求交给 canUseTool；mini-cc 也让未知风险进入确认路径。
  const askDecision = toolResult.behavior === "ask"
    ? toolResult
    : askFromPassthrough(options.tool.name, toolResult);
  const permissionContext = options.context.permissionContext ?? { mode: "deny" as const };

  if (permissionContext.mode === "bypass") {
    //L03-S10 应用 bypass 模式：这里只允许绕过 ask，不绕过前面已经返回的 deny，用来教学区分“用户信任模式”和“硬安全边界”。
    return {
      behavior: "allow",
      updatedInput: askDecision.updatedInput ?? options.input,
      reason: "Allowed by bypass permission mode after hard denies were checked.",
    };
  }

  if (permissionContext.mode === "deny") {
    //L03-S11 支持非交互拒绝模式：没有人能确认 ask 时，工具请求必须 fail closed，适合脚本验证和未来 headless 场景。
    return denyFromAsk(options.tool.name, askDecision);
  }

  //L03 工具没有 requestApproval 回调也当成 deny 处理，避免工具直接放行的安全风险；有回调则进入正常的交互流程。
  if (!permissionContext.requestApproval) {
    return denyFromAsk(options.tool.name, askDecision);
  }

  //L03 由 main.ts 中的 requestApproval 回调实际询问用户。相当于human in the loop
  const approved = await permissionContext.requestApproval({
    toolName: options.tool.name,
    input: askDecision.updatedInput ?? options.input,
    message: askDecision.message,
    reason: askDecision.reason,
  });

  return approved
    ? {
        behavior: "allow",
        updatedInput: askDecision.updatedInput ?? options.input,
        reason: "Approved by interactive permission prompt.",
      }
    : denyFromAsk(options.tool.name, askDecision);
}
