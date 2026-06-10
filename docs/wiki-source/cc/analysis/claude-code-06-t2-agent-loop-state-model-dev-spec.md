# Claude Code 06-T2 技术文档：Agent Loop State Model 源码事实版

## 如何阅读本文

本文只描述 Claude Code 源码里的 agent loop state model。它不替其他系统做适配，不使用 hope-agent 的字段名，也不提前设计外部系统的数据结构。

本文里的类型、字段、变量名尽量保持 Claude Code 源码原名。只有一个例外：Claude Code 没有单独定义 `IterationScratch` 类型，因此本文不会把它当成源码类型；本文只称它为 “iteration-local variables”，并逐一列出源码局部变量。

快速阅读路径：

- 先读 §0 和 §1，理解 Claude Code 的状态分层。
- 再读 §2 到 §7，看 `queryLoop()` 每轮如何推进 `State`。
- 最后读 §8 到 §12，看 provider、tool、pairing、recovery、budget 的边界。

源码主线：

- `src/query.ts`：`QueryParams`、`State`、`queryLoop()`。
- `src/Tool.ts`：`ToolUseContext` 和 `Tool.call()`。
- `src/services/api/claude.ts`：provider request 与 stream chunk 聚合。
- `src/utils/messages.ts`：`normalizeMessagesForAPI()`、`ensureToolResultPairing()`。
- `src/utils/toolResultStorage.ts`：tool result budget 与 `contentReplacementState`。
- `src/query/stopHooks.ts`：无工具调用后的 stop hook continuation。

## Learning Question

本文回答：

```text
Claude Code 的 queryLoop() 到底携带哪些状态？
这些状态如何从 query() 入口进入 loop，
如何在每次模型调用前投影成 messagesForQuery，
又如何在 assistant tool_use / user tool_result 后写回下一轮 State？
```

## Scope

本文覆盖：

- `QueryParams` 的入口字段。
- `State` 的跨 iteration 字段。
- 每轮 `while (true)` 内的局部变量。
- `messages`、`messagesForQuery`、provider API messages 的差异。
- `toolUseContext` 的源码字段和职责。
- `tool_use` / `tool_result` 配对。
- 无工具调用、工具调用、fallback、abort、prompt-too-long、max output、stop hook、token budget 的 state update。

本文不覆盖：

- 单个工具内部行为。
- permission pipeline 的完整判定树。
- compaction、microcompact、context collapse 的完整算法。
- session storage / resume 的全部 schema。
- 外部 Web 后端、数据库或产品形态适配。

## 0. 核心结论

Claude Code 的 agent loop state 是三层，但源码只显式命名了前两层：

```text
QueryParams
  query() / queryLoop() 的入口参数
  messages / systemPrompt / userContext / systemContext
  canUseTool / toolUseContext / fallbackModel / maxTurns / taskBudget / deps

State
  queryLoop() 跨 while iteration 携带的 mutable state
  messages / toolUseContext / compact tracking / recovery flags
  pendingToolUseSummary / stopHookActive / turnCount / transition

iteration-local variables
  每次 while(true) 内部新建或重建的局部变量
  messagesForQuery / assistantMessages / toolResults / toolUseBlocks
  needsFollowUp / streamingToolExecutor / currentModel 等
```

源码确认：

- `QueryParams` 定义在 `src/query.ts:181`。
- `State` 定义在 `src/query.ts:203`，注释是 “Mutable state carried between loop iterations”。
- `state` 初始化在 `src/query.ts:268`，`turnCount` 初始为 1。
- 每轮顶部从 `state` 解构字段在 `src/query.ts:307`。
- 每轮局部数组 `assistantMessages`、`toolResults`、`toolUseBlocks`、`needsFollowUp` 定义在 `src/query.ts:551`。
- 有工具调用时，下一轮 `state.messages` 被设置为 `messagesForQuery + assistantMessages + toolResults`，见 `src/query.ts:1715`。

最重要的事实：

```text
state.messages 是 loop 当前事实源。
messagesForQuery 是本轮模型调用前从 state.messages 投影出来的视图。
provider API messages 是 normalizeMessagesForAPI(messagesForQuery, tools) 后的 wire 形态。
```

这三者在 Claude Code 源码里不是同一个东西。

## 1. QueryParams：query() 的入口状态

`QueryParams` 是 `query()` / `queryLoop()` 的入口参数。源码字段如下：

