import type { Tool, ToolUseContext } from "../../Tool.ts";
import type { ToolResultBlock, ToolUseBlock } from "../../types.ts";
import { hasPermissionToUseTool } from "../../utils/permissions/permissions.ts";

export async function runToolUse(options: {
  toolUse: ToolUseBlock;
  tools: Tool[];
  context: ToolUseContext;
}): Promise<ToolResultBlock> {
  //L01-S21 查找工具：单工具执行先按 tool_use.name 找工具，这是 Tool Dispatcher 课程要扩展的核心查找点。
  const tool = options.tools.find((candidate) => candidate.name === options.toolUse.name);
  let content: string;
  if (!tool) {
    content = `Error: unknown tool ${options.toolUse.name}`;
  } else {
    //L03-S05 在执行层放置权限闸门：runToolUse 是 tool_use 变成副作用的最后边界，因此必须先拿 permission decision 再调用 tool.call()。
    //L03 核心逻辑入口
    const permissionDecision = await hasPermissionToUseTool({
      tool,
      input: options.toolUse.input,
      context: options.context,
    });

    if (permissionDecision.behavior !== "allow") {
      //L03-S22 回填拒绝结果：权限失败也必须保留原 tool_use_id，模型下一轮才能理解“工具请求被系统拒绝”，而不是误以为工具已经执行。
      content = `Error: ${permissionDecision.message}`;
    } else {
      //L03-S23 只在 allow 后执行工具：这条线把“判断是否允许”和“实际产生副作用”明确隔开，是后续文件工具和 MCP 工具复用的关键边界。
      content = await tool.call(
        permissionDecision.updatedInput ?? options.toolUse.input,
        options.context,
      );
    }
  }

  //L01-S22 映射工具结果：工具输出必须映射成 tool_result，并用 tool_use_id 回连模型原始请求。
  return {
    type: "tool_result",
    tool_use_id: options.toolUse.id,
    content,
  };
}
