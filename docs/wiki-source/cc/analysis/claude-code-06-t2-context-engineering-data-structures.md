# Claude Code 06-T2 技术方案：Context Engineering Data Structures

## 如何阅读本文

本文是一份 Claude Code 源码事实版 06-T2 技术方案。它回答的是：如果 Claude Code 自己要把 “上下文工程” 拆成一组开发任务，T2 应该先把哪些数据结构、生命周期和转换关系理清楚。

本文不做 hope-agent 适配，不重命名 Claude Code 字段，不引入外部系统专用 schema。所有结构均使用 Claude Code 源码里的类型名、变量名或函数名；源码里没有单独命名的局部变量集合，会明确写成 “iteration-local variables”。

推荐阅读路径：

- 快速路径：读 §0、§1、§2、§3。
- 实现路径：读 §4 到 §18，按数据结构生命周期理解每个结构在哪里产生、被谁读取、如何变成下一轮模型上下文。
- 完整索引路径：读 §19 到 §26，补齐 budget、microcompact、文件缓存、provider options、resume、观测等支撑结构。
- 校验路径：读 §27、§28 和附录 A，用源码位置检查结论是否有依据。

## Learning Question

06-T2 的问题不是“`queryLoop()` 的 `State` 有哪些字段”这么窄，而是：

```text
Claude Code 上下文工程涉及哪些数据结构？
它们分别属于入口参数、loop 状态、message transcript、投影视图、
provider wire request、tool runtime、attachment、compaction、budget、
recovery 和 diagnostics 的哪一层？
这些结构如何连接成每轮模型可见上下文？
```

如果只做 `State`，后续写 projector、provider normalization、tool result budget、compact、resume 时一定会继续扩字段，产生割裂。因此 06-T2 应该先建立上下文工程数据结构总表。

## Scope

本文覆盖：

- `QueryParams`
- `State`
- `QueryDeps`
- `QueryConfig`
- `ToolUseContext`
- `ToolPermissionContext` / `QueryChainTracking`
- `Message[]`、`messagesForQuery`、provider API messages
- `UserMessage` / `AssistantMessage` / `AttachmentMessage` / `System*Message` 的使用形态
- content block：`text`、`thinking`、`tool_use`、`tool_result` 等
- iteration-local variables：`assistantMessages`、`toolResults`、`toolUseBlocks`、`needsFollowUp`
- `Attachment`
- `FileState` / `FileStateCache`
- `MemoryPrefetch`
- `SystemPrompt`、`userContext`、`systemContext`
- `ContentReplacementState` / `ContentReplacementRecord`
- `PersistedToolResult` / `PersistToolResultError`
- `ContentReplacementEntry`
- `CompactionResult` / `RecompactionInfo`
- `AutoCompactTrackingState`
- `BudgetTracker` / `TokenBudgetDecision` / `taskBudgetRemaining`
- `MicrocompactResult` / `PendingCacheEdits`
- `ContextEditStrategy` / `ContextManagementConfig` / `TimeBasedMCConfig`
- provider request `Options`
- session resume / log 结构：`SerializedMessage`、`TranscriptMessage`、`ProcessedResume`、`SessionLogResult`
- context collapse persistence：`ContextCollapseCommitEntry`、`ContextCollapseSnapshotEntry`
- `/context` 观测结构：`ContextData`
- `transition` / `turnCount`
- token / task budget 相关状态承载
- provider normalization 与 pairing guard 派生结构

本文不覆盖：

- 单个工具内部实现。
- permission rule / hook / classifier 完整判定树。
- microcompact、autocompact、session memory compact 的算法细节。
- session storage 的完整持久化格式。
- 非 Claude Code 源码事实的适配 schema 或字段重命名。

## 0. 设计摘要

Claude Code 的上下文工程数据模型不是一个大 `ContextState`，而是一条多阶段数据链：

```text
QueryParams
  messages / systemPrompt / userContext / systemContext
  toolUseContext / canUseTool / maxTurns / taskBudget / deps
        |
        v
State
  messages / toolUseContext / autoCompactTracking
  maxOutputTokensRecoveryCount / hasAttemptedReactiveCompact
  maxOutputTokensOverride / pendingToolUseSummary
  stopHookActive / turnCount / transition
        |
        v
messagesForQuery
  getMessagesAfterCompactBoundary()
  -> applyToolResultBudget()
  -> snip
  -> microcompact
  -> context collapse
  -> autocompact / buildPostCompactMessages()
        |
        v
provider adapter input
  messages = prependUserContext(messagesForQuery, userContext)
  systemPrompt = appendSystemContext(systemPrompt, systemContext)
        |
        v
provider API messages
  normalizeMessagesForAPI()
  -> ensureToolResultPairing()
  -> provider-specific filtering / media stripping
        |
        v
assistantMessages / toolUseBlocks / toolResults
        |
        v
next State.messages =
  messagesForQuery + assistantMessages + toolResults
```

最重要的事实：

- `QueryParams.messages` 是入口消息。
- `State.messages` 是 `queryLoop()` 当前事实源。
- `messagesForQuery` 是每轮模型调用前的投影视图。
- provider adapter input 会在 `messagesForQuery` 前置 `userContext`，并把 `systemContext` 合入 system prompt。
- provider API messages 是 `normalizeMessagesForAPI()` 和 `ensureToolResultPairing()` 之后的 wire 形态。
- `ToolUseContext.messages` 每轮被设置成 `messagesForQuery`。
- 有工具调用时，下一轮 `State.messages` 不是简单 append 到旧 `messages`，而是 `messagesForQuery + assistantMessages + toolResults`。

## 1. 全局心智模型

Claude Code 上下文工程的核心数据分层如下：

