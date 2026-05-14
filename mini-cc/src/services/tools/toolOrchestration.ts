import type { Tool, ToolUseContext } from "../../Tool.ts";
import type { ToolResultBlock, ToolUseBlock } from "../../types.ts";
import { runToolUse } from "./toolExecution.ts";

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
