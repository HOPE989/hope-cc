# Claude Code MessageProjection 方法级源码分析：投影链上每个方法到底做什么

## 如何阅读本文

这版文档只回答一个窄问题：Claude Code 在 `queryLoop()` 里把 `messages` 变成当前模型调用窗口时，下面这些方法各自到底做了什么、为什么按这个顺序执行、各自改了什么状态。

```text
getMessagesAfterCompactBoundary()
applyToolResultBudget()
snipCompactIfNeeded()
microcompact()
contextCollapse.applyCollapsesIfNeeded()
autocompact()
buildPostCompactMessages()
prependUserContext()
```

推荐阅读路径：

- **只想理解机制**：读 §0、§1，然后按 §2 到 §9 顺序看八个方法。
- **想复现实现**：读 §1 的总执行图，再重点看每个方法里的“输入输出”“内部步骤”“状态副作用”和 §11 的最小实现骨架。
- **想核验源码**：直接看每节开头的源码入口和附录 A。

这不是 context engineering 总览，也不是 agent loop 总览。相关总链路已经在其他 analysis 中分析过；本文只细究投影链上的具体方法。

## Learning Question

本文回答：

```text
Claude Code 的 MessageProjection 不是一个类，而是一组方法串起来的 read-time pipeline。
这些方法分别如何切片、预算、裁剪、微压缩、折叠、完整压缩和注入上下文？
```

一句话结论：

```text
MessageProjection 不是“把历史数组传给模型”，而是每轮调用前按固定顺序构造一个临时窗口：
先确定 active history，再按 provider 实际 wire 形态控制大工具结果，
再让 snip/microcompact/collapse/autocompact 逐级释放上下文压力，
最后才把 userContext 作为 meta user message 注入请求。
```

## Scope

本文覆盖：

- 八个方法的调用点、输入输出、内部决策和副作用。
- 方法之间的依赖顺序，尤其是为什么 `applyToolResultBudget()` 在 `microcompact()` 前，为什么 `contextCollapse` 在 `autocompact()` 前。
- 可见源码中能确认的机制，以及 feature-gated 缺失源码只能确认的调用契约。

本文不覆盖：

- agent loop 的完整执行流。
- pre-agent loop 如何收集系统上下文、用户输入和 attachment。
- provider streaming 的完整实现。
- `snipCompact.ts`、`snipProjection.ts`、`contextCollapse` 的具体算法。当前源码镜像中这些实现文件不可见，只能分析调用契约。
- `mini-cc` 或 build-along。

## 0. 核心结论

### 0.1 八个方法的职责一览

| 顺序 | 方法 | 输入 | 输出 | 核心职责 |
|---:|---|---|---|---|
| 1 | `getMessagesAfterCompactBoundary()` | 当前 `messages` | compact/snip 后的 active history | 找最后一个 compact boundary，并默认应用 snip projection |
| 2 | `applyToolResultBudget()` | active history + replacement state | 替换过大 tool_result 后的 messages | 按 provider wire-level user message 控制工具结果体积，并冻结替换决策 |
| 3 | `snipCompactIfNeeded()` | budgeted messages | snipped messages + freed token estimate + optional boundary | feature-gated 历史裁剪；当前只能确认调用契约 |
| 4 | `microcompact()` / `microcompactMessages()` | snipped messages | 直接清理后的 messages，或 cache-edits metadata | 轻量处理旧工具结果；可能改消息，也可能只排队 API cache edits |
| 5 | `contextCollapse.applyCollapsesIfNeeded()` | microcompacted messages | collapsed view | feature-gated 读时折叠；当前只能确认调用契约 |
| 6 | `autocompact()` / `autoCompactIfNeeded()` | collapsed view + runtime context | optional `CompactionResult` | 判断是否达到完整压缩阈值，并执行 session memory 或 summary compact |
| 7 | `buildPostCompactMessages()` | `CompactionResult` | post-compact messages | 定义 compact 结果进入下一轮窗口的顺序协议 |
| 8 | `prependUserContext()` | final `messagesForQuery` + `userContext` | request messages | 把动态用户上下文注入为 meta user reminder |

### 0.2 这条链不是“每步都删除消息”

这些方法对状态的影响不一样：

| 方法 | 是否返回新 messages | 是否持久化事件 | 是否修改共享状态 | 是否只影响 provider request |
|---|---:|---:|---:|---:|
| `getMessagesAfterCompactBoundary()` | 是，切片或投影 | 否 | 否 | 否 |
| `applyToolResultBudget()` | 可能 | 可通过 callback 写 replacement record | 会 mutate `ContentReplacementState` | 否 |
| `snipCompactIfNeeded()` | 可能 | 可能 yield boundary | 具体实现待验证 | 否 |
| `microcompactMessages()` time-based | 是，直接替换 tool_result content | 否 | 会 reset cached MC state | 否 |
| `microcompactMessages()` cached | messages 不变 | boundary 延后 yield | 会更新 module-level cached MC state | 是，排队 cache_edits |
| `contextCollapse.applyCollapsesIfNeeded()` | 是，读时 collapsed view | 当前调用点不 yield | 使用 collapse store，细节待验证 | 否 |
| `autoCompactIfNeeded()` | 不直接返回 messages；返回 `CompactionResult` | compact 成功后 yield post-compact messages | 清理多类 cache/tracking | 否 |
| `buildPostCompactMessages()` | 是，纯组装 | 否 | 否 | 否 |
| `prependUserContext()` | 是，前置 meta user message | 否 | 否 | 是，请求级注入 |

### 0.3 方法顺序的关键依赖

```text
compact boundary
  -> tool result budget
       -> snip
            -> microcompact
                 -> context collapse
                      -> autocompact
                           -> post-compact messages
                                -> user context prepend
```

顺序不是随意的：

