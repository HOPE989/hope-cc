# ✅Claude Code：真实模型 Provider 与 Bash 工具闭环

第二课把 `project-cc` 里的 `mini-cc` 从第一课的 mock provider 推进到真实 Anthropic-compatible Messages API。完成这一课之后，`mini-cc` 不再只是写死一段 `tool_use` 的教学 demo，而是可以启动一次、持续对话，并由真实模型决定什么时候调用 `bash`。

这份 raw source 记录的是一个很小但关键的跨越：

```text
mock model
-> real Anthropic Messages provider
-> tool_use(name=bash)
-> local bash execution
-> tool_result as user message
-> model continues
```

它不是要复刻完整 Claude Code，而是把真实 Claude Code 中最核心的模型协议、工具协议和 transcript 结构缩小成一条可运行路径。

## 为什么要做这个机制？

第一课的 `mini-cc` 已经实现了 agent loop 的最小形状：

```text
user message
-> assistant message
-> if tool_use: execute tool
-> user tool_result
-> next model call
```

但第一课的模型是 `MockClaudeProvider`。它能帮助我们看清 loop，却不能回答一个更真实的问题：当模型真的来自 LLM API 时，工具调用到底从哪里来？

对 coding agent 来说，模型调用不是“发 prompt，拿文本”。它至少同时带着三类输入：

```text
system prompt
transcript messages
tools schema
```

模型输出也不只是自然语言，而是一个 content block 列表。这个列表里可能有 `text`，也可能有 `tool_use`，还可能同时出现二者。

所以第二课的目标不是加一个 HTTP 请求，而是把第一课的 loop 和真实 Anthropic Messages API 接起来，让真实模型通过结构化协议驱动 `bash`。

## Claude Code 源码里看到的核心结构

这次读源码确认了几件事。

第一，Claude Code 的模型请求集中在 Anthropic client / Messages API 边界：

- `src/services/api/client.ts:88`：`getAnthropicClient()` 创建 Anthropic client。
- `src/services/api/client.ts:301`：client config 注入 `apiKey` / `authToken` 等认证配置。
- `src/services/api/client.ts:315`：返回 Anthropic SDK client。
- `src/services/api/claude.ts:555`：API key 校验调用 `anthropic.beta.messages.create(...)`。
- `src/services/api/claude.ts:864`：非 streaming fallback 调用 `anthropic.beta.messages.create(...)`。
- `src/services/api/claude.ts:1822`：主 streaming 路径调用 `anthropic.beta.messages.create({ ...params, stream: true })`。

这说明真实 Claude Code 不把模型调用散落在工具执行或 REPL 入口里，而是有明确的 API service 边界。

第二，工具不是靠自然语言说明塞给模型，而是通过结构化 schema 暴露：

- `src/utils/api.ts:136`：工具 schema 基础字段是 `name`、`description`、`input_schema`。
- `src/utils/api.ts:157`：Claude Code 会从工具自身 schema 生成 `input_schema`。
- `src/utils/api.ts:218`：最终 schema 显式包含 `input_schema`。

这给 `mini-cc` 的推导很直接：`BashTool` 已经有 `name / description / input_schema`，第二课只需要把这份结构化定义放进 API body。

第三，loop 是否继续，不能只看 `stop_reason`：

- `src/query.ts:554` 附近的源码注释指出，`stop_reason === 'tool_use'` 不总是可靠。
- `src/query.ts:557` 附近的继续信号来自 content block 中是否出现 `tool_use`。

因此 `mini-cc` 第二课保留第一课的判断方式：provider 可以返回 `stop_reason`，但 `queryLoop` 继续与否仍然由 `response.content` 里的 `tool_use` block 决定。

第四，工具结果必须作为 user message 回填：

- `src/query.ts:1536` 附近说明，`tool_result` message 的顺序不能和普通 user message 随意交错。

Anthropic 工具协议的关键配对是：

```text
assistant content:
  tool_use(id="...")

user content:
  tool_result(tool_use_id="...")
```

这也是第一课已经搭好的 transcript 结构。第二课只换 provider，不重新设计消息结构。

## 核心协议 / 数据结构

第二课保留的最小协议如下：

```ts
messages: Message[]
tools: ToolDefinition[]
system: string
```

`tools` 里只发送三个字段：