| 层 | 源码结构 / 变量 | 生命周期 | 作用 |
|---|---|---|---|
| query 入口 | `QueryParams` | 一次 `query()` 调用 | 把消息、系统提示、工具 runtime、权限函数和依赖注入 loop。 |
| loop 跨轮状态 | `State` | 一个 agentic turn 内多次 iteration | 保存当前事实源、工具上下文、恢复标记、turn 计数和 transition。 |
| loop 单轮局部 | `messagesForQuery`、`assistantMessages`、`toolResults`、`toolUseBlocks`、`needsFollowUp` | 一次 `while(true)` iteration | 承载本轮 provider 输入、assistant 输出、工具请求和工具结果。 |
| message transcript | `Message[]` | UI / loop / session 存储共同使用 | 保存 user、assistant、attachment、system、progress 等内部消息。 |
| provider wire | `normalizeMessagesForAPI()` 输出 | 一次 provider request | 只包含 provider 可接受的 user / assistant 消息。 |
| tool runtime | `ToolUseContext` | query / session / tool execution 交错 | 工具列表、MCP、abort、callbacks、app state、file cache、content replacement。 |
| context producer | `Attachment` / `AttachmentMessage` | pre-loop、post-tool、post-compact | 把计划、文件、memory、skills、MCP、queued command 等上下文注入 messages。 |
| compaction | `CompactionResult`、`AutoCompactTrackingState`、`RecompactionInfo` | compact 前后 / 跨 iteration | 生成 compact boundary、summary、恢复附件和 hooks 结果。 |
| microcompact | `MicrocompactResult`、`PendingCacheEdits`、`ContextManagementConfig`、`TimeBasedMCConfig` | provider request 前 / API request 构造时 | 管理旧工具结果清理、cache edits、API native context management。 |
| budget | `ContentReplacementState`、`BudgetTracker`、`TokenBudgetDecision`、`taskBudgetRemaining`、token usage | 跨 turn / 每轮 request | 管理大工具结果替换、API task budget、token 观测和 continuation。 |
| file / memory cache | `FileStateCache`、`FileState`、`MemoryPrefetch`、memory/skill trigger sets | session / query / post-tool | 记录模型已见过的文件、memory、skill discovery，支持 compact 后恢复和去重。 |
| persistence / resume | `SerializedMessage`、`TranscriptMessage`、`ContentReplacementEntry`、`ProcessedResume`、`ContextCollapse*Entry` | session log / resume | 把内部消息和上下文改写记录写入 transcript，并在 resume 时重建工作状态。 |
| observability | `ContextData` | `/context` / diagnostics | 展示模型上下文窗口的 token 分类、message breakdown 和 API usage。 |
| protocol guard | `ensureToolResultPairing()` 内部索引 | provider request 前派生 | 防止 missing / orphan / duplicate tool result 破坏 API 请求。 |

## 2. 数据流总览

一次 Claude Code agentic turn 中，数据流按下面顺序推进：

```text
Host / Entry
  -> QueryParams
       messages
       systemPrompt
       userContext
       systemContext
       toolUseContext
       canUseTool
       deps

queryLoop bootstrap
  -> State initialized from QueryParams

each while iteration
  -> messagesForQuery from State.messages
  -> context projection transforms
  -> toolUseContext.messages = messagesForQuery
  -> prependUserContext(messagesForQuery, userContext)
  -> appendSystemContext(systemPrompt, systemContext)
  -> deps.callModel(...)
  -> assistantMessages + toolUseBlocks

if no tool_use
  -> recovery / stop hooks / token budget continuation / completed

if tool_use
  -> runTools(...)
  -> toolResults
  -> post-tool attachments / memory / skill discovery
  -> next State
```

这个流里有三个边界最容易混淆：

| 边界 | 源码事实 |
|---|---|
| `State.messages` vs `messagesForQuery` | `messagesForQuery` 每轮从 `State.messages` 投影出来，并经过 budget / compact；它不是完整历史。 |
| `messagesForQuery` vs provider API messages | provider 前先注入 `userContext` / `systemContext`，再做 `normalizeMessagesForAPI()` 和 `ensureToolResultPairing()`。 |
| tool result vs attachment | 工具执行结果是 user-side message；post-tool context 如 memory/skill/queued command 可能是 `AttachmentMessage`，但最终同样进入下一轮 `toolResults` 集合。 |

## 3. 06-T2 应该交付什么

T2 的合理交付物不是实现算法，而是这张“数据结构地基表”：

| 数据结构 | 是否 T2 需要讲清楚 | T2 不做 |
|---|---:|---|
| `QueryParams` | 是 | 不改入口行为。 |
| `QueryConfig` | 是 | 不把 feature gate 判定全部搬入配置。 |
| `State` | 是 | 不实现新 recovery 算法。 |
| iteration-local variables | 是 | 不强行抽新类型。 |
| `Message[]` 与 message variants | 是 | 不补缺失的 `types/message.js` 源文件。 |
| `messagesForQuery` | 是 | 不实现具体 projector 新算法。 |
| provider API messages | 是 | 不重写 provider normalizer。 |
| provider request `Options` | 是 | 不改 API adapter 行为。 |
| `ToolUseContext` | 是 | 不拆分 CLI runtime。 |
| `Attachment` | 是 | 不实现所有 producer。 |
| `FileStateCache` / `MemoryPrefetch` | 是 | 不实现具体文件恢复策略。 |
| `ContentReplacementState` | 是 | 不实现文件持久化策略。 |
| `PersistedToolResult` / `ContentReplacementEntry` | 是 | 不补完整 session storage。 |
| `BudgetTracker` / `TokenBudgetDecision` | 是 | 不设计新 budget 策略。 |
| `MicrocompactResult` / API context management | 是 | 不展开 microcompact 算法。 |
| `CompactionResult` | 是 | 不实现 summary 生成。 |
| `AutoCompactTrackingState` / `RecompactionInfo` | 是 | 不实现 threshold 策略。 |
| resume / log / context-collapse entries | 是 | 不补完整持久化读写实现。 |
| `ContextData` | 是 | 不设计完整 `/context` UI。 |
| pairing guard 派生索引 | 是 | 不实现新的 pairing 算法。 |

## 4. `QueryParams`：query 入口数据包

`QueryParams` 定义在 `src/query.ts:181`：

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

职责：

- `messages`：进入 loop 的初始内部消息数组。
- `systemPrompt`：基础系统提示。
- `userContext`：用户/项目上下文，后续 provider request 中注入。
- `systemContext`：追加到 system prompt。
- `canUseTool`：工具执行权限函数。
- `toolUseContext`：工具运行时上下文。
- `fallbackModel`：provider fallback 目标。
- `querySource`：区分 REPL、SDK、subagent、compact 等来源。
- `maxOutputTokensOverride`：max output retry 覆盖。
- `maxTurns`：agentic turn 内最大 provider call 路径数。
- `taskBudget`：API task budget，源码注释说明它不同于 tokenBudget auto-continue。
- `deps`：测试和生产依赖注入。

T2 结论：

```text
QueryParams 是入口快照。
它不是 provider request，也不是 loop 内全部上下文状态。
```

## 5. `QueryDeps`：query 依赖注入结构

`QueryDeps` 定义在 `src/query/deps.ts:21`：

```ts
export type QueryDeps = {
  callModel: typeof queryModelWithStreaming
  microcompact: typeof microcompactMessages
  autocompact: typeof autoCompactIfNeeded
  uuid: () => string
}
```

源码注释说明：这个结构用于让测试直接注入 fakes，而不是对模块做 spy；当前 scope 故意很窄，只包含 model、compaction 和 uuid。

T2 结论：

- `callModel` 是 provider adapter 边界。
- `microcompact` 和 `autocompact` 是 context projection 链路中的可替换环节。
- `uuid` 用于 query tracking / compact tracking 等 id 生成。
- `runTools`、stop hooks、queue ops 等还没有进入 `QueryDeps`。

## 6. `QueryConfig`：query 入口配置快照

