# Claude Code MessageProjection 技术方案：从 transcript 到 provider request 的可复现投影层

## 如何阅读本文

本文分析 Claude Code 中“MessageProjection”这一机制。需要先说明：当前源码镜像中没有一个直接命名为 `MessageProjection` 的类或类型；本文使用这个名字指代 Claude Code 在每次模型调用前，把完整会话历史投影成本轮模型可见窗口的机制。源码中最接近的实体是 `messagesForQuery`、`getMessagesAfterCompactBoundary()`、`normalizeMessagesForAPI()` 以及 `query.ts` 中围绕它们串起来的投影链。

推荐两条阅读路径：

- **快速判断路径**：读本节、§ Learning Question、§ Scope、§ 0 设计摘要、§ 1 心智模型、§ 2 执行流。目标是在 30 分钟内理解 MessageProjection 到底解决什么问题。
- **实现路径**：从 § 3 数据协议 顺序读到 § 10 测试计划。目标是为外部 agent 系统设计一套可落地的投影层。

文档地图：

| 目标 | 主要章节 |
|---|---|
| 快速理解 MessageProjection | § 0、§ 1、§ 2 |
| 复现投影 pipeline | § 3、§ 4、§ 5 |
| 理解 provider 前最后转换 | § 6 |
| 处理 UI、SDK、resume 差异 | § 7 |
| 做工程落地 | § 8、§ 9、§ 10、§ 11 |
| 核验源码依据 | 附录 A、附录 B |

最小闭环如下：

```text
-------------------+      read-time projection       +--------------------+
| durable transcript| ------------------------------> | messagesForQuery   |
| Message[]         |                                 | internal API view  |
+-------------------+                                 +---------+----------+
      ^                                                           |
      | loop continuation / compact / tool results                |
      |                                                           v
+-----+-------------+      provider normalization       +----------+---------+
| next State.messages| <------------------------------ | messagesForAPI     |
| fact source        |                                 | provider request   |
+-------------------+                                 +--------------------+
```

## Learning Question

本文回答一个可脱离 Claude Code 源码复用的工程问题：

```text
如果一个 agent 系统要同时支持长会话、工具调用、压缩、恢复、UI 回放、
provider 协议差异和 token 预算，应该如何把完整 transcript 投影成本轮模型请求？
```

一句话答案：

```text
不要把 transcript 直接发给模型；每轮模型调用前都生成一个可丢弃、可审计、
可恢复的 API view，再由 provider normalizer 转成最终 request。
```

## Scope

本文覆盖：

- `query.ts` 每轮模型调用前的 `messagesForQuery` 投影顺序。
- `messagesForQuery` 与 `messagesForAPI` 的边界。
- compact boundary、tool result budget、snip、microcompact、context collapse、autocompact 的顺序和职责。
- 工具执行后如何把 assistant messages、tool results、attachments 回填到下一轮 `State.messages`。
- `/context`、UI scrollback、SDK、resume 为什么不能直接使用同一视图。
- 面向外部系统的模块划分、数据协议、失败模式和测试计划。

本文不覆盖：

- `snipCompact.ts`、`snipProjection.ts` 的具体裁剪算法。当前源码镜像只有 feature-gated 引用，没有文件实体。
- `services/contextCollapse/*` 的具体算法。当前源码镜像只有 feature-gated 引用，没有完整实现文件。
- provider streaming 的全部细节。本文只分析它与投影层的接口边界。
- `mini-cc` 课程实现、lesson 注释和 build-along。

## 0. 设计摘要

### 0.1 核心方案

Claude Code 的 MessageProjection 可以拆成两级：

```text
Transcript Projection:
  Message[] -> messagesForQuery

Provider Projection:
  messagesForQuery + userContext + tools -> messagesForAPI
```

第一级在 `src/query.ts` 的 `queryLoop()` 中完成，主要解决“本轮模型应该看到哪一段历史，以及哪些历史应该被替换、折叠、压缩或总结”。第二级在 `src/services/api/claude.ts` 和 `src/utils/messages.ts` 中完成，主要解决“provider API 接受什么形状的 user/assistant messages”。

### 0.2 为什么必须有投影层

一个朴素 agent loop 可能这样做：

```ts
await callModel({ messages: transcript })
```

Claude Code 源码说明这会失败。原因不是单纯 token 太多，而是 `transcript` 同时服务多个目标：

- UI 要保留足够多历史用于 scrollback。
- resume 要从 JSONL 恢复 parent chain。
- compact 要保留 boundary 和 summary metadata。
- tool result budget 要替换大输出但保持 `tool_use_id` 稳定。
- provider 要看到合法的 `user` / `assistant` 交替和 tool result 配对。
- `/context` 要展示模型实际看到的 API view，而不是 raw history。

因此，投影层的核心职责不是“删除旧消息”，而是：

```text
在不破坏 durable transcript 的前提下，为当前模型调用构造一个临时、合法、预算内的上下文窗口。
```

### 0.3 源码确认的主链路

主链路来自 `src/query.ts`：

```text
queryLoop()
  state.messages
    -> getMessagesAfterCompactBoundary()
    -> applyToolResultBudget()
    -> snipCompactIfNeeded()                  // feature-gated，当前镜像缺具体实现
    -> microcompact()
    -> contextCollapse.applyCollapsesIfNeeded() // feature-gated，当前镜像缺具体实现
    -> autocompact()
    -> buildPostCompactMessages()             // only if compacted
    -> prependUserContext()
    -> deps.callModel()
       -> queryModelWithStreaming()
          -> normalizeMessagesForAPI()
          -> ensureToolResultPairing()
          -> provider request
```

