import type { ModelProvider } from "./types.ts";
import type { Tool } from "./Tool.ts";
import { query } from "./query.ts";

export class QueryEngine {
  private readonly options: {
    provider: ModelProvider;
    tools: Tool[];
    cwd: string;
  };

  constructor(options: {
    provider: ModelProvider;
    tools: Tool[];
    cwd: string;
  }) {
    this.options = options;
  }

  async submitMessage(prompt: string): Promise<void> {
    //L01-S04 准备上下文：QueryEngine 是简化版入口包装，对应 Claude Code 中 REPL/headless 在进入 query() 前准备上下文。
    for await (const event of query({
      prompt,
      provider: this.options.provider,
      tools: this.options.tools,
      toolUseContext: { cwd: this.options.cwd },
    })) {
      //L01-S05 消费事件流：query() 用事件流返回中间状态；入口层只关心何时 done，不直接实现 loop 细节。
      if (event.type === "done") {
        return;
      }
    }
  }
}
