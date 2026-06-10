# Claude Code Agent Loop State 数据结构参考

## 如何阅读本文

本文回答一个窄问题：在 Claude Code 的 agent loop 中，哪些数据算作 loop state，应该如何抽象成外部系统可复用的数据结构。

快速读者先看 §0 和 §2；要实现自己的 agent harness，重点看 §3、§4、§5。本文不解释单个工具、不展开 context compaction 算法，也不写 `mini-cc` 课程实现。

## 0. 核心结论

Claude Code 的 loop state 不是一个单一大对象，而是三层：

```text
+---------------------------------------------------------+
| QueryParams: 本次 query() 的入口参数                    |
| messages / systemPrompt / toolUseContext / maxTurns ... |
+---------------------------+-----------------------------+
                            |
                            v
+---------------------------------------------------------+
| State: 跨 loop iteration 持久更新的状态                  |
| messages / toolUseContext / recovery flags / turnCount   |
+---------------------------+-----------------------------+
                            |
                            v
+---------------------------------------------------------+
| IterationScratch: 单次模型请求期间的临时状态              |
| messagesForQuery / assistantMessages / toolUseBlocks      |
| toolResults / needsFollowUp / streamingToolExecutor       |
+---------------------------------------------------------+
```

源码确认：

- `query()` 的入口参数由 `QueryParams` 描述，位置是 `src/query.ts:181`。
- `queryLoop()` 内部显式定义了 `State`，注释称其为 “Mutable state carried between loop iterations”，位置是 `src/query.ts:204`。
- `queryLoop()` 初始化 `let state: State = ...`，位置是 `src/query.ts:268`。
- 每次 `while (true)` 顶部从 `state` 解构当前迭代要读的字段，位置是 `src/query.ts:307`。
- 每次模型请求期间创建 `assistantMessages`、`toolResults`、`toolUseBlocks`、`needsFollowUp`，位置是 `src/query.ts:551` 到 `src/query.ts:558`。
- 工具运行时上下文由 `ToolUseContext` 描述，位置是 `src/Tool.ts:158`。

## 1. 术语

| 术语 | 含义 |
|---|---|
| `QueryParams` | `query()` 的外部输入。它包含初始 transcript、system/user context、工具权限函数、工具上下文、预算和依赖注入。 |
| `State` | `queryLoop()` 在多次 loop iteration 之间携带的可变状态。 |
| `messages` | 当前 loop 认定的 transcript 事实源。 |
| `messagesForQuery` | 本轮实际送进模型前的 transcript 投影视图，会经过 compact boundary、预算、snip、microcompact、autocompact 等处理。 |
| `assistantMessages` | 本轮模型产生的 assistant message。 |
| `toolUseBlocks` | 从 assistant content 中抽出的本轮工具请求。 |
| `toolResults` | 本轮工具执行后要作为 user-side fact 回填的消息。 |
| `ToolUseContext` | 工具执行、权限、UI、会话状态、MCP、文件缓存、query tracking 等运行时上下文。 |

## 2. 源码中的最小 State

Claude Code 的 `State` 源码结构如下。这里保留字段名和职责，不复制完整源码注释：

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

字段职责：

| 字段 | 职责 | 更新时机 |
|---|---|---|
| `messages` | 当前 agent turn 的事实源 transcript。 | 下一轮工具回填、compact retry、stop hook retry、max output recovery、token budget continuation。 |
| `toolUseContext` | 工具和 UI/权限运行时上下文。 | 每轮会写入 `messagesForQuery`；工具执行后可能返回更新后的 context。 |
| `autoCompactTracking` | 自动压缩的跨轮跟踪状态。 | autocompact 成功/失败或进入下一轮时更新。 |
| `maxOutputTokensRecoveryCount` | max output tokens 多轮恢复次数。 | 命中 max output tokens 后递增；正常进入下一工具轮后清零。 |
| `hasAttemptedReactiveCompact` | 防止 reactive compact 在同一失败路径中无限重试。 | reactive compact 成功或进入下一轮时更新。 |
| `maxOutputTokensOverride` | 某次 retry 的输出 token 上限覆盖。 | max output escalation 时设定；下一状态通常清空。 |
| `pendingToolUseSummary` | 上一轮工具摘要的异步任务。 | 工具执行后启动；下一轮模型 streaming 期间等待完成。 |
| `stopHookActive` | 标记当前是否处在 stop hook 阻断后的重试路径。 | stop hook blocking retry 时设为 true。 |
| `turnCount` | 当前 agentic turn 内第几轮模型调用。 | 每次完成工具回填并进入下一轮时递增。 |
| `transition` | 上一次进入下一轮的原因。 | 各个 `continue` 分支写入，例如 `next_turn`、`reactive_compact_retry`。 |