关键源码位置：

- `src/query.ts:219` 定义 `query()`，`src/query.ts:241` 进入 `queryLoop()`。
- `src/query.ts:365` 从 `getMessagesAfterCompactBoundary(messages)` 得到 `messagesForQuery`。
- `src/query.ts:379` 执行 `applyToolResultBudget()`。
- `src/query.ts:403` 调用 feature-gated `snipCompactIfNeeded()`。
- `src/query.ts:415` 调用 `deps.microcompact()`。
- `src/query.ts:442` 调用 feature-gated `contextCollapse.applyCollapsesIfNeeded()`。
- `src/query.ts:455` 调用 `deps.autocompact()`。
- `src/query.ts:528` 到 `src/query.ts:535` 将 autocompact 结果转成 post-compact messages。
- `src/query.ts:659` 到 `src/query.ts:660` 调 provider 前执行 `prependUserContext(messagesForQuery, userContext)`。
- `src/services/api/claude.ts:1266` 执行 `normalizeMessagesForAPI(messages, filteredTools)`。

## 1. 全局心智模型

### 1.1 三个不要混淆的视图

| 视图 | 源码对应 | 生命周期 | 谁使用 | 不应该做什么 |
|---|---|---|---|---|
| `transcript` | `State.messages`、`QueryEngine.mutableMessages`、session JSONL | 持久或跨轮 | UI、resume、审计、下一轮投影 | 不应直接发给 provider |
| `messagesForQuery` | `src/query.ts` 局部变量 | 单次 loop iteration | tool runtime、compact、stop hooks、下一轮 state 构造 | 不应当成最终 provider request |
| `messagesForAPI` | `normalizeMessagesForAPI()` 输出 | 单次 provider request | Anthropic/Bedrock/Vertex/Foundry 等 API | 不应反写为唯一 transcript |

最容易错的是把 `messagesForQuery` 叫作“最终上下文”。它仍然可能包含 attachment、内部 system、progress 过滤前形态、连续 user messages、未修复的 tool pairing 等结构。真正 provider request 还要经过 `normalizeMessagesForAPI()` 和 provider-specific post-processing。

### 1.2 Key Terms

| 术语 | 含义 |
|---|---|
| durable transcript | 会话事实源。可以包含 UI-only、system boundary、attachment、progress、compact metadata 等内部消息。 |
| projection | 读时生成的临时视图，不等同于删除历史。 |
| compact boundary | 手动或自动 compact 后写入的 system marker，用来切断旧 transcript 前缀。 |
| tool result budget | 在投影层把大 tool result 替换为稳定 preview，避免单条 wire user message 超预算。 |
| snip | feature-gated 历史中段裁剪机制。当前镜像可确认调用位置和恢复边界，不能确认算法。 |
| microcompact | 对工具结果等可压缩内容做轻量压缩或 cache editing，通常早于 autocompact。 |
| context collapse | feature-gated 读时折叠机制。目标是用摘要占位替换部分历史，避免触发完整 autocompact。 |
| autocompact | 达到阈值后调用 summarizer，生成 compact boundary、summary messages、保留尾部和恢复 attachments。 |
| provider normalization | 把内部 `Message[]` 变成 provider 可接受的 `(UserMessage | AssistantMessage)[]`。 |

### 1.3 常见失败模式

| 失败模式 | 现象 | 修正方向 |
|---|---|---|
| 直接发送 transcript | compact 前历史和 summary 同时进入模型，token 暴涨或语义冲突 | 每轮先通过 projection 生成 `messagesForQuery` |
| 把 UI scrollback 当模型窗口 | 用户看到的历史与模型实际可见内容不一致，调试误判 | UI 和 API view 分离，`/context` 显示 API view |
| 在存储层永久改写 provider request | resume、审计、UI、compact metadata 丢失 | 投影是 read-time view，只把必要 boundary/summary 作为事件写回 |
| 大工具结果按内部消息逐条预算 | 多个 user messages 到 API 层被合并后仍超限 | 按 `normalizeMessagesForAPI()` 的合并规则分组预算 |
| compact 切断 tool_use/tool_result pair | provider 400，或者模型看见无配对工具结果 | projection 和 compact 必须维护 API invariants |
| snip 删除 JSONL 中段但不 relink | resume 后 parent chain 断裂或旧历史复活 | boundary 记录 removed UUIDs，恢复时删除并 relink |
| 只做 `messagesForQuery` 不做 provider normalization | progress/system/virtual/unsupported blocks 泄漏到 API | provider boundary 前统一 normalize 和 pairing 修复 |

## 2. Execution Flow：一次模型调用前后发生什么

### 2.1 loop state 到 iteration scratch

`src/query.ts` 把状态分成两层：

- `QueryParams`：本次 `query()` 的入口参数，见 `src/query.ts:181`。
- `State`：`queryLoop()` 跨 iteration 携带的可变状态，见 `src/query.ts:207`。

每次 `while(true)` 顶部从 `state` 解构当前 iteration 要用的字段。随后创建局部 `messagesForQuery`、`assistantMessages`、`toolResults`、`toolUseBlocks`、`needsFollowUp` 等 scratch 状态。

源码确认：

- `src/query.ts:263` 使用 `productionDeps()` 或测试注入 deps。
- `src/query.ts:302` 启动 relevant memory prefetch 时读取 `state.messages`。
- `src/query.ts:365` 创建 `messagesForQuery`。
- `src/query.ts:551` 到 `src/query.ts:558` 创建本轮 assistant/tool scratch。

