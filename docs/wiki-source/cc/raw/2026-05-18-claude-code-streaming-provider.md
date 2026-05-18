# ✅Claude Code Streaming Provider：把 chunk 聚合成可执行的 tool_use

Lesson 04 解决的是 coding agent 里一个很容易被低估的机制：模型返回不是一次性文本，而是一串 streaming event；工具调用的参数也不是一开始就是对象，而是由一段段 `input_json_delta.partial_json` 拼出来的。对 Claude Code 这类 agent 来说，provider 层必须先把 chunk 聚合成完整 content block，query loop 才能判断是否要执行工具。

这一课在 `mini-cc` 中完成的路径是：

```text
Anthropic SSE stream
-> parseSSE()
-> applyStreamEvent()
-> StreamingBlock.inputJson
-> finalizeStreamingContent()
-> ContentBlock[]
-> queryLoop detects tool_use
```

核心取舍是：`query.ts` 不理解 SSE、delta 或 partial JSON；它仍然只消费完整的 `ContentBlock[]`。streaming 是 provider adapter 的内部能力，不应该泄漏到主状态机。

## 为什么要做这个机制？

前三课已经让 `mini-cc` 跑通了：

```text
user input
-> model provider
-> assistant tool_use
-> tool execution
-> user tool_result
-> next model call
```

但 Lesson 02 的真实 provider 仍然是非 streaming。它可以说明“真实模型如何发起工具调用”，却无法解释 Claude Code 的主路径为什么要处理 chunk。

对 coding agent 来说，streaming 不只是为了让终端更早打印字。更关键的是：工具调用也会被流式生成。

一个完整的 `tool_use` 在传输过程中可能经历：

```text
content_block_start(tool_use, id, name)
-> input_json_delta('{"command"')
-> input_json_delta(':"dir"}')
-> content_block_stop
```

在 `content_block_stop` 之前，工具输入还不是可靠对象。如果工具执行层过早读取，就可能拿到半截 JSON、错位 block，或者在 fallback 后留下孤儿工具结果。因此 Lesson 04 要把 provider streaming 的边界讲清楚：

```text
chunk 是传输层碎片
content block 是 assistant message 的结构化片段
tool_use 是 query loop 和工具执行层能理解的协议对象
```

## Claude Code 源码里看到的核心结构

源码阅读确认了 Claude Code 主路径使用 raw stream，而不是让 SDK 自动在每个 delta 上反复解析半成品 JSON：

| 源码位置 | 关键事实 |
|---|---|
| `src/services/api/claude.ts:1818` | 源码注释说明使用 raw stream，避免 `BetaMessageStream` 对每个 `input_json_delta` 做 O(n^2) partial JSON parsing。 |
| `src/services/api/claude.ts:1822` | 调用 `anthropic.beta.messages.create({ ...params, stream: true })`。 |
| `src/services/api/claude.ts:1940` | 通过 `for await (const part of stream)` 消费 stream event。 |
| `src/services/api/claude.ts:1995` | `content_block_start` 建立 content block 槽位。 |
| `src/services/api/claude.ts:2000` | streaming `tool_use.input` 初始化为空字符串。 |
| `src/services/api/claude.ts:2087` | `input_json_delta` 只允许进入工具类 block。 |
| `src/services/api/claude.ts:2111` | `partial_json` 被追加到工具 input 字符串。 |
| `src/services/api/claude.ts:2171` | `content_block_stop` 时构造 assistant message。 |
| `src/utils/messages.ts:2651` | `normalizeContentFromAPI()` 是 API content 标准化入口。 |
| `src/utils/messages.ts:2676` | stringified tool input 用 `safeParseJSON()` 解析成对象。 |
| `src/query.ts:829` | query loop 从 assistant content 中筛选 `tool_use`。 |
| `src/query.ts:834` | 发现 `tool_use` 后设置 `needsFollowUp = true`。 |
| `src/services/tools/StreamingToolExecutor.ts:64` | streaming fallback 时 pending / in-progress 工具结果要被 discard。 |

从这些源码可以推导出一个清晰边界：

```text
provider streaming:
  stream event -> content block -> assistant message

query loop:
  assistant message -> tool_use detection -> follow-up decision

tool execution:
  complete tool_use.input object -> permission -> tool.call()
```

## 核心协议 / 数据结构