## 3. 外部系统可复用的参考结构

下面不是 Claude Code 源码原样导出，而是根据源码确认行为整理出的实现参考。建议外部 agent harness 按三层拆分，而不是把所有字段塞进一个全局 store。

```ts
type AgentLoopParams = {
  messages: TranscriptMessage[]
  systemPrompt: SystemPrompt
  userContext: Record<string, string>
  systemContext: Record<string, string>
  tools: ToolRegistry
  canUseTool: CanUseTool
  runtime: ToolRuntimeContext
  fallbackModel?: string
  maxTurns?: number
  maxOutputTokensOverride?: number
  taskBudget?: { total: number }
}

type AgentLoopState = {
  messages: TranscriptMessage[]
  runtime: ToolRuntimeContext

  compact: {
    autoTracking?: AutoCompactTracking
    hasAttemptedReactiveCompact: boolean
  }

  recovery: {
    maxOutputTokensRecoveryCount: number
    maxOutputTokensOverride?: number
    stopHookActive?: boolean
    transition?: ContinueReason
  }

  turn: {
    count: number
    pendingToolUseSummary?: Promise<ToolUseSummary | null>
  }
}

type IterationScratch = {
  messagesForQuery: TranscriptMessage[]
  assistantMessages: AssistantMessage[]
  toolUseBlocks: ToolUseBlock[]
  toolResults: UserMessage[]
  needsFollowUp: boolean
  streamingToolExecutor?: StreamingToolExecutor
  currentModel: string
}

type ContinueReason =
  | { reason: "next_turn" }
  | { reason: "collapse_drain_retry"; committed: number }
  | { reason: "reactive_compact_retry" }
  | { reason: "max_output_tokens_escalate" }
  | { reason: "max_output_tokens_recovery"; attempt: number }
  | { reason: "stop_hook_blocking" }
  | { reason: "token_budget_continuation" }
```

设计要点：

- `AgentLoopState.messages` 是事实源；`IterationScratch.messagesForQuery` 是本轮模型输入视图。两者不能混为一谈。
- `toolUseBlocks` 只来自 assistant content block，不应由工具运行层主动生成。
- `toolResults` 必须回填成 user message，再进入下一轮模型输入。
- recovery / compact / stop hook 这些 retry 状态应该放在 loop state，而不是塞进 message content。
- `runtime` 可以很大，但它是工具运行上下文，不应成为 transcript 的替代品。

## 4. ToolUseContext 的边界

Claude Code 的 `ToolUseContext` 很宽，源码位置是 `src/Tool.ts:158`。它至少包含这些类别：

| 类别 | 代表字段 | 含义 |
|---|---|---|
| 工具配置 | `options.tools`、`options.mainLoopModel`、`options.mcpClients`、`options.agentDefinitions` | 本轮可用工具、模型和外部能力。 |
| 中断和执行控制 | `abortController` | 控制 streaming 和工具执行中断。 |
| 文件/内容缓存 | `readFileState`、`contentReplacementState` | 支持文件读取缓存和 tool result budget 替换。 |
| App 状态访问 | `getAppState()`、`setAppState()` | 读取/更新权限模式、MCP 状态、UI 状态等。 |
| UI/SDK 回调 | `setToolJSX`、`addNotification`、`setSDKStatus`、`requestPrompt` | 将工具执行进度和权限交互接到不同入口。 |
| 查询链路 | `queryTracking`、`agentId`、`agentType`、`toolUseId` | 区分主线程、subagent、嵌套工具调用和 telemetry。 |
| 权限/决策状态 | `toolDecisions`、`localDenialTracking`、`requireCanUseTool` | 支持权限复用、拒绝计数和特殊执行路径。 |
| transcript 视图 | `messages` | 工具执行时看到的当前 messages；`query.ts` 每轮会更新为 `messagesForQuery`。 |

外部系统复现时，建议把它拆成 `ToolRuntimeContext`，并明确它“不拥有”这些职责：