### 2.2 投影 pipeline 顺序

| 顺序 | 源码位置 | 输入 | 输出 | 作用 |
|---:|---|---|---|---|
| 1 | `src/query.ts:365` | `messages` | compact slice | 从最后一个 compact boundary 开始取消息；默认还会过滤 snip removed messages |
| 2 | `src/query.ts:379` | compact slice | budgeted messages | 替换过大的 tool result 内容 |
| 3 | `src/query.ts:403` | budgeted messages | snipped messages | feature-gated，snip 在 microcompact 前运行 |
| 4 | `src/query.ts:415` | snipped messages | microcompacted messages | 轻量 compact 或 cache editing |
| 5 | `src/query.ts:442` | microcompacted messages | collapsed view | feature-gated，context collapse 在 autocompact 前运行 |
| 6 | `src/query.ts:455` | collapsed view | optional compaction result | 判断是否触发 autocompact |
| 7 | `src/query.ts:528` | compaction result | post-compact messages | 成功 compact 后替换本轮内部投影视图 |
| 8 | `src/query.ts:548` | final `messagesForQuery` | `toolUseContext.messages` | 工具运行上下文看到本轮投影 |
| 9 | `src/query.ts:660` | `messagesForQuery` + `userContext` | provider input messages | 添加 meta user context reminder |
| 10 | `src/services/api/claude.ts:1266` | provider input messages | `messagesForAPI` | provider normalization |

### 2.3 ASCII sequence

```text
queryLoop iteration
  |
  | state.messages
  v
getMessagesAfterCompactBoundary()
  |
  v
applyToolResultBudget()
  |
  v
snipCompactIfNeeded()?          [feature-gated]
  |
  v
microcompactMessages()
  |
  v
contextCollapse.project/apply()? [feature-gated]
  |
  v
autoCompactIfNeeded()
  |             \
  | no compact   \ compacted
  |               v
  |          buildPostCompactMessages()
  v
messagesForQuery
  |
  +--> toolUseContext.messages
  |
  v
prependUserContext()
  |
  v
queryModelWithStreaming()
  |
  v
normalizeMessagesForAPI()
  |
  v
provider request
```

### 2.4 工具执行后的下一轮 state

如果模型没有请求工具，`queryLoop()` 进入 stop hooks、token budget 等收尾路径后返回。若模型请求工具，则执行工具，收集 `toolResults` 和 mid-turn attachments，然后构造下一轮 `State`：

```text
next.messages = [
  ...messagesForQuery,
  ...assistantMessages,
  ...toolResults,
]
```

源码确认：

- `src/query.ts:1396` 把工具 update message 通过 `normalizeMessagesForAPI([update.message], tools)` 转成 user-side tool result 加进 `toolResults`。
- `src/query.ts:1585` 把 mid-turn attachments 基于 `messagesForQuery + assistantMessages + toolResults` 生成。
- `src/query.ts:1716` 构造下一轮 `State.messages`。

设计结论：

```text
下一轮事实源不是原始 transcript 简单 append，而是以上一轮投影窗口为基底，
再追加本轮 assistant output 和工具/附件回填。
```

这保证 compact、snip、collapse 等投影结果在同一 `query()` 调用内继续生效，不会因为工具回填又把旧历史带回来。

## 3. 数据协议：外部系统应该暴露什么接口

### 3.1 推荐 API

```ts
type ProjectMessagesInput = {
  transcript: AgentMessage[]
  userContext: Record<string, string>
  systemPrompt: SystemPromptBlock[]
  systemContext: Record<string, string>
  tools: ToolDefinition[]
  runtime: AgentRuntimeContext
  querySource: QuerySource
  model: string
}

type ProjectionDiagnostics = {
  sourceMessageCount: number
  queryMessageCount: number
  apiMessageCount: number
  appliedTransforms: string[]
  estimatedTokensBeforeProvider: number
  snipTokensFreed?: number
  compacted?: boolean
  warnings: string[]
}

type ProjectMessagesOutput = {
  internalWindow: AgentMessage[]      // Claude Code 的 messagesForQuery
  providerMessages: ProviderMessage[] // Claude Code 的 messagesForAPI
  systemPrompt: ProviderSystemPrompt
  diagnostics: ProjectionDiagnostics
}
```

### 3.2 Message 层级

Claude Code 的 `Message` 类型定义文件在当前源码镜像中不可见，但调用点可以确认主要类别：

- `user`：由 `createUserMessage()` 创建，包含 `message.role = "user"`、`content`、`isMeta`、`isVisibleInTranscriptOnly`、`isVirtual`、`uuid`、`timestamp` 等字段，见 `src/utils/messages.ts:460`。
- `assistant`：由 `createAssistantMessage()` / `baseCreateAssistantMessage()` 创建，包含 provider message shape、`uuid`、`timestamp`、`requestId`、`isApiErrorMessage` 等字段，见 `src/utils/messages.ts:411`。
- `attachment`：由 `createAttachmentMessage()` 创建，包含 typed `attachment`、`uuid`、`timestamp`，见 `src/utils/attachments.ts:3201`。
- `system`：包括 compact boundary、microcompact boundary、api error、local command 等，`createCompactBoundaryMessage()` 位于 `src/utils/messages.ts:4530`，`createMicrocompactBoundaryMessage()` 位于 `src/utils/messages.ts:4557`。
- `progress` / `stream_event` / `tombstone` / `tool_use_summary`：在 `query.ts`、`QueryEngine.ts` 和 UI 中作为内部状态或输出事件处理。

设计要点：