Lesson 04 最重要的数据形态变化是 `tool_use.input`：

```text
partial_json fragments
-> stringified JSON
-> parsed object
```

Claude Code 在 stream 聚合阶段把工具输入当作字符串累加，等 block 完成后再进入 `normalizeContentFromAPI()`。这样做有两个价值：

1. 避免每个 `input_json_delta` 都触发一次半成品 JSON parse。
2. 确保工具权限、schema normalize 和执行层只面对完整对象。

`mini-cc` 对应的数据结构是：

```ts
type StreamingBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; inputJson: string };
```

`StreamingBlock.inputJson` 明确表示：在 provider streaming 内部，工具输入还只是 JSON 字符串，不是 `ToolUseBlock.input`。只有 `finalizeStreamingContent()` 才把它解析成：

```ts
{
  type: "tool_use",
  id,
  name,
  input: parseToolInput(inputJson),
}
```

这条转换线是本课的核心。

## mini-cc 实现结构

Lesson 04 没有新增 CLI、npm script 或平行 main 文件。入口仍然是：

```text
mini-cc/src/main.ts
-> QueryEngine.submitMessage()
-> query()
-> provider.createMessage()
```

变化只发生在 `mini-cc/src/services/api/anthropicMessages.ts` 的 provider adapter 内部：

| 模块 / 方法 | 作用 |
|---|---|
| `createAnthropicProviderFromEnv()` | 从环境变量创建 provider，并通过 `MINI_CC_STREAMING=0` 保留非 streaming 退路。 |
| `AnthropicMessagesProvider.createMessage()` | 统一 provider 入口；默认尝试 streaming，失败后回退非 streaming。 |
| `createStreamingMessage()` | 发起 `stream: true` 的 Messages 请求，聚合 SSE 后返回完整 `ModelResponse`。 |
| `parseSSE()` | 从 HTTP body 中切出 SSE event。 |
| `parseSSEEvent()` | 把单个 `data:` event 解析成 `AnthropicStreamEvent`。 |
| `applyStreamEvent()` | 根据 start / delta / message_delta 更新 `StreamingBlock[]`。 |
| `finalizeStreamingContent()` | stream 结束后把半成品 blocks 转成完整 `ContentBlock[]`。 |
| `parseToolInput()` | 把累加出的 `inputJson` 解析成对象；失败时保守返回 `{}`。 |

`query.ts` 的职责没有扩张。它仍然只做：

```text
provider.createMessage()
-> response.content
-> toolUseBlocks(response.content)
-> runTools()
```

这保留了后续演进空间：未来如果要实现边流式边执行工具，应在 query loop 和 tool services 之间引入类似 `StreamingToolExecutor` 的边界，而不是让 provider 直接执行工具。

## 关键模块说明

### `createMessage()`：provider 内部分叉点

`createMessage()` 是 query loop 能看到的唯一模型接口。Lesson 04 在这里加入 streaming / non-streaming 分叉：

```text
if streaming:
  try createStreamingMessage()
  catch -> warn -> createNonStreamingMessage()
else:
  createNonStreamingMessage()
```

这个设计让入口层、QueryEngine 和 query loop 都不需要知道当前 provider 是否启用了 streaming。对上层来说，它永远拿到同一种 `ModelResponse`。

### `parseSSE()`：只切传输事件，不解释协议

`parseSSE()` 的职责是把 HTTP response body 切成一个个 SSE event：

```text
raw bytes
-> text buffer
-> split by blank line
-> data: lines
-> AnthropicStreamEvent
```

它不理解 `tool_use`、`text_delta` 或 stop reason。这样 `parseSSE()` 可以保持传输层工具函数的边界。

### `applyStreamEvent()`：协议语义的 reducer

`applyStreamEvent()` 才处理 Anthropic stream event 的语义：

- `content_block_start(text)`：建立空 text block。
- `content_block_start(tool_use)`：建立带 `inputJson: ""` 的 tool block。
- `content_block_delta(text_delta)`：追加到 text block。
- `content_block_delta(input_json_delta)`：追加到 tool block 的 `inputJson`。
- `message_delta`：返回 stop reason。
- `error`：抛出 stream 错误。

