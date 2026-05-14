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
    for await (const event of query({
      prompt,
      provider: this.options.provider,
      tools: this.options.tools,
      toolUseContext: { cwd: this.options.cwd },
    })) {
      if (event.type === "done") {
        return;
      }
    }
  }
}
