# Claude Code Streaming Provider 源码分析

## Learning Question

Lesson 04 要回答的问题是：

```text
Anthropic streaming API 连续吐出 chunk
-> Claude Code 如何把 chunk 聚合成 assistant content block
-> tool_use.input 什么时候从 partial_json 变成对象
-> query loop 什么时候知道本轮需要执行工具
```

这节课不是学习“如何在终端实时打印文字”。对 coding agent 更关键的是：模型的工具调用本身也是流式生成的。`tool_use` 的 `name` 和 `id` 会先出现，但 `input` 不是一开始就完整的对象，而是一段段 `input_json_delta.partial_json`。只有聚合完成后，工具层才能拿到可靠的 `ToolUseBlock`。

## Scope

本文覆盖：

- Claude Code 为什么使用 raw stream，而不是 SDK 的 `BetaMessageStream` 自动 partial parse。
- `content_block_start`、`content_block_delta`、`content_block_stop` 如何形成 assistant message。
- `input_json_delta` 如何累加成字符串，再由 `normalizeContentFromAPI()` 解析成对象。
- `query.ts` 如何基于完整 assistant message 识别 `tool_use` 并设置 follow-up。
- `StreamingToolExecutor` 与本课 provider streaming 的边界差异。
- `mini-cc` Lesson 04 如何实现最小 streaming adapter。

本文不覆盖：

- 完整 thinking / signature / connector text / server tool use。
- prompt cache、usage、cost、TTFT、stall telemetry 的完整实现。
- 真正边流式边执行工具的并发调度。
- stream watchdog、model fallback 的生产级细节。

## Mental Model

先分清三层：

```text
chunk / stream event
  API 逐个发来的事件，例如 text_delta、input_json_delta

content block
  一段完整 assistant content，例如 text 或 tool_use

assistant message
  本轮模型输出，可以包含多个 content block
```

Streaming provider 做的事是把第一层聚合到第二、第三层：

```text
message_start
-> content_block_start(text)
-> content_block_delta(text_delta)
-> content_block_stop
-> content_block_start(tool_use)
-> content_block_delta(input_json_delta)
-> content_block_stop
-> message_delta(stop_reason)
-> message_stop

=> assistant message:
   content:
     - text(...)
     - tool_use(id, name, input object)
```

关键边界：

- API 层负责拼 chunk。
- Provider adapter 负责把 API block 标准化成内部 `ContentBlock[]`。
- Query loop 不应该理解 SSE、delta 或 partial JSON；它只消费已经成形的 assistant message。
- 工具执行层只在拿到完整 `tool_use.input` 后运行。

## Execution Flow

### 1. Claude Code 主路径发起 streaming Messages 请求

源码确认：

- `src/services/api/claude.ts:1818`：源码注释说明使用 raw stream，避免 `BetaMessageStream` 对每个 `input_json_delta` 做 O(n^2) partial JSON parsing。
- `src/services/api/claude.ts:1822`：调用 `anthropic.beta.messages.create({ ...params, stream: true })`。
- `src/services/api/claude.ts:1857`：拿到 `Stream<BetaRawMessageStreamEvent>`。
- `src/services/api/claude.ts:1940`：通过 `for await (const part of stream)` 消费 stream event。

设计结论：

Claude Code 不依赖 SDK 在流中不断解析半成品 JSON，而是自己把 `input_json_delta.partial_json` 累加起来。这样可以避免大工具输入时的重复解析成本，也让工具输入的最终解析点更明确。

### 2. `content_block_start` 只建立槽位

源码确认：

- `src/services/api/claude.ts:1995`：处理 `content_block_start`。
- `src/services/api/claude.ts:1997`：`tool_use` block 会被写入 `contentBlocks[part.index]`。
- `src/services/api/claude.ts:2000`：`tool_use.input` 初始化为字符串 `''`。
- `src/services/api/claude.ts:2019`：`text` block 也写入 `contentBlocks[part.index]`。
- `src/services/api/claude.ts:2022`：注释说明 start 事件里的 text 可能会和 delta 重复，因此这里把 text 初始化为空字符串。

设计结论：

`content_block_start` 的角色不是“拿到完整内容”，而是告诉 provider：第几个 content block 开始了，它大概是什么类型。真正的文本和工具输入还要从后续 delta 累加。

### 3. `content_block_delta` 才是内容累加点

源码确认：

