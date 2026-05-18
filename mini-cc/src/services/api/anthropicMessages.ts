import type {
  ContentBlock,
  Message,
  ModelProvider,
  ModelResponse,
  ToolDefinition,
  ToolUseBlock,
} from "../../types.ts";

type FetchLike = typeof fetch;

export type AnthropicMessagesProviderOptions = {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  anthropicVersion?: string;
  streaming?: boolean;
  fetchImpl?: FetchLike;
};

type AnthropicResponseBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input?: unknown }
  | { type: string; [key: string]: unknown };

type AnthropicResponse = {
  content?: AnthropicResponseBlock[];
  stop_reason?: string | null;
};

type AnthropicStreamEvent =
  | { type: "message_start"; message?: unknown }
  | { type: "content_block_start"; index: number; content_block: AnthropicResponseBlock }
  | {
      type: "content_block_delta";
      index: number;
      delta:
        | { type: "text_delta"; text: string }
        | { type: "input_json_delta"; partial_json: string }
        | { type: string; [key: string]: unknown };
    }
  | { type: "content_block_stop"; index: number }
  | { type: "message_delta"; delta?: { stop_reason?: string | null } }
  | { type: "message_stop" }
  | { type: "ping" }
  | { type: "error"; error?: unknown }
  | { type: string; [key: string]: unknown };

type StreamingBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; inputJson: string };

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";

/**
 * 把用户配置的 Anthropic base URL 归一成 Messages API endpoint。
 * @param baseUrl 用户提供或默认的 Anthropic base URL。
 * @returns 可直接请求的 `/v1/messages` URL。
 */
function buildMessagesUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (trimmed.endsWith("/v1/messages")) return trimmed;
  if (trimmed.endsWith("/v1")) return `${trimmed}/messages`;
  return `${trimmed}/v1/messages`;
}

/**
 * 把 mini-cc 内部消息转换成 Anthropic Messages API 可接受的消息结构。
 * @param message mini-cc 内部 transcript 消息。
 * @returns 可发送给 Anthropic-compatible API 的消息对象。
 */
function normalizeMessage(message: Message): Message {
  if (typeof message.content === "string") return message;

  return {
    role: message.role,
    content: message.content.map((block) => {
      if (block.type === "tool_result") {
        return {
          type: "tool_result",
          tool_use_id: block.tool_use_id,
          content: block.content,
        };
      }
      return block;
    }),
  };
}

/**
 * 把 mini-cc 工具定义裁剪成 Anthropic Messages API 需要的 schema 字段。
 * @param tools 当前暴露给模型的工具定义列表。
 * @returns 标准化后的工具 schema 列表。
 */
function normalizeTools(tools: ToolDefinition[]): ToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema,
  }));
}

/**
 * 把非 streaming API 返回的 content blocks 转成 mini-cc 内部只支持的 ContentBlock。
 * @param content Anthropic-compatible API 返回的原始 content blocks。
 * @returns mini-cc 标准化后的 text/tool_use blocks。
 */
function normalizeResponseContent(content: AnthropicResponseBlock[] | undefined): ContentBlock[] {
  const blocks = content ?? [];
  return blocks.flatMap((block): ContentBlock[] => {
    if (block.type === "text") {
      return [{ type: "text", text: block.text }];
    }
    if (block.type === "tool_use") {
      const toolUse: ToolUseBlock = {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input:
          block.input && typeof block.input === "object" && !Array.isArray(block.input)
            ? (block.input as Record<string, unknown>)
            : {},
      };
      return [toolUse];
    }
    return [];
  });
}

/**
 * 把 Anthropic stop_reason 归一成 mini-cc 只关心的 tool_use 或 end_turn。
 * @param stopReason API 返回的原始 stop_reason。
 * @param content 已标准化的 content blocks。
 * @returns mini-cc 内部使用的停止原因。
 */