```text
Message 是内部 transcript 事件，不等于 provider MessageParam。
```

`normalizeMessagesForAPI()` 只返回 `UserMessage | AssistantMessage`，这说明 attachment、progress、普通 system 等都不是 provider 原生消息。

### 3.3 `isMeta` 的意义

`createUserMessage()` 支持 `isMeta?: true`。源码中的 user context、很多 attachments、recovery prompt 都以 meta user message 注入。`shouldShowUserMessage()` 会在非 transcript 视图中过滤大多数 meta user message，见 `src/utils/messages.ts:4658`。

`isMeta` 不是“不会发给模型”的意思。相反，很多 meta message 只是不展示给默认 UI，但会进入模型上下文。外部系统应把它理解为：

```text
这条 user message 来自系统/运行时注入，不是键盘用户直接输入。
```

## 4. 核心 transform 详解

### 4.1 Compact Boundary Slice

入口：

- `src/utils/messages.ts:4611` `isCompactBoundaryMessage()`
- `src/utils/messages.ts:4620` 左右 `findLastCompactBoundaryIndex()`
- `src/utils/messages.ts:4635` 左右 `getMessagesAfterCompactBoundary()`

源码行为：

```text
boundaryIndex = findLastCompactBoundaryIndex(messages)
sliced = boundaryIndex === -1 ? messages : messages.slice(boundaryIndex)
if HISTORY_SNIP and !includeSnipped:
    return projectSnippedView(sliced)
return sliced
```

设计含义：

- compact boundary 是投影层第一道切线。
- boundary 本身留在 slice 中，但 provider normalization 会过滤普通 system message。
- snip filtering 被合并在这个函数内，说明调用方通常想要“compact 后 + snip 后”的 active context。

注意：`includeSnipped: true` 是 UI 特例，不是模型调用默认行为。

### 4.2 Tool Result Budget

入口：

- `src/query.ts:379` `applyToolResultBudget()`
- `src/utils/toolResultStorage.ts` 中 `collectCandidatesByMessage()`、`partitionByPriorDecision()`、`selectFreshToReplace()`、`replaceToolResultContents()`

源码确认：

- `query.ts` 注释说明它在 microcompact 前运行，因为 cached microcompact 只按 `tool_use_id` 操作，不检查内容。
- `toolResultStorage.ts` 明确按照 `normalizeMessagesForAPI()` 的 wire-level 合并规则收集候选：连续 user messages 会在 provider 前合并，progress/attachment/system 不形成 wire boundary，只有新的 assistant message 通常形成边界。
- replacement 决策分为 `mustReapply`、`frozen`、`fresh`，避免跨轮改变已缓存前缀。

设计结论：

```text
工具结果预算必须按 provider 最终会看到的 user turn 分组，而不是按内部 Message[] 的物理条数分组。
```

否则并行工具结果在内部看是多条 user message，到了 provider 变成一条巨大的 user message，预算会漏判。

### 4.3 Snip

入口：

- `src/query.ts:403` `snipCompactIfNeeded(messagesForQuery)`
- `src/utils/messages.ts:4650` `projectSnippedView(sliced)`
- `src/QueryEngine.ts:1278` `snipReplay`
- `src/utils/sessionStorage.ts:1962` 附近 `applySnipRemovals()`

源码确认：

- snip 在 microcompact 前执行。
- `snipTokensFreed` 被传给 autocompact 和 blocking limit 判断，因为 surviving assistant 的 usage 仍可能反映 pre-snip context，`tokenCountWithEstimation()` 看不到 snip 节省。
- SDK/headless `QueryEngine` 对 snip boundary 走 replay：如果 yield 的 system message 是 snip boundary，就对 `mutableMessages` 重新执行 `snipCompactIfNeeded(store, { force: true })`，避免 marker 每轮重复触发和内存不收敛。
- session resume 会根据 snip boundary 中的 `removedUuids` 删除 JSONL 中仍存在的消息，并 relink dangling `parentUuid`。

待验证：

- 当前源码镜像没有 `src/services/compact/snipCompact.ts` 和 `src/services/compact/snipProjection.ts` 文件实体，所以不能确认 snip 如何选择裁剪范围、boundary message 具体 subtype 和 marker 协议。

外部系统可先复现边界协议：

```ts
type SnipBoundary = {
  kind: "snip_boundary"
  removedMessageIds: string[]
  tokensFreedEstimate: number
}
```

关键不是先实现复杂选择算法，而是保证：

- active context 投影会过滤 removed IDs。
- durable transcript 仍能审计 boundary。
- resume 会 replay removal 并 relink parent chain。
- token threshold 使用 adjusted token estimate。

### 4.4 Microcompact

入口：

- `src/query.ts:415` `deps.microcompact(messagesForQuery, toolUseContext, querySource)`
- `src/services/compact/microCompact.ts:253` `microcompactMessages()`

源码确认：

- time-based microcompact 先执行；如果最后一个 main-loop assistant 距今超过配置阈值，说明 server cache 可能已经冷却，于是直接清理旧工具结果内容。
- cached microcompact 只在支持模型和 main thread source 下启用，使用 cache editing API 删除工具结果而不改本地 message content。
- 如果这些路径都不适用，当前 legacy microcompact 已移除，返回原 messages。

设计结论：

```text
microcompact 是“轻量降上下文压力”的阶段，不必总是修改 transcript；
它可能只生成 API 层 cache edit 信息，也可能直接替换旧 tool_result 内容。
```

### 4.5 Context Collapse

入口：