- compact boundary 必须最早，因为旧 compact 前历史不应该参与后续预算和压缩判断。
- tool result budget 必须早于 cached microcompact，因为 cached microcompact 只按 `tool_use_id` 操作，不检查内容；先替换内容不会破坏它。
- snip 早于 microcompact，且 `tokensFreed` 要传给 autocompact，修正 stale usage。
- context collapse 早于 autocompact，因为它如果已把上下文降到阈值下，就避免完整 summary compact。
- autocompact 成功后必须用 `buildPostCompactMessages()` 替换当前窗口，而不是继续用旧窗口。
- `prependUserContext()` 放最后，因为它是本次请求级 meta reminder，不是 durable transcript 的 active history 切片。

## 1. 总执行位置：这些方法在哪里串起来

源码主入口在 `src/query.ts` 的 `queryLoop()`。

关键片段可以抽象为：

```ts
let messagesForQuery = [...getMessagesAfterCompactBoundary(messages)]

messagesForQuery = await applyToolResultBudget(...)

const snipResult = snipCompactIfNeeded(messagesForQuery)
messagesForQuery = snipResult.messages
snipTokensFreed = snipResult.tokensFreed

const microcompactResult = await microcompact(messagesForQuery, ...)
messagesForQuery = microcompactResult.messages
pendingCacheEdits = microcompactResult.compactionInfo?.pendingCacheEdits

const collapseResult = await contextCollapse.applyCollapsesIfNeeded(...)
messagesForQuery = collapseResult.messages

const { compactionResult } = await autocompact(..., snipTokensFreed)
if (compactionResult) {
  messagesForQuery = buildPostCompactMessages(compactionResult)
}

messages: prependUserContext(messagesForQuery, userContext)
```

源码确认：

- `src/query.ts:365` 创建 `messagesForQuery`。
- `src/query.ts:379` 调 `applyToolResultBudget()`。
- `src/query.ts:403` 调 `snipCompactIfNeeded()`。
- `src/query.ts:415` 调 `deps.microcompact()`。
- `src/query.ts:441` 调 `contextCollapse.applyCollapsesIfNeeded()`。
- `src/query.ts:455` 调 `deps.autocompact()`。
- `src/query.ts:528` 调 `buildPostCompactMessages()`。
- `src/query.ts:660` 调 provider 前执行 `prependUserContext()`。

## 2. `getMessagesAfterCompactBoundary()`：确定 active history 的第一刀

### 源码入口

- `src/utils/messages.ts:4611` `isCompactBoundaryMessage()`
- `src/utils/messages.ts:4620` `findLastCompactBoundaryIndex()`
- `src/utils/messages.ts:4643` `getMessagesAfterCompactBoundary()`

### 输入输出

```ts
function getMessagesAfterCompactBoundary<T extends Message | NormalizedMessage>(
  messages: T[],
  options?: { includeSnipped?: boolean },
): T[]
```

输入是当前 `messages`。输出是：

- 如果没有 compact boundary：原数组。
- 如果有 compact boundary：从最后一个 boundary 开始到末尾的 slice。
- 如果 `HISTORY_SNIP` 开启且没有 `includeSnipped`：再调用 `projectSnippedView()` 过滤 snipped messages。

### 内部步骤

1. `findLastCompactBoundaryIndex()` 从尾到头扫描。
2. 找到最后一个 `type === "system" && subtype === "compact_boundary"`。
3. `boundaryIndex === -1` 时返回全部 messages。
4. 否则返回 `messages.slice(boundaryIndex)`，注意包含 boundary 本身。
5. 默认情况下，如果 `HISTORY_SNIP` feature 开启，会动态 require `snipProjection.js` 并执行 `projectSnippedView(sliced)`。
6. 如果调用方显式传 `{ includeSnipped: true }`，则跳过 snip projection。

### 为什么 boundary 本身要保留

源码注释说明：boundary 是 system message，最终会被 `normalizeMessagesForAPI()` 过滤。它留在 `messagesForQuery` 中不是为了发给模型，而是为了让内部状态、UI、resume 和后续处理知道“这是 compact 后的活跃区间起点”。

### 为什么 snip projection 放在这里

`getMessagesAfterCompactBoundary()` 注释明确说：

```text
model-facing paths need both compact-slice AND snip-filter applied
```

这说明 Claude Code 把 active history 定义成两个条件的组合：

```text
最后一次 compact boundary 之后
并且不包含 snip 已移除的中段消息
```

### 重要调用差异

| 调用方 | 参数 | 语义 |
|---|---|---|
| `query.ts` | 默认 | 模型调用路径，应用 compact slice + snip filter |
| `/compact` | 默认 | compact summarizer 不总结已 snip 的内容 |
| UI `Messages.tsx` | `{ includeSnipped: true }` | UI scrollback 保留 snipped 内容 |

### 方法级结论

`getMessagesAfterCompactBoundary()` 不是普通 slice helper。它定义了“当前 active transcript”的第一层语义：最后一次 compact 之前的内容默认不再参与模型上下文；snip 已移除的内容默认也不进入模型路径。

## 3. `applyToolResultBudget()`：按 provider wire 形态冻结大工具结果

### 源码入口

- `src/query.ts:379` 调用点。
- `src/utils/toolResultStorage.ts:390` `ContentReplacementState`。
- `src/utils/toolResultStorage.ts:924` `applyToolResultBudget()`。
- `src/utils/toolResultStorage.ts:799` `enforceToolResultBudget()`。

### 输入输出

```ts
async function applyToolResultBudget(
  messages: Message[],
  state: ContentReplacementState | undefined,
  writeToTranscript?: (records: ToolResultReplacementRecord[]) => void,
  skipToolNames?: ReadonlySet<string>,
): Promise<Message[]>
```

输出是替换过部分 `tool_result.content` 的 `Message[]`，或者原 messages。