```ts
export type QueryParams = {
  messages: Message[]
  systemPrompt: SystemPrompt
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
  canUseTool: CanUseToolFn
  toolUseContext: ToolUseContext
  fallbackModel?: string
  querySource: QuerySource
  maxOutputTokensOverride?: number
  maxTurns?: number
  skipCacheWrite?: boolean
  taskBudget?: { total: number }
  deps?: QueryDeps
}
```

源码位置：`src/query.ts:181`。

字段含义：

| 字段 | 源码事实 |
|---|---|
| `messages` | 进入本次 query 的初始 message 数组，后续成为 `State.messages` 初值。 |
| `systemPrompt` | provider request 的 system prompt 基础内容。 |
| `userContext` | 每轮请求时会通过 provider request 构建逻辑注入，不是 `State.messages` 顶层字段。 |
| `systemContext` | 会追加进 effective system prompt。 |
| `canUseTool` | 工具执行前权限函数，传给 `runTools()` / `Tool.call()` 链路。 |
| `toolUseContext` | 工具运行时上下文，进入 `State.toolUseContext`。 |
| `fallbackModel` | provider fallback 时可切换的模型。 |
| `querySource` | 区分 REPL、SDK、agent 等入口，影响持久化、analytics、context 行为。 |
| `maxOutputTokensOverride` | max output retry / escalation 的入口覆盖。 |
| `maxTurns` | agentic turn 内最多允许多少次模型调用路径。 |
| `taskBudget` | API task budget，注释明确它不同于 tokenBudget auto-continue。 |
| `deps` | 注入 provider、microcompact、autocompact、uuid 等依赖。 |

`QueryParams` 本身不是跨 iteration 可变状态。`queryLoop()` 进入后会把其中一部分复制进 `State`。

## 2. State：queryLoop() 跨 iteration 状态

`State` 源码定义：

```ts
type State = {
  messages: Message[]
  toolUseContext: ToolUseContext
  autoCompactTracking: AutoCompactTrackingState | undefined
  maxOutputTokensRecoveryCount: number
  hasAttemptedReactiveCompact: boolean
  maxOutputTokensOverride: number | undefined
  pendingToolUseSummary: Promise<ToolUseSummaryMessage | null> | undefined
  stopHookActive: boolean | undefined
  turnCount: number
  transition: Continue | undefined
}
```

源码位置：`src/query.ts:203`。

初始化：

```ts
let state: State = {
  messages: params.messages,
  toolUseContext: params.toolUseContext,
  maxOutputTokensOverride: params.maxOutputTokensOverride,
  autoCompactTracking: undefined,
  stopHookActive: undefined,
  maxOutputTokensRecoveryCount: 0,
  hasAttemptedReactiveCompact: false,
  turnCount: 1,
  pendingToolUseSummary: undefined,
  transition: undefined,
}
```

源码位置：`src/query.ts:268`。

字段职责：

| 字段 | 生命周期 | 源码事实 |
|---|---|---|
| `messages` | 跨 loop iteration | 当前 loop 的 message 事实源。每轮 provider 前从它投影出 `messagesForQuery`。 |
| `toolUseContext` | 跨 loop iteration | 工具 runtime；每轮会把 `messagesForQuery` 写入 `toolUseContext.messages`。 |
| `autoCompactTracking` | 跨 loop iteration | autocompact 的 turn counter / failure tracking。 |
| `maxOutputTokensRecoveryCount` | 当前 agentic turn | max output recovery 次数。 |
| `hasAttemptedReactiveCompact` | 当前 overflow recovery 路径 | 防止 reactive compact 无限重试。 |
| `maxOutputTokensOverride` | 某次 retry | max output escalation 的临时输出上限。 |
| `pendingToolUseSummary` | 下一轮 side channel | 工具批次后异步生成的 summary Promise。 |
| `stopHookActive` | stop hook retry 路径 | 防止 stop hook blocking 路径递归失控。 |
| `turnCount` | agentic turn | 初始 1；有工具结果并准备下一轮 provider call 时递增。 |
| `transition` | 跨 iteration diagnostics / guard | 记录上一轮为什么 `continue`。 |

## 3. while iteration 顶部：读取 State，生成 queryTracking

每次 `while (true)` 顶部，Claude Code 先重新绑定本轮变量：

```ts
let { toolUseContext } = state
const {
  messages,
  autoCompactTracking,
  maxOutputTokensRecoveryCount,
  hasAttemptedReactiveCompact,
  maxOutputTokensOverride,
  pendingToolUseSummary,
  stopHookActive,
  turnCount,
} = state
```