- `src/query.ts:442` `contextCollapse.applyCollapsesIfNeeded()`
- `/context` 中 `projectView()`：`src/commands/context/context.tsx`

源码确认：

- context collapse 在 autocompact 前运行。
- `query.ts` 注释说明，如果 collapse 已把上下文降到 autocompact 阈值下，就避免 autocompact 把粒度上下文替换为单一 summary。
- collapse 是读时投影：summary messages 存在 collapse store，不直接塞进 REPL array；每次 `projectView()` 重放 commit log。
- `src/commands/context/context.tsx` 的 `toApiView()` 也调用 `projectView()`，避免 `/context` 显示 raw history token 数。

待验证：

- 当前源码镜像没有完整 `src/services/contextCollapse/*` 实体，只能确认调用顺序、读时投影性质和与 autocompact 的边界。

### 4.6 Autocompact

入口：

- `src/query.ts:455` `deps.autocompact()`
- `src/services/compact/autoCompact.ts:241` `autoCompactIfNeeded()`
- `src/services/compact/compact.ts:330` `buildPostCompactMessages()`

源码确认：

- `shouldAutoCompact()` 会排除 `session_memory`、`compact` 等 querySource，避免压缩子任务死锁。
- 如果 auto compact disabled、reactive-only mode 或 context collapse 接管上下文管理，则 proactive autocompact 不触发。
- token 估算使用 `tokenCountWithEstimation(messages) - snipTokensFreed`。
- 成功 compact 后优先尝试 session memory compaction；否则调用 `compactConversation()`。
- `buildPostCompactMessages()` 输出顺序固定：`boundaryMarker, summaryMessages, messagesToKeep, attachments, hookResults`。

设计结论：

```text
autocompact 是投影链中少数会产生可持久 boundary/summary 事件的阶段。
它不是 provider normalization；它改变之后 loop 内继续使用的 internal window。
```

## 5. Provider Projection：`messagesForQuery` 如何变成 `messagesForAPI`

### 5.1 User Context 前置

`src/utils/api.ts:449` 的 `prependUserContext()` 在非测试环境下把 `userContext` 渲染成一条 `isMeta: true` 的 user message，放到 messages 最前面。

它的作用是把 CLAUDE.md、日期、项目上下文等动态信息作为 user-side reminder，而不是混入 system prompt。这使 system prompt 更稳定，动态上下文也更容易在投影层管理。

### 5.2 Provider normalizer 入口

`src/services/api/claude.ts:1266`：

```text
messagesForAPI = normalizeMessagesForAPI(messages, filteredTools)
```

随后 provider 层继续执行：

- 模型不支持 tool search 时，去掉 tool-search-only 字段。
- `ensureToolResultPairing(messagesForAPI)` 修复 tool_use/tool_result mismatch。
- `stripAdvisorBlocks()` 移除当前 beta 不支持的 advisor blocks。
- `stripExcessMediaItems()` 限制媒体数量。
- 可能注入 deferred tools 提示。

这说明 `messagesForQuery` 仍不是最终 provider request。

### 5.3 `normalizeMessagesForAPI()` 的主要转换

入口：`src/utils/messages.ts:1989`

| 转换 | 源码行为 | 设计目的 |
|---|---|---|
| attachment reorder | `reorderAttachmentsForAPI()` 先把 attachment 调整到合适位置 | 避免附件破坏 tool result 批次 |
| virtual filter | 过滤 `isVirtual` user/assistant | display-only message 不进 API |
| system/progress/error filter | progress、普通 system、synthetic API error 不进 API | 保持 provider message 合法 |
| local_command 转 user | local command output 变 user message | 模型可引用历史本地命令输出 |
| user merge | 连续 user messages 合并 | 适配 Bedrock；也匹配一方 API 行为 |
| tool_reference strip | 按 tool search 支持情况和可用工具过滤 | 避免不支持字段导致 provider 400 |
| assistant normalize | tool_use input 标准化，去掉 tool-search-only 字段 | 防止 stale session 字段污染新模型 |
| assistant merge | 同 `message.id` 的 assistant fragments 合并 | streaming 拆块后恢复同一 assistant response |
| thinking cleanup | 过滤 orphan/trailing thinking | 避免 thinking signature 相关 API 错误 |
| empty content repair | 确保 assistant 非空 | 避免 provider 拒绝空 assistant |
| media validate | 校验 image size | 提前发现不可发送内容 |
| snip id tag | HISTORY_SNIP 开启时给 user message 加 `[id:]` tag | 让模型可以引用 message id 进行 snip |

设计结论：

```text
Provider normalizer 是 MessageProjection 的第二级，不是简单 serializer。
它同时承担协议合法性、模型能力差异、恢复兼容和缓存稳定性。
```

## 6. 投影层与恢复路径

### 6.1 Prompt-too-long 和 reactive retry

如果 provider 返回 prompt-too-long，`query.ts` 在 `needsFollowUp === false` 分支中处理：

- context collapse 可先 drain staged collapse，再重试。
- reactive compact 可尝试总结后重试。
- 如果恢复失败，才 yield withheld error 并返回。

源码位置集中在 `src/query.ts:1062` 之后。

设计含义：

```text
Projection 不只是请求前预算，还参与请求失败后的恢复决策。
```

外部系统应把 413/PTL 视作投影层可处理的反馈，而不是直接把错误交给用户。

### 6.2 Max output tokens recovery

当模型输出达到 max output limit 时，`query.ts` 会构造 meta user recovery message，让下一轮从中断处继续，而不是直接结束。这条 recovery message 被追加到：

```text
[
  ...messagesForQuery,
  ...assistantMessages,
  recoveryMessage,
]
```

