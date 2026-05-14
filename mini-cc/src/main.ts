import { QueryEngine } from "./QueryEngine.ts";
import { MockClaudeProvider } from "./services/api/mockClaude.ts";
import { getDefaultTools } from "./tools.ts";

/*
 * //L01-S01 读取参数：读取命令行 prompt，作为简化版 Claude Code 交互输入的入口。
 *
 * 运行 `npm run lesson:01 -- "列出目录"` 时，npm 里的 `--` 只是 npm 自己的参数分隔符，
 * 它不会作为脚本参数传给 Node。实际执行近似为：
 *
 *   node --experimental-strip-types src/main.ts 列出目录
 *
 * 所以 process.argv 大致是：
 *
 *   [node.exe, C:\...\mini-cc\src\main.ts, 列出目录]
 *
 * 此时 process.argv.slice(2) 拿到的是 ["列出目录"]。
 */
const prompt = process.argv.slice(2).join(" ") || "List files in the current workspace";

//L01-S02 创建入口包装：创建 QueryEngine，把启动入口和核心 agent loop 分开，贴近 Claude Code 的入口包装边界。
const engine = new QueryEngine({
  provider: new MockClaudeProvider(),
  tools: getDefaultTools(),
  cwd: process.cwd(),
});

//L01-S03 提交消息：提交用户消息，后续由 QueryEngine 进入 query() / queryLoop()。
await engine.submitMessage(prompt);
