import type { Tool, ToolUseContext } from "../../Tool.ts";
import type { ToolResultBlock, ToolUseBlock } from "../../types.ts";
import { runToolUse } from "./toolExecution.ts";

/**
 * 按顺序调度本轮 assistant message 中的多个 tool_use。
 * @param options 本轮工具调用列表、可用工具列表和工具运行上下文。
 * @returns 与 tool_use 顺序对应的 tool_result block 列表。
 */
export async function runTools(options: {
  toolUses: ToolUseBlock[];
  tools: Tool[];
  context: ToolUseContext;
}): Promise<ToolResultBlock[]> {
  //L01-S23 串行调度工具：第一课使用串行调度保持可理解，后续再学习 Claude Code 的并发和安全分组。
  const results: ToolResultBlock[] = [];
  for (const toolUse of options.toolUses) {
    results.push(await runToolUse({
      toolUse,
      tools: options.tools,
      context: options.context,
    }));
  }
  return results;
}
