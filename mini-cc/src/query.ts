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
  yield* queryLoop(params);
}

async function* queryLoop(params: QueryParams): AsyncGenerator<QueryEvent> {
  const system = params.systemPrompt ?? "You are a small coding agent. Use tools when needed.";
  const maxTurns = params.maxTurns ?? 8;
  let state: QueryState = {
    messages: [{ role: "user", content: params.prompt }],
    turnCount: 0,
  };

  while (true) {
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

    const response = await params.provider.createMessage({
      system,
      messages: state.messages,
      tools: params.tools,
    });

    const assistantMessage: Message = { role: "assistant", content: response.content };
    state.messages.push(assistantMessage);
    yield { type: "assistant", message: assistantMessage };

    const assistantText = textFromBlocks(response.content);
    if (assistantText) {
      console.log(`[assistant]\n${assistantText}`);
    }

    const toolUses = toolUseBlocks(response.content);
    if (toolUses.length === 0) {
      console.log("[loop] no tool_use; stop");
      yield { type: "done", messages: state.messages };
      return;
    }

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
    yield { type: "tool_result", message: toolResultMessage };
  }
}