- `src/services/api/claude.ts:2053`：处理 `content_block_delta`。
- `src/services/api/claude.ts:2054`：先按 `part.index` 找到对应 block。
- `src/services/api/claude.ts:2087`：`input_json_delta` 只能写入 `tool_use` 或 `server_tool_use`。
- `src/services/api/claude.ts:2102`：工具 input 必须仍然是字符串，否则抛错。
- `src/services/api/claude.ts:2111`：把 `delta.partial_json` 追加到 `contentBlock.input`。
- `src/services/api/claude.ts:2113`：`text_delta` 只能写入 `text` block。
- `src/services/api/claude.ts:2125`：把 `delta.text` 追加到 `contentBlock.text`。

设计结论：

这里的类型检查很关键：如果 `input_json_delta` 写进了 text block，或者 text_delta 写进了 tool_use block，说明 stream 协议或本地聚合状态已经错位。Claude Code 会直接抛错，而不是继续构造一个不可信的 tool call。

### 4. `content_block_stop` 形成可 yield 的 assistant message

源码确认：

- `src/services/api/claude.ts:2171`：处理 `content_block_stop`。
- `src/services/api/claude.ts:2172`：按 index 取出已累加的 content block。
- `src/services/api/claude.ts:2192`：构造 `AssistantMessage`。
- `src/services/api/claude.ts:2195`：调用 `normalizeContentFromAPI([contentBlock], tools, options.agentId)`。
- `src/services/api/claude.ts:2209`：把 message 放入 `newMessages`。
- `src/services/api/claude.ts:2210`：立即 `yield m`。

设计结论：

真实 Claude Code 可以在每个 content block 完成时就 yield 一个 assistant message，而不是等整条 message stop。这样 UI 可以更早显示文本，`StreamingToolExecutor` 也可以更早拿到完成的 tool_use block。

### 5. `normalizeContentFromAPI()` 把 streamed input 字符串解析成对象

源码确认：

- `src/utils/messages.ts:2651`：`normalizeContentFromAPI()` 是 API content 标准化入口。
- `src/utils/messages.ts:2661`：对 `tool_use` 单独处理。
- `src/utils/messages.ts:2663`：`contentBlock.input` 必须是字符串或对象。
- `src/utils/messages.ts:2670`：源码注释说明 fine-grained streaming 下 API 返回的是 stringified JSON。
- `src/utils/messages.ts:2676`：当 input 是字符串时调用 `safeParseJSON(contentBlock.input)`。
- `src/utils/messages.ts:2694`：解析失败或空字符串会落到 `{}`。
- `src/utils/messages.ts:2701`：随后按工具做 `normalizeToolInput(...)`。

设计结论：

streaming 下的 `tool_use.input` 在 provider 内部经历了两个形态：

```text
partial_json fragments
-> stringified JSON
-> parsed object
```

工具层不应该接触前两种形态。工具权限、schema 校验和执行都应该面对最终对象。

### 6. `query.ts` 只基于完整 assistant message 决定 follow-up

源码确认：

- `src/query.ts:659`：`deps.callModel(...)` 被作为 async iterable 消费。
- `src/query.ts:823`：未被 withheld 的 message 被 yield 给上层。
- `src/query.ts:826`：只有 `message.type === 'assistant'` 才进入 assistant message 处理。
- `src/query.ts:827`：assistant message 写入 `assistantMessages`。
- `src/query.ts:829`：从 `message.message.content` 中筛选 `tool_use`。
- `src/query.ts:833`：把筛出的 `tool_use` 写入 `toolUseBlocks`。
- `src/query.ts:834`：`needsFollowUp = true`。
- `src/query.ts:1062`：如果没有 `needsFollowUp`，本轮会走结束路径。

设计结论：

Agent loop 的继续条件仍然是 content block，而不是 `stop_reason` 或某个 stream event。Streaming 只是改变了 provider 如何拿到 content block，不改变主 loop 的协议。

### 7. StreamingToolExecutor 是下一层能力，不是 provider 的职责

源码确认：

- `src/query.ts:561`：`config.gates.streamingToolExecution` 决定是否启用 streaming tool execution。
- `src/query.ts:563`：启用时创建 `StreamingToolExecutor`。
- `src/query.ts:841`：每个完成的 `tool_use` block 会调用 `streamingToolExecutor.addTool(...)`。
- `src/services/tools/StreamingToolExecutor.ts:35`：该类负责并发控制。
- `src/services/tools/StreamingToolExecutor.ts:38`：结果按工具接收顺序 buffered 并输出。
- `src/services/tools/StreamingToolExecutor.ts:64`：streaming fallback 时会 discard pending / in-progress tools。
- `src/services/tools/StreamingToolExecutor.ts:453`：`getRemainingResults()` 等待剩余工具并 yield 结果。

设计结论：