如果 `state` 是 `undefined`，直接 no-op。这表示 feature 未启用或当前上下文不需要该预算机制。

### 核心状态：`ContentReplacementState`

```ts
type ContentReplacementState = {
  seenIds: Set<string>
  replacements: Map<string, string>
}
```

这两个字段是机制核心：

- `seenIds`：某个 `tool_use_id` 已经经过预算决策。不管当时有没有替换，以后命运都冻结。
- `replacements`：已经替换过的 `tool_use_id -> exact preview string`。以后每轮用同一个字符串 re-apply，不再读文件、不重新生成 preview。

设计目标是 prompt cache 稳定：

```text
同一个 tool_result 第一次如果完整进入模型，以后不能突然变 preview；
第一次如果变 preview，以后必须 byte-identical 地继续变同一个 preview。
```

### 内部步骤

`applyToolResultBudget()` 本身只是薄包装：

1. `state` 为空则返回原 messages。
2. 调 `enforceToolResultBudget(messages, state, skipToolNames)`。
3. 如果产生 `newlyReplaced`，调用 `writeToTranscript` 把 replacement record 写入 transcript。
4. 返回 result messages。

真正逻辑在 `enforceToolResultBudget()`：

1. `collectCandidatesByMessage(messages)` 提取候选 tool_result，并按 API wire-level user message 分组。
2. 如果需要跳过某些工具，先 `buildToolNameMap(messages)` 得到 `tool_use_id -> tool_name`。
3. 读取 per-message budget limit。
4. 对每个候选组执行 `partitionByPriorDecision()`：
   - `mustReapply`：已有 replacement，直接放进 `replacementMap`。
   - `frozen`：已 seen 但未 replacement，本轮不能再替换。
   - `fresh`：从未见过，可以参与本轮预算决策。
5. 对 fresh 结果：
   - `skipToolNames` 命中的先加入 `seenIds`，但不计入 freshSize。
   - 计算 `frozenSize + freshSize` 是否超过 limit。
   - 超过时用 `selectFreshToReplace()` 按 size 从大到小选择要替换的 fresh results。
6. 未被选中替换的 candidate 同步加入 `seenIds`。
7. 被选中的 candidate 异步 `persistToolResult()`，成功后生成 preview 字符串。
8. 成功 replacement：
   - 加入 `replacementMap`。
   - 写入 `state.replacements`。
   - 记录 `newlyReplaced`，供 transcript 持久化。
9. 最后用 `replaceToolResultContents()` 返回新 messages。

### 为什么要按 API-level user message 分组

这是这个方法最容易被误解的地方。

源码注释说明，`normalizeMessagesForAPI()` 会合并连续 user messages；progress、attachment、普通 system 不会形成 provider wire boundary。因此内部多个 user/tool_result messages 到 API 层可能合并成一个 user turn。

所以预算不能按内部 `Message[]` 的物理条数计算，而要模拟 provider 最终会看到的分组：

```text
assistant boundary 之前的一组 user/tool_result
  -> API 上可能是一个 user message
  -> budget 必须按这一组总大小算
```

否则并行工具调用产生多个看似“每条都没超限”的 tool_result，到了 provider 层合并后仍然超大。

### 为什么只替换 fresh，不替换 frozen

如果一个 tool_result 在上一轮完整进入过模型，那么下一轮突然替换成 preview，会改变历史 prefix，导致 prompt cache 失效，也会改变模型可见事实。因此 Claude Code 把未替换的 seen result 视为 frozen：即使后续总量超预算，也不再替换它，而是等待 microcompact 或 compact 处理。

### persistence 失败时怎么处理

`buildReplacement()` 如果 persist 失败返回 `null`。但 `enforceToolResultBudget()` 仍会把 candidate 加入 `seenIds`，只是不写 `replacements`。

这意味着：

```text
持久化失败后，原始内容本轮已经发给模型；
之后必须把它视为 seen-but-unreplaced，不能下一轮又尝试替换。
```

这也是 prompt cache 稳定性约束。

### skipToolNames 的作用

`query.ts` 传入的 `skipToolNames` 来自：

```ts
toolUseContext.options.tools
  .filter(t => !Number.isFinite(t.maxResultSizeChars))
  .map(t => t.name)
```

这类工具，例如 Read，自己有结果大小协议，不应该由 aggregate budget wrapper 再替换。被 skip 的结果会标记 seen，从而冻结“永不由这个机制替换”的决策。

### 方法级结论

`applyToolResultBudget()` 不是简单截断工具输出。它是一个跨轮稳定的、按 provider wire 分组的 tool_result replacement protocol。它的核心不是“省 token”，而是“在省 token 的同时不破坏 prompt cache 和历史一致性”。

## 4. `snipCompactIfNeeded()`：feature-gated 中段裁剪的调用契约

### 源码入口

当前源码镜像没有 `src/services/compact/snipCompact.ts` 和 `src/services/compact/snipProjection.ts` 文件实体。可见调用点包括：

- `src/query.ts:403` `snipModule!.snipCompactIfNeeded(messagesForQuery)`
- `src/QueryEngine.ts:1281` `snipCompactIfNeeded(store, { force: true })`
- `src/utils/messages.ts:4650` `projectSnippedView(sliced)`
- `src/utils/sessionStorage.ts:1962` 附近 `applySnipRemovals()`

### 可确认输入输出

从调用点可推断返回值至少包含：

```ts
type SnipResult = {
  messages: Message[]
  tokensFreed: number
  boundaryMessage?: Message
}
```

`query.ts` 对它的消费方式：

1. 用 `snipResult.messages` 替换 `messagesForQuery`。
2. 把 `snipResult.tokensFreed` 保存为 `snipTokensFreed`。
3. 如果有 `boundaryMessage`，就 `yield` 该 system message。

### 为什么 snip 在 microcompact 前