这再次体现：下一轮基底是当前投影窗口，而不是 raw transcript。

### 6.3 Stop hooks 和 token budget continuation

stop hooks blocking errors、token budget continuation 都会构造新的 `State.messages`：

```text
messagesForQuery + assistantMessages + injected user/meta messages
```

这些路径说明 MessageProjection 是 loop state 的中轴：所有“继续生成”的原因最终都回到一个新的 projected state，而不是回到原始历史。

## 7. UI、SDK、Resume 的差异边界

### 7.1 `/context` 显示 API view

`src/commands/context/context.tsx` 中的 `toApiView()` 先调用 `getMessagesAfterCompactBoundary()`，再 feature-gated 调用 `projectView()`。注释明确说明 `/context` 应显示模型实际看到的内容，而不是 REPL raw history。

`src/commands/context/context-noninteractive.ts` 也走同样思路，`collectContextData()` 注释称它 mirror `query.ts` 的 pre-API transforms。

设计结论：

```text
上下文可视化工具必须复用投影逻辑，否则用户看到的 token ledger 会误导调试。
```

### 7.2 UI 保留 scrollback，但模型过滤 snip

`src/components/Messages.tsx` 中 UI 渲染使用 `getMessagesAfterCompactBoundary(normalizedMessages, { includeSnipped: true })`。注释说明 UI rendering 保留 snipped messages 用于 scrollback，避免把模型过滤策略误用到 UI。

`src/components/Message.tsx` 对 snip boundary message 做特殊渲染，对 snip marker message 返回 `null`。

设计结论：

```text
UI projection 与 model projection 不是同一个函数调用参数。
```

### 7.3 SDK / headless QueryEngine 的内存收敛

`src/QueryEngine.ts` 的 `snipReplay` 注释说明：

- REPL 保留完整历史用于 UI scrollback，并按需通过 `projectSnippedView` 投影。
- `QueryEngine` 没有同样 UI 需求，因此遇到 snip boundary 时重放 snip，以删除 zombie messages 和 stale markers，限制长 SDK session 的内存增长。

compact boundary 也类似：`QueryEngine` 在 yield compact boundary 给 SDK 后，会把 boundary 前消息从 `mutableMessages` 和局部 `messages` 中 splice 掉。

设计结论：

```text
同一个投影事件在不同 host 中可以有不同物理内存策略，
但对模型可见窗口必须保持一致。
```

### 7.4 Resume replay

`src/utils/sessionStorage.ts` 的 `applySnipRemovals()` 解决 append-only JSONL 与 snip 中段删除之间的冲突：

- boundary 记录 `removedUuids`。
- resume 时从 Map 中删除这些 UUID。
- surviving message 如果 parentUuid 指向删除区域，就沿 deleted parent links 找到第一个非删除 ancestor 并 relink。

设计结论：

```text
持久化层不能只记录“当前投影视图”；它要记录足够的边界 metadata，
让 resume 能重放投影效果并保持 conversation chain 连续。
```

## 8. 模块职责拆分

| 模块 | 负责 | 不负责 |
|---|---|---|
| `TranscriptStore` | append-only 保存 Message events、boundary metadata、parent chain | 判断当前模型该看哪些消息 |
| `MessageProjector` | 从 transcript 生成 `messagesForQuery`，执行 boundary/snip/budget/microcompact/collapse/autocompact | 直接构造 provider-specific JSON |
| `ToolResultBudgeter` | 按 wire-level user group 替换大工具结果，并冻结替换决策 | 总结整段对话 |
| `CompactService` | 生成 boundary、summary、messagesToKeep、恢复 attachments | 管 UI scrollback |
| `ProviderNormalizer` | 过滤内部消息、合并 user/assistant、修复 tool pairing、清理 unsupported blocks | 修改 durable transcript |
| `ContextLedger` | 展示 API view token 分类和预算 | 展示 raw transcript 作为模型上下文 |
| `ResumeProjector` | 根据 compact/snip metadata 重放删除、relink、恢复 content replacement state | 发起新模型调用 |
| `HostPolicyAdapter` | 决定 REPL、SDK、remote host 如何物理保留或释放历史 | 改变模型可见语义 |

## 9. 外部系统最小实现

### 9.1 MVP pipeline

```ts
async function projectMessages(input: ProjectMessagesInput): Promise<ProjectMessagesOutput> {
  const diagnostics: ProjectionDiagnostics = {
    sourceMessageCount: input.transcript.length,
    queryMessageCount: 0,
    apiMessageCount: 0,
    appliedTransforms: [],
    estimatedTokensBeforeProvider: 0,
    warnings: [],
  }

  let internalWindow = getMessagesAfterLastCompactBoundary(input.transcript)
  diagnostics.appliedTransforms.push("compact-boundary")

  internalWindow = await applyToolResultBudget(internalWindow, input.runtime.contentReplacementState)
  diagnostics.appliedTransforms.push("tool-result-budget")

  if (input.runtime.snipEnabled) {
    const snip = projectSnippedView(internalWindow, input.runtime.snipState)
    internalWindow = snip.messages
    diagnostics.snipTokensFreed = snip.tokensFreed
    diagnostics.appliedTransforms.push("snip")
  }

  internalWindow = await microcompact(internalWindow, input.runtime, input.querySource)
  diagnostics.appliedTransforms.push("microcompact")

  if (input.runtime.contextCollapseEnabled) {
    internalWindow = await projectCollapsedView(internalWindow, input.runtime.collapseStore)
    diagnostics.appliedTransforms.push("context-collapse")
  }

  const compact = await autoCompactIfNeeded({
    messages: internalWindow,
    runtime: input.runtime,
    systemPrompt: input.systemPrompt,
    userContext: input.userContext,
    systemContext: input.systemContext,
    querySource: input.querySource,
    snipTokensFreed: diagnostics.snipTokensFreed ?? 0,
  })

  if (compact) {
    internalWindow = buildPostCompactMessages(compact)
    diagnostics.compacted = true
    diagnostics.appliedTransforms.push("autocompact")
  }

  const withUserContext = prependUserContext(internalWindow, input.userContext)
  const providerMessages = normalizeMessagesForProvider(withUserContext, input.tools, input.model)

  diagnostics.queryMessageCount = internalWindow.length
  diagnostics.apiMessageCount = providerMessages.length
  diagnostics.estimatedTokensBeforeProvider = estimateTokens(internalWindow)

  return {
    internalWindow,
    providerMessages,
    systemPrompt: appendSystemContext(input.systemPrompt, input.systemContext),
    diagnostics,
  }
}
```