源码位置：`src/query.ts:307`。

然后生成或递增 `queryTracking`：

- 若已有 `toolUseContext.queryTracking`，复用 `chainId` 并将 `depth + 1`。
- 否则创建新的 `chainId` 和 `depth = 0`。
- 再写回本轮局部 `toolUseContext`。

源码位置：`src/query.ts:346` 到 `:363`。

注意：这里不是直接修改 `state.toolUseContext`，而是本轮局部变量先变更；只有 continue site 才写回新的 `state`。

## 4. messages 与 messagesForQuery：事实源和投影视图

Claude Code 每轮模型调用前不会直接把 `state.messages` 发给 provider。它先生成 `messagesForQuery`：

```ts
let messagesForQuery = [...getMessagesAfterCompactBoundary(messages)]
```

源码位置：`src/query.ts:365`。

随后依次处理：

1. `applyToolResultBudget()`：`src/query.ts:369`。
2. `snipCompactIfNeeded()`：`src/query.ts:396`。
3. `deps.microcompact()`：`src/query.ts:412`。
4. `contextCollapse.applyCollapsesIfNeeded()`：`src/query.ts:428`。
5. `deps.autocompact()`：`src/query.ts:453`。

如果 autocompact 成功：

- `buildPostCompactMessages(compactionResult)` 生成 post-compact messages。
- 这些 message 会被 yield。
- 本轮 `messagesForQuery` 被替换为 `postCompactMessages`。

源码位置：`src/query.ts:528` 到 `:535`。

最后，Claude Code 把本轮投影视图写入工具上下文：

```ts
toolUseContext = {
  ...toolUseContext,
  messages: messagesForQuery,
}
```

源码位置：`src/query.ts:545`。

源码事实结论：

```text
State.messages
  是 loop 当前事实源。

messagesForQuery
  是每轮模型请求前从 State.messages 生成的读时视图。

toolUseContext.messages
  每轮被设置成 messagesForQuery，让工具和权限逻辑看到本轮 API 视图。
```

## 5. iteration-local variables：源码局部状态

Claude Code 没有定义 `IterationScratch` 类型。它在每轮 `while` 内直接创建局部变量：

```ts
const assistantMessages: AssistantMessage[] = []
const toolResults: (UserMessage | AttachmentMessage)[] = []
const toolUseBlocks: ToolUseBlock[] = []
let needsFollowUp = false
```

源码位置：`src/query.ts:551`。

这些局部变量的职责：

| 局部变量 | 职责 |
|---|---|
| `assistantMessages` | 收集本轮 provider stream 产出的 assistant messages。 |
| `toolResults` | 收集工具执行结果和后续 attachment，最终作为 user-side messages 进入下一轮。 |
| `toolUseBlocks` | 从 assistant content 中筛出的本轮工具调用。 |
| `needsFollowUp` | 是否需要执行工具并进入下一轮。 |
| `streamingToolExecutor` | 可选的 streaming tool executor；只属于本轮 provider/tool 执行期。 |
| `currentModel` | 本轮 provider call 使用的模型，fallback 时可切换。 |
| `attemptWithFallback` | fallback attempt 控制。 |

这些局部变量不会作为持久状态保存。fallback、abort、retry 时会清理或丢弃它们。

## 6. tool_use 是唯一可靠继续信号

Claude Code 明确不信任 `stop_reason === "tool_use"`：

```ts
// Note: stop_reason === 'tool_use' is unreliable -- it's not always set correctly.
```

源码位置：`src/query.ts:553`。

真实继续条件来自 assistant content block：

```ts
if (message.type === 'assistant') {
  assistantMessages.push(message)

  const msgToolUseBlocks = message.message.content.filter(
    content => content.type === 'tool_use',
  ) as ToolUseBlock[]

  if (msgToolUseBlocks.length > 0) {
    toolUseBlocks.push(...msgToolUseBlocks)
    needsFollowUp = true
  }
}
```

源码位置：`src/query.ts:826` 到 `:835`。

如果启用 `streamingToolExecutor`，每个 `tool_use` block 会被提前加入 executor：

```ts
streamingToolExecutor.addTool(toolBlock, message)
```

源码位置：`src/query.ts:837` 到 `:843`。

## 7. Provider stream：raw chunk 到 AssistantMessage

Claude Code 的 provider adapter 是 `queryModelWithStreaming()`：

```ts
export async function* queryModelWithStreaming({
  messages,
  systemPrompt,
  thinkingConfig,
  tools,
  signal,
  options,
})
```

