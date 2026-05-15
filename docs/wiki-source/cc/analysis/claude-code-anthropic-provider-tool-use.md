# Claude Code Anthropic Provider 与 Tool Use 源码分析

## Learning Question

第二课要回答的问题是：`mini-cc` 如何从第一课的 mock provider，切到真正的模型调用，并仍然让 LLM 通过 `bash` 完成最基本的本地操作？

这不是单纯“发一个 HTTP 请求”。对于 coding agent，模型调用必须带上三样东西：

```text
transcript messages
tool schema
system prompt
```

模型返回的也不只是文本，而是可能包含 `tool_use` 的 assistant content。`mini-cc` 已经在第一课实现了 `tool_use -> tool_result -> follow-up`，所以第二课的重点是 provider adapter：把本地 transcript 和工具协议映射到 Anthropic Messages API。

## Scope

本文覆盖：

- Claude Code 如何创建 Anthropic client 并调用 Messages API。
- 工具 schema 如何暴露为 `name / description / input_schema`。
- 为什么不能只相信 `stop_reason`，而要看 content block 中是否有 `tool_use`。
- `mini-cc` 第二课如何接入真实 Anthropic-compatible endpoint。

本文不覆盖：

- streaming chunk / `partial_json` 的完整聚合。
- Bedrock / Vertex / Foundry 多 provider 分支。
- permission hook、post tool hook、工具结果持久化。
- Anthropic server tools 和 MCP connector。

这些会在后续课程单独展开。

## Mental Model

第一课的 mock provider 做了这件事：

```text
messages + tools -> 写死返回 tool_use 或 text
```

第二课的真实 provider 做同一件事，只是把“写死返回”换成 Anthropic Messages API，并让入口变成持续交互的 harness：

```text
mini-cc >> user input
-> saved transcript + new user message
-> POST /v1/messages
-> assistant content blocks
-> text/tool_use 标准化
-> queryLoop 执行工具并回填 tool_result
-> 保存更新后的 transcript
-> 回到 mini-cc >>
```

关键边界是：provider adapter 不执行工具。它只负责 API I/O 和协议转换。工具执行仍然属于 `services/tools`。

## Execution Flow

### 1. Claude Code 使用 Anthropic SDK client

源码确认：

- `src/services/api/client.ts:88`：`getAnthropicClient()` 是创建 Anthropic client 的入口。
- `src/services/api/client.ts:301`：client config 中注入 `apiKey` / `authToken` 等认证配置。
- `src/services/api/client.ts:315`：返回 `new Anthropic(clientConfig)`。
- `src/services/api/claude.ts:555`：API key 校验直接调用 `anthropic.beta.messages.create(...)`。
- `src/services/api/claude.ts:864`：非 streaming fallback 也调用 `anthropic.beta.messages.create(...)`。
- `src/services/api/claude.ts:1822`：主 streaming 路径调用 `anthropic.beta.messages.create({ ...params, stream: true })`。

设计结论：

Claude Code 的 provider 边界不是“自己拼所有 HTTP 细节”，而是集中创建 SDK client，然后由 `claude.ts` 组织 Messages API 参数、streaming、fallback、retry 和错误恢复。`mini-cc` 第二课为了保持最小可理解，先用 `fetch` 直连 Anthropic-compatible `/v1/messages`，但模块边界仍然按 provider adapter 组织。

### 2. 工具 schema 以 API tool definition 暴露给模型

源码确认：

- `src/utils/api.ts:136`：工具 schema 的基础字段是 `name`、`description`、`input_schema`，并带有 strict / eager input streaming 等扩展字段。
- `src/utils/api.ts:157`：Claude Code 会从工具自身 schema 生成 `input_schema`。
- `src/utils/api.ts:218`：最终 schema 显式包含 `input_schema`。

Anthropic 官方文档也确认：client tools 由应用执行；模型返回 `tool_use`，应用执行后再回传 `tool_result`。

设计结论：

