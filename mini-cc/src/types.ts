export type Role = "user" | "assistant";

//L01-S06 定义消息块：ContentBlock 是 agent loop 的最小消息协议，保留 text、tool_use、tool_result 三类核心块。
export type TextBlock = {
  type: "text";
  text: string;
};

export type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
};

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export type Message = {
  role: Role;
  content: string | ContentBlock[];
};

export type ToolDefinition = {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
};

export type ModelRequest = {
  system: string;
  messages: Message[];
  tools: ToolDefinition[];
};

export type ModelResponse = {
  content: ContentBlock[];
  stop_reason: "tool_use" | "end_turn";
};

export type ModelProvider = {
  /**
   * 把 mini-cc 的模型请求发送给具体 provider，并返回标准化后的模型响应。
   * @param request 本轮系统提示、消息历史和工具 schema。
   * @returns 标准化后的 assistant content blocks 和停止原因。
   */
  createMessage(request: ModelRequest): Promise<ModelResponse>;
};

//L01-S07 定义事件流：QueryEvent 模拟 Claude Code 的 AsyncGenerator 事件流，让 UI/SDK 层能消费 assistant、tool_result 和 done。
export type QueryEvent =
  | { type: "assistant"; message: Message }
  | { type: "tool_result"; message: Message }
  | { type: "done"; messages: Message[] };
