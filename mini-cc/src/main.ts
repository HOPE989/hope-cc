import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { QueryEngine } from "./QueryEngine.ts";
import { createAnthropicProviderFromEnv } from "./services/api/anthropicMessages.ts";
// import { MockClaudeProvider } from "./services/api/mockClaude.ts";
import { getDefaultTools } from "./tools.ts";
import { loadDotEnv } from "./utils/dotenv.ts";

//L01-S01 启动入口：main.ts 只负责启动 mini-cc 应用；用户消息统一从交互式提示符进入。

const systemPrompt = [
  "You are mini-cc, a small coding agent used for a Claude Code build-along lesson.",
  "Use the bash tool when you need to inspect or operate on the local workspace.",
  "Keep commands small and explain the result after the tool returns.",
].join("\n");

async function main() {
  loadDotEnv({ override: true });

  //L01-S02 创建入口包装：创建 QueryEngine，把启动入口和核心 agent loop 分开，贴近 Claude Code 的入口包装边界。
  const engine = new QueryEngine({
    //L02-S04 接入真实 provider：mock 已完成教学使命，入口默认使用 Anthropic Messages adapter 驱动真实模型。
    provider: createAnthropicProviderFromEnv(),
    // provider: new MockClaudeProvider(),
    tools: getDefaultTools(),
    cwd: process.cwd(),
    systemPrompt,
    maxTurns: 6,
  });

  const repl = createInterface({ input, output });
  try {
    while (true) {
      //L02-S07 交互式 harness：进程启动一次后反复读取用户输入，每次输入都复用 QueryEngine 中保存的 transcript。
      const prompt = await repl.question("\x1b[36mmini-cc >> \x1b[0m");
      const trimmed = prompt.trim();
      if (!trimmed || trimmed.toLowerCase() === "q" || trimmed.toLowerCase() === "exit") {
        break;
      }
      //L01-S03 提交消息：提交用户消息，后续由 QueryEngine 进入 query() / queryLoop()。
      //L02-S05 运行真实工具闭环：同一个入口、同一个 queryLoop，由真实模型决定是否发起 bash tool_use。
      await engine.submitMessage(trimmed);
      console.log();
    }
  } finally {
    repl.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