源码注释明确：

```text
Apply snip before microcompact (both may run — they are not mutually exclusive).
```

这说明 snip 与 microcompact 不是二选一。snip 先减少 active history，再让 microcompact 处理剩余窗口里的工具结果/cache edits。

### 为什么 `tokensFreed` 要继续传给 autocompact

`query.ts` 注释说明 surviving assistant 的 usage 可能仍反映 pre-snip context，`tokenCountWithEstimation()` 读到的是 protected-tail assistant 的 usage，看不到 snip 已经释放的 tokens。

因此 `snipTokensFreed` 会传给：

- `autoCompactIfNeeded(..., snipTokensFreed)`
- blocking limit 判断中的 `tokenCountWithEstimation(messagesForQuery) - snipTokensFreed`

机制含义：

```text
snip 修改了消息窗口，但 token usage 估算源可能仍滞后；
所以 snip 必须额外返回 freed-token delta，供后续阈值判断修正。
```

### boundaryMessage 的语义

`query.ts` 只负责 yield boundary，不负责把它 replay 到 store。不同 host 的处理不一样：

- REPL 保留完整历史用于 UI scrollback，通过 `projectSnippedView()` 在模型路径过滤。
- SDK/headless `QueryEngine` 遇到 snip boundary 时，会对 `mutableMessages` 执行 force replay，删除 zombie messages 和 stale markers，避免长 session 内存泄漏。

### resume 语义

`src/utils/sessionStorage.ts` 的 `applySnipRemovals()` 说明 snip 不像 compact boundary 那样删除前缀，而是删除中段。JSONL 是 append-only，因此 removed messages 仍在磁盘上。恢复时必须：

1. 从 snip boundary metadata 读 `removedUuids`。
2. 从 message Map 中删除这些 UUID。
3. 对 parentUuid 指向删除区域的 survivor 做 relink。

### 待验证

当前不能确认：

- snip 如何选择裁剪范围。
- boundary subtype 和 marker message 的精确 shape。
- `tokensFreed` 如何估算。
- `force: true` 如何改变执行条件。

### 方法级结论

在可见源码中，`snipCompactIfNeeded()` 的确定职责是：在 microcompact 前对 active history 做中段裁剪，并把“消息窗口变化”和“token 估算修正”同时返回。具体裁剪算法不可见，不能写成源码事实。

## 5. `microcompact()` / `microcompactMessages()`：两种轻量压缩路径

### 源码入口

- `src/query.ts:415` 调 `deps.microcompact()`。
- `src/query/deps.ts` 生产依赖把 `microcompact` 绑定到 `microcompactMessages()`。
- `src/services/compact/microCompact.ts:253` `microcompactMessages()`。

### 输入输出

```ts
type MicrocompactResult = {
  messages: Message[]
  compactionInfo?: {
    pendingCacheEdits?: PendingCacheEdits
  }
}
```

`query.ts` 使用方式：

1. `messagesForQuery = microcompactResult.messages`
2. 如果启用 cached microcompact，读取 `microcompactResult.compactionInfo?.pendingCacheEdits`
3. pending cache edits 的 boundary message 延后到 API response 后生成

### compactable tools

`microCompact.ts` 定义 `COMPACTABLE_TOOLS`，包括：

- FileRead
- Shell 类工具
- Grep、Glob
- WebSearch、WebFetch
- FileEdit、FileWrite

`collectCompactableToolIds()` 扫描 assistant `tool_use` blocks，按 encounter order 收集这些工具的 `tool_use.id`。

### 分支一：time-based microcompact

`microcompactMessages()` 先调用 `maybeTimeBasedMicrocompact()`。如果触发，则直接返回，不再走 cached microcompact。

触发条件来自 `evaluateTimeBasedTrigger()`：

- time-based config enabled。
- 必须有显式 `querySource`。
- 必须是 main thread source。
- 找得到最近 assistant message。
- 当前时间与最近 assistant timestamp 的 gap 大于阈值。

默认配置在 `src/services/compact/timeBasedMCConfig.ts`：

```ts
enabled: false
gapThresholdMinutes: 60
keepRecent: 5
```

触发后内部步骤：

1. 收集 compactable tool ids。
2. `keepRecent = Math.max(1, config.keepRecent)`，至少保留最近一个。
3. 旧的 compactable tool ids 进入 `clearSet`。
4. 遍历 user messages，找到 `tool_result.tool_use_id` 在 `clearSet` 的 block。
5. 用 `TIME_BASED_MC_CLEARED_MESSAGE` 替换 block.content。
6. 统计 `tokensSaved`。
7. 如果确实清理了内容：
   - log event。
   - suppress compact warning。
   - `resetMicrocompactState()`，避免 cached MC 状态引用已被内容清理的 server-side entries。
   - prompt cache break detection 里调用 `notifyCacheDeletion(querySource)`。

机制含义：

```text
time-based microcompact 认为 server prompt cache 已经过期，
所以直接缩短即将重写的 prompt 内容，比保持 cache prefix 更重要。
```

### 分支二：cached microcompact

如果 time-based 未触发，且 `CACHED_MICROCOMPACT` feature 开启，才可能走 cached path。

触发条件：

- cached MC runtime enabled。
- model 支持 cache editing。
- querySource 是 main thread source。

cached path 内部步骤：

1. lazy import `cachedMicrocompact.js`。
2. `ensureCachedMCState()` 获取 module-level cached state。
3. 收集 compactable tool ids。
4. 遍历 user messages，注册仍未 registered 的 tool_result。
5. `getToolResultsToDelete(state)` 决定要删除哪些 cached tool refs。
6. 如果有要删的：
   - `createCacheEditsBlock()` 创建 cache edits。
   - 写入 module-level `pendingCacheEdits`。
   - log event。
   - suppress warning。
   - prompt cache break detection 调 `notifyCacheDeletion()`。
   - 捕获最近 assistant usage 里的 cumulative `cache_deleted_input_tokens` baseline。
   - 返回原 messages，并在 `compactionInfo.pendingCacheEdits` 中携带 deleted ids 和 baseline。