```ts
{
  name: "bash",
  description: "Run a shell command in the current workspace.",
  input_schema: {
    type: "object",
    properties: {
      command: { type: "string" }
    },
    required: ["command"]
  }
}
```

模型返回后，`mini-cc` 只保留两类 content block：

```text
text
tool_use
```

这样做是刻意收窄边界：真实 Claude Code 还会处理 thinking、server tools、MCP、streaming chunk、prompt cache 等更多 block 和元信息，但第二课只需要证明真实模型可以发起本地工具调用。

这里有一个很重要的运行现象：LLM 可以直接返回只有 `tool_use`、没有 `text` 的 assistant message。

例如用户说“删掉这个 test 文件”，模型可能直接回复：

```text
assistant:
  - tool_use(name="bash", input={ command: "del test.txt" })
```

这时控制台会看到：

```text
[turn 1] call model
[tool:bash] {"command":"del test.txt"} -> (no output)
```

中间没有 `[assistant]`，不是应用把 LLM 文本丢了，而是这一轮 LLM 本来就没有返回 text block。`queryLoop` 仍然会把 assistant message 写进 transcript，只是 `textFromBlocks()` 提取不到文本，所以不打印。

另一种情况是同一条 assistant message 同时包含 `text` 和 `tool_use`：

```text
assistant:
  - text("看来这是一个 Windows 环境。让我使用 Windows 的命令来查看文件：")
  - tool_use(name="bash", input={ command: "dir" })
```

这时 `mini-cc` 会先打印 `[assistant]`，再执行 `[tool:bash]`。判断标准很简单：

```text
有没有 text block -> 是否打印 assistant 文本
有没有 tool_use block -> 是否继续工具执行 loop
```

## mini-cc 实现结构

第二课的实现没有新增一个“第二课入口”。它直接增强第一课已经存在的代码路径：

```text
mini-cc/src/main.ts
-> QueryEngine.submitMessage()
-> query()
-> queryLoop()
-> AnthropicMessagesProvider.createMessage()
-> runTools()
-> BashTool.call()
```

关键文件如下：

| 文件 | 作用 |
|---|---|
| `mini-cc/src/services/api/anthropicMessages.ts` | 新增真实 Anthropic-compatible provider。 |
| `mini-cc/src/main.ts` | 保留同一个启动入口，默认使用真实 provider，并启动交互式 REPL。 |
| `mini-cc/src/QueryEngine.ts` | 保存跨用户输入的 transcript。 |
| `mini-cc/src/query.ts` | 复用第一课 agent loop，支持传入完整 messages。 |
| `mini-cc/src/utils/dotenv.ts` | 启动时读取 `.env`。 |
| `mini-cc/src/tools/BashTool.ts` | 继续提供最小 `bash` 工具和危险命令拦截。 |
| `mini-cc/.env.example` | 给出本地模型配置模板。 |
| `mini-cc/.gitignore` | 忽略真实 `.env`，避免 key 进入仓库。 |

完整运行路径是：

```text
npm run dev
-> loadDotEnv({ override: true })
-> createAnthropicProviderFromEnv()
-> mini-cc >> user input
-> QueryEngine appends user message to saved transcript
-> queryLoop calls model
-> model returns text/tool_use
-> runTools executes bash
-> tool_result appended as user message
-> next model call
-> final text
-> mini-cc >> next input, history preserved
```

## 关键模块说明

### AnthropicMessagesProvider

`mini-cc/src/services/api/anthropicMessages.ts` 是第二课的核心新增模块。

它负责四件事：

1. 从环境变量读取 `ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL`、模型名、max tokens 和 `anthropic-version`。
2. 把 base url 规范化到 `/v1/messages`，兼容用户传入根地址、`/v1` 或完整 `/v1/messages`。
3. 把 `ModelRequest` 转成 Anthropic Messages API body。
4. 把 API 返回的 content block 标准化成 `mini-cc` 认识的 `text` / `tool_use`。

本课没有引入 Anthropic SDK，而是用 `fetch` 直连 API。这个取舍是为了让协议透明：读者能直接看到 headers、body、tools 和 messages 是怎么进 `/v1/messages` 的。

### main.ts

`mini-cc/src/main.ts` 仍然是唯一应用入口。第二课做了两点增强：

- 默认 provider 从 `MockClaudeProvider` 换成 `createAnthropicProviderFromEnv()`。
- 用 `node:readline/promises` 实现 `mini-cc >>` 交互式循环。