源码位置：`src/services/api/claude.ts:752`。

provider 层用 raw stream，而不是把 partial JSON parser 暴露给 loop：

```ts
// Use raw stream instead of BetaMessageStream to avoid O(n²) partial JSON parsing
```

源码位置：`src/services/api/claude.ts:1818`。

stream 处理事实：

- `content_block_start` 初始化 content block slot。
- `input_json_delta` 累积到 tool input 字符串。
- `text_delta` 累积 text。
- `thinking_delta` 累积 thinking。
- `signature_delta` 写入 thinking signature。
- `content_block_stop` 时调用 `normalizeContentFromAPI()`，生成完整 `AssistantMessage` 并 yield。

关键源码位置：

- `content_block_start`：`src/services/api/claude.ts:1995`。
- `input_json_delta`：`src/services/api/claude.ts:2087`。
- `content_block_stop` 生成 `AssistantMessage`：`src/services/api/claude.ts:2171`。

源码事实结论：

```text
queryLoop() 消费的是 AssistantMessage，不直接消费 provider raw delta。
tool_use.input 的 partial JSON 聚合属于 provider adapter。
```

## 8. 无工具调用路径：recovery / hooks / completed

如果 stream 结束后 `needsFollowUp === false`，Claude Code 不会立刻 completed。它先处理多种 continuation：

```ts
if (!needsFollowUp) {
  ...
}
```

源码位置：`src/query.ts:1062`。

### 8.1 prompt-too-long / media recovery

如果最后一条 assistant 是 withheld 413：

1. 先尝试 context collapse drain retry。
2. 再尝试 reactive compact。
3. 如果恢复失败，yield withheld error 并返回。

关键源码：

- withheld 413 判断：`src/query.ts:1070`。
- collapse drain retry：`src/query.ts:1090` 到 `:1115`。
- reactive compact retry：`src/query.ts:1119` 到 `:1165`。
- recovery 失败返回：`src/query.ts:1168` 到 `:1175`。

对应 `State` 更新：

- collapse drain retry 会设置 `messages = drained.messages`，`transition = { reason: 'collapse_drain_retry', committed }`。
- reactive compact retry 会设置 `messages = postCompactMessages`，`hasAttemptedReactiveCompact = true`，`transition = { reason: 'reactive_compact_retry' }`。

### 8.2 max output tokens recovery

如果命中 max output tokens：

1. 可先做 max output escalation：设置 `maxOutputTokensOverride = ESCALATED_MAX_TOKENS`，`messages = messagesForQuery`，然后 `continue`。
2. 如果仍需要恢复，则注入 meta user recovery message，`maxOutputTokensRecoveryCount + 1`，然后 `continue`。
3. 超过恢复上限后 surface withheld error。

关键源码：

- max output 判断：`src/query.ts:1188`。
- escalation state：`src/query.ts:1207`。
- recovery message state：`src/query.ts:1231`。

### 8.3 API error 不跑 stop hooks

如果最后 message 是 API error：

```ts
if (lastMessage?.isApiErrorMessage) {
  void executeStopFailureHooks(lastMessage, toolUseContext)
  return { reason: 'completed' }
}
```

源码位置：`src/query.ts:1258`。

注释说明原因：API error 不是有效模型回答，跑 stop hooks 会形成 error -> hook blocking -> retry -> error 的循环。

### 8.4 stop hook blocking

Claude Code 调用：

```ts
const stopHookResult = yield* handleStopHooks(...)
```

源码位置：`src/query.ts:1267`。

如果 hook 返回 blocking errors：

```ts
state = {
  messages: [
    ...messagesForQuery,
    ...assistantMessages,
    ...stopHookResult.blockingErrors,
  ],
  stopHookActive: true,
  transition: { reason: 'stop_hook_blocking' },
  ...
}
continue
```

源码位置：`src/query.ts:1282` 到 `:1305`。

`handleStopHooks()` 本身用 `messagesForQuery + assistantMessages` 构造 hook context，源码位置：`src/query/stopHooks.ts:84`。

### 8.5 token budget continuation

如果 feature gate 开启 token budget，且 `checkTokenBudget()` 返回 continue：

```ts
state = {
  messages: [
    ...messagesForQuery,
    ...assistantMessages,
    createUserMessage({
      content: decision.nudgeMessage,
      isMeta: true,
    }),
  ],
  transition: { reason: 'token_budget_continuation' },
  ...
}
continue
```

源码位置：`src/query.ts:1308` 到 `:1340`。