这里有一个用户追问沉淀下来的细节：`blocks` 是数组对象，传进 `applyStreamEvent(blocks, event)` 后，helper 对 `blocks[event.index]`、`block.text`、`block.inputJson` 的原地修改会影响外层 `createStreamingMessage()` 中的同一个数组对象。更准确地说，JavaScript 参数是按值传递，但对象值本身是引用；本课依赖的是“修改同一个数组对象”，不是让 helper 替换外层变量。

### `finalizeStreamingContent()`：把 provider 内部形态交还给 agent loop

`finalizeStreamingContent()` 是 provider streaming 和 agent loop 的交界点。它把：

```text
StreamingBlock[]
```

转换成：

```text
ContentBlock[]
```

从这一刻开始，`queryLoop` 才能安全地调用 `toolUseBlocks(response.content)`。在这之前，工具输入还只是 `inputJson` 字符串，不能进入权限或执行层。

## 注释驱动阅读路径

Lesson 04 的代码注释路径是：

| Step | 文件 | 阅读重点 |
|---|---|---|
| `L04-S01` | `mini-cc/src/main.ts` | 从既有应用入口进入 streaming 课程，不新增 CLI。 |
| `L04-S02` | `mini-cc/src/services/api/anthropicMessages.ts` | provider 工厂读取 `MINI_CC_STREAMING`，默认启用 streaming。 |
| `L04-S03` | `mini-cc/src/QueryEngine.ts` | QueryEngine 继续只传递 provider，不感知 streaming / fallback。 |
| `L04-S04` | `mini-cc/src/query.ts` | query loop 仍等待完整 `ContentBlock[]`，不解析 SSE。 |
| `L04-S05` | `mini-cc/src/services/api/anthropicMessages.ts` | `createMessage()` 是 provider 内部分叉点。 |
| `L04-S06` | `mini-cc/src/services/api/anthropicMessages.ts` | `createStreamingMessage()` 请求体加入 `stream: true`。 |
| `L04-S07` | `mini-cc/src/services/api/anthropicMessages.ts` | 建立 `blocks[index]` 和 `stopReason` 聚合状态。 |
| `L04-S08` | `mini-cc/src/services/api/anthropicMessages.ts` | `parseSSE()` 切事件，`applyStreamEvent()` 聚合协议内容。 |
| `L04-S09` | `mini-cc/src/services/api/anthropicMessages.ts` | stream 结束后 finalize 成完整 `ContentBlock[]`。 |

本轮还额外给 `mini-cc/src` 中的稳定方法入口补齐了 JSDoc 方法注释。这不是新的机制课程编号，而是阅读辅助：每个命名函数、类方法、对象方法和类型函数签名都说明职责、参数和返回值，避免后续课程读者只能靠实现细节猜边界。

## 运行效果 / 验证

本课验证了四类行为。

第一，假 SSE stream 可以聚合成完整 content blocks：

```text
text_delta("准备查看")
input_json_delta('{"command"')
input_json_delta(':"dir"}')
message_delta(stop_reason="tool_use")

=> content:
   text("准备查看")
   tool_use(name="bash", input={ command: "dir" })
```

运行结果：

```text
stream aggregation ok
```

第二，streaming 失败后会回退到非 streaming：

```text
stream fallback ok
[stream:fallback] Anthropic streaming API error 500: bad stream; retrying without streaming.
```

第三，关键模块可以导入：

```text
module imports ok
```

第四，streaming provider 可以驱动既有 query loop 完成工具闭环：

```text
[turn 1] call model
[tool:bash] {"command":"node --version"} -> v22.16.0

[turn 2] call model
[assistant]
工具结果已收到。
[loop] no tool_use; stop
streaming query loop ok
```

本轮方法注释维护后，又补充运行了：

```text
node --experimental-strip-types --check src/**/*.ts
jsdoc coverage ok
```

这说明方法注释没有破坏 TypeScript strip 模式下的运行，且稳定方法入口已经有 JSDoc 覆盖。

## 工程取舍

第一，`mini-cc` 只实现 provider 内聚合，不实现边流式边执行工具。真实 Claude Code 可以在每个 `content_block_stop` 后 yield assistant message，并把完成的 `tool_use` 交给 `StreamingToolExecutor`；Lesson 04 先等整条 stream 完成后一次性返回 `ContentBlock[]`，让主 loop 保持简单。

第二，fallback 只做非 streaming retry，不处理 tombstone partial messages。原因是 `mini-cc` provider 没有提前 yield partial assistant message，也没有提前执行工具；streaming attempt 失败时，不会产生需要 discard 的 pending tool result。真实 Claude Code 必须处理这个问题，因为它可能已经 yield 了 assistant block 或排队执行了工具。