`QueryConfig` 定义在 `src/query/config.ts:15`：

```ts
export type QueryConfig = {
  sessionId: SessionId
  gates: {
    streamingToolExecution: boolean
    emitToolUseSummaries: boolean
    isAnt: boolean
    fastModeEnabled: boolean
  }
}
```

源码注释说明：

```text
Immutable values snapshotted once at query() entry.
Separating these from the per-iteration State struct and the mutable
ToolUseContext makes future step() extraction tractable.
```

T2 结论：

- `QueryConfig` 是 query 入口的 immutable runtime snapshot。
- 它和 `State` 不同：`State` 表示 loop 跨 iteration 的当前状态；`QueryConfig` 表示本次 query 调用期间不应反复读取的环境 / gate 快照。
- 它和 `ToolUseContext` 也不同：`ToolUseContext` 允许工具执行后被替换或扩展；`QueryConfig` 是 plain data。
- `feature()` gates 被源码注释明确排除在 `QueryConfig` 外，因为它们是 tree-shaking boundary，需要留在 guarded blocks。

## 7. `State`：queryLoop 跨 iteration 状态

`State` 定义在 `src/query.ts:203`：

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

初始化在 `src/query.ts:268`：

- `messages = params.messages`
- `toolUseContext = params.toolUseContext`
- `maxOutputTokensOverride = params.maxOutputTokensOverride`
- `turnCount = 1`
- recovery / compact / summary / transition 字段初始化为空或 false。

字段分组：

| 分组 | 字段 | 源码语义 |
|---|---|---|
| transcript fact | `messages` | loop 当前事实源。 |
| runtime | `toolUseContext` | 工具执行和 context producer 的运行时上下文。 |
| compaction tracking | `autoCompactTracking` | autocompact turn counter 和 failure circuit breaker。 |
| recovery | `maxOutputTokensRecoveryCount`、`hasAttemptedReactiveCompact`、`maxOutputTokensOverride`、`stopHookActive` | 防止 recovery 无限循环，并控制 retry。 |
| UI/side channel | `pendingToolUseSummary` | 工具批次摘要异步任务。 |
| loop control | `turnCount`、`transition` | 当前 agentic turn 轮数和上一轮 continue 原因。 |

T2 结论：

```text
State 是 queryLoop 的最小跨轮状态。
但上下文工程的数据结构不止 State；
State 只是连接 messages、tool runtime、compact tracking 和 recovery 的中心节点。
```

## 8. `Message[]`：内部 transcript / context carrier

Claude Code 中大量模块 import `Message`、`UserMessage`、`AssistantMessage`、`AttachmentMessage`、`System*Message` from `../types/message.js`。当前源码树没有展开 `src/types/message.ts`，因此本文只根据使用点确认 message 形态，不编造完整类型定义。

从源码使用可确认的 message 类别：

| 类别 | 使用点 | 作用 |
|---|---|---|
| `UserMessage` | `createUserMessage()`、tool result、compact summary、recovery meta message | 用户输入、meta user context、tool result、compact summary。 |
| `AssistantMessage` | provider stream 输出、`assistantMessages` | 模型输出，包含 text/thinking/tool_use。 |
| `AttachmentMessage` | `createAttachmentMessage()`、`getAttachmentMessages()`、post-compact file attachments | 文件、计划、memory、skill、MCP、queued command 等上下文。 |
| `SystemCompactBoundaryMessage` | `createCompactBoundaryMessage()`、`isCompactBoundaryMessage()` | compact boundary marker。 |
| `SystemMicrocompactBoundaryMessage` | `createMicrocompactBoundaryMessage()` | microcompact boundary marker。 |
| `SystemInformationalMessage` 等 | `createSystemMessage()` | UI / SDK / diagnostics 事件。 |
| `ProgressMessage` | tool/hook progress | provider 前会被过滤或不作为 API message。 |
| `TombstoneMessage` | streaming fallback | 删除 UI/transcript 中 orphan partial message。 |

重要字段事实：

- `UserMessage` 可有 `isMeta`，用于模型可见但 UI 隐藏或特殊渲染的 meta user message。
- compact summary 是 `UserMessage`，带 `isCompactSummary: true`。
- compact boundary 是 `SystemCompactBoundaryMessage`，`normalizeMessagesForAPI()` 会过滤 system boundary，但 `getMessagesAfterCompactBoundary()` 用它做切片。
- attachment 是内部 message，不是 provider 原生角色；provider 前会被 normalization 渲染或合并。

## 9. content blocks：message 内部协议

Claude Code 依赖 Anthropic content block 协议：

| block | 出现位置 | 作用 |
|---|---|---|
| `text` | user / assistant / tool_result content | 普通文本。 |
| `thinking` / `redacted_thinking` | assistant content | thinking 输出与签名相关。 |
| `tool_use` | assistant content | 模型请求工具执行。 |
| `tool_result` | user content | 工具执行结果，必须用 `tool_use_id` 配对。 |
| `image` / `document` | user content 或 tool_result content | 用户附件或工具结果中的媒体。 |
| `server_tool_use` / `mcp_tool_use` | assistant content | provider/server-side tool use，pairing guard 也处理。 |

源码事实：

- `queryLoop()` 只通过 assistant content 里的 `tool_use` 判断 `needsFollowUp`，见 `src/query.ts:829`。
- `attachments.ts` 注释明确：`tool_use` lives in assistant content；`tool_result` in user content，见 `src/utils/attachments.ts:2460`。
- `ensureToolResultPairing()` 处理 missing、orphan、duplicate tool-use/tool-result，见 `src/utils/messages.ts:5119`。
- `hoistToolResults()` 要求 user message content 中 `tool_result` block 靠前，见 `src/utils/messages.ts:2466`。

## 10. `messagesForQuery`：本轮模型输入投影视图

`messagesForQuery` 是 `queryLoop()` 每轮局部变量，不是类型定义。它的生成链路在 `src/query.ts:365` 到 `:535`：

```text
messagesForQuery = getMessagesAfterCompactBoundary(messages)
  -> applyToolResultBudget()
  -> snipCompactIfNeeded()
  -> deps.microcompact()
  -> contextCollapse.applyCollapsesIfNeeded()
  -> deps.autocompact()
  -> optional buildPostCompactMessages(compactionResult)
```

关键事实：

- `getMessagesAfterCompactBoundary()` 从最后一个 compact boundary 开始切片，见 `src/utils/messages.ts:4631`。
- tool result budget 在 microcompact 前执行，源码注释说明 cached microcompact 按 `tool_use_id` 工作，不检查内容，见 `src/query.ts:369`。
- context collapse 在 autocompact 前执行，如果 collapse 足以降 token，就避免 single summary，见 `src/query.ts:428`。
- autocompact 成功后，`messagesForQuery` 被替换为 `buildPostCompactMessages(compactionResult)`，见 `src/query.ts:528`。
- 每轮最后写入 `toolUseContext.messages = messagesForQuery`，见 `src/query.ts:545`。
- provider 调用时传入的是 `prependUserContext(messagesForQuery, userContext)`，而 system prompt 先经过 `appendSystemContext(systemPrompt, systemContext)`，见 `src/query.ts:449` 和 `src/query.ts:660`。