### 8.6 completed

所有 continuation 都没有触发时：

```ts
return { reason: 'completed' }
```

源码位置：`src/query.ts:1357`。

## 9. 有工具调用路径：runTools、toolResults、下一轮 State

如果 `needsFollowUp === true`，Claude Code 执行工具：

```ts
const toolUpdates = streamingToolExecutor
  ? streamingToolExecutor.getRemainingResults()
  : runTools(toolUseBlocks, assistantMessages, canUseTool, toolUseContext)
```

源码位置：`src/query.ts:1380`。

每个 tool update：

- 如果有 `update.message`，先 yield。
- 再调用 `normalizeMessagesForAPI([update.message], tools)`，筛出 user message 后 push 到 `toolResults`。
- 如果有 `update.newContext`，更新 `updatedToolUseContext`。

源码位置：`src/query.ts:1384` 到 `:1407`。

工具批次后，Claude Code 还会处理：

- `pendingToolUseSummary`：`src/query.ts:1411`。
- abort during tools：`src/query.ts:1484`。
- hook stopped continuation：`src/query.ts:1518`。
- queued commands / attachments：`src/query.ts:1535` 到 `:1589`。
- memory prefetch attachment：`src/query.ts:1592`。
- skill discovery attachment：`src/query.ts:1617`。
- `refreshTools()`：`src/query.ts:1659`。

特别注意 `src/query.ts:1535` 的注释：

```text
Be careful to do this after tool calls are done, because the API
will error if we interleave tool_result messages with regular user messages.
```

### 9.1 turnCount 与 maxTurns

工具结果准备好后，Claude Code 计算：

```ts
const nextTurnCount = turnCount + 1
```

源码位置：`src/query.ts:1678`。

如果 `maxTurns && nextTurnCount > maxTurns`：

- yield `max_turns_reached` attachment。
- return `{ reason: 'max_turns', turnCount: nextTurnCount }`。

源码位置：`src/query.ts:1704`。

这说明：

```text
maxTurns 限制的是“是否允许进入下一轮 provider call”。
第一轮产生 tool_use 后，工具可以执行；超限发生在准备第二轮 provider call 前。
```

### 9.2 下一轮 State 写回

未超限时，Claude Code 构造下一轮 state：

```ts
const next: State = {
  messages: [...messagesForQuery, ...assistantMessages, ...toolResults],
  toolUseContext: toolUseContextWithQueryTracking,
  autoCompactTracking: tracking,
  turnCount: nextTurnCount,
  maxOutputTokensRecoveryCount: 0,
  hasAttemptedReactiveCompact: false,
  pendingToolUseSummary: nextPendingToolUseSummary,
  maxOutputTokensOverride: undefined,
  stopHookActive,
  transition: { reason: 'next_turn' },
}
state = next
```

源码位置：`src/query.ts:1715` 到 `:1727`。

这是 Claude Code agent loop state model 的核心 reducer 事实：

```text
下一轮 State.messages =
  本轮 provider 前投影视图 messagesForQuery
  + 本轮 assistant messages
  + 本轮 user-side tool results / attachments
```

## 10. fallback / abort / exception 的状态处理

### 10.1 streaming fallback

如果 streaming fallback 发生，Claude Code 会：

- tombstone 已 yield 的 orphan assistant messages。
- 清空 `assistantMessages`、`toolResults`、`toolUseBlocks`。
- `needsFollowUp = false`。
- discard 旧 `streamingToolExecutor` 并新建。

源码位置：`src/query.ts:709` 到 `:740`。

注释说明：旧 attempt 的 partial messages，尤其 thinking blocks，可能有 invalid signatures；旧 tool result 也不能泄漏到 fallback response。

### 10.2 model fallback

如果抛出 `FallbackTriggeredError` 且有 `fallbackModel`：

- 切换 `currentModel`。
- `yieldMissingToolResultBlocks(assistantMessages, 'Model fallback triggered')`。
- 清空本轮 scratch。
- discard executor。
- 更新 `toolUseContext.options.mainLoopModel`。
- 对内部用户可 strip thinking signature。
- yield system warning。
- `continue` 重试同一轮 provider call。

源码位置：`src/query.ts:893` 到 `:950`。

### 10.3 query exception

如果 provider / loop 内部异常：

- log。
- 为已出现的 tool use 补 missing tool result。
- yield synthetic assistant API error message。
- return `{ reason: 'model_error', error }`。

源码位置：`src/query.ts:955` 到 `:996`。

### 10.4 streaming abort