Provider streaming 和 streaming tool execution 是两层：

```text
Provider streaming:
  chunk -> content block -> assistant message

Streaming tool execution:
  完成的 tool_use block -> 提前排队执行工具 -> 有序回填 tool_result
```

`mini-cc` Lesson 04 只做第一层。第二层要等 Tool Dispatcher / 并发执行课程再进入。

### 8. Streaming fallback 要处理孤儿消息和孤儿工具结果

源码确认：

- `src/query.ts:678`：`onStreamingFallback` 会设置 `streamingFallbackOccured`。
- `src/query.ts:712`：如果发生 fallback，会处理第一轮 stream 产生的 tool calls。
- `src/query.ts:716`：已 yield 的 partial assistant messages 会 tombstone。
- `src/query.ts:725`：清空 `assistantMessages`。
- `src/query.ts:727`：清空 `toolUseBlocks`。
- `src/query.ts:733`：如果存在 `streamingToolExecutor`，会 `discard()`。
- `src/query.ts:735`：重新创建新的 executor。
- `src/services/api/claude.ts:2308`：stream watchdog abort 后进入 non-streaming retry。
- `src/services/api/claude.ts:2337`：如果 stream 没有产生有效 assistant message，也触发 non-streaming fallback。
- `src/services/api/claude.ts:2551`：fallback 路径调用 `executeNonStreamingRequest(...)`。

设计结论：

一旦 stream 中途失败，系统不能把失败 attempt 的 tool_result 留在 transcript 里。那些 tool_result 的 `tool_use_id` 可能来自已丢弃的 assistant message，会破坏 `tool_use` / `tool_result` 配对。`mini-cc` Lesson 04 暂时没有边流式边执行工具，所以 fallback 只需要重新请求非 streaming；真实 Claude Code 必须额外处理已经 yield 或已经排队执行的对象。

## Reading Path

本轮阅读路径：

1. 从 learning map 的 `Recommended Source Entry` 进入 `src/services/api/claude.ts`。
2. 用 `content_block_start`、`input_json_delta`、`message_delta` 搜索 streaming 事件处理。
3. 读 `queryModelWithStreaming()` 的请求发起、stream 循环和 fallback 片段。
4. 追到 `src/utils/messages.ts:2651`，确认 streamed tool input 最终如何解析。
5. 回到 `src/query.ts`，确认 query loop 只处理 assistant message 和 `tool_use` block。
6. 读 `src/services/tools/StreamingToolExecutor.ts`，明确 provider streaming 与边流式边执行工具的边界。
7. 对照 `mini-cc/src/services/api/anthropicMessages.ts`，决定 Lesson 04 只实现 provider 内聚合。

## Source Evidence

| 源码位置 | 关键事实 |
|---|---|
| `src/services/api/claude.ts:1818` | 使用 raw stream，避免每个 `input_json_delta` 做 O(n^2) partial parsing。 |
| `src/services/api/claude.ts:1822` | 主路径调用 Messages API，并设置 `stream: true`。 |
| `src/services/api/claude.ts:1995` | `content_block_start` 建立 content block 槽位。 |
| `src/services/api/claude.ts:2000` | streaming `tool_use.input` 先初始化为空字符串。 |
| `src/services/api/claude.ts:2022` | text start 里的初始 text 被忽略，以避免重复。 |
| `src/services/api/claude.ts:2087` | `input_json_delta` 只允许进入工具类 block。 |
| `src/services/api/claude.ts:2111` | `partial_json` 被追加到工具 input 字符串。 |
| `src/services/api/claude.ts:2125` | `text_delta` 被追加到 text block。 |
| `src/services/api/claude.ts:2171` | `content_block_stop` 时构造 assistant message。 |
| `src/services/api/claude.ts:2195` | 每个完成 block 都经过 `normalizeContentFromAPI()`。 |
| `src/utils/messages.ts:2676` | stringified tool input 用 `safeParseJSON()` 解析。 |
| `src/query.ts:829` | query loop 从 assistant content 中筛选 `tool_use`。 |
| `src/query.ts:834` | 发现 `tool_use` 后设置 `needsFollowUp = true`。 |
| `src/services/tools/StreamingToolExecutor.ts:64` | fallback 时 pending / in-progress 工具结果要被 discard。 |

## Build-Along Derivation

Lesson 04 在 `mini-cc` 中保留这些边界：