### 9.2 MVP 必须满足的 invariants

| Invariant | 为什么 |
|---|---|
| compact boundary 前消息默认不进入 `internalWindow` | 防止 summary 和旧原文重复 |
| tool_use 和 tool_result 不能被投影切断 | provider 协议要求配对 |
| provider normalizer 不反写 transcript | 避免存储层丢失 UI/resume 信息 |
| meta user message 可进模型但默认不进普通 UI | 区分系统注入和用户输入 |
| UI context ledger 使用 API view | 用户调试时看到真实模型窗口 |
| resume 能重放 snip/compact boundary | append-only transcript 与 active context 保持一致 |

## 10. 测试计划

### 10.1 单元测试

| 测试 | 断言 |
|---|---|
| compact boundary slice | 最后一个 boundary 前的消息不进入 `messagesForQuery` |
| boundary included but provider filtered | boundary 留在 internal window，`normalizeMessagesForAPI()` 后不出现普通 system |
| user context prepend | 非空 userContext 生成 `isMeta: true` user message，空 context 不注入 |
| tool result budget grouping | 多个内部 user tool results 在 wire-level 同组时按总大小预算 |
| assistant same-id merge | 同一 `message.id` 的 assistant fragments 在 API 前合并 |
| progress/system filter | progress 和普通 system 不进入 `messagesForAPI` |
| attachment normalization | attachment 转为 user-side provider message，并与相邻 user 合并 |

### 10.2 集成测试

| 场景 | 断言 |
|---|---|
| 长工具输出后继续一轮 | 下一轮 request 中大 tool result 被稳定 preview 替换 |
| 手动 compact 后继续 | request 只包含 boundary 后 summary/tail/attachments，不包含旧全文 |
| autocompact 成功 | 当前 query 内后续请求使用 `buildPostCompactMessages()` 输出 |
| tool call 后 follow-up | 下一轮 `State.messages` 是 `messagesForQuery + assistantMessages + toolResults` |
| `/context` | 显示 compact/collapse/microcompact 后的 API view token，而不是 raw transcript |
| SDK compact boundary | boundary 前 mutable history 被释放，但 SDK 仍收到 compact boundary event |

### 10.3 Resume 测试

| 场景 | 断言 |
|---|---|
| compact boundary resume | boundary 前未保留消息不会重新进入 active context |
| snip boundary resume | removed UUIDs 被删除，survivor parentUuid 被 relink |
| content replacement resume | 已替换 tool result 使用同一 preview，不重新采样 |
| older snip boundary 缺 removedUuids | 标为兼容路径，不假装已过滤 |

### 10.4 Provider compatibility 测试

| 场景 | 断言 |
|---|---|
| Bedrock-style 连续 user | normalizer 合并连续 user messages |
| tool search disabled | tool_reference 和 caller 等字段被清理 |
| orphan tool_result | pairing repair 剥离或补 synthetic error |
| trailing thinking | thinking-only orphan 不导致 provider 400 |
| media 超量 | oldest media 被 strip 或提前报可恢复错误 |

## 11. 部署层级

| 阶段 | 必须实现 | 可以暂缓 |
|---|---|---|
| MVP | compact boundary slice、tool result budget、userContext prepend、provider normalizer、tool pairing repair、context ledger | snip、context collapse、cached microcompact |
| Production | autocompact、post-compact restoration、resume replay、content replacement freeze、prompt-too-long recovery | session memory compact、cache editing |
| Enterprise | host-specific retention policy、SDK/remote/replay 一致性、collapse/snippet audit、观测指标、跨 provider compatibility suite | 复杂自动 snip 策略可按需启用 |

## 12. Verification

本轮验证方式是静态源码追踪和文档自检：

- 使用 `rg` 搜索 `MessageProjection|projection|snipProjection|messagesForQuery|normalizeMessagesForAPI`，确认当前镜像没有直接 `MessageProjection` 符号。
- 阅读并交叉核对 `src/query.ts`、`src/QueryEngine.ts`、`src/utils/messages.ts`、`src/utils/api.ts`、`src/services/api/claude.ts`、`src/services/compact/*`、`src/utils/toolResultStorage.ts`、`src/utils/sessionStorage.ts`、`src/commands/context/*`、`src/components/Messages.tsx`。
- 未运行 runtime 测试：仓库根目录当前没有 `package.json`，且 `snipCompact.ts`、`snipProjection.ts`、`contextCollapse` 相关实体文件在当前源码镜像中缺失，无法对这些 feature-gated 分支做端到端执行验证。