如果 abort 发生在 streaming 阶段：

- streaming executor 路径 consume `getRemainingResults()`，让 executor 生成 synthetic tool results。
- 非 executor 路径调用 `yieldMissingToolResultBlocks()`。
- yield user interruption message。
- return `{ reason: 'aborted_streaming' }`。

源码位置：`src/query.ts:1011` 到 `:1051`。

### 10.5 tool abort

如果 abort 发生在工具执行期间：

- yield tool-use interruption message。
- 可检查 maxTurns 并 yield max-turns attachment。
- return `{ reason: 'aborted_tools' }`。

源码位置：`src/query.ts:1484` 到 `:1515`。

## 11. ToolUseContext：工具运行时上下文

`ToolUseContext` 定义在 `src/Tool.ts:158`。它是一个宽对象，不只是 tool registry。

关键字段类别：

| 类别 | 字段 |
|---|---|
| 工具和模型选项 | `options.commands`、`options.mainLoopModel`、`options.tools`、`options.thinkingConfig`、`options.mcpClients`、`options.mcpResources`、`options.agentDefinitions`、`options.refreshTools` |
| 中断控制 | `abortController` |
| 文件和内容状态 | `readFileState`、`contentReplacementState` |
| App state | `getAppState()`、`setAppState()`、`setAppStateForTasks` |
| UI / SDK callbacks | `setToolJSX`、`addNotification`、`setSDKStatus`、`setStreamMode`、`requestPrompt` |
| session / agent identity | `agentId`、`agentType`、`toolUseId` |
| query tracking | `queryTracking` |
| permission / decisions | `toolDecisions`、`localDenialTracking`、`requireCanUseTool` |
| provider-visible messages view | `messages` |

工具调用签名：

```ts
call(
  args,
  context: ToolUseContext,
  canUseTool: CanUseToolFn,
  parentMessage: AssistantMessage,
  onProgress?: ToolCallProgress,
): Promise<ToolResult>
```

源码位置：`src/Tool.ts:379`。

源码事实边界：

- 工具执行看到的 `context.messages` 是本轮 `messagesForQuery`。
- 工具可以返回 `newContext`，由 query loop 在 tool update 消费时更新。
- 工具不直接写 `State.messages`；query loop 收集 tool update 后统一写入下一轮 state。
- callbacks、abort controller、UI 状态属于运行期对象，不是 transcript message。

## 12. Provider normalization 与 pairing guard

provider 层在发送 API 前执行：

```ts
let messagesForAPI = normalizeMessagesForAPI(messages, filteredTools)
...
messagesForAPI = ensureToolResultPairing(messagesForAPI)
```

源码位置：`src/services/api/claude.ts:1266`、`src/services/api/claude.ts:1298`。

`normalizeMessagesForAPI()` 定义在 `src/utils/messages.ts:1989`，它会处理：

- attachment reorder。
- virtual messages stripping。
- user / assistant message normalization。
- tool search / media / provider 兼容字段。
- 连续 user message 合并等 provider API 形态问题。

`hoistToolResults()` 会把 user message content 中的 `tool_result` blocks 提到前面，避免 provider 报 tool result 顺序错误。源码位置：`src/utils/messages.ts:2466`。

`ensureToolResultPairing()` 定义在 `src/utils/messages.ts:5119`，注释明确处理两类方向：

- Forward：给缺失 result 的 `tool_use` 插入 synthetic error `tool_result`。
- Reverse：移除引用不存在 tool use 的 orphan `tool_result`。

它还处理：

- duplicate `tool_use.id`。
- duplicate `tool_result.tool_use_id`。
- user message 起始处 orphan tool result。
- server-side tool use / tool result pairing。
- strict mode 下直接 throw，而不是 repair。

源码事实结论：

```text
provider API messages 是 normalize + pairing guard 后的请求形态。
这一步不是 State.messages 本身。
pairing repair 是 provider boundary 的防线，不是普通业务逻辑。
```

## 13. tool result budget 与 contentReplacementState

tool result budget 发生在 `messagesForQuery` 投影阶段，并且先于 microcompact：

```ts
messagesForQuery = await applyToolResultBudget(...)
```

源码位置：`src/query.ts:369`。

底层 `enforceToolResultBudget()` 的关键事实：

- 按 API-level user message 分组，而不是单个 internal message 分组。
- 因为 `normalizeMessagesForAPI()` 会合并连续 user messages。
- 每个 `tool_use_id` 的 fate 会被冻结：
  - 已替换的结果下一轮复用相同 replacement。
  - 已见过但未替换的结果后续不会再替换。