T2 结论：

```text
messagesForQuery 是上下文工程的中轴结构。
它不是原始 transcript，也不是 provider wire messages。
```

## 11. iteration-local variables：单轮 provider / tool 局部数据

Claude Code 没有定义单独的 `IterationScratch` 类型。每轮 `while(true)` 内部使用这些局部变量：

```ts
const assistantMessages: AssistantMessage[] = []
const toolResults: (UserMessage | AttachmentMessage)[] = []
const toolUseBlocks: ToolUseBlock[] = []
let needsFollowUp = false
```

源码位置：`src/query.ts:551`。

工具路径还会使用：

- `streamingToolExecutor`
- `updatedToolUseContext`
- `nextPendingToolUseSummary`
- `queuedCommandsSnapshot`
- `pendingMemoryPrefetch`
- `pendingSkillPrefetch`

职责：

| 变量 | 作用 |
|---|---|
| `assistantMessages` | 本轮 provider stream 产出的 assistant messages。 |
| `toolUseBlocks` | 从 assistant content 中筛出的 tool_use blocks。 |
| `needsFollowUp` | 是否进入工具执行路径。 |
| `toolResults` | 工具结果和 post-tool attachment，进入下一轮 `State.messages`。 |
| `updatedToolUseContext` | 工具执行后可能返回的新 runtime context。 |
| `nextPendingToolUseSummary` | 工具批次摘要 Promise，写入下一轮 `State.pendingToolUseSummary`。 |

## 12. `ToolUseContext`：工具运行时与上下文 runtime

`ToolUseContext` 定义在 `src/Tool.ts:158`。它是 Claude Code 最大的上下文 runtime 对象之一。

主要字段组：

| 组 | 字段 |
|---|---|
| options | `commands`、`mainLoopModel`、`tools`、`thinkingConfig`、`mcpClients`、`mcpResources`、`agentDefinitions`、`refreshTools` |
| abort | `abortController` |
| file / content state | `readFileState`、`contentReplacementState` |
| app state | `getAppState()`、`setAppState()`、`setAppStateForTasks` |
| UI / SDK callbacks | `setToolJSX`、`addNotification`、`setStreamMode`、`setSDKStatus`、`requestPrompt`、`onCompactProgress` |
| identity | `agentId`、`agentType`、`toolUseId` |
| permissions | `toolDecisions`、`localDenialTracking`、`requireCanUseTool` |
| context view | `messages` |
| cache | `renderedSystemPrompt` |

工具调用签名在 `src/Tool.ts:379`：

```ts
call(args, context, canUseTool, parentMessage, onProgress?)
```

T2 结论：

- `ToolUseContext.messages` 每轮代表 `messagesForQuery`。
- `ToolUseContext` 包含大量运行时对象，不能等同于持久 transcript。
- `contentReplacementState` 属于工具结果预算和 prompt cache 稳定性。
- `refreshTools()` 支持工具批次后刷新 MCP / tool schema，见 `src/query.ts:1659`。

## 13. `Attachment` 与 `AttachmentMessage`

`Attachment` 是 Claude Code 的 typed context carrier。`src/utils/attachments.ts` 中的 union 很大，本文只列与上下文工程主线直接相关的类别：

| attachment type | 源码使用事实 |
|---|---|
| `queued_command` | post-tool 阶段把 queued commands 转成 attachment，见 `src/query.ts:1580`。 |
| `invoked_skills` | compact 后可恢复已调用 skill 内容，见 `src/utils/attachments.ts:646`。 |
| `max_turns_reached` | max turns 截断时 yield，见 `src/query.ts:1706`。 |
| `current_session_memory` | session memory 上下文，见 `src/utils/attachments.ts:662`。 |
| `deferred_tools_delta` | deferred tools delta announcement，见 `src/utils/attachments.ts:686`。 |
| `agent_listing_delta` | agent listing delta，见 `src/utils/attachments.ts:692`。 |
| `mcp_instructions_delta` | MCP instructions delta，见 `src/utils/attachments.ts:702`。 |
| plan mode attachments | plan mode 根据 human turns 节流，见 `src/utils/attachments.ts:1131`。 |

关键事实：

- attachment 是内部 message，可以进入 `Message[]`。
- provider 前由 `normalizeMessagesForAPI()` 处理，不是 provider 原生 message type。
- post-tool attachments 会 push 到 `toolResults`，并最终进入下一轮 `State.messages`。
- compact 后 attachments 是 `CompactionResult.attachments` 的一部分。

## 14. provider API messages：wire request 结构

`queryLoop()` 调用 `deps.callModel()`，生产实现是 `queryModelWithStreaming()`。provider adapter 接收：

- `messages`
- `systemPrompt`
- `thinkingConfig`
- `tools`
- `signal`
- `options`

`queryModelWithStreaming()` 定义在 `src/services/api/claude.ts:752`。

provider 前处理：

```ts
let messagesForAPI = normalizeMessagesForAPI(messages, filteredTools)
...
messagesForAPI = ensureToolResultPairing(messagesForAPI)
```

源码位置：`src/services/api/claude.ts:1266` 和 `:1298`。

provider stream 处理：

- raw stream 自己累积 partial JSON，见 `src/services/api/claude.ts:1818`。
- `content_block_stop` 时生成完整 `AssistantMessage`，见 `src/services/api/claude.ts:2171`。

T2 结论：

```text
provider API messages 是 wire 形态。
它是 messagesForQuery 经过 normalize / guard 后的结果，
不是 State.messages，也不是 session transcript。
```

## 15. `ContentReplacementState` 与大工具结果预算

`ContentReplacementState` 定义在 `src/utils/toolResultStorage.ts:390`：

```ts
export type ContentReplacementState = {
  seenIds: Set<string>
  replacements: Map<string, string>
}
```

相关结构：

```ts
export type ContentReplacementRecord = {
  kind: 'tool-result'
  toolUseId: string
  replacement: string
}
```

源码位置：`src/utils/toolResultStorage.ts:465`。

关键函数：

- `provisionContentReplacementState()`：为新 conversation thread provision state；可从 initial messages 和 records reconstruct，见 `src/utils/toolResultStorage.ts:436`。
- `applyToolResultBudget()`：在 `messagesForQuery` 上应用替换，见 `src/utils/toolResultStorage.ts:924`。
- `reconstructContentReplacementState()`：resume 时从 records 重建，见 `src/utils/toolResultStorage.ts:938`。

关键语义：