关键点：

```text
cached microcompact 不修改本地 messages。
它通过 API 层插入 cache_edits/cache_reference 来删除服务器缓存中的工具结果。
```

### pending cache edits 如何进入 API

`src/services/api/claude.ts` 会在构造请求前：

- `consumePendingCacheEdits()` 一次性消费新 edits。
- 读取 `getPinnedCacheEdits()`，把以前 pin 过的 edits 放回原位置。
- 在 API messages 中把 new cache edits 插入最后一个 user message。
- 调 `pinCacheEdits(i, newCacheEdits)`，保证未来请求在同一位置重发。

这说明 cached microcompact 的一部分逻辑跨越了 `microCompact.ts` 和 provider request builder。

### microcompact boundary 为什么延迟

`query.ts` 在 API streaming 结束后，如果 `pendingCacheEdits` 存在，会读取最后一个 assistant usage 的 cumulative `cache_deleted_input_tokens`，减去 baseline，得到本次真实删除 token 数。只有 `deletedTokens > 0` 时才 yield `createMicrocompactBoundaryMessage()`。

机制含义：

```text
cached microcompact 的 boundary 不是“客户端决定删除了几个工具”。
它要等 API 返回真实 cache_deleted_input_tokens 后，才记录实际节省。
```

### 方法级结论

`microcompactMessages()` 是轻量上下文压力释放层，但它有两种完全不同语义：

- time-based：本地直接改 messages，清掉旧 tool_result 内容。
- cached：本地 messages 不变，排队 API cache edits，等 response 后再生成 boundary。

上一版只把它写成“轻量压缩”是不够的；真正机制是“根据 cache 是否还值得保留，选择内容清理或 cache editing”。

## 6. `contextCollapse.applyCollapsesIfNeeded()`：autocompact 前的读时折叠契约

### 源码入口

当前源码镜像没有完整 `src/services/contextCollapse/*` 实体。可见调用点包括：

- `src/query.ts:441` `contextCollapse.applyCollapsesIfNeeded()`
- `src/query.ts:1095` 附近 `contextCollapse.recoverFromOverflow()`
- `src/commands/context/context.tsx` `projectView()`
- `src/services/compact/postCompactCleanup.ts` `resetContextCollapse()`

### 可确认输入输出

从 `query.ts` 可确认：

```ts
const collapseResult = await contextCollapse.applyCollapsesIfNeeded(
  messagesForQuery,
  toolUseContext,
  querySource,
)
messagesForQuery = collapseResult.messages
```

返回值至少包含：

```ts
type CollapseResult = {
  messages: Message[]
}
```

### 为什么在 autocompact 前

`query.ts` 注释直接说明：

```text
Runs BEFORE autocompact so that if collapse gets us under the
autocompact threshold, autocompact is a no-op and we keep granular
context instead of a single summary.
```

也就是说 collapse 是 autocompact 的前置替代策略：先尝试保留更细粒度的上下文结构；如果它足以降到阈值下，就不触发完整 summary compact。

### 读时投影语义

`query.ts` 注释还说明：

- collapse view 是 read-time projection。
- summary messages 存在 collapse store，不在 REPL array。
- `projectView()` 每次 entry 重放 commit log。
- 同一 turn 内，collapsed view 通过下一轮 `State.messages` 往前流。

这与 compact boundary 不同：

```text
compact 会 yield boundary + summary messages；
context collapse 在当前调用点不 yield，主要通过 projection store 改变本轮视图。
```

### overflow recovery

当 API 返回 prompt-too-long 且错误被 withheld，`query.ts` 会先尝试：

```ts
contextCollapse.recoverFromOverflow(messagesForQuery, querySource)
```

如果 `drained.committed > 0`，则构造新的 `State`：

```text
messages = drained.messages
transition = collapse_drain_retry
```

然后继续 loop。这说明 collapse 不只是请求前 projection，也参与 413 后恢复。

### 清理边界

`runPostCompactCleanup(querySource)` 在 main-thread compact 后会 `resetContextCollapse()`，但避免 subagent compact 清理 main thread 的 module-level collapse store。

### 待验证

当前不能确认：

- span 如何选择。
- summary 如何生成。
- commit log 具体结构。
- staged vs committed collapse 的阈值。
- `recoverFromOverflow()` drain 策略。

### 方法级结论

`contextCollapse.applyCollapsesIfNeeded()` 在可见源码中的确定职责是：在完整 autocompact 前提供一个读时折叠视图，并在 prompt-too-long 恢复中优先于 reactive compact 尝试 drain。它的算法不可见，不能写成源码事实。

## 7. `autocompact()` / `autoCompactIfNeeded()`：完整压缩的阈值和熔断

### 源码入口

- `src/query.ts:455` 调 `deps.autocompact()`。
- `src/query/deps.ts` 生产依赖绑定 `autoCompactIfNeeded()`。
- `src/services/compact/autoCompact.ts:160` `shouldAutoCompact()`。
- `src/services/compact/autoCompact.ts:241` `autoCompactIfNeeded()`。

### 输入输出

```ts
async function autoCompactIfNeeded(
  messages: Message[],
  toolUseContext: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  querySource?: QuerySource,
  tracking?: AutoCompactTrackingState,
  snipTokensFreed?: number,
): Promise<{
  wasCompacted: boolean
  compactionResult?: CompactionResult
  consecutiveFailures?: number
}>
```

注意：`query.ts` 当前 destructure 的是 `{ compactionResult, consecutiveFailures }`。如果有 `compactionResult`，才会调用 `buildPostCompactMessages()` 替换 `messagesForQuery`。

