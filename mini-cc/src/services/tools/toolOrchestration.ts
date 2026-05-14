import type { Tool, ToolUseContext } from "../../Tool.ts";
import type { ToolResultBlock, ToolUseBlock } from "../../types.ts";
import { runToolUse } from "./toolExecution.ts";

export async function runTools(options: {
  toolUses: ToolUseBlock[];
  tools: Tool[];
  context: ToolUseContext;
}): Promise<ToolResultBlock[]> {
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