`mini-cc` 不需要把 `bash` 的使用方法塞进自然语言 prompt 里赌模型理解。它应该把 `BashTool` 的 `name / description / input_schema` 作为 `tools` 参数发给模型。

### 3. 是否继续 loop 由 content block 决定

源码确认：

- `src/query.ts:554`：源码注释明确提到 `stop_reason === 'tool_use'` 不总是可靠。
- `src/query.ts:557` 附近：真实继续信号来自 streaming 中是否出现 `tool_use` block。

设计结论：

第二课的 `mini-cc` provider 会保留 `stop_reason`，但 `queryLoop` 仍然按 assistant content 中的 `tool_use` 判断是否继续。这延续了第一课的核心协议边界。

还有一个容易误解的运行现象：assistant message 不一定同时包含 `text` 和 `tool_use`。真实模型可以直接返回一个只有 `tool_use` 的 assistant content，例如：

```text
assistant:
  - tool_use(name=bash, input={ command: "del test.txt" })
```

这种情况下，`mini-cc/src/query.ts` 会先把 assistant message 写回 transcript，但 `textFromBlocks()` 提取不到文本，所以控制台不会打印 `[assistant] ...`。日志会表现为：

```text
[turn 1] call model
[tool:bash] {"command":"del test.txt"} -> (no output)
```

这不是应用丢弃了 LLM 文本，而是这一轮 LLM 本来就只返回了工具请求。对 coding agent 来说这很常见：模型认为动作明确时，会直接发起工具调用，等工具结果回来后再给最终说明。

相反，如果同一条 assistant message 里既有 `text` block 又有 `tool_use` block，`mini-cc` 会先打印文本，再执行工具。例如：

```text
[turn 2] call model
[assistant]
看来这是一个 Windows 环境。让我使用 Windows 的命令来查看文件：

[tool:bash] {"command":"dir"} -> Volume in drive C is Windows
...
```

这表示模型这一轮返回的是一条 assistant message，content 大致是：

```text
assistant:
  - text("看来这是一个 Windows 环境...")
  - tool_use(name=bash, input={ command: "dir" })
```

所以，是否出现 `[assistant]` 只取决于本轮 assistant content 里有没有 `text` block；是否继续执行工具，则取决于同一轮 content 里有没有 `tool_use` block。

### 4. `tool_result` 必须作为 user message 回填

源码确认：

- `src/query.ts:1536`：Claude Code 源码注释说明，不能把 `tool_result` message 和普通 user message 随意交错，否则 API 会报错。
- 第一课 analysis 已确认：`tool_use` 在 assistant content 中，`tool_result` 在 user content 中。

设计结论：

第二课只换 provider，不改 transcript 结构。真实模型调用前，messages 中仍然应该是：

```text
user: prompt
assistant: text + tool_use
user: tool_result
assistant: final text
```

## Source Evidence

| 源码位置 | 关键事实 |
|---|---|
| `src/services/api/client.ts:88` | 创建 Anthropic client 的统一入口。 |
| `src/services/api/client.ts:301` | client config 注入认证配置。 |
| `src/services/api/client.ts:315` | 返回 Anthropic SDK client。 |
| `src/services/api/claude.ts:555` | API key 校验使用 Messages API。 |
| `src/services/api/claude.ts:864` | 非 streaming fallback 使用 Messages API。 |
| `src/services/api/claude.ts:1822` | 主 streaming 路径使用 Messages API stream。 |
| `src/utils/api.ts:136` | 工具 schema 基础字段是 `name / description / input_schema`。 |
| `src/query.ts:554` | `stop_reason === 'tool_use'` 不总是可靠。 |
| `src/query.ts:1536` | `tool_result` message 的顺序不能随意和普通 user message 交错。 |
| Anthropic docs: Tool use overview | client tool 返回 `tool_use`，本地执行后回传 `tool_result`。 |
| Anthropic docs: API overview | Messages API 是 `POST /v1/messages`，请求需要 API key、`anthropic-version` 和 JSON content type。 |

## Build-Along Derivation

