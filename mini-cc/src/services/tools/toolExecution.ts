import type { Tool, ToolUseContext } from "../../Tool.ts";
import type { ToolResultBlock, ToolUseBlock } from "../../types.ts";

export async function runToolUse(options: {
  toolUse: ToolUseBlock;
  tools: Tool[];
  context: ToolUseContext;
}): Promise<ToolResultBlock> {
  const tool = options.tools.find((candidate) => candidate.name === options.toolUse.name);
  const content = tool
    ? await tool.call(options.toolUse.input, options.context)
    : `Error: unknown tool ${options.toolUse.name}`;

  return {
    type: "tool_result",
    tool_use_id: options.toolUse.id,
    content,
  };
}