mock 没有被粗暴删除，而是在入口里注释保留。这符合本项目的课程演进规则：旧实现成为过去式时，优先保留为阅读线索，让读者看见从 mock 到 real provider 的替换点。

### QueryEngine

第一课的 `queryLoop` 可以处理一次用户输入内部的多轮：

```text
model -> tool -> model
```

但用户希望启动一次应用后持续输入多条消息。这就需要一个更外层的 transcript 容器。第二课把这个状态放进 `QueryEngine`：

```text
private messages: Message[] = []
```

每次 `submitMessage()` 都把新 user message 接到旧 transcript 后面。等 `query()` 产出 `done` 事件后，`QueryEngine` 再保存更新后的完整 messages。

这让交互式 harness 不会每次输入都丢历史。

### query.ts

`query.ts` 的核心判断没有变：

```text
if no tool_use -> done
if has tool_use -> run tools -> append tool_result -> continue
```

第二课只给它增加了一个能力：可以从外部传入完整 `messages`。这避免把跨输入历史塞进 `queryLoop`，也让 `queryLoop` 继续保持“单次用户输入内部的 agent loop”这一职责。

### dotenv.ts

Node 现在有原生 `.env` 相关能力。这里没有引入第三方 `dotenv` 包，而是用 `node:util` 的 `parseEnv()` 解析 `.env`，再自己实现一层很薄的 `override` 语义。

原因是本地学习脚本常见习惯是 `load_dotenv(override=True)`：`.env` 可以覆盖当前 shell 里已有的实验变量。Node 的 `process.loadEnvFile()` 不覆盖已有环境变量；本课需要的是更接近 build-along 实验的行为，所以保留了这个小 wrapper。

## 注释驱动阅读路径

第二课在代码里新增或维护了 `L02-Sxx` 注释：

| Step | 文件 | 阅读重点 |
|---|---|---|
| `L02-S01` | `mini-cc/src/services/api/anthropicMessages.ts` | 真实 provider 从环境变量读取模型配置。 |
| `L02-S02` | `mini-cc/src/services/api/anthropicMessages.ts` | provider adapter 把 transcript 和工具 schema 映射到 `/v1/messages`。 |
| `L02-S03` | `mini-cc/src/services/api/anthropicMessages.ts` | API 响应被标准化成 `text/tool_use`。 |
| `L02-S04` | `mini-cc/src/main.ts` | 入口默认从 mock 切到真实 Anthropic provider。 |
| `L02-S05` | `mini-cc/src/main.ts` | 同一个入口运行真实模型驱动的工具闭环。 |
| `L02-S06` | `mini-cc/src/QueryEngine.ts` | 交互式 harness 保存跨输入 transcript。 |
| `L02-S07` | `mini-cc/src/main.ts` | `mini-cc >>` 循环让进程启动一次、多次输入。 |
| `L02-S08` | `mini-cc/src/utils/dotenv.ts` | 启动时加载 `.env`，避免密钥写进命令行或源码。 |

这条注释路径是本课最重要的阅读顺序：先看 provider，再看入口切换，再看 transcript 保存，最后看配置加载。

## 运行效果 / 验证

本课启动命令统一为：

```powershell
Set-Location C:\dev\workspace\hope-cc\mini-cc
npm run dev
```

本地 `.env` 示例：

```text
ANTHROPIC_API_KEY=你的 key
ANTHROPIC_BASE_URL=你的 Anthropic-compatible base url
MODEL_ID=可用模型名
```

进入提示符后，可以连续输入：

```text
mini-cc >> 用 bash 打印当前目录，然后告诉我这里有哪些顶层文件
mini-cc >> 继续查看 package.json
mini-cc >> exit
```

已验证的范围包括：

- 缺少 `ANTHROPIC_API_KEY` 时，启动阶段给出明确错误。
- fake fetch 可以验证 provider 请求 URL、headers、body 和 `tool_use` 标准化。
- REPL 可以通过管道输入验证 `exit` 退出。
- `QueryEngine` 的 transcript 会跨用户输入保存。
- `.env` loader 可以解析引号和 override 行为。

真实模型效果需要用户提供可用的 base url、api key 和 model 后运行。用户实测中已经观察到两种真实形态：

```text
assistant only tool_use
assistant text + tool_use
```