- 预算按 API-level user message 聚合，因为 `normalizeMessagesForAPI()` 会合并连续 user messages。
- 每个 `tool_use_id` 的替换命运被冻结：已替换的结果复用同一 replacement；已见过但未替换的结果后续不再替换。
- `replacement` 存 exact string，避免代码变更导致 prompt cache 不稳定。

## 16. `CompactionResult` / `RecompactionInfo`

`CompactionResult` 定义在 `src/services/compact/compact.ts:299`：

```ts
export interface CompactionResult {
  boundaryMarker: SystemMessage
  summaryMessages: UserMessage[]
  attachments: AttachmentMessage[]
  hookResults: HookResultMessage[]
  messagesToKeep?: Message[]
  userDisplayMessage?: string
  preCompactTokenCount?: number
  postCompactTokenCount?: number
  truePostCompactTokenCount?: number
  compactionUsage?: ReturnType<typeof getTokenUsage>
}
```

`buildPostCompactMessages()` 定义了 compact 后 messages 顺序：

```text
boundaryMarker
summaryMessages
messagesToKeep
attachments
hookResults
```

源码位置：`src/services/compact/compact.ts:325`。

`RecompactionInfo` 定义在 `src/services/compact/compact.ts:317`：

```ts
export type RecompactionInfo = {
  isRecompactionInChain: boolean
  turnsSincePreviousCompact: number
  previousCompactTurnId?: string
  autoCompactThreshold: number
  querySource?: QuerySource
}
```

T2 结论：

- compact 结果不是一个 summary string。
- 它是 boundary、summary messages、保留 messages、恢复 attachments、hook results 和 token usage 的组合。
- post-compact message order 是上下文工程协议。

## 17. `AutoCompactTrackingState`

`AutoCompactTrackingState` 定义在 `src/services/compact/autoCompact.ts:51`：

```ts
export type AutoCompactTrackingState = {
  compacted: boolean
  turnCounter: number
  turnId: string
  consecutiveFailures?: number
}
```

作用：

- `compacted`：当前是否处于 compact 后 tracking 链。
- `turnCounter`：compact 后经过多少轮。
- `turnId`：compact turn id。
- `consecutiveFailures`：autocompact failure circuit breaker。

`autoCompactIfNeeded()` 返回：

```ts
{
  wasCompacted: boolean
  compactionResult?: CompactionResult
  consecutiveFailures?: number
}
```

源码位置：`src/services/compact/autoCompact.ts:241`。

`queryLoop()` 在 autocompact 成功后重置 tracking：

- `compacted: true`
- `turnId: deps.uuid()`
- `turnCounter: 0`
- `consecutiveFailures: 0`

源码位置：`src/query.ts:521`。

## 18. `transition` / `turnCount` / recovery flags

`State.transition` 注释：

```text
Why the previous iteration continued. Undefined on first iteration.
Lets tests assert recovery paths fired without inspecting message contents.
```

源码位置：`src/query.ts:214`。

读取到的 transition reason：

| reason | 写入位置 | 含义 |
|---|---|---|
| `collapse_drain_retry` | `src/query.ts:1109` | prompt-too-long 后先 drain context collapse。 |
| `reactive_compact_retry` | `src/query.ts:1162` | reactive compact 后重试。 |
| `max_output_tokens_escalate` | `src/query.ts:1217` | 提升 max output tokens 后重试。 |
| `max_output_tokens_recovery` | `src/query.ts:1246` | 注入 recovery message 后继续。 |
| `stop_hook_blocking` | `src/query.ts:1302` | stop hook blocking 后继续。 |
| `token_budget_continuation` | `src/query.ts:1338` | token budget nudge 后继续。 |
| `next_turn` | `src/query.ts:1725` | 工具结果进入下一轮。 |

`turnCount`：

- 初始 1，见 `src/query.ts:276`。
- 工具结果准备好并将进入下一轮 provider call 时递增，见 `src/query.ts:1678`。
- max turns 检查发生在写回下一轮 state 前，见 `src/query.ts:1704`。

## 19. pairing guard 派生数据

Claude Code 没有把 pairing index 作为持久结构保存。`ensureToolResultPairing()` 在 provider boundary 派生这些集合：

- `allSeenToolUseIds`
- per-assistant `seenToolUseIds`
- `serverResultIds`
- `existingToolResultIds`
- `missingIds`
- `orphanedIds`
- duplicate tool result tracking

源码位置：`src/utils/messages.ts:5119` 到 `:5458`。

它处理：

- tool use 缺少 tool result。
- tool result 引用不存在的 tool use。
- duplicate tool use id。
- duplicate tool result id。
- server-side tool use 缺少 server-side result。
- strict mode 下拒绝 synthetic repair。

T2 结论：

```text
pairing index 是 provider 前派生 guard，不是 State 字段。
```

## 20. provider request `Options`

provider adapter 的消息输入不只有 `messages`。`queryModelWithStreaming()` / `queryModel()` 使用的 `Options` 定义在 `src/services/api/claude.ts:676`：

```ts
export type Options = {
  getToolPermissionContext: () => Promise<ToolPermissionContext>
  model: string
  toolChoice?: BetaToolChoiceTool | BetaToolChoiceAuto | undefined
  isNonInteractiveSession: boolean
  extraToolSchemas?: BetaToolUnion[]
  maxOutputTokensOverride?: number
  fallbackModel?: string
  onStreamingFallback?: () => void
  querySource: QuerySource
  agents: AgentDefinition[]
  allowedAgentTypes?: string[]
  hasAppendSystemPrompt: boolean
  fetchOverride?: ClientOptions['fetch']
  enablePromptCaching?: boolean
  skipCacheWrite?: boolean
  temperatureOverride?: number
  effortValue?: EffortValue
  mcpTools: Tools
  hasPendingMcpServers?: boolean
  queryTracking?: QueryChainTracking
  agentId?: AgentId
  outputFormat?: BetaJSONOutputFormat
  fastMode?: boolean
  advisorModel?: string
  addNotification?: (notif: Notification) => void
  taskBudget?: { total: number; remaining?: number }
}
```

T2 结论：

- provider request 的上下文不仅是 `messagesForQuery`，还包括工具权限上下文、模型选择、agent definitions、MCP tools、prompt cache 开关、query tracking、task budget。
- `taskBudget.remaining` 是 caller 计算出的 API-side remaining budget，和 `tokenBudget.ts` 的 auto-continue 不是同一套机制。
- `queryTracking` 通过 `ToolUseContext.queryTracking` 在 loop 中递增，然后传入 provider options，用于跟踪 query chain。

## 21. `BudgetTracker` / `TokenBudgetDecision` / `taskBudgetRemaining`

Claude Code 有两套容易混淆的 budget：