这些源码事实推导出 `mini-cc` Lesson 02 的实现：

| Claude Code 边界 | mini-cc 对应 | 本课取舍 |
|---|---|---|
| `src/services/api/client.ts` | `mini-cc/src/services/api/anthropicMessages.ts` | 不引入 SDK，直接用 `fetch` 保持协议透明。 |
| `src/services/api/claude.ts` | `AnthropicMessagesProvider.createMessage()` | 只实现非 streaming Messages API。 |
| `src/utils/api.ts` | `normalizeTools()` | 只发送 `name / description / input_schema`。 |
| `src/query.ts` | `mini-cc/src/query.ts` | 不改 loop，继续按 content blocks 查找 `tool_use`。 |
| `src/services/tools/*` | `mini-cc/src/services/tools/*` | provider 不执行工具，只返回模型意图。 |
| REPL/headless 入口复用 loop | `mini-cc/src/main.ts` / `mini-cc/src/QueryEngine.ts` | 进程启动一次后循环读输入，`QueryEngine` 保存跨输入 transcript。 |

## 源码确认 / 合理推断 / 待验证

源码确认：

- Claude Code 的模型调用集中在 Anthropic Messages API。
- 工具 schema 以结构化 `tools` 参数发给模型。
- `tool_use` content block 是比 `stop_reason` 更可靠的继续信号。
- assistant message 可以只有 `tool_use`、没有 `text`；这种轮次不会打印 `[assistant]` 文本，但仍会写入 transcript 并触发工具执行。
- `tool_result` 作为 user message 回填，且顺序必须保持合法。

合理推断：

- `mini-cc` 第二课暂时不做 streaming，也能教学上覆盖“真实模型决定调用 bash”的核心机制，因为第一课已经保留完整 `tool_use/tool_result` transcript。
- 把 transcript 保存在 `QueryEngine` 比保存在 `queryLoop` 更适合交互式 harness，因为 `queryLoop` 只负责一次用户输入内部的模型/工具 follow-up。
- 使用环境变量承载 key / base url 比写入配置文件更适合当前课程阶段，避免密钥进入仓库。

待验证：

- 用户提供的 Anthropic-compatible base URL 是否完整兼容 `/v1/messages`、`tools` 和 `tool_use/tool_result`。
- 目标模型是否稳定产生 `bash` tool call；不同模型可能需要更强 system prompt。
- streaming 下 `input_json_delta` 到完整 `tool_use.input` 的聚合时机。

## mini-cc Lesson 02 Design

第二课新增：

```text
mini-cc/src/services/api/anthropicMessages.ts
mini-cc/src/main.ts
mini-cc/src/utils/dotenv.ts
```

运行时由环境变量提供：

```text
ANTHROPIC_API_KEY
ANTHROPIC_BASE_URL
MODEL_ID、ANTHROPIC_MODEL 或 MINI_CC_MODEL
```

这些变量可以写入 `mini-cc/.env`。启动时 `loadDotEnv({ override: true })` 会用 Node 原生 `util.parseEnv()` 解析 `.env`，再写入 `process.env` 并创建真实 provider。Node 也提供 `process.loadEnvFile()`，但它不覆盖已有环境变量；本课需要贴近 `load_dotenv(override=True)` 的本地实验体验，所以保留一个很薄的 wrapper。

本课保留的最小闭环：

```text
npm run dev
-> mini-cc >> "用 bash 看当前目录"
-> AnthropicMessagesProvider.createMessage()
-> model returns tool_use(name=bash)
-> runTools()
-> BashTool.call()
-> user tool_result
-> second model call
-> final assistant text
-> mini-cc >> next input with history preserved
```

## Verification

本课实现后需要验证两层：

1. 无 API key 时，CLI 给出明确错误，不泄露密钥。
2. 用 fake fetch 验证 provider 能把 `tools`、`messages` 发到 `/v1/messages`，并把 API 返回的 `tool_use` 标准化成 `mini-cc` content block。

真实模型验证需要用户提供 API key、base url 和可用 model 后再运行。