| Claude Code 边界 | mini-cc 对应 | 本课取舍 |
|---|---|---|
| REPL / SDK 入口复用 provider | `mini-cc/src/main.ts`、`mini-cc/src/QueryEngine.ts` | 从既有应用入口进入 L04，不新增 CLI。 |
| `src/services/api/claude.ts` | `mini-cc/src/services/api/anthropicMessages.ts` | 在 provider 内部解析 SSE。 |
| raw stream event | `parseSSE()` / `applyStreamEvent()` | 只处理 text 和 tool_use 主线。 |
| `input_json_delta` 累加 | `StreamingBlock.inputJson` | 先保存字符串，完成后解析成对象。 |
| `normalizeContentFromAPI()` | `finalizeStreamingContent()` | 只保留空字符串 `{}` fallback，不做工具特定 normalize。 |
| `query.ts` 消费 assistant message | `mini-cc/src/query.ts` | 主 loop 不解析 chunk，只等完整 `ContentBlock[]`。 |
| streaming fallback | `createMessage()` catch 后调用非 streaming | mini-cc 尚未提前 yield partial message，所以不需要 tombstone / discard。 |

### 补充：L04-S08 的 `blocks` 是引用吗？

是。`mini-cc/src/services/api/anthropicMessages.ts:359` 调用：

```ts
const eventStopReason = applyStreamEvent(blocks, event);
```

这里传入的 `blocks` 是同一个数组对象的引用。JavaScript/TypeScript 的规则更准确地说是“参数按值传递，但对象值本身是引用”：`applyStreamEvent()` 收到的是指向同一个数组对象的引用副本。

所以在 `applyStreamEvent(blocks, event)` 里做这些操作，会影响外层 `createStreamingMessage()` 中的同一个 `blocks`：

```ts
blocks[event.index] = { type: "text", text: "" };
block.text += event.delta.text;
block.inputJson += event.delta.partial_json;
```

但如果在 helper 里写：

```ts
blocks = [];
```

这只会让 helper 的局部参数指向新数组，不会改变外层变量。也就是说，本课依赖的是“原地修改数组槽位和数组里的 block 对象”，不是让 helper 替换外层 `blocks` 变量。

`eventStopReason` 之所以要通过返回值传回，是因为 `stopReason` 是外层的局部变量，不在 `applyStreamEvent()` 的参数里；对这种标量状态，用返回值比让 helper 隐式修改外层状态更清楚。

## Verification

已用假 SSE stream 验证最小聚合路径：

```text
text_delta("准备查看")
input_json_delta('{"command"')
input_json_delta(':"dir"}')
message_delta(stop_reason="tool_use")

=> content:
   text("准备查看")
   tool_use(name="bash", input={ command: "dir" })
```

验证命令：

```powershell
Set-Location C:\dev\workspace\hope-cc\mini-cc
node --experimental-strip-types --input-type=module -
```

运行结果：

```text
stream aggregation ok
```

同时验证了 streaming 失败后会回退非 streaming：

```text
stream fallback ok
[stream:fallback] Anthropic streaming API error 500: bad stream; retrying without streaming.
```

关键模块导入也通过：

```text
module imports ok
```

最后验证了 streaming provider 能驱动既有 query loop 完成工具闭环：

```text
[turn 1] call model
[tool:bash] {"command":"node --version"} -> v22.16.0

[turn 2] call model
[assistant]
工具结果已收到。
[loop] no tool_use; stop
streaming query loop ok
```

## 源码确认 / 合理推断 / 待验证

### 源码确认

- Claude Code 主路径使用 `stream: true` 的 Messages API。
- `tool_use.input` 在 streaming 聚合阶段先是字符串。
- `input_json_delta.partial_json` 会被追加到该字符串。
- `content_block_stop` 时会构造 assistant message 并 yield。
- `normalizeContentFromAPI()` 负责把 stringified input 解析成对象。
- `query.ts` 通过 assistant content 中的 `tool_use` 判断是否需要 follow-up。
- streaming fallback 会清掉旧 attempt 的 assistant messages / tool uses，并 discard executor。

### 合理推断

- Claude Code 选择 raw stream 的一个核心工程动机是控制工具输入解析成本和时机；源码注释明确提到避免 O(n^2) partial parsing，但更完整的性能收益还和大工具输入、fine-grained tool streaming 相关。
- `content_block_stop` 级别 yield 让 UI 和 streaming tool execution 都可以更早消费完成块；这比等 `message_stop` 更适合 coding agent。

### 待验证

- `eager_input_streaming` 在不同代理 / Bedrock / Vertex 下的兼容性差异需要单独实验。
- `StreamingToolExecutor` 的并发安全分组和结果排序还需要后续课程继续读源码。
- stream watchdog 与 fallback 在真实网络中断时的具体用户可见表现，需要 `cc-practice-lab` 做实验。
