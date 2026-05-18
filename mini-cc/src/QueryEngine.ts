import type { Message, ModelProvider } from "./types.ts";
import type { Tool, ToolPermissionContext } from "./Tool.ts";
import { query } from "./query.ts";

export class QueryEngine {
  private messages: Message[] = [];

  private readonly options: {
    provider: ModelProvider;
    tools: Tool[];
    cwd: string;
    permissionContext?: ToolPermissionContext;
    systemPrompt?: string;
    maxTurns?: number;
  };

  /**
   * 创建入口包装器，保存 provider、工具、cwd、权限上下文和 loop 配置。
   * @param options QueryEngine 运行 query loop 所需的依赖和配置。
   * @returns 初始化后的 QueryEngine 实例。
   */
  constructor(options: {
    provider: ModelProvider;
    tools: Tool[];
    cwd: string;
    permissionContext?: ToolPermissionContext;
    systemPrompt?: string;
    maxTurns?: number;
  }) {
    this.options = options;
  }

  /**
   * 把一次用户输入接到历史 transcript 后面，并驱动 query loop 跑到本轮完成。
   * @param prompt 用户在交互式入口输入的文本。
   * @returns 本轮 agent loop 完成后的异步结果。
   */
  async submitMessage(prompt: string): Promise<void> {
    //L02-S06 保留跨输入 transcript：交互式 harness 不能每次用户输入都重建 messages，否则模型看不到上一轮上下文。
    const messages: Message[] = [...this.messages, { role: "user", content: prompt }];

    //L01-S04 准备上下文：QueryEngine 是简化版入口包装，对应 Claude Code 中 REPL/headless 在进入 query() 前准备上下文。
    //L04-S03 让入口包装保持透明：QueryEngine 只把 provider 传进 query()，不关心 provider 是 streaming 还是非 streaming，避免 UI/REPL 层知道 API chunk 细节。
    for await (const event of query({
      messages,
      provider: this.options.provider,
      tools: this.options.tools,
      //L03-S04 传入权限上下文：QueryEngine 是入口包装层，它把 main.ts 准备好的权限能力交给 queryLoop，而不自己做权限判断。
      toolUseContext: {
        cwd: this.options.cwd,
        permissionContext: this.options.permissionContext,
      },
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