- 不决定 agent loop 是否继续；继续信号来自 assistant message 中是否存在 `tool_use`。
- 不直接修改全局 transcript；工具返回 `tool_result` 或额外消息，由 loop 统一归并。
- 不负责 provider streaming delta 聚合；provider 应输出完整 assistant message/content block。

## 5. 状态更新规则

### 5.1 每轮开始

源码确认：`queryLoop()` 每轮顶部解构 `state`，然后建立 `queryTracking`，并从 `messages` 投影出 `messagesForQuery`。位置包括 `src/query.ts:307`、`src/query.ts:340`、`src/query.ts:364`。

参考流程：

```ts
let { runtime } = state
const { messages, turn, compact, recovery } = state

runtime = {
  ...runtime,
  queryTracking: nextQueryTracking(runtime.queryTracking),
}

let messagesForQuery = projectAfterCompactBoundary(messages)
messagesForQuery = await applyContextBudget(messagesForQuery, runtime)
runtime = { ...runtime, messages: messagesForQuery }
```

### 5.2 模型 streaming 期间

源码确认：本轮局部数组在 `src/query.ts:551` 到 `src/query.ts:558` 创建。assistant message 到达后会被 push 到 `assistantMessages`，并扫描 content 中的 `tool_use`；找到工具调用就设置 `needsFollowUp = true`。位置是 `src/query.ts:821` 到 `src/query.ts:835`。

参考流程：

```ts
for await (const message of callModel(messagesForQuery)) {
  yield message

  if (message.type !== "assistant") continue

  scratch.assistantMessages.push(message)

  const blocks = message.content.filter(
    (block): block is ToolUseBlock => block.type === "tool_use",
  )

  if (blocks.length > 0) {
    scratch.toolUseBlocks.push(...blocks)
    scratch.needsFollowUp = true
    scratch.streamingToolExecutor?.addTools(blocks, message)
  }
}
```

### 5.3 没有工具调用时

没有 `tool_use` 时，loop 不会直接无条件结束。它先处理 prompt-too-long / reactive compact、max-output recovery、stop hooks、token budget continuation。只有这些分支都不要求继续时，才返回 completed。

源码确认：

- `if (!needsFollowUp)` 分支从 `src/query.ts:1062` 开始。
- reactive compact retry 会重写 `State` 并 `continue`，位置是 `src/query.ts:1152`。
- max output escalation / recovery 会重写 `State` 并 `continue`，位置是 `src/query.ts:1207` 和 `src/query.ts:1231`。
- stop hook blocking 会重写 `State` 并 `continue`，位置是 `src/query.ts:1283`。
- token budget continuation 会重写 `state` 并 `continue`，位置是 `src/query.ts:1321`。

### 5.4 有工具调用时

有 `tool_use` 时，loop 执行工具，收集 `tool_result`，然后进入下一轮。

关键 invariant：

```text
assistant message: content 包含 tool_use(id)
user message:      content 包含 tool_result(tool_use_id = id)
下一轮模型输入:    messagesForQuery + assistantMessages + toolResults
```

源码确认：

- Claude Code 不信任 `stop_reason === "tool_use"`，而是扫描 content block，位置是 `src/query.ts:553` 到 `src/query.ts:558`。
- 下一轮状态组合为 `messages: [...messagesForQuery, ...assistantMessages, ...toolResults]`，位置是 `src/query.ts:1715`。
- `turnCount` 在进入下一轮前递增，位置是 `src/query.ts:1679`。

参考流程：

```ts
const updatedRuntime = await runToolsAndCollectResults({
  toolUseBlocks: scratch.toolUseBlocks,
  assistantMessages: scratch.assistantMessages,
  runtime: state.runtime,
  out: scratch.toolResults,
})

const nextTurnCount = state.turn.count + 1

state = {
  messages: [
    ...scratch.messagesForQuery,
    ...scratch.assistantMessages,
    ...scratch.toolResults,
  ],
  runtime: updatedRuntime,
  compact: { autoTracking, hasAttemptedReactiveCompact: false },
  recovery: {
    maxOutputTokensRecoveryCount: 0,
    maxOutputTokensOverride: undefined,
    stopHookActive,
    transition: { reason: "next_turn" },
  },
  turn: {
    count: nextTurnCount,
    pendingToolUseSummary: nextPendingToolUseSummary,
  },
}
```