| 结构 | 源码位置 | 语义 |
|---|---|---|
| `taskBudget?: { total: number }` | `QueryParams` | API-side task budget 的入口总量。 |
| `taskBudgetRemaining` | `src/query.ts:291` | compact 后由 caller 维护的 remaining，用于补偿 server 看不到 compact 前窗口的问题。 |
| `BudgetTracker` | `src/query/tokenBudget.ts:6` | token budget auto-continue 的本地追踪器。 |
| `TokenBudgetDecision` | `src/query/tokenBudget.ts:43` | 决定继续注入 nudge message 还是停止。 |

`BudgetTracker`：

```ts
export type BudgetTracker = {
  continuationCount: number
  lastDeltaTokens: number
  lastGlobalTurnTokens: number
  startedAt: number
}
```

`TokenBudgetDecision` 是 union：

```ts
type ContinueDecision = {
  action: 'continue'
  nudgeMessage: string
  continuationCount: number
  pct: number
  turnTokens: number
  budget: number
}

type StopDecision = {
  action: 'stop'
  completionEvent: {
    continuationCount: number
    pct: number
    turnTokens: number
    budget: number
    diminishingReturns: boolean
    durationMs: number
  } | null
}
```

T2 结论：

- `BudgetTracker` 不在 `State` 里，是 `queryLoop()` 的 loop-local 结构，见 `src/query.ts:280`。
- `taskBudgetRemaining` 也不在 `State` 里，源码注释说明这样做是为了避免触碰多个 continue site。
- token budget continuation 会通过 `transition.reason = 'token_budget_continuation'` 进入下一轮。

## 22. microcompact / API context management 数据结构

microcompact 不是只返回 `Message[]`。`src/services/compact/microCompact.ts:207` 定义：

```ts
export type PendingCacheEdits = {
  trigger: 'auto'
  deletedToolIds: string[]
  baselineCacheDeletedTokens: number
}

export type MicrocompactResult = {
  messages: Message[]
  compactionInfo?: {
    pendingCacheEdits?: PendingCacheEdits
  }
}
```

API-side context management 结构定义在 `src/services/compact/apiMicrocompact.ts:35`：

```ts
export type ContextEditStrategy =
  | {
      type: 'clear_tool_uses_20250919'
      trigger?: { type: 'input_tokens'; value: number }
      keep?: { type: 'tool_uses'; value: number }
      clear_tool_inputs?: boolean | string[]
      exclude_tools?: string[]
      clear_at_least?: { type: 'input_tokens'; value: number }
    }
  | {
      type: 'clear_thinking_20251015'
      keep: { type: 'thinking_turns'; value: number } | 'all'
    }

export type ContextManagementConfig = {
  edits: ContextEditStrategy[]
}
```

time-based microcompact 配置定义在 `src/services/compact/timeBasedMCConfig.ts:18`：

```ts
export type TimeBasedMCConfig = {
  enabled: boolean
  gapThresholdMinutes: number
  keepRecent: number
}
```

T2 结论：

- `MicrocompactResult.messages` 回写到 `messagesForQuery`。
- `PendingCacheEdits` 不是普通 message，而是后续 provider request 构造时消费的 cache edit side channel。
- `ContextManagementConfig` 会通过 Anthropic request 的 `context_management` 发送给 API，属于 provider wire request 的一部分。
- `TimeBasedMCConfig` 决定长时间 gap 后是否在请求前清理旧工具结果，目标是减少 cache miss 后重写的上下文体积。

## 23. 文件、memory、skill discovery 运行时结构

`ToolUseContext.readFileState` 的类型是 `FileStateCache`。`FileState` 定义在 `src/utils/fileStateCache.ts:4`：

```ts
export type FileState = {
  content: string
  timestamp: number
  offset: number | undefined
  limit: number | undefined
  isPartialView?: boolean
}
```

`FileStateCache` 是带路径 normalize 和 LRU size limit 的 cache。它用于：

- 记录模型已经看过的文件内容。
- compact 后选择最近文件恢复。
- 文件 edit/write 前判断模型是否只看过 partial view。
- nested memory / dynamic skill discovery 的去重。

`ToolUseContext` 还承载这些上下文触发集合：

| 字段 | 源码位置 | 语义 |
|---|---|---|
| `nestedMemoryAttachmentTriggers?: Set<string>` | `src/Tool.ts:215` | 工具读文件后触发 nested memory attachment 注入。 |
| `loadedNestedMemoryPaths?: Set<string>` | `src/Tool.ts:222` | 非 LRU 的 CLAUDE.md 去重集合，避免 readFileState eviction 后重复注入。 |
| `dynamicSkillDirTriggers?: Set<string>` | `src/Tool.ts:223` | 触发动态 skill dir discovery。 |
| `discoveredSkillNames?: Set<string>` | `src/Tool.ts:225` | 记录本 session 已 surfaced 的 skill 名称，用于 telemetry / 去重。 |
| `fileReadingLimits` / `globLimits` | `src/Tool.ts:245` | 限制文件读取和 glob 结果。 |

relevant memory prefetch 的句柄定义在 `src/utils/attachments.ts:2346`：

```ts
export type MemoryPrefetch = {
  promise: Promise<Attachment[]>
  settledAt: number | null
  consumedOnIteration: number
  [Symbol.dispose](): void
}
```

T2 结论：

- 文件、memory、skill discovery 不是只通过 `Message[]` 表达；它们在 `ToolUseContext` 里有 session-level runtime state。
- `MemoryPrefetch` 是 query 级 side channel：它并行搜索 relevant memories，post-tool 阶段如果已完成才消费并注入 attachment。
- `pendingSkillPrefetch` 是 skill discovery 的 per-iteration side channel：每轮开始由 `startSkillDiscoveryPrefetch()` 启动，post-tool 阶段由 `collectSkillDiscoveryPrefetch()` 消费并注入 `AttachmentMessage`，见 `src/query.ts:331` 和 `src/query.ts:1617`。
- 这些结构解释了为什么 Claude Code 能在 compact 后恢复“工作现场”，也解释了为什么同一 memory/skill 不会无限重复注入。

## 24. 工具结果持久化与 replacement log 结构

`ContentReplacementState` 管理“本轮上下文里如何替换大工具结果”；但完整链路还包含落盘和 transcript 记录。

`PersistedToolResult` 定义在 `src/utils/toolResultStorage.ts:81`：

```ts
export type PersistedToolResult = {
  filepath: string
  originalSize: number
  isJson: boolean
  preview: string
  hasMore: boolean
}
```

`PersistToolResultError`：

```ts
export type PersistToolResultError = {
  error: string
}
```

`ContentReplacementEntry` 定义在 `src/types/logs.ts:181`：

```ts
export type ContentReplacementEntry = {
  type: 'content-replacement'
  sessionId: UUID
  agentId?: AgentId
  replacements: ContentReplacementRecord[]
}
```

T2 结论：

