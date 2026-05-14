export type Role = "user" | "assistant";

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
  createMessage(request: ModelRequest): Promise<ModelResponse>;
};

export type QueryEvent =
  | { type: "assistant"; message: Message }
  | { type: "tool_result"; message: Message }
  | { type: "done"; messages: Message[] };