function normalizeStopReason(stopReason: string | null | undefined, content: ContentBlock[]): ModelResponse["stop_reason"] {
  if (stopReason === "tool_use") return "tool_use";
  return content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn";
}

/**
 * 把 streaming 阶段累加出来的 partial JSON 字符串解析成工具输入对象。
 * @param inputJson streaming input_json_delta 拼接出的 JSON 字符串。
 * @returns 可放入 tool_use.input 的对象；解析失败时返回空对象。
 */
function parseToolInput(inputJson: string): Record<string, unknown> {
  if (inputJson.trim().length === 0) return {};

  try {
    const parsed = JSON.parse(inputJson);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * 把 streaming 聚合状态转换成 queryLoop 能消费的完整 ContentBlock[]。
 * @param blocks 按 content_block.index 保存的 streaming 半成品 block。
 * @returns 完整的 text/tool_use content blocks。
 */
function finalizeStreamingContent(blocks: StreamingBlock[]): ContentBlock[] {
  return blocks.filter((block): block is StreamingBlock => Boolean(block)).map((block) => {
    if (block.type === "text") {
      return { type: "text", text: block.text };
    }

    return {
      type: "tool_use",
      id: block.id,
      name: block.name,
      input: parseToolInput(block.inputJson),
    };
  });
}

/**
 * 把单个 Anthropic stream event 应用到当前 streaming 聚合状态。
 * @param blocks 按 content_block.index 保存的 streaming 半成品 block。
 * @param event 当前收到的 Anthropic stream event。
 * @returns event 携带 stop_reason 时返回该值，否则返回 null。
 */
function applyStreamEvent(blocks: StreamingBlock[], event: AnthropicStreamEvent): string | null {
  switch (event.type) {
    case "content_block_start": {
      const block = event.content_block;
      if (block.type === "text") {
        // 真实 Claude Code 会忽略 start 事件里的初始 text，统一从 text_delta 累加，避免 SDK 重复文本。
        blocks[event.index] = { type: "text", text: "" };
      } else if (block.type === "tool_use") {
        // Streaming 时工具输入还不是对象，而是一段段 partial_json，需要先保存为字符串。
        blocks[event.index] = {
          type: "tool_use",
          id: block.id,
          name: block.name,
          inputJson: "",
        };
      }
      return null;
    }
    case "content_block_delta": {
      const block = blocks[event.index];
      if (!block) throw new Error(`Streaming content block ${event.index} was not started.`);

      if (event.delta.type === "text_delta") {
        if (block.type !== "text") throw new Error("Received text_delta for a non-text block.");
        // provider adapter 负责把零散 token 拼回 assistant text，queryLoop 不接触 chunk。
        block.text += event.delta.text;
      } else if (event.delta.type === "input_json_delta") {
        if (block.type !== "tool_use") throw new Error("Received input_json_delta for a non-tool block.");
        // partial_json 只有在 block 完成后才能解析成 tool_use.input。
        block.inputJson += event.delta.partial_json;
      }
      return null;
    }
    case "message_delta":
      return event.delta?.stop_reason ?? null;
    case "error":
      throw new Error(`Anthropic stream error: ${JSON.stringify(event.error ?? event)}`);
    default:
      return null;
  }
}

/**
 * 从 HTTP streaming response 中持续解析 Anthropic SSE event。
 * @param response fetch 返回的 streaming Response。
 * @returns 逐个产出的 Anthropic stream event。
 */
async function* parseSSE(response: Response): AsyncGenerator<AnthropicStreamEvent> {
  if (!response.body) {
    throw new Error("Streaming response did not include a readable body.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = buffer.replace(/\r\n/g, "\n");

    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = parseSSEEvent(rawEvent);
      if (event) yield event;
      boundary = buffer.indexOf("\n\n");
    }
  }

  buffer += decoder.decode();
  buffer = buffer.replace(/\r\n/g, "\n");
  if (buffer.trim().length > 0) {
    const event = parseSSEEvent(buffer);
    if (event) yield event;
  }
}

/**
 * 把一个原始 SSE event 文本解析成 Anthropic stream event。
 * @param rawEvent 单个 SSE event 的原始文本。
 * @returns 解析出的 Anthropic stream event；空事件或 [DONE] 时返回 null。
 */
function parseSSEEvent(rawEvent: string): AnthropicStreamEvent | null {
  const dataLines = rawEvent
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart());

  if (dataLines.length === 0) return null;

  const data = dataLines.join("\n");
  if (data === "[DONE]") return null;

  return JSON.parse(data) as AnthropicStreamEvent;
}

/**
 * 安全读取当前进程环境变量，兼容未来非 Node 运行环境。
 * @param name 环境变量名称。
 * @returns 环境变量值；不存在或不支持 process 时返回 undefined。
 */
function readEnv(name: string): string | undefined {
  return typeof process === "undefined" ? undefined : process.env[name];
}

/**
 * 从环境变量创建 Anthropic Messages provider。
 * @returns 已配置好的 AnthropicMessagesProvider 实例。
 */
export function createAnthropicProviderFromEnv(): AnthropicMessagesProvider {
  //L02-S01 读取模型配置：真实 provider 从环境变量取 base url / api key，避免把密钥写进代码或 transcript。
  const apiKey = readEnv("ANTHROPIC_API_KEY");
  if (!apiKey) {
    throw new Error("Missing ANTHROPIC_API_KEY. Set it in your shell before running mini-cc with the real model.");
  }

  return new AnthropicMessagesProvider({
    apiKey,
    baseUrl: readEnv("ANTHROPIC_BASE_URL") ?? DEFAULT_BASE_URL,
    model: readEnv("MINI_CC_MODEL") ?? readEnv("ANTHROPIC_MODEL") ?? readEnv("MODEL_ID") ?? DEFAULT_MODEL,
    maxTokens: Number(readEnv("MINI_CC_MAX_TOKENS") ?? DEFAULT_MAX_TOKENS),
    anthropicVersion: readEnv("ANTHROPIC_VERSION") ?? DEFAULT_ANTHROPIC_VERSION,
    //L04-S02 在 provider 工厂选择 streaming 模式：默认开启 streaming，保留 MINI_CC_STREAMING=0 作为教学和故障排查用的非 streaming 退路。
    streaming: readEnv("MINI_CC_STREAMING") !== "0",
  });
}

export class AnthropicMessagesProvider implements ModelProvider {
  private readonly options: Required<Omit<AnthropicMessagesProviderOptions, "fetchImpl">> & {
    fetchImpl: FetchLike;
  };

  /**
   * 初始化 Anthropic Messages provider 的请求配置和 fetch 实现。
   * @param options API key、base URL、模型、token 上限、版本、streaming 开关和 fetch 实现。
   * @returns 初始化后的 AnthropicMessagesProvider 实例。
   */
  constructor(options: AnthropicMessagesProviderOptions) {
    if (!options.apiKey) {
      throw new Error("AnthropicMessagesProvider requires apiKey.");
    }

    this.options = {
      apiKey: options.apiKey,
      baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
      model: options.model ?? DEFAULT_MODEL,
      maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      anthropicVersion: options.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION,
      streaming: options.streaming ?? true,
      fetchImpl: options.fetchImpl ?? fetch,
    };
  }

  /**
   * 通过统一 provider 接口创建模型消息，优先走 streaming，失败时回退非 streaming。
   * @param request mini-cc 标准模型请求。
   * @returns 标准化后的模型响应。
   */
  async createMessage(request: Parameters<ModelProvider["createMessage"]>[0]): Promise<ModelResponse> {
    //L04-S05 在 provider 内部选择执行路径：createMessage() 是 queryLoop 看到的唯一模型接口；这里先尝试 streaming，失败再回到 Lesson 02 的非 streaming 路径。
    if (this.options.streaming) {
      try {
        //L04 核心入口
        return await this.createStreamingMessage(request);
      } catch (error) {
        console.warn(
          `[stream:fallback] ${error instanceof Error ? error.message : String(error)}; retrying without streaming.`,
        );
      }
    }

    return this.createNonStreamingMessage(request);
  }

  /**
   * 发送非 streaming Anthropic Messages 请求，并把响应标准化为 mini-cc 模型响应。
   * @param request mini-cc 标准模型请求。
   * @returns 标准化后的模型响应。
   */
  private async createNonStreamingMessage(request: Parameters<ModelProvider["createMessage"]>[0]): Promise<ModelResponse> {
    //L02-S02 发送 Anthropic Messages 请求：provider adapter 把 mini-cc 的 transcript 和工具 schema 映射到 /v1/messages。
    const response = await this.options.fetchImpl(buildMessagesUrl(this.options.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.options.apiKey,
        "anthropic-version": this.options.anthropicVersion,
      },
      body: JSON.stringify({
        model: this.options.model,
        max_tokens: this.options.maxTokens,
        system: request.system,
        messages: request.messages.map(normalizeMessage),
        tools: normalizeTools(request.tools),
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${body.slice(0, 1_000)}`);
    }

    const data = (await response.json()) as AnthropicResponse;
    const content = normalizeResponseContent(data.content);

    //L02-S03 标准化模型输出：真实 API 可能有更多 block；本课只保留 text/tool_use，让既有 queryLoop 继续工作。
    return {
      content,
      stop_reason: normalizeStopReason(data.stop_reason, content),
    };
  }

  //L04 核心新增方法，替换原有的 createMessage（现改为createNonStreamingMessage）
  /**
   * 发送 streaming Anthropic Messages 请求，聚合 SSE chunk 后返回完整模型响应。
   * @param request mini-cc 标准模型请求。
   * @returns 聚合并标准化后的模型响应。
   */
  private async createStreamingMessage(request: Parameters<ModelProvider["createMessage"]>[0]): Promise<ModelResponse> {
    //L04-S06 发起 streaming Messages 请求：请求体仍然包含 system/messages/tools，只额外加 stream:true；这对应 Claude Code 的 provider 层，而不是 queryLoop。
    const response = await this.options.fetchImpl(buildMessagesUrl(this.options.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.options.apiKey,
        "anthropic-version": this.options.anthropicVersion,
      },
      body: JSON.stringify({
        model: this.options.model,
        max_tokens: this.options.maxTokens,
        system: request.system,
        messages: request.messages.map(normalizeMessage),
        tools: normalizeTools(request.tools),
        stream: true,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Anthropic streaming API error ${response.status}: ${body.slice(0, 1_000)}`);
    }

    //L04-S07 建立本轮 stream 聚合状态：blocks 按 content_block.index 存放半成品 block，stopReason 等 message_delta 到来后再记录。
    const blocks: StreamingBlock[] = [];
    let stopReason: string | null = null;

    //L04-S08 逐个消费 SSE 事件：parseSSE() 只负责把 HTTP 字节流切成事件，applyStreamEvent() 再处理 start/delta/stop 的协议含义。
    for await (const event of parseSSE(response)) {
      //L04 blocks传递的是引用
      const eventStopReason = applyStreamEvent(blocks, event);
      if (eventStopReason) {
        stopReason = eventStopReason;
      }
    }

    //L04-S09 交还完整 ContentBlock[]：只有到 stream 结束后，partial_json 才被解析成真正的 tool_use.input，后续 tool_use 检测仍交给既有 queryLoop。
    const content = finalizeStreamingContent(blocks);
    if (content.length === 0 && !stopReason) {
      throw new Error("Stream ended without receiving usable content.");
    }

    return {
      content,
      stop_reason: normalizeStopReason(stopReason, content),
    };
  }
}