- 这样做是为了保持 prompt cache 稳定。
- 新 replacement records 可以返回给调用方持久化，用于 resume 重建。

源码依据：

- group by API-level user message 的注释：`src/utils/toolResultStorage.ts:575`。
- fate frozen 注释：`src/utils/toolResultStorage.ts:742`。
- `ContentReplacementState` 被 mutation 的注释：`src/utils/toolResultStorage.ts:759`。
- replacement 修改 user `tool_result.content`：`src/utils/toolResultStorage.ts:695`。

`ToolUseContext` 中对应字段是：

```ts
contentReplacementState?: ContentReplacementState
```

源码位置：`src/Tool.ts:285`。

## 14. transition 的源码枚举事实

`transition` 字段类型是 `Continue | undefined`，源码注释是：

```ts
// Why the previous iteration continued. Undefined on first iteration.
// Lets tests assert recovery paths fired without inspecting message contents.
```

源码位置：`src/query.ts:214`。

当前读取到的 transition reason 包括：

| reason | 写入位置 | 含义 |
|---|---|---|
| `collapse_drain_retry` | `src/query.ts:1109` | prompt-too-long 后先 drain context collapse。 |
| `reactive_compact_retry` | `src/query.ts:1162` | reactive compact 成功后重试。 |
| `max_output_tokens_escalate` | `src/query.ts:1217` | 输出 token 上限升级后重试。 |
| `max_output_tokens_recovery` | `src/query.ts:1246` | 注入恢复 message 后继续。 |
| `stop_hook_blocking` | `src/query.ts:1302` | stop hook 返回 blocking errors 后继续。 |
| `token_budget_continuation` | `src/query.ts:1338` | token budget 要求继续。 |
| `next_turn` | `src/query.ts:1725` | 工具结果已准备好，进入下一轮 provider call。 |

源码事实结论：

```text
transition 不等同于 error recovery。
正常工具调用后的 next_turn 也写 transition。
```

## 15. turnCount 与 maxTurns

源码事实：

- `turnCount` 初始化为 1：`src/query.ts:276`。
- 有工具结果并准备下一轮 provider call 时，`nextTurnCount = turnCount + 1`：`src/query.ts:1678`。
- max turns 检查发生在工具执行和 attachments 处理之后、下一轮 state 写回之前：`src/query.ts:1704`。

语义：

```text
turnCount = 1
  表示当前路径将发起第一次 provider call。

nextTurnCount = 2
  表示第一轮 provider call 已产生 tool_use，
  工具结果已准备好，
  正准备发起第二次 provider call。
```

如果 `maxTurns = 1`：

- 第一轮 provider call 可以发生。
- 第一轮产生的 tool use 可以执行。
- 工具结果可以被收集。
- 但在准备第二轮 provider call 前，`nextTurnCount > maxTurns`，loop 返回 `max_turns`。

## 16. Claude Code 06-T2 的源码事实验收清单

如果要判断一个实现是否符合 Claude Code 当前源码事实，至少检查：

- 是否有 `QueryParams.messages` 作为进入 loop 的初始 messages。
- 是否有跨 iteration `State.messages`。
- 是否每轮从 `State.messages` 生成 `messagesForQuery`。
- 是否每轮把 `toolUseContext.messages` 设置成 `messagesForQuery`。
- 是否只通过 assistant content 中的 `tool_use` 判断 `needsFollowUp`。
- 是否不依赖 `stop_reason === "tool_use"`。
- 是否将本轮 assistant messages 放入 `assistantMessages`。
- 是否将工具执行产物 normalize 后放入 `toolResults`。
- 是否在有工具调用的 continue site 写入 `messages = messagesForQuery + assistantMessages + toolResults`。
- 是否在工具结果已准备好、下一轮 provider call 前递增 `turnCount`。
- 是否在 provider boundary 运行 `normalizeMessagesForAPI()`。
- 是否在 provider boundary 运行 `ensureToolResultPairing()`。
- 是否在 fallback / exception / abort 时补齐 missing tool result 或丢弃旧 attempt。
- 是否把 max output、reactive compact、stop hook、token budget continuation 写成 `State` 更新，而不是塞进普通 assistant 文本。
- 是否让 `contentReplacementState` 按 tool_use_id 冻结 tool result replacement 决策。

## 附录 A：源码依据

