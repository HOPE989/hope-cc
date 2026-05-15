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

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";

function buildMessagesUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (trimmed.endsWith("/v1/messages")) return trimmed;
  if (trimmed.endsWith("/v1")) return `${trimmed}/messages`;
  return `${trimmed}/v1/messages`;
}

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

function normalizeTools(tools: ToolDefinition[]): ToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema,
  }));
}

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

function readEnv(name: string): string | undefined {
  return typeof process === "undefined" ? undefined : process.env[name];
}

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
  });
}

export class AnthropicMessagesProvider implements ModelProvider {
  private readonly options: Required<Omit<AnthropicMessagesProviderOptions, "fetchImpl">> & {
    fetchImpl: FetchLike;
  };

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
      fetchImpl: options.fetchImpl ?? fetch,
    };
  }

  async createMessage(request: Parameters<ModelProvider["createMessage"]>[0]): Promise<ModelResponse> {
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
      stop_reason: data.stop_reason === "tool_use" ? "tool_use" : "end_turn",
    };
  }
}