这两个现象都被沉淀进 analysis，作为理解 Messages content block 的关键例子。

## 工程取舍

这次实现有几个刻意取舍。

第一，provider 不执行工具。它只负责 API I/O 和协议转换。工具执行仍然留在 `services/tools` 和 `BashTool`。这样后续加 streaming、retry、fallback 时，不会污染工具层；后续加权限和 path guard 时，也不用改 provider。

第二，不新增 `lesson:02` 脚本。用户已经把运行方式统一成 `npm run dev`，第二课就在既有入口上增强。这让学习路径更像真实产品演进：同一个应用入口不断长能力，而不是每一课都开一个新门口。

第三，mock 作为过去式被注释保留。它不再是默认路径，但仍然展示第一课到第二课的替换点。

第四，build-along 不再承载运行观察追问。用户提醒过：如果编码已经完成、没有动代码，就不要为了补观察去修改 `02-anthropic-provider-bash.md`。像“tool_use-only 为什么没有 assistant 文本”这种机制澄清，应该进 analysis 和 raw，而不是把 build-along 改成运行日志。

第五，先做非 streaming。真实 Claude Code 主路径有 streaming、retry、fallback、request id、telemetry 等生产级机制，但第二课只解决“真实模型能驱动 bash 闭环”。这让课程保持可理解，也给后续 `Streaming Provider` 留出清晰 frontier。

## 和真实 Claude Code 的差距

`mini-cc` 第二课完成的是最小真实模型闭环，不是生产级 provider。差距包括：

- Claude Code 使用 Anthropic SDK 和复杂 client config；本课用 `fetch` 直连。
- Claude Code 主路径是 streaming；本课是非 streaming。
- Claude Code 处理 retry、fallback、request id、telemetry；本课没有。
- Claude Code 处理 thinking、server tools、MCP、prompt cache；本课只保留 `text` / `tool_use`。
- Claude Code 有 permission hook、pre tool hook、post tool hook；本课只有 `BashTool` 内部的最小危险命令拦截。
- Claude Code 会处理 malformed transcript 和工具结果持久化；本课只保留 maxTurns 停止保护。

这些差距不是失败，而是后续课程的入口。第二课完成后，最自然的下一步就是 `Permission / Tool Safety` 或 `Streaming Provider`。

## 这份资料可以抽取哪些 wiki 词条？

这份 raw source 后续可以抽取为：

- `Claude Code Anthropic Provider`
- `Anthropic Messages API 工具调用`
- `tool_use / tool_result 协议`
- `Agent transcript`
- `Coding Agent REPL harness`
- `mini-cc Lesson 02`
- `LLM tool-use-only response`
- `Node .env loader for agent experiments`

也可以支撑这些问题页：

- 为什么 LLM 调工具时有时没有 assistant 文本？
- coding agent 为什么要把工具 schema 结构化发给模型？
- `tool_result` 为什么是 user message？
- mini agent 如何从 mock provider 演进到真实模型 provider？

## 后续 TODO

- 精读 Claude Code streaming provider，理解 `content_block_start`、`input_json_delta`、`content_block_stop` 如何聚合成完整 tool input。
- 精读 Bash permission / tool safety 路径，把 `BashTool` 的危险命令拦截拆成独立权限边界。
- 增加 read/write/edit 文件工具，让模型不只通过 shell 操作文件。
- 增加 session save/resume，保证 `tool_use` / `tool_result` 配对历史可恢复。
- 增加 transcript compaction，避免长会话无限增长。

## Raw Reference

- hope-cc analysis: `docs/wiki-source/cc/analysis/claude-code-anthropic-provider-tool-use.md`
- hope-cc build-along: `docs/build-along/cc/02-anthropic-provider-bash.md`
- hope-cc learning map: `docs/wiki-source/cc/00-learning-map.md`
- mini-cc provider: `mini-cc/src/services/api/anthropicMessages.ts`
- mini-cc entry: `mini-cc/src/main.ts`
- mini-cc query engine: `mini-cc/src/QueryEngine.ts`
- mini-cc loop: `mini-cc/src/query.ts`
- mini-cc dotenv loader: `mini-cc/src/utils/dotenv.ts`
- Claude Code source evidence:
  - `src/services/api/client.ts`
  - `src/services/api/claude.ts`
  - `src/utils/api.ts`
  - `src/query.ts`
