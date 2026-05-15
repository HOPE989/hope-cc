import type { Message, ModelProvider } from "./types.ts";
import type { Tool } from "./Tool.ts";
import { query } from "./query.ts";

export class QueryEngine {
  private messages: Message[] = [];

  private readonly options: {
    provider: ModelProvider;
    tools: Tool[];
    cwd: string;
    systemPrompt?: string;
    maxTurns?: number;
  };

  constructor(options: {
    provider: ModelProvider;
    tools: Tool[];
    cwd: string;
    systemPrompt?: string;
    maxTurns?: number;
  }) {
    this.options = options;
  }

  async submitMessage(prompt: string): Promise<void> {
    //L02-S06 保留跨输入 transcript：交互式 harness 不能每次用户输入都重建 messages，否则模型看不到上一轮上下文。
    const messages: Message[] = [...this.messages, { role: "user", content: prompt }];

    //L01-S04 准备上下文：QueryEngine 是简化版入口包装，对应 Claude Code 中 REPL/headless 在进入 query() 前准备上下文。
    for await (const event of query({
      messages,
      provider: this.options.provider,
      tools: this.options.tools,
      toolUseContext: { cwd: this.options.cwd },
      systemPrompt: this.options.systemPrompt,
      maxTurns: this.options.maxTurns,
    })) {
      //L01-S05 消费事件流：query() 用事件流返回中间状态；入口层只关心何时 done，不直接实现 loop 细节。
      if (event.type === "done") {
        this.messages = event.messages;
        return;
      }
    }
  }
}