- `PersistedToolResult` 描述大结果落盘后的模型可见引用信息。
- `ContentReplacementRecord` 描述 replacement 决策本身。
- `ContentReplacementEntry` 把 replacement 决策写入 session transcript，resume 时用于重建 `ContentReplacementState`。
- `agentId` 让 main thread 和 subagent sidechain 的 replacement records 分开归属。

## 25. session log / resume / context collapse 持久化结构

Claude Code 的 session storage 不只是保存 `Message[]`。`src/types/logs.ts` 定义多种 transcript metadata entry，其中和上下文工程直接相关的是：

```ts
export type SerializedMessage = Message & {
  cwd: string
  userType: string
  entrypoint?: string
  sessionId: string
  timestamp: string
  version: string
  gitBranch?: string
  slug?: string
}

export type TranscriptMessage = SerializedMessage & {
  parentUuid: UUID | null
  logicalParentUuid?: UUID | null
  isSidechain: boolean
  gitBranch?: string
  agentId?: string
  teamName?: string
  agentName?: string
  agentColor?: string
  promptId?: string
}
```

resume 处理结果定义在 `src/utils/sessionRestore.ts:276`：

```ts
export type ProcessedResume = {
  messages: Message[]
  fileHistorySnapshots?: FileHistorySnapshot[]
  contentReplacements?: ContentReplacementRecord[]
  agentName: string | undefined
  agentColor: AgentColorName | undefined
  restoredAgentDef: AgentDefinition | undefined
  initialState: AppState
}
```

session log 列表结果定义在 `src/utils/sessionStorage.ts:4064`：

```ts
export type SessionLogResult = {
  logs: LogOption[]
  allStatLogs: LogOption[]
  nextIndex: number
}
```

context collapse persistence entry 定义在 `src/types/logs.ts:255` 和 `:282`：

```ts
export type ContextCollapseCommitEntry = {
  type: 'marble-origami-commit'
  sessionId: UUID
  collapseId: string
  summaryUuid: string
  summaryContent: string
  summary: string
  firstArchivedUuid: string
  lastArchivedUuid: string
}

export type ContextCollapseSnapshotEntry = {
  type: 'marble-origami-snapshot'
  sessionId: UUID
  staged: Array<{
    startUuid: string
    endUuid: string
    summary: string
    risk: number
    stagedAt: number
  }>
  armed: boolean
  lastSpawnTokens: number
}
```

T2 结论：

- `Message[]` 是 runtime transcript；session log 里的 `TranscriptMessage` 还带 cwd、session、parent、sidechain、agent 等恢复信息。
- `ProcessedResume` 是 resume 后重新交给 UI / query runtime 的恢复结果，不只是 messages。
- context collapse 的 commit/snapshot entries 会影响 resume 后的 `projectView()` / `messagesForQuery`，因此属于上下文工程数据结构索引。

## 26. `/context` 观测结构 `ContextData`

`/context` 的核心返回结构是 `ContextData`，定义在 `src/utils/analyzeContext.ts:190`：

```ts
export interface ContextData {
  readonly categories: ContextCategory[]
  readonly totalTokens: number
  readonly maxTokens: number
  readonly rawMaxTokens: number
  readonly percentage: number
  readonly gridRows: GridSquare[][]
  readonly model: string
  readonly memoryFiles: MemoryFile[]
  readonly mcpTools: McpTool[]
  readonly deferredBuiltinTools?: DeferredBuiltinTool[]
  readonly systemTools?: SystemToolDetail[]
  readonly systemPromptSections?: SystemPromptSectionDetail[]
  readonly agents: Agent[]
  readonly slashCommands?: SlashCommandInfo
  readonly skills?: SkillInfo
  readonly autoCompactThreshold?: number
  readonly isAutoCompactEnabled: boolean
  messageBreakdown?: {
    toolCallTokens: number
    toolResultTokens: number
    attachmentTokens: number
    assistantMessageTokens: number
    userMessageTokens: number
    toolCallsByType: Array<{
      name: string
      callTokens: number
      resultTokens: number
    }>
    attachmentsByType: Array<{ name: string; tokens: number }>
  }
  readonly apiUsage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  } | null
}
```

T2 结论：

- `ContextData` 是上下文工程的 diagnostics schema。
- 它把 system prompt、tools、MCP、agents、slash commands、skills、memory files、messages、attachments、API usage 放到同一个 token 账本里。
- 如果只写 runtime state 而不写 `ContextData`，会漏掉 Claude Code 如何解释“模型上下文窗口由什么组成”。

## 27. T2 到后续 06 任务的边界

| 后续任务 | 消费 T2 哪些结构 | T2 不做 |
|---|---|---|
| messages / transcript contract | `Message[]`、message variants、content blocks、compact boundary | 不补完整 storage schema。 |
| context producer / attachment 总线 | `Attachment`、`AttachmentMessage`、`ToolUseContext` | 不实现每个 producer。 |
| projector / messagesForQuery | `State.messages`、`messagesForQuery`、projection transform 顺序 | 不实现新裁剪算法。 |
| provider normalization | `normalizeMessagesForAPI()`、provider API messages、pairing guard | 不改 provider adapter。 |
| tool runtime | `ToolUseContext`、`toolUseBlocks`、`toolResults` | 不展开 permission pipeline。 |
| file / memory / skill runtime | `FileStateCache`、trigger sets、`MemoryPrefetch` | 不实现具体 prefetch / discovery 算法。 |
| long content / budget | `ContentReplacementState`、`ContentReplacementRecord` | 不设计新对象存储方案。 |
| token / task budget | `BudgetTracker`、`TokenBudgetDecision`、`taskBudgetRemaining` | 不改 continuation 策略。 |
| microcompact | `MicrocompactResult`、`PendingCacheEdits`、`ContextManagementConfig` | 不展开 clear-tool-result 算法。 |
| compaction | `CompactionResult`、`AutoCompactTrackingState`、`RecompactionInfo` | 不实现 summary / threshold。 |
| recovery | `transition`、recovery flags、turnCount | 不实现新 retry 策略。 |
| persistence / resume | `SerializedMessage`、`TranscriptMessage`、`ProcessedResume`、context collapse entries | 不补完整 session storage。 |
| observability | `ContextData`、token usage、compactionUsage、queryTracking、message counts | 不设计完整 `/context` UI。 |

## 28. 验收标准

一份 Claude Code-like 06-T2 数据结构方案至少应满足：