### 阈值计算

`getEffectiveContextWindowSize(model)`：

1. 读取模型 context window。
2. 为 compact summary output 预留 token，最多 20,000。
3. 支持 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 环境变量缩小窗口。

`getAutoCompactThreshold(model)`：

```text
effectiveContextWindow - 13,000
```

也支持 `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 测试覆盖。

`calculateTokenWarningState()` 同时计算：

- warning threshold
- error threshold
- autocompact threshold
- blocking limit

### `shouldAutoCompact()` 的决策树

`shouldAutoCompact()` 先排除不能 compact 的路径：

1. `querySource === "session_memory"` 或 `"compact"` 返回 false，避免 forked agent deadlock。
2. context collapse feature 下，如果 `querySource === "marble_origami"` 返回 false，避免 ctx-agent compact 后清理 main thread collapse store。
3. `isAutoCompactEnabled()` false 返回 false。
4. reactive-only feature 下 suppress proactive autocompact。
5. context-collapse enabled 时 suppress proactive autocompact，因为 collapse 接管 headroom 管理。
6. 最后才计算：

```ts
tokenCountWithEstimation(messages) - snipTokensFreed
```

然后用 `calculateTokenWarningState()` 判断是否超过 autocompact threshold。

### 为什么要减 `snipTokensFreed`

同 §4：snip 删除了消息，但 token usage 可能仍来自 surviving assistant 的旧 usage。`tokenCountWithEstimation()` 对新增消息做估算，但历史 usage 仍可能是 pre-snip。减去 `snipTokensFreed` 是为了不误触发 autocompact 或 blocking limit。

### `autoCompactIfNeeded()` 的执行树

1. 如果 `DISABLE_COMPACT`，返回不 compact。
2. 如果 `tracking.consecutiveFailures >= 3`，返回不 compact。这个是 circuit breaker。
3. 调 `shouldAutoCompact()`，未达阈值返回。
4. 构造 `RecompactionInfo`：
   - 是否已经在同一 compact chain 中。
   - 距离上次 compact 几轮。
   - previous compact turn id。
   - 当前 threshold。
   - querySource。
5. 先尝试 `trySessionMemoryCompaction()`。
6. 如果 session memory compaction 成功：
   - `setLastSummarizedMessageId(undefined)`。
   - `runPostCompactCleanup(querySource)`。
   - prompt cache break detection 里 `notifyCompaction()`。
   - `markPostCompaction()`。
   - 返回 `compactionResult`。
7. 如果 session memory compact 不成功，调用传统 `compactConversation()`：
   - `suppressFollowUpQuestions = true`
   - `customInstructions = undefined`
   - `isAutoCompact = true`
   - 传入 `recompactionInfo`
8. 成功后同样 reset summary id、cleanup，并返回 `consecutiveFailures: 0`。
9. 失败时：
   - 非用户 abort 错误会 `logError()`。
   - failure count +1。
   - 达到 3 次会写 circuit breaker debug log。
   - 返回 `{ wasCompacted: false, consecutiveFailures }`。

### `query.ts` 如何消费失败计数

如果没有 `compactionResult`，但 `consecutiveFailures !== undefined`，`query.ts` 会把这个值写回 `tracking`，让下一轮 `autoCompactIfNeeded()` 能触发 circuit breaker。

### 方法级结论

`autoCompactIfNeeded()` 不是简单“超过阈值就总结”。它包含：

- 多个 querySource/feature gate 排除条件。
- snip token correction。
- session memory compaction 优先。
- traditional summary compact fallback。
- post-compact cleanup。
- 连续失败熔断。

这才是它作为 MessageProjection 末级压力释放阀的真实机制。

## 8. `buildPostCompactMessages()`：compact 产物进入下一轮窗口的顺序协议

### 源码入口

- `src/services/compact/compact.ts:330` `buildPostCompactMessages()`
- `src/query.ts:528` proactive autocompact 成功后调用。
- `src/query.ts:1148` reactive compact 成功后也调用。

### 输入输出

```ts
function buildPostCompactMessages(result: CompactionResult): Message[] {
  return [
    result.boundaryMarker,
    ...result.summaryMessages,
    ...(result.messagesToKeep ?? []),
    ...result.attachments,
    ...result.hookResults,
  ]
}
```

它是纯函数，但定义了 compact 后窗口的协议顺序。

### `CompactionResult` 主要字段

从 `src/services/compact/compact.ts` 可见：

| 字段 | 含义 |
|---|---|
| `boundaryMarker` | compact boundary system message |
| `summaryMessages` | compact summary user message，通常 `isCompactSummary` / transcript-only |
| `messagesToKeep` | reactive/session-memory/partial compact 可能保留的尾部或部分消息 |
| `attachments` | compact 后恢复文件、计划、skills、tool delta、MCP instructions 等 |
| `hookResults` | SessionStart/PostCompact hooks 产生的消息 |

### 为什么顺序重要

这个顺序让后续 `getMessagesAfterCompactBoundary()` 的语义成立：

```text
boundary -> summary -> kept messages -> restored context attachments -> hook messages
```

如果 boundary 不在第一位，后续 compact slice 可能切错。

如果 summary 不在 kept messages 前，模型会先看到尾部上下文再看到“旧历史摘要”，语义顺序会反直觉。

如果 attachments/hookResults 不放在后面，compact 后恢复的文件、plan mode、invoked skills、deferred tools delta 等可能被 summary 淹没或顺序不稳定。

### proactive 与 reactive 共用

`query.ts` 在 proactive autocompact 和 reactive compact 成功后都调用它。这说明 compact 产物不论来源，都要归一成同一种 post-compact window 协议。

### 方法级结论

`buildPostCompactMessages()` 虽短，但它是 compact 结果的 ABI。外部系统复现时不要随意调整顺序；它决定 compact 后 active context 的可恢复性和后续投影一致性。

## 9. `prependUserContext()`：把动态上下文注入为请求级 meta user message

### 源码入口

- `src/utils/api.ts:449` `prependUserContext()`
- `src/query.ts:660` provider 调用前使用。

### 输入输出

```ts
function prependUserContext(
  messages: Message[],
  context: { [k: string]: string },
): Message[]
```

行为：

1. `NODE_ENV === "test"` 时直接返回原 messages。
2. `context` 为空时直接返回原 messages。
3. 否则创建一条 `isMeta: true` user message，内容包在 `<system-reminder>` 里。
4. 把该 meta user message 放到 messages 最前面。

### 为什么不是 system prompt

`prependUserContext()` 注入的是动态 user-side context，例如 CLAUDE.md、项目/运行时上下文等。它没有并入 `systemPrompt`，而是作为 meta user message 前置。

这样做的效果：

- system prompt 可以保持更稳定。
- 动态上下文和真实用户输入都走 user message 协议，但通过 `isMeta` 区分来源。
- `normalizeMessagesForAPI()` 后仍能作为 provider user context 发送。

### 为什么放在 projection 链最后

`userContext` 不参与：

- compact boundary slice。
- tool_result budget。
- snip。
- microcompact。
- context collapse。
- autocompact threshold 的 active history 处理。

它只在本轮 provider request 前被注入。这避免动态 reminder 被写入 durable transcript 或被 compact/snip 当作历史消息处理。

### 方法级结论

`prependUserContext()` 是 MessageProjection 的最后一段请求级注入。它不改变会话历史事实源，只改变本轮发给 provider 的 messages 前缀。

## 10. 方法之间的耦合点

### 10.1 `applyToolResultBudget()` 与 `normalizeMessagesForAPI()`

`applyToolResultBudget()` 必须知道 provider normalizer 会如何合并 user messages。它通过 `collectCandidatesByMessage()` 模拟 wire-level user group。否则预算判断会和最终 API request 不一致。

### 10.2 `snipCompactIfNeeded()` 与 `autocompact()`

snip 返回 `tokensFreed`，autocompact 和 blocking limit 都要减掉它。这个耦合不是可选优化，而是修正 stale usage 的必要补丁。

### 10.3 `microcompact()` 与 provider request builder

cached microcompact 不改 messages，而是通过 module-level `pendingCacheEdits` 让 `services/api/claude.ts` 插入 cache edits。它跨越 projection layer 和 provider layer。

### 10.4 `contextCollapse` 与 autocompact

context collapse 先运行，成功降压时 autocompact no-op。失败或 413 时，collapse 还有 `recoverFromOverflow()` 优先恢复路径。

### 10.5 `autocompact()` 与 `buildPostCompactMessages()`

autocompact 返回的是 `CompactionResult`，不是直接返回 messages。`query.ts` 统一通过 `buildPostCompactMessages()` 把它变成 active window，并 yield 每条 post-compact message。

## 11. 外部系统最小复现骨架

```ts
async function projectMessagesForTurn(input: {
  messages: Message[]
  runtime: RuntimeContext
  userContext: Record<string, string>
  querySource: QuerySource
}): Promise<{
  messagesForQuery: Message[]
  requestMessages: Message[]
  pendingEvents: Message[]
  diagnostics: ProjectionDiagnostics
}> {
  const pendingEvents: Message[] = []

  let messagesForQuery = getMessagesAfterCompactBoundary(input.messages)

  messagesForQuery = await applyToolResultBudget(
    messagesForQuery,
    input.runtime.contentReplacementState,
    records => input.runtime.transcript.writeContentReplacements(records),
    input.runtime.unboundedToolNames,
  )

  let snipTokensFreed = 0
  if (input.runtime.snipEnabled) {
    const snip = snipCompactIfNeeded(messagesForQuery)
    messagesForQuery = snip.messages
    snipTokensFreed = snip.tokensFreed
    if (snip.boundaryMessage) pendingEvents.push(snip.boundaryMessage)
  }

  const micro = await microcompactMessages(
    messagesForQuery,
    input.runtime.toolUseContext,
    input.querySource,
  )
  messagesForQuery = micro.messages
  input.runtime.pendingCacheEdits = micro.compactionInfo?.pendingCacheEdits

  if (input.runtime.contextCollapseEnabled) {
    const collapsed = await applyCollapsesIfNeeded(
      messagesForQuery,
      input.runtime.toolUseContext,
      input.querySource,
    )
    messagesForQuery = collapsed.messages
  }

  const compact = await autoCompactIfNeeded(
    messagesForQuery,
    input.runtime.toolUseContext,
    input.runtime.cacheSafeParams(messagesForQuery),
    input.querySource,
    input.runtime.autoCompactTracking,
    snipTokensFreed,
  )

  if (compact.compactionResult) {
    messagesForQuery = buildPostCompactMessages(compact.compactionResult)
    pendingEvents.push(...messagesForQuery)
  } else if (compact.consecutiveFailures !== undefined) {
    input.runtime.autoCompactTracking = {
      ...input.runtime.autoCompactTracking,
      consecutiveFailures: compact.consecutiveFailures,
    }
  }

  return {
    messagesForQuery,
    requestMessages: prependUserContext(messagesForQuery, input.userContext),
    pendingEvents,
    diagnostics: { snipTokensFreed },
  }
}
```

## 12. 测试计划

| 方法 | 测试重点 |
|---|---|
| `getMessagesAfterCompactBoundary()` | 最后一个 boundary 后切片；`includeSnipped` 开关；boundary 自身保留 |
| `applyToolResultBudget()` | wire-level user grouping；fresh/frozen/mustReapply；persist failure；skipToolNames |
| `snipCompactIfNeeded()` | mock 返回 messages/tokens/boundary 后 query 是否正确消费；`tokensFreed` 是否传给 autocompact |
| `microcompactMessages()` time-based | gap threshold；keepRecent 最小为 1；旧 tool_result 被替换；cached MC state reset |
| `microcompactMessages()` cached | messages 不变；pendingCacheEdits 产生；API 后 boundary 使用真实 deleted tokens |
| `contextCollapse.applyCollapsesIfNeeded()` | mock collapsed messages 后 autocompact 是否基于 collapsed view 判断 |
| `autoCompactIfNeeded()` | 禁用条件；querySource guard；contextCollapse 接管；snipTokensFreed；failure circuit breaker |
| `buildPostCompactMessages()` | 输出顺序固定；messagesToKeep 为空时不插 undefined |
| `prependUserContext()` | test env no-op；空 context no-op；非空 context 创建 `isMeta` user message |

## 13. 源码确认、合理推断、待验证

### 13.1 源码确认

- `getMessagesAfterCompactBoundary()` 先找最后一个 compact boundary，再默认应用 snip projection。
- `applyToolResultBudget()` 通过 `ContentReplacementState.seenIds/replacements` 保持跨轮替换决策稳定。
- `applyToolResultBudget()` 按 provider wire-level user message 分组，而不是按内部 Message 物理条数分组。
- `microcompactMessages()` 先尝试 time-based microcompact，命中后短路，不再走 cached microcompact。
- time-based microcompact 会直接替换旧 `tool_result.content`，并 reset cached MC state。
- cached microcompact 不修改本地 messages，而是生成 pending cache edits，由 provider request builder 插入 API messages。
- cached microcompact boundary 延迟到 API response 后，用真实 `cache_deleted_input_tokens` delta 生成。
- `shouldAutoCompact()` 会排除 compact/session_memory 等 querySource，并在 context collapse 接管时 suppress proactive autocompact。
- `autoCompactIfNeeded()` 有连续失败熔断，默认 3 次后不再尝试。
- `buildPostCompactMessages()` 固定输出 boundary、summary、kept messages、attachments、hook results。
- `prependUserContext()` 在非测试、context 非空时创建 `isMeta: true` 的 system-reminder user message，并放到 messages 前面。

### 13.2 合理推断

- 这条链的主设计目标是“稳定 provider request prefix”，不是单纯压 token。
- `applyToolResultBudget()` 的 frozen 规则说明 Claude Code 宁愿保留某些已见过的大结果，也不愿在后续轮次改变历史 prefix。
- `contextCollapse` 的设计意图是保留比 autocompact summary 更细粒度的上下文；这是从调用顺序和注释推导出的。

### 13.3 待验证

- `snipCompactIfNeeded()` 的具体裁剪算法、boundary shape、marker shape、`tokensFreed` 估算方式。
- `projectSnippedView()` 的具体过滤实现。
- `contextCollapse.applyCollapsesIfNeeded()` 的 span 选择、summary store、commit log、drain 策略。
- `cachedMicrocompact.js` 具体 `getToolResultsToDelete()` 和 `createCacheEditsBlock()` 算法，因为当前 `rg --files` 未发现该文件。

## Verification

本轮只做静态源码验证：

- 重新搜索八个方法的真实入口和调用点。
- 阅读 `src/query.ts`、`src/utils/messages.ts`、`src/utils/toolResultStorage.ts`、`src/services/compact/microCompact.ts`、`src/services/compact/autoCompact.ts`、`src/services/compact/compact.ts`、`src/utils/api.ts`、`src/services/api/claude.ts`、`src/utils/sessionStorage.ts`、`src/services/compact/postCompactCleanup.ts`。
- 未运行项目测试：仓库根目录没有 `package.json`，且若干 feature-gated 实体文件在当前源码镜像中不可见，不能做端到端执行验证。

## 附录 A：源码依据

| 方法/结论 | 源码路径 | 关键符号 |
|---|---|---|
| 投影链调用顺序 | `src/query.ts` | `queryLoop()`, `messagesForQuery` |
| compact boundary slice | `src/utils/messages.ts` | `getMessagesAfterCompactBoundary()`, `findLastCompactBoundaryIndex()` |
| tool result budget state | `src/utils/toolResultStorage.ts` | `ContentReplacementState`, `enforceToolResultBudget()` |
| wire-level grouping | `src/utils/toolResultStorage.ts` | `collectCandidatesByMessage()` |
| budget integration | `src/utils/toolResultStorage.ts` | `applyToolResultBudget()` |
| microcompact 入口 | `src/services/compact/microCompact.ts` | `microcompactMessages()` |
| time-based microcompact | `src/services/compact/microCompact.ts`, `src/services/compact/timeBasedMCConfig.ts` | `evaluateTimeBasedTrigger()`, `maybeTimeBasedMicrocompact()` |
| cached microcompact state | `src/services/compact/microCompact.ts` | `consumePendingCacheEdits()`, `pinCacheEdits()`, `resetMicrocompactState()` |
| cached edits provider injection | `src/services/api/claude.ts` | `consumePendingCacheEdits()`, `pinCacheEdits()` call sites |
| autocompact threshold | `src/services/compact/autoCompact.ts` | `getEffectiveContextWindowSize()`, `getAutoCompactThreshold()` |
| autocompact decision | `src/services/compact/autoCompact.ts` | `shouldAutoCompact()` |
| autocompact execution | `src/services/compact/autoCompact.ts` | `autoCompactIfNeeded()` |
| compact result order | `src/services/compact/compact.ts` | `buildPostCompactMessages()` |
| compact conversation result | `src/services/compact/compact.ts` | `compactConversation()` |
| post compact cleanup | `src/services/compact/postCompactCleanup.ts` | `runPostCompactCleanup()` |
| user context prepend | `src/utils/api.ts` | `prependUserContext()` |
