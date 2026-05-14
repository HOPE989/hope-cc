import type { Tool, ToolUseContext } from "./Tool.ts";
import type { ContentBlock, Message, ModelProvider, QueryEvent, ToolUseBlock } from "./types.ts";
import { runTools } from "./services/tools/toolOrchestration.ts";

type QueryParams = {
  prompt: string;
  provider: ModelProvider;
  tools: Tool[];
  toolUseContext: ToolUseContext;
  systemPrompt?: string;
  maxTurns?: number;
};

type QueryState = {
  messages: Message[];
  turnCount: number;
};

function textFromBlocks(blocks: ContentBlock[]): string {
  return blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function toolUseBlocks(blocks: ContentBlock[]): ToolUseBlock[] {
  return blocks.filter((block): block is ToolUseBlock => block.type === "tool_use");
}

export async function* query(params: QueryParams): AsyncGenerator<QueryEvent> {
  //L01-S11 暴露 loop 入口：query() 只暴露异步生成器接口，真正状态机下沉到 queryLoop()。
  yield* queryLoop(params);
}

async function* queryLoop(params: QueryParams): AsyncGenerator<QueryEvent> {
  const system = params.systemPrompt ?? "You are a small coding agent. Use tools when needed.";
  const maxTurns = params.maxTurns ?? 8;
  //L01-S12 初始化状态：state 保存跨轮 transcript 和 turnCount，这是 agent loop 能连续推进的核心。
  let state: QueryState = {
    messages: [{ role: "user", content: params.prompt }],
    turnCount: 0,
  };

  while (true) {
    //L01-S13 检查轮数上限：maxTurns 是最小停止保护，避免模型持续 tool_use 导致无限循环。
    if (state.turnCount >= maxTurns) {
      state.messages.push({
        role: "assistant",
        content: [{ type: "text", text: `Stopped after maxTurns=${maxTurns}.` }],
      });
      yield { type: "done", messages: state.messages };
      return;
    }

    state = { ...state, turnCount: state.turnCount + 1 };
    console.log(`\n[turn ${state.turnCount}] call model`);

    //L01-S14 调用模型：每一轮都把当前 messages 和工具 schema 发给模型，模型只能通过协议请求工具。
    const response = await params.provider.createMessage({
      system,
      messages: state.messages,
      tools: params.tools,
    });

    const assistantMessage: Message = { role: "assistant", content: response.content };
    
    //L01-S15 记录模型输出：assistant message 先写回 transcript 并 yield 给入口层，对应 Claude Code 的流式事件输出。
    state.messages.push(assistantMessage);
    yield { type: "assistant", message: assistantMessage };

    const assistantText = textFromBlocks(response.content);
    if (assistantText) {
      console.log(`[assistant]\n${assistantText}`);
    }

    const toolUses = toolUseBlocks(response.content);
    //L01-S16 判断停止条件：没有 tool_use 就说明本轮不需要 follow-up，agent loop 可以完成。
    if (toolUses.length === 0) {
      console.log("[loop] no tool_use; stop");
      yield { type: "done", messages: state.messages };
      return;
    }

    //L01-S17 执行工具调度：出现 tool_use 后，queryLoop 只调用工具调度层，不直接知道 bash 等具体工具细节。
    const toolResults = await runTools({
      toolUses,
      tools: params.tools,
      context: params.toolUseContext,
    });

    for (let i = 0; i < toolUses.length; i += 1) {
      console.log(`[tool:${toolUses[i].name}] ${JSON.stringify(toolUses[i].input)} -> ${toolResults[i].content.slice(0, 200)}`);
    }

    const toolResultMessage: Message = { role: "user", content: toolResults };
    state.messages.push(toolResultMessage);
    //L01-S18 回填工具结果：tool_result 作为 user message 回填 transcript，下一轮模型才能基于工具结果继续推理。
    yield { type: "tool_result", message: toolResultMessage };
  }
}