第三，`parseToolInput()` 对 JSON 解析失败返回 `{}`。这不是生产级错误恢复，只是教学版保持 loop 可运行的保守策略。后续如果引入 schema validation，应把 malformed tool input 明确映射成错误 `tool_result`。

第四，仍然不引入 Anthropic SDK。直接用 `fetch` 和 SSE parser 是为了让协议更透明：读者可以看到 `stream: true`、`data:` event、`partial_json` 聚合和最终 `ContentBlock[]` 的完整路径。

第五，方法注释作为规则沉淀进 `AGENTS.md`，但不替代 `Lxx-Sxx` 课程注释。`Lxx-Sxx` 解释课程机制路径；JSDoc 解释方法职责和参数协议。两者服务不同阅读层级。

## 和真实 Claude Code 的差距

| 真实 Claude Code | mini-cc Lesson 04 |
|---|---|
| 使用 Anthropic SDK raw stream。 | 直接用 `fetch` 解析 SSE。 |
| 每个 `content_block_stop` 都可以 yield assistant message。 | 等整个 stream 完成后一次性返回 `ContentBlock[]`。 |
| `normalizeContentFromAPI()` 支持更多 block、工具输入 normalize 和错误路径。 | 只支持 text 和 tool_use，JSON 失败返回 `{}`。 |
| 支持 thinking、signature、connector text、server tools、usage、cost。 | 暂时都不实现。 |
| streaming fallback 会 tombstone partial messages，并 discard pending tools。 | provider 尚未提前 yield / execute，因此只做非 streaming retry。 |
| 可选启用 `StreamingToolExecutor` 边流式边执行工具。 | 工具仍在完整 assistant response 后串行执行。 |
| 有 watchdog、stall telemetry、request id、fallback model。 | 暂不实现生产级观测和恢复。 |

这些差距是刻意留下的学习 frontier。Lesson 04 的目标不是复刻 Claude Code 的完整 streaming runtime，而是把 provider streaming 的最小协议边界跑通。

## 这份资料可以抽取哪些 wiki 词条？

这份 raw source 后续可以抽取为：

- `project-cc`
- `Claude Code Streaming Provider`
- `Agent Provider Adapter`
- `Streaming Chunk 聚合`
- `tool_use partial JSON`
- `ContentBlock 协议`
- `Agent Loop 与 Provider 边界`
- `Streaming Tool Execution`
- `Coding Agent Fallback Recovery`
- `mini-cc Lesson 04`

也可以支撑这些问题页：

- Claude Code 为什么要自己聚合 `input_json_delta`？
- message、content block、stream chunk 的边界是什么？
- streaming 下 `tool_use.input` 什么时候从字符串变成对象？
- 为什么 query loop 不应该直接解析 SSE？
- streaming fallback 为什么要丢弃 pending tool results？

## 后续 TODO

- 精读 `src/services/tools/StreamingToolExecutor.ts`，进入边流式边执行工具和并发结果排序。
- 先补 Tool Dispatcher，让 `mini-cc` 有多个工具后再讨论并发安全分组。
- 为 `parseToolInput()` 增加更明确的 malformed JSON 错误结果，而不是静默 `{}`。
- 继续学习 stream watchdog、fallback model 和 telemetry，理解生产级 stream 恢复。
- 进入 Context / Compaction 时，确认 streaming 产生的 assistant messages 如何进入 transcript 和压缩边界。

## Raw Reference

- hope-cc analysis: `docs/wiki-source/cc/analysis/claude-code-streaming-provider.md`
- hope-cc build-along: `docs/build-along/cc/04-streaming-provider.md`
- hope-cc learning map: `docs/wiki-source/cc/00-learning-map.md`
- mini-cc provider: `mini-cc/src/services/api/anthropicMessages.ts`
- mini-cc entry: `mini-cc/src/main.ts`
- mini-cc query engine: `mini-cc/src/QueryEngine.ts`
- mini-cc loop: `mini-cc/src/query.ts`
- Claude Code source evidence:
  - `src/services/api/claude.ts`
  - `src/utils/messages.ts`
  - `src/query.ts`
  - `src/services/tools/StreamingToolExecutor.ts`
