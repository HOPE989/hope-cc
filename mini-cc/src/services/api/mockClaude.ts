import type { ContentBlock, Message, ModelProvider, ToolResultBlock } from "../../types.ts";

function latestUserText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
  }
  return "";
}

function latestToolResults(messages: Message[]): ToolResultBlock[] {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user" || !Array.isArray(last.content)) {
    return [];
  }
  return last.content.filter((block): block is ToolResultBlock => block.type === "tool_result");
}

function chooseCommand(prompt: string): string {
  const lower = prompt.toLowerCase();
  if (lower.includes("list") || lower.includes("文件") || lower.includes("目录")) {
    return "node -e \"console.log(require('fs').readdirSync(process.cwd()).join('\\n'))\"";
  }
  if (lower.includes("node") || lower.includes("version") || lower.includes("版本")) {
    return "node --version";
  }
  return "node -e \"console.log(process.cwd())\"";
}

export class MockClaudeProvider implements ModelProvider {
  async createMessage({ messages }: Parameters<ModelProvider["createMessage"]>[0]) {
    const toolResults = latestToolResults(messages);
    //L01-S19 结束工具循环：mock provider 看到 tool_result 后停止调用工具，用来验证 tool_use -> tool_result -> final answer 闭环。
    if (toolResults.length > 0) {
      const content: ContentBlock[] = [
        {
          type: "text",
          text: `我已经看到工具结果：\n\n${toolResults.map((r) => r.content).join("\n")}\n\n这一轮没有继续调用工具，agent loop 结束。`,
        },
      ];
      return { content, stop_reason: "end_turn" as const };
    }

    const prompt = latestUserText(messages);
    //L01-S20 生成工具请求：第一轮没有工具结果时，mock provider 主动生成 tool_use，模拟真实模型向 harness 请求工具。
    const content: ContentBlock[] = [
      {
        type: "text",
        text: "我需要先观察工作区状态，所以调用 bash 工具。",
      },
      {
        type: "tool_use",
        id: "toolu_01",
        name: "bash",
        input: {
          command: chooseCommand(prompt),
        },
      },
    ];
    return { content, stop_reason: "tool_use" as const };
  }
}
