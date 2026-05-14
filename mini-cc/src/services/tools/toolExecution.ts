import type { Tool, ToolUseContext } from "../../Tool.ts";
import type { ToolResultBlock, ToolUseBlock } from "../../types.ts";

export async function runToolUse(options: {
  toolUse: ToolUseBlock;
  tools: Tool[];
  context: ToolUseContext;
}): Promise<ToolResultBlock> {
  //L01-S21 查找工具：单工具执行先按 tool_use.name 找工具，这是 Tool Dispatcher 课程要扩展的核心查找点。
  const tool = options.tools.find((candidate) => candidate.name === options.toolUse.name);
  const content = tool
    ? await tool.call(options.toolUse.input, options.context)
    : `Error: unknown tool ${options.toolUse.name}`;

  //L01-S22 映射工具结果：工具输出必须映射成 tool_result，并用 tool_use_id 回连模型原始请求。
  return {
    type: "tool_result",
    tool_use_id: options.toolUse.id,
    content,
  };
}
