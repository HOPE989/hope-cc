import { QueryEngine } from "./QueryEngine.ts";
import { MockClaudeProvider } from "./services/api/mockClaude.ts";
import { getDefaultTools } from "./tools.ts";

const prompt = process.argv.slice(2).join(" ") || "List files in the current workspace";

const engine = new QueryEngine({
  provider: new MockClaudeProvider(),
  tools: getDefaultTools(),
  cwd: process.cwd(),
});

await engine.submitMessage(prompt);