## 13. 合理推断与待验证

### 13.1 源码确认

- `MessageProjection` 不是当前源码镜像中的直接类名；源码用 `messagesForQuery` 表示本轮内部投影视图。
- `queryLoop()` 每轮从 `getMessagesAfterCompactBoundary(messages)` 开始构造 `messagesForQuery`。
- 投影顺序是 compact boundary、tool result budget、snip、microcompact、context collapse、autocompact。
- autocompact 成功后，`buildPostCompactMessages()` 的输出会替换当前 `messagesForQuery`。
- provider 调用前，`query.ts` 会把 `userContext` 通过 `prependUserContext()` 放到 request messages 前面。
- provider 层会调用 `normalizeMessagesForAPI()`，随后执行 tool-search/model 能力清理、tool pairing repair、advisor/media stripping 等。
- 工具执行后的下一轮 state 使用 `messagesForQuery + assistantMessages + toolResults`，而不是回到 raw transcript。
- `/context` 命令显式复用 API view 逻辑，避免显示 raw history。
- UI 可通过 `includeSnipped: true` 保留 snipped scrollback，而模型默认过滤。
- session resume 通过 snip boundary metadata replay 中段删除并 relink parent chain。

### 13.2 合理推断

- Claude Code 的上下文工程核心是“读时投影 + provider normalization”，而不是单一 prompt 拼接器。
- `messagesForQuery` 是 loop continuation 的事实基底，因此 compact/snip/collapse 的效果会在同一 `query()` 调用内继续生效。
- prompt cache 稳定性是 tool result budget、microcompact、system/user context 分离的重要设计约束。
- 外部系统若没有 `ContextLedger` 或 `/context` 等价能力，很难调试用户看到的历史与模型实际上下文之间的差异。

### 13.3 待验证

- `snipCompactIfNeeded()` 的具体裁剪策略、boundary subtype、marker 协议和 runtime enable 条件。
- `projectSnippedView()` 的具体实现和 removed UUID 匹配策略。
- `contextCollapse.applyCollapsesIfNeeded()` 的 span 选择、summary store、commit log 和 recovery 策略。
- `reactiveCompact.tryReactiveCompact()` 的完整实现细节。
- `src/types/message.js` 对应的 TypeScript 源文件在当前镜像中不可见，本文对 `Message` shape 的描述来自创建函数、mappers 和调用点，而非完整类型定义文件。

## 附录 A：源码依据 / 设计来源校验

| 结论 | 源码路径 | 关键符号或位置 |
|---|---|---|
| `query()` 和 `queryLoop()` 是主入口 | `src/query.ts` | `query()` at `:219`, `queryLoop()` at `:241` |
| 入口参数包含 messages/system/user/tool context | `src/query.ts` | `QueryParams` at `:181` |
| loop state 跨 iteration 携带 messages 等字段 | `src/query.ts` | `State` at `:207` |
| 创建 `messagesForQuery` | `src/query.ts` | `getMessagesAfterCompactBoundary()` at `:365` |
| 工具结果预算在 microcompact 前 | `src/query.ts`, `src/utils/toolResultStorage.ts` | `applyToolResultBudget()` at `src/query.ts:379` |
| snip 在 microcompact 前 | `src/query.ts` | `snipCompactIfNeeded()` at `:403` |
| microcompact | `src/query.ts`, `src/services/compact/microCompact.ts` | `deps.microcompact()` at `src/query.ts:415`, `microcompactMessages()` at `microCompact.ts:253` |
| context collapse 在 autocompact 前 | `src/query.ts` | `applyCollapsesIfNeeded()` at `:442` |
| autocompact | `src/query.ts`, `src/services/compact/autoCompact.ts` | `deps.autocompact()` at `src/query.ts:455`, `autoCompactIfNeeded()` at `autoCompact.ts:241` |
| post-compact messages 顺序 | `src/services/compact/compact.ts` | `buildPostCompactMessages()` at `:330` |
| user context 前置为 meta user message | `src/utils/api.ts` | `prependUserContext()` at `:449` |
| provider normalization | `src/services/api/claude.ts`, `src/utils/messages.ts` | `normalizeMessagesForAPI()` at `claude.ts:1266`, function at `messages.ts:1989` |
| tool result budget 按 wire user group | `src/utils/toolResultStorage.ts` | `collectCandidatesByMessage()` 注释和实现 |
| `/context` 使用 API view | `src/commands/context/context.tsx`, `src/commands/context/context-noninteractive.ts` | `toApiView()`, `collectContextData()` |
| UI 保留 snipped scrollback | `src/components/Messages.tsx` | `includeSnipped: true` |
| QueryEngine 处理 snip/compact boundary | `src/QueryEngine.ts` | `snipReplay`, system switch, compact boundary splice |
| snip resume replay | `src/utils/sessionStorage.ts` | `applySnipRemovals()` |
| SDK/internal message mapping | `src/utils/messages/mappers.ts` | `toInternalMessages()`, `toSDKMessages()` |

## 附录 B：和现有 context engineering 文档的关系

`docs/wiki-source/cc/analysis/claude-code-context-engineering-technical-scheme.md` 已经从全局上下文工程角度覆盖了 system/user context、attachments、tool budget、compact、memory、skills 等主题。本文是其中“消息投影”链路的专题展开，边界更窄：

- 那篇文档回答“Claude Code 的上下文工程整体怎么设计”。
- 本文回答“每轮模型调用前，Message[] 到 provider request 的投影层怎么设计”。

两者可以互相引用，但本文不替代全局上下文工程方案。