| 源码位置 | 确认事实 |
|---|---|
| `src/query.ts:181` | `QueryParams` 字段。 |
| `src/query.ts:203` | `State` 字段。 |
| `src/query.ts:214` | `transition` 字段注释。 |
| `src/query.ts:268` | 初始化 `state`。 |
| `src/query.ts:307` | 每轮顶部解构 `state`。 |
| `src/query.ts:346` | 生成 / 递增 `queryTracking`。 |
| `src/query.ts:365` | `messagesForQuery` 从 compact boundary 后生成。 |
| `src/query.ts:369` | tool result budget。 |
| `src/query.ts:396` | history snip。 |
| `src/query.ts:412` | microcompact。 |
| `src/query.ts:428` | context collapse。 |
| `src/query.ts:453` | autocompact。 |
| `src/query.ts:545` | `toolUseContext.messages = messagesForQuery`。 |
| `src/query.ts:551` | iteration-local arrays。 |
| `src/query.ts:553` | `stop_reason === "tool_use"` 不可靠。 |
| `src/query.ts:709` | streaming fallback 清理 scratch / tombstone。 |
| `src/query.ts:826` | assistant message 进入 `assistantMessages`。 |
| `src/query.ts:829` | 扫描 `tool_use`。 |
| `src/query.ts:893` | model fallback 清理旧 attempt。 |
| `src/query.ts:980` | query exception 补 missing tool result。 |
| `src/query.ts:1011` | streaming abort 补 tool result / interruption。 |
| `src/query.ts:1062` | 无工具调用分支。 |
| `src/query.ts:1099` | collapse drain retry state。 |
| `src/query.ts:1152` | reactive compact retry state。 |
| `src/query.ts:1207` | max output escalation state。 |
| `src/query.ts:1231` | max output recovery state。 |
| `src/query.ts:1282` | stop hook blocking state。 |
| `src/query.ts:1321` | token budget continuation state。 |
| `src/query.ts:1357` | completed return。 |
| `src/query.ts:1380` | 选择 streaming executor 或 `runTools()`。 |
| `src/query.ts:1395` | tool update normalize 后进入 `toolResults`。 |
| `src/query.ts:1411` | pending tool use summary。 |
| `src/query.ts:1535` | tool result 与普通 user message 不可交错。 |
| `src/query.ts:1659` | refresh tools。 |
| `src/query.ts:1678` | `nextTurnCount = turnCount + 1`。 |
| `src/query.ts:1704` | max turns 检查。 |
| `src/query.ts:1715` | 下一轮 `State` 写回。 |
| `src/Tool.ts:158` | `ToolUseContext` 字段。 |
| `src/Tool.ts:379` | `Tool.call()` 签名。 |
| `src/services/api/claude.ts:752` | `queryModelWithStreaming()` 参数。 |
| `src/services/api/claude.ts:1266` | provider 前 `normalizeMessagesForAPI()`。 |
| `src/services/api/claude.ts:1298` | provider 前 `ensureToolResultPairing()`。 |
| `src/services/api/claude.ts:1818` | raw stream 自行累积 partial JSON。 |
| `src/services/api/claude.ts:2171` | `content_block_stop` 生成 `AssistantMessage`。 |
| `src/utils/messages.ts:1989` | `normalizeMessagesForAPI()` 定义。 |
| `src/utils/messages.ts:2466` | `hoistToolResults()`。 |
| `src/utils/messages.ts:5119` | `ensureToolResultPairing()`。 |
| `src/utils/toolResultStorage.ts:575` | tool result budget 按 API-level user message 分组。 |
| `src/utils/toolResultStorage.ts:742` | tool result replacement fate frozen。 |
| `src/utils/toolResultStorage.ts:759` | `ContentReplacementState` 被 mutation。 |

## 合理推断

- Claude Code 没有把 iteration-local variables 抽成显式类型，是因为 `query.ts` 自身就是 reducer 边界；局部变量只服务于本轮 provider/tool execution。
- `State.messages = messagesForQuery + assistantMessages + toolResults` 表明 Claude Code 的 loop 内事实源会跟随投影结果前进；完整 UI 历史和 session persistence 是入口 / host / storage 层的另一个问题。
- `transition` 主要服务于 recovery guard 和测试可观测性，而不是 provider protocol。

## 待验证

- `StreamingToolExecutor` 内部排序和 abort synthetic result 细节需要单独阅读。
- stop hook 如何把 hook output 映射成 blocking errors，需要单独阅读 hooks pipeline。
- context collapse、snip compact、reactive compact 的具体算法不在本文展开。