## 6. Message pairing 辅助索引

Loop state 本身不保存 tool-use 索引，但 Claude Code 在消息工具函数中维护查询结构，用于检查和修复 transcript。

源码确认：`MessageLookups` 位于 `src/utils/messages.ts:1146`，其中包含：

```ts
type MessageLookups = {
  toolResultByToolUseID: Map<string, NormalizedMessage>
  resolvedToolUseIDs: Set<string>
  erroredToolUseIDs: Set<string>
  // 另有 tool use / parent / id 相关索引，供消息规范化和配对检查使用。
}
```

`ensureToolResultPairing()` 位于 `src/utils/messages.ts:5133`，注释明确处理两类危险情况：

- 重复 `tool_use.id` 会导致 API 报 “tool_use ids must be unique”。
- 孤立 `tool_result.tool_use_id` 会导致 API 报 unexpected tool use id。

外部实现建议把这类索引作为派生结构，而不是持久 loop state：

```ts
type MessagePairingIndex = {
  toolUseById: Map<string, ToolUseBlock>
  toolResultByToolUseId: Map<string, UserMessage>
  resolvedToolUseIds: Set<string>
  erroredToolUseIds: Set<string>
}
```

## 7. 最小实现清单

外部系统如果只想实现 Claude Code-like loop，最小 state 可以保留这些字段：

```ts
type MinimalLoopState = {
  messages: TranscriptMessage[]
  runtime: {
    tools: ToolRegistry
    canUseTool: CanUseTool
    abortController: AbortController
    messages: TranscriptMessage[]
    queryTracking?: { chainId: string; depth: number }
  }
  turnCount: number
  recovery: {
    maxOutputTokensRecoveryCount: number
    hasAttemptedReactiveCompact: boolean
    stopHookActive?: boolean
    transition?: ContinueReason
  }
}
```

不要省掉的边界：

- `messages` 与 `messagesForQuery` 分离。
- `tool_use` 与 `tool_result` 强配对。
- 工具结果统一由 loop 回填，而不是工具直接递归调用模型。
- abort / fallback / retry 时必须补齐或清理已发出的 `tool_use`，避免下一轮出现 orphan tool result。
- recovery 状态必须有上限或 guard，防止 compact、max-output、stop hook 形成无限循环。

## 8. 源码依据

| 结论 | 源码位置 |
|---|---|
| `QueryParams` 是 query 入口参数 | `src/query.ts:181` |
| `State` 是跨 iteration mutable state | `src/query.ts:204` |
| `state` 初始化 | `src/query.ts:268` |
| 每轮顶部解构 `state` | `src/query.ts:307` |
| `messagesForQuery` 从 compact boundary 后的 messages 投影 | `src/query.ts:364` |
| 每轮 scratch 数组 | `src/query.ts:551` 到 `src/query.ts:558` |
| streaming tool executor 是每轮局部执行器 | `src/query.ts:563` |
| 扫描 assistant content 中的 `tool_use` | `src/query.ts:821` 到 `src/query.ts:835` |
| 没有 `tool_use` 时进入 recovery / stop hook / completion 分支 | `src/query.ts:1062` |
| 下一工具轮重建 `State` | `src/query.ts:1715` |
| `ToolUseContext` 类型 | `src/Tool.ts:158` |
| `ToolUseContext.messages` 字段 | `src/Tool.ts:250` |
| `MessageLookups` | `src/utils/messages.ts:1146` |
| `ensureToolResultPairing()` | `src/utils/messages.ts:5133` |

## 合理推断

- Claude Code 把 `State` 控制在较小范围，是为了让 transcript、工具上下文、恢复标记成为唯一跨轮事实源；模型 streaming、工具执行器和临时数组则随 iteration 生命周期释放。
- 外部系统如果需要持久化恢复，应该持久化 `messages`、必要的 `runtime` 标识、`turnCount` 和 compact/recovery 边界；不要持久化 `streamingToolExecutor` 这类执行期对象。

## 待验证

- 本文没有运行 Claude Code 的端到端会话，只做源码级确认。
- `types/message.js` 在当前源码树中作为 import specifier 出现，但对应 TypeScript 源文件未在 `src/types/` 下直接展开；本文的 message 结构依据 `query.ts`、`Tool.ts` 和 `utils/messages.ts` 的使用方式归纳。