- 能画出 `QueryParams -> State -> messagesForQuery -> provider API messages -> assistant/tool local variables -> next State.messages` 的完整链路。
- 明确 `State.messages`、`messagesForQuery`、provider API messages 三者区别。
- 明确 `ToolUseContext.messages` 每轮被设置为 `messagesForQuery`。
- 明确 `tool_use` 在 assistant content，`tool_result` 在 user content。
- 明确 `AttachmentMessage` 是内部 context carrier，不是 provider 原生消息。
- 明确 `CompactionResult` 的 post-compact message order。
- 明确 `ContentReplacementState` 按 `tool_use_id` 冻结 replacement 决策。
- 明确大工具结果链路包含 `PersistedToolResult`、`ContentReplacementRecord`、`ContentReplacementEntry`。
- 明确 `BudgetTracker` 和 API-side `taskBudgetRemaining` 是两套不同 budget 机制。
- 明确 microcompact 可能产生 `PendingCacheEdits`，并且 API request 可能带 `ContextManagementConfig`。
- 明确 `FileStateCache`、memory/skill trigger sets、`MemoryPrefetch` 是上下文 producer 的 runtime state。
- 明确 resume / session log 通过 `TranscriptMessage`、`ProcessedResume`、context-collapse entries 恢复上下文状态。
- 明确 `/context` 的 `ContextData` 是上下文观测 schema。
- 明确 pairing guard 是 provider boundary 派生逻辑。
- 明确 `transition` 不只表示错误，也包含正常 `next_turn`。
- 明确 `turnCount` 初始 1，并在准备下一轮 provider call 前递增。
- 不引入外部系统字段名替代 Claude Code 源码名。

## 附录 A：源码依据

| 结构 / 结论 | 源码位置 |
|---|---|
| `QueryParams` | `src/query.ts:181` |
| `State` | `src/query.ts:203` |
| `State.transition` 注释 | `src/query.ts:214` |
| `state` 初始化 | `src/query.ts:268` |
| 每轮解构 `State` | `src/query.ts:307` |
| `messagesForQuery` 从 compact boundary 后生成 | `src/query.ts:365` |
| tool result budget 在 microcompact 前运行 | `src/query.ts:369` |
| snip / microcompact / context collapse / autocompact 顺序 | `src/query.ts:396`, `:414`, `:428`, `:453` |
| autocompact 成功后 `buildPostCompactMessages()` | `src/query.ts:528` |
| `toolUseContext.messages = messagesForQuery` | `src/query.ts:545` |
| `systemContext` 合入 system prompt | `src/query.ts:449`, `src/utils/api.ts:437` |
| `userContext` 注入 provider messages | `src/query.ts:660`, `src/utils/api.ts:449` |
| iteration-local arrays | `src/query.ts:551` |
| `tool_use` 扫描与 `needsFollowUp` | `src/query.ts:829` |
| tool execution updates enter `toolResults` | `src/query.ts:1395` |
| post-tool attachments enter `toolResults` | `src/query.ts:1580` |
| refresh tools after tool batch | `src/query.ts:1659` |
| `nextTurnCount` | `src/query.ts:1678` |
| next `State.messages` | `src/query.ts:1715` |
| `QueryDeps` | `src/query/deps.ts:21` |
| `QueryConfig` | `src/query/config.ts:15` |
| `BudgetTracker` / `TokenBudgetDecision` | `src/query/tokenBudget.ts:6`, `:43` |
| `taskBudgetRemaining` | `src/query.ts:291` |
| `ToolUseContext` | `src/Tool.ts:158` |
| `ToolPermissionContext` | `src/Tool.ts:123` |
| `QueryChainTracking` | `src/Tool.ts:90` |
| `Tool.call()` signature | `src/Tool.ts:379` |
| `FileState` / `FileStateCache` | `src/utils/fileStateCache.ts:4`, `:30` |
| memory / skill trigger fields | `src/Tool.ts:215`, `:222`, `:223`, `:225` |
| `MemoryPrefetch` | `src/utils/attachments.ts:2346` |
| skill discovery prefetch 启动 / 消费 | `src/query.ts:331`, `:1617` |
| attachment union examples | `src/utils/attachments.ts:620` |
| `tool_use` / `tool_result` location comment | `src/utils/attachments.ts:2460` |
| `createCompactBoundaryMessage()` | `src/utils/messages.ts:4530` |
| `getMessagesAfterCompactBoundary()` | `src/utils/messages.ts:4631` |
| `normalizeMessagesForAPI()` | `src/utils/messages.ts:1989` |
| `hoistToolResults()` | `src/utils/messages.ts:2466` |
| `ensureToolResultPairing()` | `src/utils/messages.ts:5119` |
| provider request `Options` | `src/services/api/claude.ts:676` |
| `ContextManagementConfig` / `ContextEditStrategy` | `src/services/compact/apiMicrocompact.ts:35`, `:59` |
| `MicrocompactResult` / `PendingCacheEdits` | `src/services/compact/microCompact.ts:207`, `:215` |
| `TimeBasedMCConfig` | `src/services/compact/timeBasedMCConfig.ts:18` |
| `ContentReplacementState` | `src/utils/toolResultStorage.ts:390` |
| `ContentReplacementRecord` | `src/utils/toolResultStorage.ts:465` |
| `PersistedToolResult` / `PersistToolResultError` | `src/utils/toolResultStorage.ts:81`, `:90` |
| `ContentReplacementEntry` | `src/types/logs.ts:181` |
| `applyToolResultBudget()` | `src/utils/toolResultStorage.ts:924` |
| `reconstructContentReplacementState()` | `src/utils/toolResultStorage.ts:938` |
| `CompactionResult` | `src/services/compact/compact.ts:299` |
| `RecompactionInfo` | `src/services/compact/compact.ts:317` |
| `buildPostCompactMessages()` order | `src/services/compact/compact.ts:325` |
| `AutoCompactTrackingState` | `src/services/compact/autoCompact.ts:51` |
| `autoCompactIfNeeded()` return shape | `src/services/compact/autoCompact.ts:241` |
| `SerializedMessage` / `TranscriptMessage` | `src/types/logs.ts:8`, `:221` |
| `ProcessedResume` | `src/utils/sessionRestore.ts:276` |
| `SessionLogResult` | `src/utils/sessionStorage.ts:4064` |
| `ContextCollapseCommitEntry` / `ContextCollapseSnapshotEntry` | `src/types/logs.ts:255`, `:282` |
| `ContextData` | `src/utils/analyzeContext.ts:190` |

## 合理推断

- Claude Code 没有单独定义 “context engineering state” 是因为上下文工程跨越 `query.ts`、`ToolUseContext`、message normalization、attachments、compact、tool result storage 多个边界；T2 用数据结构总表比只写 `State` 更贴近源码事实。
- `messagesForQuery` 是后续上下文工程任务的中心概念；大多数机制要么生产它的输入，要么改写它，要么把它 normalize 成 provider messages。
- `AttachmentMessage` 是 Claude Code 避免把所有服务端上下文伪装成普通 user text 的关键结构。

## 待验证

- `src/types/message.js` 对应的完整源码类型未在当前 `src/types/` 下展开；本文基于使用点总结 message shape。
- `StreamingToolExecutor` 的内部排序和 abort synthetic result 细节需要单独专题分析。
- context collapse、snip compact、microcompact 的具体结果结构需要各自专题补齐。
