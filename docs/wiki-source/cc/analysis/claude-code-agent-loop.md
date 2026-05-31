# Claude Code Agent Loop 源码分析：一次循环里到底发生了什么

## 如何阅读本文

本文是一份源码机制分析，不是 `mini-cc` 课程记录。推荐按三条路径阅读：

- **快速心智模型**：读 § Learning Question、§ Scope、§ 0 核心结论、§ 1 关键术语。目标是在 15 分钟内理解 Claude Code 为什么需要一个循环，而不是一次模型调用。
- **源码跟踪路径**：读 § 2 到 § 7。这里按 `queryLoop()` 的真实执行顺序，把一次循环拆成上下文准备、模型采样、stream 归一化、工具执行、transcript 回填和下一轮状态更新。
- **实现迁移路径**：读 § 8、§ 9、§ 12。目标是把 Claude Code 的设计边界迁移到外部 agent harness：哪些模块必须分层，哪些 invariant 必须守住，哪些错误路径不能省。

先记住这张最小闭环图：

```text
+------------------+
| queryLoop state  |
| messages/context |
+---------+--------+
          |
          v
  context projection
  compact / budget / tools
          |
          v
      call model
          |
          v
 assistant content blocks
 text / thinking / tool_use
          |
          +-----------------------+
          | no tool_use           | has tool_use
          v                       v
    stop hooks / done       tool runtime
                                  |
                                  v
                            user tool_result
                                  |
                                  v
                         state.messages updated
                                  |
                                  v
                          next loop iteration
```

本文里“**一次 agent loop**”特指 `src/query.ts` 里 `queryLoop()` 的 `while (true)` 一次迭代。一次用户请求可能经历多次 loop 迭代：

```text
loop #1: user prompt -> assistant tool_use -> tool_result
loop #2: tool_result -> assistant tool_use -> tool_result
loop #3: tool_result -> assistant final text -> completed
```

## Learning Question

本文回答一个具体问题：

```text
Claude Code 在 queryLoop 的一次迭代中，
从已有 transcript 出发，到决定结束或进入下一轮，
到底做了哪些工程动作？
```

更具体地说，本文要解释：

- 为什么 `query()` 是异步生成器，而不是返回最终字符串。
- 一次 loop 为什么先整理上下文，再调用模型。
- provider 如何把 streaming chunk 变成 `AssistantMessage`。
- `tool_use` 如何成为继续循环的唯一可靠信号。
- 工具执行如何经过 schema、hook、permission、call、result mapping。
- 为什么 `tool_result` 必须作为 user message 回填。
- 发生 fallback、abort、prompt-too-long、max-output、permission deny 时，Claude Code 如何保持 transcript 不破。

## Scope

**本文覆盖：**

- `src/query.ts` 中 `query()` / `queryLoop()` 的主状态机。
- `QueryParams`、`State`、`ToolUseContext`、`messagesForQuery`、`assistantMessages`、`toolUseBlocks`、`toolResults` 的职责。
- `src/services/api/claude.ts` 如何把消息、系统提示、工具 schema 送入 Anthropic Messages API，并把 raw stream 归一化成 assistant messages。
- `src/services/tools/toolOrchestration.ts`、`src/services/tools/StreamingToolExecutor.ts`、`src/services/tools/toolExecution.ts` 的工具调度与执行边界。
- `tool_use` / `tool_result` 配对、消息归一化、错误修复和 API 合法性约束。
- 外部系统复现这套 loop 时应保留的模块边界和失败模式。

**本文不完整展开：**

- 单个工具（Bash、Read、Edit、MCP、Skill）的内部实现。
- context compaction 的完整算法。
- permission rule / classifier / UI dialog 的完整判定树。
- subagent、session resume、tool search、skills、plugins、MCP 的完整生命周期。

这些机制会在各自 analysis 中继续展开；本文只分析它们在一次 loop 内出现的接口和边界。

## 0. 核心结论

Claude Code 的 agent loop 不是“模型返回工具调用，然后应用执行工具”这么简单。它更接近一个 **transcript reducer + side-effect runtime**：

```text
输入: 现有 messages + system/user context + tool runtime context
输出: 若干可流式展示的事件 + 更新后的 messages + 终止原因
副作用: 模型请求、工具执行、权限交互、hooks、compaction、telemetry
```

一次 loop 的主干可以还原成下面这段伪代码：

```ts
while (true) {
  yield stream_request_start

  messagesForQuery = projectHistoryAfterCompactBoundary(state.messages)
  messagesForQuery = applyToolResultBudget(messagesForQuery)
  messagesForQuery = maybeSnip(messagesForQuery)
  messagesForQuery = await microcompact(messagesForQuery)
  messagesForQuery = maybeContextCollapse(messagesForQuery)
  messagesForQuery = await autocompact(messagesForQuery)

  assistantMessages = []
  toolUseBlocks = []
  toolResults = []

  for await (message of callModel(messagesForQuery, tools, systemPrompt)) {
    yield message unless it is temporarily withheld for recovery
    if (message is assistant) {
      assistantMessages.push(message)
      toolUseBlocks.push(...message.content.filter(tool_use))
      maybeStartStreamingToolExecution(tool_use)
    }
    yieldCompletedStreamingToolResults()
  }

  if (no tool_use) {
    maybeRecoverPromptTooLongOrMaxOutput()
    maybeRunStopHooks()
    return completed
  }

  for await (toolUpdate of runToolsOrDrainStreamingExecutor(toolUseBlocks)) {
    yield toolUpdate.message
    toolResults.push(normalizeToUserToolResult(toolUpdate.message))
    updateToolUseContext(toolUpdate.newContext)
  }

  injectAttachmentsMemorySkillDiscoveryAndQueuedNotifications()
  refreshTools()

  state.messages = [
    ...messagesForQuery,
    ...assistantMessages,
    ...toolResults,
  ]
  state.turnCount++
}
```

真正重要的是这些 invariant：

| Invariant | 源码依据 | 为什么重要 |
|---|---|---|
| `tool_use` 在 assistant content 中，`tool_result` 在 user content 中 | `src/utils/attachments.ts:2460` | 这是 Anthropic Messages API 的工具闭环协议。 |
| 是否继续不能只看 `stop_reason` | `src/query.ts:553` 到 `:558`、`src/utils/messages.ts:829` 到 `:836` | 注释明确说 `stop_reason === 'tool_use'` 不可靠；Claude Code 直接扫描 content block。 |
| 每个 `tool_use.id` 必须有匹配的 `tool_result.tool_use_id` | `src/query.ts:123` 到 `:147`、`src/utils/messages.ts:5119` 到 `:5460` | 否则下一次 API 调用会因为 orphan/missing tool result 失败。 |
| 工具结果要在工具批次执行完后再和普通 user message / attachments 合流 | `src/query.ts:1535` 到 `:1537` | API 会拒绝交错的 `tool_result` 和普通 user message。 |
| 工具执行不属于 `query.ts` | `src/query.ts:1380` 到 `:1382`、`src/services/tools/toolExecution.ts:337` | 主 loop 只维护 transcript 和调度边界；具体副作用进入工具服务层。 |
| provider 层负责把 raw stream 聚合成完整 content block | `src/services/api/claude.ts:1818` 到 `:1824`、`src/services/api/claude.ts:1979` 到 `:2210` | `queryLoop()` 消费的是 message/block，不直接理解 streaming delta。 |

## 1. 关键术语

### 1.1 Query / Loop / Turn

| 术语 | 含义 | 关键源码 |
|---|---|---|
| `query()` | 对外暴露的异步生成器；入口层、SDK、subagent 都消费它。 | `src/query.ts:219` |
| `queryLoop()` | 真正的跨轮状态机。 | `src/query.ts:241` |
| loop iteration | `while (true)` 的一次执行；可能以 completed、tool follow-up、compact retry、max-output retry 等结束。 | `src/query.ts:307` |
| user turn / agentic turn | 用户发起的一次请求；可能包含多个 loop iteration。 | `src/query.ts:1678` 到 `:1727` |
| `turnCount` | loop 内部对即将进入第几轮模型请求的计数。 | `src/query.ts:213`、`:276`、`:1678` |

`QueryParams` 说明 `query()` 不是只有 prompt。它需要完整运行环境：

```text
messages
systemPrompt
userContext
systemContext
canUseTool
toolUseContext
fallbackModel
querySource
maxTurns
taskBudget
deps
```

源码位置：`src/query.ts:181` 到 `:199`。

### 1.2 Message / Content Block / Chunk

Claude Code 里必须分清三层：

```text
message       = transcript 中的一个 role 回合
content block = message.content 里的结构化片段
chunk         = streaming 传输中的原始 delta
```

例子：

```ts
{
  role: "assistant",
  content: [
    { type: "text", text: "我先检查文件。" },
    {
      type: "tool_use",
      id: "toolu_1",
      name: "Read",
      input: { file_path: "src/query.ts" },
    },
  ],
}
```

这是一条 assistant message，里面有两个 content block。真实 streaming 里，`tool_use.input` 可能先以多个 `input_json_delta.partial_json` chunk 到达，provider 聚合后才变成完整 input。

### 1.3 `messages` 与 `messagesForQuery`

| 名称 | 含义 |
|---|---|
| `state.messages` / `messages` | loop 持有的当前事实源，包含历史、assistant 输出、tool result、compact boundary 等。 |
| `messagesForQuery` | 本轮真正准备送入模型的投影视图；会经过 compact boundary、tool result budget、snip、microcompact、context collapse、autocompact 等处理。 |

`messagesForQuery` 从 `getMessagesAfterCompactBoundary(messages)` 开始，而不是直接复用完整历史。源码位置：`src/query.ts:365`。

### 1.4 三个本地数组

每次 loop 迭代都会创建三个局部数组：

```ts
const assistantMessages: AssistantMessage[] = []
const toolResults: (UserMessage | AttachmentMessage)[] = []
const toolUseBlocks: ToolUseBlock[] = []
let needsFollowUp = false
```

源码位置：`src/query.ts:551` 到 `:558`。

它们分别承担：

| 数组 | 职责 |
|---|---|
| `assistantMessages` | 收集本轮模型实际产生的 assistant message。 |
| `toolUseBlocks` | 从 assistant content 中提取本轮要执行的工具请求。 |
| `toolResults` | 收集工具执行结果、hook 附件、queued command 附件、memory/skill discovery 附件，最终作为 user-side facts 进入下一轮。 |

### 1.5 `ToolUseContext`

`ToolUseContext` 是工具运行时上下文，不只是 cwd 或 permission mode。它包含工具列表、模型配置、MCP clients、app state、abort controller、read file cache、query tracking、permission decisions、content replacement state、subagent 标记等。

源码位置：`src/Tool.ts:158` 到 `:300`。

这说明工具不是裸函数：

```text
tool.call(input)
```

而是：

```text
tool.call(input, ToolUseContext, canUseTool, parentAssistantMessage, onProgress)
```

源码位置：`src/Tool.ts:379` 到 `:385`。

## 2. 系统上下文：谁会进入 `query()`

Claude Code 有多个入口，但它们最终复用同一个核心 loop。

| 入口 | 源码位置 | 说明 |
|---|---|---|
| REPL 主线程 | `src/screens/REPL.tsx:2793` 到 `:2803` | 交互式 UI 在准备 system/user context 后，用 `for await` 消费 `query()` 事件。 |
| SDK / headless | `src/QueryEngine.ts:675` 到 `:686` | SDK 路径同样消费 `query()`，并负责把事件记录到 mutable messages / transcript。 |
| forked agent | `src/utils/forkedAgent.ts:545` | forked agent 复用主 loop，只是上下文隔离。 |
| AgentTool 子 agent | `src/tools/AgentTool/runAgent.ts:748` | AgentTool 也通过 `query()` 跑子任务。 |

这个边界很关键：入口层负责 UI、CLI、SDK、session persistence、初始消息准备；`query.ts` 负责 agent 状态推进；工具服务层负责副作用。

```text
REPL / SDK / AgentTool
  |
  | prepares QueryParams
  v
query() / queryLoop()
  |
  | calls model through QueryDeps
  v
services/api/claude.ts
  |
  | dispatches tool_use
  v
services/tools/*
  |
  | returns user tool_result
  v
queryLoop next state
```

`query()` 通过 `QueryDeps` 调用模型和 compaction 相关能力。生产实现把 `callModel` 指向 `queryModelWithStreaming()`，同时注入 `microcompact`、`autocompact` 和 `uuid`。源码位置：`src/query/deps.ts:21` 到 `:39`。

## 3. 一次 loop 的阶段总览

一次 `while (true)` 迭代可以拆成 9 个阶段：

| 阶段 | 发生什么 | 关键源码 |
|---:|---|---|
| 1 | 从 `state` 解构本轮输入，启动 skill discovery prefetch，发出 `stream_request_start`。 | `src/query.ts:307` 到 `:337` |
| 2 | 生成 `queryTracking`，把 `messages` 投影成 `messagesForQuery`。 | `src/query.ts:346` 到 `:365` |
| 3 | 对上下文做 budget、snip、microcompact、collapse、autocompact。 | `src/query.ts:369` 到 `:535` |
| 4 | 选择模型、检查 blocking limit，创建 streaming tool executor。 | `src/query.ts:560` 到 `:648` |
| 5 | 调用 provider，streaming 消费 assistant messages。 | `src/query.ts:652` 到 `:864` |
| 6 | 如果没有 `tool_use`，处理 recovery、stop hooks、token budget，然后结束。 | `src/query.ts:1062` 到 `:1357` |
| 7 | 如果有 `tool_use`，执行工具或 drain streaming executor。 | `src/query.ts:1360` 到 `:1409` |
| 8 | 把工具结果、附件、memory、skill discovery、queued notifications 合并进 `toolResults`。 | `src/query.ts:1411` 到 `:1676` |
| 9 | 检查 `maxTurns`，写入新的 `state.messages`，进入下一轮。 | `src/query.ts:1678` 到 `:1728` |

下面逐段展开。

## 4. 入口与状态初始化

### 4.1 `query()` 是事件流，不是字符串函数

`query()` 的签名是异步生成器：

```ts
export async function* query(params): AsyncGenerator<
  StreamEvent | RequestStartEvent | Message | TombstoneMessage | ToolUseSummaryMessage,
  Terminal
>
```

源码位置：`src/query.ts:219` 到 `:228`。

它会 `yield* queryLoop(...)`，结束后再把已消费的 queued command 标记为 completed。源码位置：`src/query.ts:229` 到 `:238`。

这说明 `query()` 面向 UI / SDK 的输出不是“最终答案”，而是一串事件：

- `stream_request_start`
- assistant message
- progress message
- user `tool_result`
- attachment
- tombstone
- tool use summary
- API error message

外部消费者用 `for await` 持续消费这些事件。REPL 的消费点在 `src/screens/REPL.tsx:2793` 到 `:2803`；SDK 的消费点在 `src/QueryEngine.ts:675` 到 `:686`。

### 4.2 `State` 是跨 loop 迭代的最小可变状态

`State` 包含：

```text
messages
toolUseContext
autoCompactTracking
maxOutputTokensRecoveryCount
hasAttemptedReactiveCompact
maxOutputTokensOverride
pendingToolUseSummary
stopHookActive
turnCount
transition
```

源码位置：`src/query.ts:203` 到 `:217`。

初始化时，`messages` 来自 `params.messages`，`toolUseContext` 来自入口层，`turnCount` 从 1 开始。源码位置：`src/query.ts:265` 到 `:279`。

这个设计有一个明确意图：每个 `continue` 点都写回完整 `state`，而不是散落地修改多个局部变量。`transition` 记录“上一轮为什么继续”，用于 recovery guard 和测试断言。

## 5. 阶段一：上下文投影与压缩

一次 loop 不是直接把完整历史发给模型。它先构造本轮的 `messagesForQuery`。

### 5.1 从 compact boundary 后的消息开始

源码：

```text
messagesForQuery = [...getMessagesAfterCompactBoundary(messages)]
```

位置：`src/query.ts:365`。

含义：如果之前发生过 compaction，模型本轮看到的是 compact 后的摘要和保留段，而不是所有历史原文。

### 5.2 工具结果预算

`applyToolResultBudget()` 会限制聚合工具结果的体积，并可把替换记录持久化到 session / agent sidechain。源码位置：`src/query.ts:369` 到 `:394`。

这一步在 microcompact 之前执行。源码注释说明原因：cached microcompact 按 `tool_use_id` 操作，不检查内容；先替换内容不会破坏它的 ID 级缓存。

### 5.3 Snip、microcompact、context collapse、autocompact

Claude Code 在模型请求前连续尝试多种上下文控制：

| 机制 | 源码位置 | 在本轮中的作用 |
|---|---|---|
| history snip | `src/query.ts:396` 到 `:410` | 可删除或替换一部分历史，并 yield boundary message。 |
| microcompact | `src/query.ts:412` 到 `:426` | 对局部消息做微压缩，可能延后 boundary message。 |
| context collapse | `src/query.ts:428` 到 `:447` | 把历史投影成 collapsed view，并可能提交更多 collapse。 |
| autocompact | `src/query.ts:453` 到 `:535` | 如果上下文过长，生成 summary messages / attachments / hook results，并用 post-compact messages 替换本轮上下文。 |

这里有一个设计细节：compaction 不是一个孤立命令，而是 loop 前置阶段的一部分。模型每次调用前，`queryLoop()` 都有机会把 transcript 投影成一个 API 可承受的窗口。

### 5.4 更新工具上下文中的 messages

完成上下文投影后，`toolUseContext.messages` 被更新为 `messagesForQuery`：

```text
toolUseContext = { ...toolUseContext, messages: messagesForQuery }
```

源码位置：`src/query.ts:545` 到 `:549`。

这让后续工具权限、hook、附件、file read state 等组件看到的是本轮 API 视图，而不是未经整理的原始历史。

## 6. 阶段二：调用模型并消费 stream

### 6.1 选择模型和 streaming tool executor

进入模型请求前，loop 会：

- 创建 `assistantMessages`、`toolResults`、`toolUseBlocks`。
- 设置 `needsFollowUp = false`。
- 根据 feature gate 决定是否创建 `StreamingToolExecutor`。
- 根据 permission mode、mainLoopModel、plan mode 超大上下文状态选择 `currentModel`。

源码位置：`src/query.ts:551` 到 `:580`。

`StreamingToolExecutor` 的意义是：当 streaming 中某个 `tool_use` block 完成后，可以提前开始执行工具，而不是等整个 assistant response 完全结束。关闭时，工具会在模型 stream 完成后统一通过 `runTools()` 执行。

### 6.2 blocking limit 是模型请求前的硬闸

如果没有自动 compaction，且当前 token 估算达到 blocking limit，loop 不会调用模型，而是直接 yield 一个 prompt-too-long API error message 并返回 `blocking_limit`。

源码位置：`src/query.ts:592` 到 `:647`。

这不是普通错误处理，而是“不要发出必然失败的 API 请求”的前置保护。

### 6.3 `deps.callModel()` 接收的不是 prompt，而是完整请求上下文

模型调用发生在：

```text
for await (const message of deps.callModel({
  messages: prependUserContext(messagesForQuery, userContext),
  systemPrompt: fullSystemPrompt,
  thinkingConfig,
  tools,
  signal,
  options: { model, fallbackModel, mcpTools, agents, taskBudget, ... }
}))
```

源码位置：`src/query.ts:659` 到 `:708`。

关键点：

- `messages` 是当前 transcript 投影视图，外加 user context。
- `tools` 是本轮可见工具列表。
- `systemPrompt` 已经合并 system context。
- `signal` 来自 `toolUseContext.abortController`，用于 user interrupt / tool abort。
- `options` 包含模型、fallback、MCP、agent definitions、effort、task budget、query tracking 等。

`query.ts` 不直接调用 Anthropic SDK；它通过 `QueryDeps.callModel` 调 provider。生产实现是 `queryModelWithStreaming()`，见 `src/query/deps.ts:21` 到 `:39`。

## 7. Provider 层：从 transcript 到 Messages API，再从 raw stream 回到 AssistantMessage

`src/services/api/claude.ts` 是一次 loop 中最关键的 adapter 层。它做两件事：

1. 把 Claude Code 内部 messages / tools / system prompt 转成 Anthropic Messages API 请求。
2. 把 raw streaming event 转回 Claude Code 内部 `AssistantMessage`。

### 7.1 生成工具 schema

`toolToAPISchema()` 会把内部 `Tool` 转成 API tool schema：

```text
name
description
input_schema
strict?
eager_input_streaming?
defer_loading?
cache_control?
```

源码位置：

- `src/utils/api.ts:119` 到 `:135`：函数签名。
- `src/utils/api.ts:136` 到 `:178`：session-stable base schema。
- `src/utils/api.ts:180` 到 `:205`：strict 和 fine-grained tool streaming 字段。
- `src/utils/api.ts:211` 到 `:265`：per-request overlay 与 beta 字段裁剪。

`claude.ts` 在请求前对 filtered tools 批量生成 tool schemas。源码位置：`src/services/api/claude.ts:1231` 到 `:1246`。

### 7.2 归一化 messages

请求发出前，provider 会执行：

```text
messagesForAPI = normalizeMessagesForAPI(messages, filteredTools)
messagesForAPI = ensureToolResultPairing(messagesForAPI)
```

源码位置：`src/services/api/claude.ts:1259` 到 `:1302`。

`normalizeMessagesForAPI()` 的职责包括：

- 重排 attachment，过滤 display-only / virtual / progress / synthetic API error。
- 合并连续 user messages。
- 把 local command system message 转成 user message。
- 规范 assistant `tool_use` input，去掉不支持的 tool-search 字段。
- 合并同 message id 的 assistant chunks。
- 清理 orphan thinking、空 assistant content、过量 media。

源码位置：`src/utils/messages.ts:1989` 到 `:2369`。

`ensureToolResultPairing()` 是防御性修复层：如果发现 assistant `tool_use` 没有对应 user `tool_result`，会插入 synthetic error tool_result；如果发现 orphan tool_result，会剥离。严格模式下会直接 throw。源码位置：`src/utils/messages.ts:5119` 到 `:5460`。

这一步说明：Claude Code 把 transcript 合法性作为 API boundary 的硬条件，而不是假设历史永远干净。

### 7.3 请求参数组装

`paramsFromContext()` 组装 Anthropic request：

```text
model
messages
system
tools
tool_choice
betas
metadata
max_tokens
thinking
context_management?
output_config?
speed?
```

源码位置：`src/services/api/claude.ts:1538` 到 `:1728`。

其中 `messages` 会经过 `addCacheBreakpoints()`，`system` 会经过 `buildSystemPromptBlocks()`，工具 schemas 和 extra tool schemas 合并为 `allTools`。源码位置：`src/services/api/claude.ts:1374` 到 `:1397`。

### 7.4 使用 raw stream，自行累积 content block

Claude Code 没有直接使用 SDK 的高级 `BetaMessageStream` 来做 partial JSON 解析，而是：

```text
anthropic.beta.messages.create({ ...params, stream: true }).withResponse()
```

源码注释说明原因：避免 SDK 对每个 `input_json_delta` 做 O(n²) partial JSON parse，因为 Claude Code 自己累加 tool input。源码位置：`src/services/api/claude.ts:1818` 到 `:1824`。

streaming 消费的关键逻辑：

| Raw event | Claude Code 行为 | 源码位置 |
|---|---|---|
| `message_start` | 保存 `partialMessage`，记录 usage / TTFT。 | `src/services/api/claude.ts:1980` 到 `:1994` |
| `content_block_start` | 按 index 初始化 text / thinking / tool_use / server_tool_use block。tool_use 的 input 初始为空字符串。 | `src/services/api/claude.ts:1995` 到 `:2052` |
| `content_block_delta` | 对 text、thinking、signature、input_json_delta 做增量累加。 | `src/services/api/claude.ts:2053` 到 `:2170` |
| `content_block_stop` | 把单个完成的 content block 归一化成一条 `AssistantMessage` 并 yield。 | `src/services/api/claude.ts:2171` 到 `:2210` |
| `message_delta` | 回写最终 usage 和 stop_reason 到最后一个已 yield message。 | `src/services/api/claude.ts:2213` 到 `:2292` |

`normalizeContentFromAPI()` 会把 streamed `tool_use.input` 字符串 parse 成对象，并做工具特定 input normalize。源码位置：`src/utils/messages.ts:2651` 到 `:2719`。

这层 adapter 的产物不是 raw chunk，而是 `AssistantMessage`。因此 `queryLoop()` 只需要扫描 assistant content block，不直接处理 `input_json_delta`。

## 8. `query.ts` 如何消费 assistant stream

### 8.1 streaming fallback 会 tombstone 旧 assistant messages

如果 streaming fallback 发生，loop 会把已经 yield 的 partial assistant messages tombstone 掉，清空本轮收集的 assistant/tool 状态，并 discard 当前 streaming tool executor。

源码位置：`src/query.ts:709` 到 `:740`。

原因写在源码注释里：fallback 前的 partial messages 尤其 thinking blocks 可能带无效签名；如果继续保留，会导致后续 API 错误。同时旧 attempt 中启动的工具结果不能泄漏到新 attempt，否则 `tool_use_id` 会 orphan。

### 8.2 assistant message yield 前可能 clone observable input

如果 assistant message 里有 `tool_use`，某些工具可以通过 `backfillObservableInput()` 给 SDK stream / transcript / hook / permission 可观察输入补充 legacy 或 derived 字段。`query.ts` 会克隆 content 再 yield，避免修改原始 API-bound message。

源码位置：`src/query.ts:742` 到 `:787`。

这个设计服务于 prompt cache 稳定性：原始 message 会回流到 API，不能随意 mutate。

### 8.3 可恢复错误先 withholding

对于 prompt-too-long、media-size、max-output 这类可能通过 collapse / reactive compact / retry 修复的错误，loop 先不 yield 给 SDK caller，而是放入 `assistantMessages` 供后续 recovery 判断。

源码位置：`src/query.ts:788` 到 `:825`。

原因：有些 SDK/desktop consumer 一看到 error 字段就会终止会话；如果提前 yield 中间错误，即使 recovery 继续跑，也没人再听结果。

### 8.4 `tool_use` 是继续信号

每个 assistant message 到达后，loop 做：

```text
assistantMessages.push(message)
msgToolUseBlocks = message.content.filter(tool_use)
if (msgToolUseBlocks.length > 0) {
  toolUseBlocks.push(...)
  needsFollowUp = true
}
```

源码位置：`src/query.ts:826` 到 `:835`。

源码注释明确指出：`stop_reason === 'tool_use'` 不可靠，loop exit signal 由 streaming 中是否看到 `tool_use` block 决定。源码位置：`src/query.ts:553` 到 `:558`。

`src/utils/messages.ts` 也用同样策略识别 tool use request：`message.message.content.some(_ => _.type === 'tool_use')`，并注释 stop_reason 不可靠。源码位置：`src/utils/messages.ts:829` 到 `:836`。

### 8.5 streaming tool executor 可提前执行工具

如果启用了 `StreamingToolExecutor`，每个新 tool block 会立即进入 executor：

```text
streamingToolExecutor.addTool(toolBlock, message)
```

源码位置：`src/query.ts:837` 到 `:844`。

随后 loop 在 stream 过程中不断拉取已完成结果：

```text
for (const result of streamingToolExecutor.getCompletedResults()) {
  yield result.message
  toolResults.push(...normalizeMessagesForAPI([result.message]).filter(user))
}
```

源码位置：`src/query.ts:847` 到 `:861`。

这样做能让长工具在模型还在输出后续内容时并行启动，但结果仍要遵守 transcript 顺序和 pairing。

## 9. 没有工具请求时：结束、恢复或续写

当 `needsFollowUp === false`，本轮不会进入工具执行。源码位置：`src/query.ts:1062`。

这并不等于立刻结束。Claude Code 还会依次处理：

### 9.1 prompt-too-long / media-size recovery

如果最后一条 assistant message 是被 withholding 的 413 / media error：

- 先尝试 context collapse drain。
- 再尝试 reactive compact。
- 如果恢复成功，写入新 `state` 并 `continue`。
- 如果恢复失败，yield 被 withholding 的错误并返回。

源码位置：`src/query.ts:1062` 到 `:1183`。

### 9.2 max output tokens recovery

如果最后一条 assistant message 是 max-output：

- 某些配置下先把输出 token 上限升级到 `ESCALATED_MAX_TOKENS`，重试同一请求。
- 否则注入一条 meta user recovery message，要求模型直接续写。
- 达到恢复上限后才 surface error。

源码位置：`src/query.ts:1185` 到 `:1256`。

### 9.3 API error 不跑 stop hooks

如果最后消息是 API error，loop 会执行 stop failure hooks，然后返回 completed，不再跑普通 stop hooks。源码注释说明原因：模型没有产生真实 response，跑 stop hooks 可能制造 error -> hook blocking -> retry -> error 的循环。

源码位置：`src/query.ts:1258` 到 `:1265`。

### 9.4 stop hooks 和 token budget continuation

非 API error 的正常 assistant response 会进入 `handleStopHooks()`。如果 hook 阻止 continuation，返回 `stop_hook_prevented`；如果 hook 给出 blocking errors，则把这些错误作为新 messages 写入 state 并 continue。

源码位置：`src/query.ts:1267` 到 `:1306`。

如果 token budget feature 要求继续，loop 会注入 meta user nudge message 并 continue。源码位置：`src/query.ts:1308` 到 `:1340`。

如果这些路径都没有触发，本次 `query()` 返回 completed。源码位置：`src/query.ts:1357`。

## 10. 有工具请求时：工具调度和执行

当 assistant content 中出现 `tool_use`，loop 进入工具执行阶段。

### 10.1 选择 streaming executor 或普通 `runTools()`

源码：

```text
const toolUpdates = streamingToolExecutor
  ? streamingToolExecutor.getRemainingResults()
  : runTools(toolUseBlocks, assistantMessages, canUseTool, toolUseContext)
```

位置：`src/query.ts:1380` 到 `:1382`。

streaming executor 已经可能在模型 streaming 过程中执行了一部分工具；此时需要 drain remaining results。普通路径则在模型 response 完成后统一调度工具。

每个 `toolUpdate` 可能包含：

- `message`：要 yield 给 UI / SDK，并可归一化成 API user message。
- `newContext`：工具产生的上下文修改，例如某些工具的 `contextModifier`。

源码位置：`src/query.ts:1384` 到 `:1407`。

### 10.2 普通工具调度：按 concurrency safe 分批

`runTools()` 的核心逻辑：

- `partitionToolCalls()` 把连续工具请求分成 batch。
- concurrency-safe 工具批次并发执行。
- 非 concurrency-safe 工具串行执行。
- 并发批次的 context modifiers 先排队，批次结束后按 block 顺序应用。

源码位置：

- `src/services/tools/toolOrchestration.ts:19` 到 `:82`：`runTools()`。
- `src/services/tools/toolOrchestration.ts:86` 到 `:116`：分批策略。
- `src/services/tools/toolOrchestration.ts:118` 到 `:149`：串行执行。
- `src/services/tools/toolOrchestration.ts:152` 到 `:176`：并发执行。

是否 concurrency-safe 由工具自己声明：

```text
tool.isConcurrencySafe(parsedInput)
```

源码位置：`src/Tool.ts:402`。

这避免了 `queryLoop()` 了解 Read、Bash、Edit、MCP 等具体工具的副作用语义。

### 10.3 StreamingToolExecutor：边流式边排队，但按顺序吐结果

`StreamingToolExecutor` 的职责写在源码注释里：

- concurrency-safe 工具可以和其他 safe 工具并行。
- non-concurrent 工具必须独占执行。
- 结果被 buffer，并按工具接收顺序输出。

源码位置：`src/services/tools/StreamingToolExecutor.ts:34` 到 `:40`。

它维护 `TrackedTool`：

```text
id
block
assistantMessage
status: queued | executing | completed | yielded
isConcurrencySafe
promise
results
pendingProgress
contextModifiers
```

源码位置：`src/services/tools/StreamingToolExecutor.ts:19` 到 `:32`。

几个关键边界：

| 行为 | 源码位置 | 说明 |
|---|---|---|
| `addTool()` 找不到工具时直接生成 error tool_result。 | `src/services/tools/StreamingToolExecutor.ts:76` 到 `:101` | 即使工具不存在，也要闭合 `tool_use`。 |
| `canExecuteTool()` 保证 non-safe 工具独占。 | `src/services/tools/StreamingToolExecutor.ts:126` 到 `:135` | safe 工具可以并行，unsafe 工具阻塞队列。 |
| `discard()` 用于 streaming fallback。 | `src/services/tools/StreamingToolExecutor.ts:64` 到 `:71` | 旧 attempt 的工具结果不能进入新 transcript。 |
| user interrupt / sibling error / streaming fallback 会生成 synthetic error tool_result。 | `src/services/tools/StreamingToolExecutor.ts:153` 到 `:205` | 仍然保持工具调用闭环。 |
| Bash 错误会 abort sibling subprocesses。 | `src/services/tools/StreamingToolExecutor.ts:347` 到 `:363` | Bash 命令常有隐式依赖链，失败后取消同批兄弟工具。 |

### 10.4 `runToolUse()`：从 tool name 到 tool_result

工具执行入口是 `runToolUse()`。源码位置：`src/services/tools/toolExecution.ts:337`。

执行链路：

| 步骤 | 行为 | 源码位置 |
|---:|---|---|
| 1 | 根据 `tool_use.name` 在本轮可用工具里查找工具，支持 alias fallback。 | `src/services/tools/toolExecution.ts:343` 到 `:356` |
| 2 | 找不到工具时返回 error `tool_result`。 | `src/services/tools/toolExecution.ts:368` 到 `:410` |
| 3 | 如果 query abort，返回取消 `tool_result`。 | `src/services/tools/toolExecution.ts:413` 到 `:452` |
| 4 | 进入 `streamedCheckPermissionsAndCallTool()`，把权限检查和工具调用统一包装成 async iterable。 | `src/services/tools/toolExecution.ts:455` 到 `:468` |
| 5 | schema 校验失败时返回 `InputValidationError` tool_result。 | `src/services/tools/toolExecution.ts:614` 到 `:680` |
| 6 | 工具级 `validateInput()` 失败时返回 error tool_result。 | `src/services/tools/toolExecution.ts:682` 到 `:733` |
| 7 | 执行 `PreToolUse` hooks，可产出消息、更新 input、给 permission result、阻止 continuation。 | `src/services/tools/toolExecution.ts:775` 到 `:891` |
| 8 | 合成 hook permission 和正常 `canUseTool()` permission。 | `src/services/tools/toolExecution.ts:916` 到 `:932` |
| 9 | permission 非 allow 时返回 error tool_result，并可能触发 PermissionDenied hooks。 | `src/services/tools/toolExecution.ts:995` 到 `:1103` |
| 10 | permission allow 后调用 `tool.call()`。 | `src/services/tools/toolExecution.ts:1206` 到 `:1222` |
| 11 | 把工具输出映射成 `ToolResultBlockParam` 并创建 user message。 | `src/services/tools/toolExecution.ts:1290` 到 `:1473` |
| 12 | 执行 `PostToolUse` hooks 和 tool-provided `newMessages`。 | `src/services/tools/toolExecution.ts:1481` 到 `:1588` |
| 13 | 工具异常时格式化为 error tool_result，并执行 failure hooks。 | `src/services/tools/toolExecution.ts:1589` 到 `:1737` |

这条链路说明：工具调用不是“直接执行函数”。它在执行真实副作用前要经过：

```text
tool lookup
-> schema parse
-> tool.validateInput
-> PreToolUse hooks
-> hook permission merge
-> canUseTool
-> tool.call
-> output mapping
-> PostToolUse hooks
-> transcript user message
```

### 10.5 Hook allow 不能绕过 deny / ask rules

`resolveHookPermissionDecision()` 的注释明确说：

```text
hook 'allow' does NOT bypass settings.json deny/ask rules
```

源码位置：`src/services/tools/toolHooks.ts:322` 到 `:330`。

如果 hook 返回 allow，Claude Code 仍然会检查 rule-based permissions；deny rule 可覆盖 hook allow，ask rule 仍然要求 prompt。源码位置：`src/services/tools/toolHooks.ts:347` 到 `:405`。

这是工具安全边界：hook 可以帮助自动批准，但不能成为绕过全局策略的后门。

## 11. 工具结果如何回到下一轮

工具执行阶段的 `update.message` 会先 yield 给消费者，然后进入 `toolResults`：

```text
toolResults.push(
  ...normalizeMessagesForAPI([update.message], tools).filter(type === user)
)
```

源码位置：`src/query.ts:1395` 到 `:1400`。

这里用 `normalizeMessagesForAPI()` 是为了把 attachment / tool result / user message 统一成下一轮 API 能接收的 user message 形状。

工具批次结束后，loop 还会追加几类东西：

| 附加内容 | 源码位置 | 作用 |
|---|---|---|
| tool use summary | `src/query.ts:1411` 到 `:1482` | 为 UI / mobile 生成工具批次摘要，且异步传到下一轮。 |
| queued command attachments | `src/query.ts:1547` 到 `:1590` | 把后台任务通知、非 slash queued command 转成 attachment。 |
| memory prefetch attachments | `src/query.ts:1592` 到 `:1614` | 如果相关 memory 预取已完成，则注入且去重。 |
| skill discovery attachments | `src/query.ts:1617` 到 `:1628` | 把预取到的 skill discovery 注入上下文。 |
| consumed queued command lifecycle | `src/query.ts:1630` 到 `:1643` | 标记 queued command started，query 正常完成后由 `query()` 标记 completed。 |
| refresh tools | `src/query.ts:1659` 到 `:1671` | MCP 等工具可在轮间刷新。 |

然后，loop 生成下一轮 state：

```text
state.messages = [
  ...messagesForQuery,
  ...assistantMessages,
  ...toolResults,
]
state.toolUseContext = updatedToolUseContext + queryTracking
state.turnCount = turnCount + 1
state.pendingToolUseSummary = nextPendingToolUseSummary
state.transition = { reason: 'next_turn' }
continue
```

源码位置：`src/query.ts:1714` 到 `:1727`。

这就是 agent loop 的核心闭环：模型输出的 `tool_use` 和工具运行时产生的 `tool_result` 都被写回 transcript，下一轮模型只能通过 transcript 认识外部世界的变化。

## 12. Transcript 协议与不变量

### 12.1 `tool_result` 是 user message

工具结果由 `createUserMessage()` 创建，content 里包含 `tool_result` block。源码位置：

- `src/utils/messages.ts:460` 到 `:523`：`createUserMessage()`。
- `src/services/tools/toolExecution.ts:1456` 到 `:1467`：成功工具结果创建 user message。
- `src/services/tools/toolExecution.ts:1715` 到 `:1735`：异常工具结果创建 user message。

`src/utils/attachments.ts` 的注释直接确认：

```text
tool_use lives in assistant content; tool_result in user content
```

源码位置：`src/utils/attachments.ts:2451` 到 `:2463`。

### 12.2 `tool_result` 必须跟上对应 `tool_use`

几条防线共同保证 pairing：

| 防线 | 源码位置 | 行为 |
|---|---|---|
| `yieldMissingToolResultBlocks()` | `src/query.ts:123` 到 `:147` | 发生 model fallback 或 query error 时，为已经出现但未闭合的 `tool_use` 生成 error `tool_result`。 |
| streaming abort handling | `src/query.ts:1011` 到 `:1029` | abort 后 drain executor，或为缺失结果生成 interruption result。 |
| tool abort handling | `src/query.ts:1484` 到 `:1515` | 工具中断时返回 user interruption 并检查 max turns。 |
| `ensureToolResultPairing()` | `src/utils/messages.ts:5119` 到 `:5460` | API boundary 前修复 missing / orphan / duplicate tool use/result。 |

这说明 `tool_result` 不是 UI 日志，而是下一轮 API 请求的结构化前提。

### 12.3 工具结果和普通 user message 不能随意交错

`query.ts` 在工具执行后有注释：

```text
Be careful to do this after tool calls are done,
because the API will error if we interleave tool_result messages with regular user messages.
```

源码位置：`src/query.ts:1535` 到 `:1537`。

因此 queued notifications、attachments、memory、skill discovery 都在工具批次完成后处理，而不是穿插在工具执行中间。

### 12.4 User content 里 `tool_result` 要排在前面

`hoistToolResults()` 会把 user message content 中的 `tool_result` blocks 提到前面，避免 “tool result must follow tool use” API errors。

源码位置：`src/utils/messages.ts:2466` 到 `:2483`。

`mergeUserMessagesAndToolResults()` 会在合并 user messages 时调用 `hoistToolResults()`。源码位置：`src/utils/messages.ts:2372` 到 `:2386`。

### 12.5 错误也是 tool_result

Claude Code 对未知工具、输入校验失败、权限拒绝、工具异常、用户中断、streaming fallback，都尽量生成合法 `tool_result`：

```text
assistant: tool_use(id=toolu_1)
user: tool_result(tool_use_id=toolu_1, is_error=true, content=...)
```

这让模型下一轮能看到“工具失败了”，而不是让 transcript 断裂。

## 13. 错误、恢复和边界路径

### 13.1 Model fallback

如果 provider 抛出 `FallbackTriggeredError` 且配置了 fallback model，loop 会：

- 切换 `currentModel`。
- 为旧 attempt 中缺失的 tool results 补 synthetic error。
- 清空 assistant/tool 状态。
- discard streaming executor。
- 更新 `toolUseContext.options.mainLoopModel`。
- 必要时 strip thinking signature blocks。
- yield 一个 system warning。
- `continue` 重试。

源码位置：`src/query.ts:893` 到 `:950`。

### 13.2 Streaming fallback

如果 streaming 中途 fallback：

- tombstone 已 yield 的 assistant messages。
- 清空本轮 assistant/tool arrays。
- discard streaming tool executor 并新建。

源码位置：`src/query.ts:709` 到 `:740`。

关键原因：旧 streaming attempt 中的 assistant message 和 tool result 不能污染新 attempt。

### 13.3 Query-level exception

如果模型调用或 loop 内部异常，`query.ts` 会：

- log error。
- 为已出现的 tool_use 补 missing tool_result。
- yield synthetic assistant API error message。
- 返回 `model_error`。

源码位置：`src/query.ts:955` 到 `:996`。

### 13.4 Streaming abort

如果用户在模型 streaming 阶段 abort：

- streaming executor 路径会 drain remaining results，让 executor 生成 synthetic tool_results。
- 非 executor 路径会用 `yieldMissingToolResultBlocks()` 补齐。
- yield user interruption message。
- 返回 `aborted_streaming`。

源码位置：`src/query.ts:1011` 到 `:1051`。

### 13.5 Tool abort

如果用户在工具执行期间 abort：

- loop 可做 computer-use cleanup。
- yield tool-use interruption message。
- 检查 abort 后是否超过 max turns。
- 返回 `aborted_tools`。

源码位置：`src/query.ts:1484` 到 `:1515`。

### 13.6 Max turns

如果工具执行后即将进入下一轮，但 `nextTurnCount > maxTurns`，loop 会 yield `max_turns_reached` attachment 并返回 `max_turns`。

源码位置：`src/query.ts:1704` 到 `:1712`。

### 13.7 Provider stream watchdog

provider 层有 streaming idle timeout watchdog。它会在无 chunk 超过阈值时主动 release stream resources，避免连接静默挂死。

源码位置：`src/services/api/claude.ts:1868` 到 `:1929`。

这不是 agent loop 的语义核心，但属于生产级 loop 的可靠性边界。

## 14. Source Evidence / 源码确认

| 源码位置 | 关键符号 / 逻辑 | 确认事实 |
|---|---|---|
| `src/query.ts:181` | `QueryParams` | `query()` 输入包含 messages、system/user context、tool runtime、permission、fallback、maxTurns、taskBudget、deps。 |
| `src/query.ts:203` | `State` | loop 持有跨迭代 mutable state。 |
| `src/query.ts:219` | `query()` | 对外暴露 async generator。 |
| `src/query.ts:241` | `queryLoop()` | 核心状态机实现。 |
| `src/query.ts:307` | `while (true)` | 单次用户请求可多轮循环。 |
| `src/query.ts:365` | `messagesForQuery` | 本轮 API 输入从 compact boundary 后的消息投影开始。 |
| `src/query.ts:379` | `applyToolResultBudget()` | 模型请求前先处理工具结果预算。 |
| `src/query.ts:414` | `deps.microcompact()` | microcompact 是每轮前置阶段。 |
| `src/query.ts:454` | `deps.autocompact()` | autocompact 在模型请求前发生。 |
| `src/query.ts:551` | `assistantMessages` / `toolResults` | 每轮局部收集 assistant 输出和 user-side 工具结果。 |
| `src/query.ts:553` | stop_reason 注释 | `stop_reason === 'tool_use'` 不可靠。 |
| `src/query.ts:557` | `toolUseBlocks` / `needsFollowUp` | `tool_use` content block 是继续信号。 |
| `src/query.ts:659` | `deps.callModel()` | loop 调 provider，传入 messages、systemPrompt、tools、signal、options。 |
| `src/query.ts:826` | assistant stream 消费 | assistant message 进入 `assistantMessages`。 |
| `src/query.ts:829` | content filter | 从 assistant content 中提取 `tool_use`。 |
| `src/query.ts:842` | `streamingToolExecutor.addTool()` | streaming 路径可提前排队执行工具。 |
| `src/query.ts:1062` | `if (!needsFollowUp)` | 无工具请求时走结束 / recovery / stop hook 路径。 |
| `src/query.ts:1380` | `toolUpdates` | 有工具请求时选择 streaming executor 或 `runTools()`。 |
| `src/query.ts:1395` | `normalizeMessagesForAPI([update.message])` | 工具更新被归一化成下一轮可用 user message。 |
| `src/query.ts:1535` | tool_result interleave 注释 | tool_result 不应和普通 user messages 交错。 |
| `src/query.ts:1716` | next state messages | 下一轮 messages = 本轮输入投影 + assistant messages + tool results。 |
| `src/query/deps.ts:21` | `QueryDeps` | 模型、microcompact、autocompact、uuid 被抽成可注入 deps。 |
| `src/services/api/claude.ts:752` | `queryModelWithStreaming()` | provider 暴露 async generator。 |
| `src/services/api/claude.ts:1266` | `normalizeMessagesForAPI()` | API 调用前归一化 messages。 |
| `src/services/api/claude.ts:1301` | `ensureToolResultPairing()` | API boundary 前修复 tool_use/tool_result mismatch。 |
| `src/services/api/claude.ts:1818` | raw stream 注释 | Claude Code 使用 raw stream，自行累积 tool input。 |
| `src/services/api/claude.ts:1995` | `content_block_start` | 初始化 content block 槽位。 |
| `src/services/api/claude.ts:2087` | `input_json_delta` | streaming tool input 以 partial JSON 累加。 |
| `src/services/api/claude.ts:2171` | `content_block_stop` | 完成的 block 生成 `AssistantMessage` 并 yield。 |
| `src/services/api/claude.ts:2213` | `message_delta` | usage / stop_reason 回写到最后 assistant message。 |
| `src/utils/api.ts:119` | `toolToAPISchema()` | 内部工具转换为 API schema。 |
| `src/utils/messages.ts:1989` | `normalizeMessagesForAPI()` | API 请求前清理、合并、规范化 transcript。 |
| `src/utils/messages.ts:2466` | `hoistToolResults()` | user message 中 tool_result blocks 必须靠前。 |
| `src/utils/messages.ts:2651` | `normalizeContentFromAPI()` | streamed tool input string parse 成对象。 |
| `src/utils/messages.ts:5119` | `ensureToolResultPairing()` | 修复 missing / orphan / duplicate tool use/result。 |
| `src/services/tools/toolOrchestration.ts:19` | `runTools()` | 普通工具调度入口。 |
| `src/services/tools/toolOrchestration.ts:91` | `partitionToolCalls()` | 按 concurrency safe 分批。 |
| `src/services/tools/StreamingToolExecutor.ts:40` | `StreamingToolExecutor` | streaming 工具执行器。 |
| `src/services/tools/toolExecution.ts:337` | `runToolUse()` | 单个工具执行入口。 |
| `src/services/tools/toolExecution.ts:614` | schema validation | 输入 schema 不合法时返回 error tool_result。 |
| `src/services/tools/toolExecution.ts:800` | `runPreToolUseHooks()` | 工具调用前运行 hooks。 |
| `src/services/tools/toolExecution.ts:921` | `resolveHookPermissionDecision()` | hook permission 和 `canUseTool` 合成最终决策。 |
| `src/services/tools/toolExecution.ts:1207` | `tool.call()` | 真正副作用只在 allow 后执行。 |
| `src/services/tools/toolExecution.ts:1403` | `addToolResult()` | 工具输出被映射成 user tool_result message。 |
| `src/services/tools/toolHooks.ts:322` | hook permission 注释 | hook allow 不绕过 deny / ask rules。 |
| `src/Tool.ts:158` | `ToolUseContext` | 工具执行上下文边界。 |
| `src/Tool.ts:379` | `Tool.call()` | 工具调用签名包含 context、permission fn、parent assistant message、progress callback。 |
| `src/Tool.ts:402` | `isConcurrencySafe()` | 并发调度策略由工具声明。 |

## 15. Discovery Log

本轮阅读路径：

1. 从 `docs/wiki-source/cc/analysis/claude-code-skills-technical-scheme.md` 确认 mature analysis 的质量目标：先讲可读心智模型，再给源码证据和外部实现含义。
2. 读取现有 `claude-code-agent-loop.md`，确认它只覆盖最小 `tool_use -> tool_result` 闭环，且混入 `mini-cc` 课程说明，不足以回答“一次 loop 里具体干了什么”。
3. 用 `rg` 定位 `query()`、`queryLoop()`、`while (true)`、`toolUseBlocks`、`needsFollowUp`、`messagesForQuery`、`runTools()`、`StreamingToolExecutor`。
4. 顺读 `src/query.ts:181` 到 `:1728`，把一次 `while` 迭代拆成上下文投影、模型调用、stream 消费、结束路径、工具路径、下一轮 state。
5. 追 `src/query/deps.ts`，确认 `query.ts` 通过 `QueryDeps` 抽象 provider 和 compaction。
6. 追 `src/services/api/claude.ts`，确认 provider 负责 API message normalization、tool schema、raw stream、content block 聚合、usage/stop_reason 回写。
7. 追 `src/utils/messages.ts`，确认 API boundary 前的 transcript normalization 和 `tool_use` / `tool_result` pairing 修复。
8. 追 `src/services/tools/toolOrchestration.ts` 和 `src/services/tools/StreamingToolExecutor.ts`，确认普通工具调度和 streaming 工具执行的并发策略。
9. 追 `src/services/tools/toolExecution.ts` 和 `src/services/tools/toolHooks.ts`，确认单个工具执行前后有 schema、validate、hooks、permission、call、PostToolUse、failure hook。
10. 反查 `src/QueryEngine.ts` 和 `src/screens/REPL.tsx`，确认 SDK/headless 和 REPL 都通过 `for await` 消费同一个 `query()`。

## 16. Design Reconstruction

Claude Code 的 agent loop 可以拆成五个独立责任层：

| 层 | 主要模块 | Owns | 不应该做什么 |
|---|---|---|---|
| Entry / Host | `REPL.tsx`、`QueryEngine.ts`、AgentTool / forked agent | 用户输入、UI/SDK 事件消费、session persistence、初始 context 准备 | 不实现模型工具闭环状态机 |
| Loop Reducer | `src/query.ts` | loop state、context projection 顺序、assistant/tool result 收集、continue/return 决策 | 不理解具体工具副作用 |
| Provider Adapter | `src/services/api/claude.ts`、`src/utils/api.ts`、`src/utils/messages.ts` | API schema、message normalization、stream chunk 聚合、provider fallback、usage/cost | 不执行本地工具 |
| Tool Runtime | `src/services/tools/*`、`src/Tool.ts` | tool lookup、schema validation、hooks、permission、execution、result mapping、concurrency | 不决定整个 agent turn 是否结束 |
| Concrete Tools | `src/tools/*`、MCP tools、SkillTool 等 | 真实文件、shell、网络、子 agent、skill 等副作用 | 不直接修改主 transcript 状态机 |

这套分层背后的工程压力是：

1. **入口很多**：REPL、SDK、subagent、forked agent 都要复用同一套行为。
2. **streaming 很复杂**：raw chunk、thinking signature、partial JSON、fallback、watchdog 都不应该污染主 loop。
3. **工具执行有安全边界**：schema、validation、hooks、permission、classifier、UI approval、failure hooks 必须集中在工具层。
4. **transcript 是事实源**：所有工具结果、错误、附件、meta continuation 都必须变成下一轮模型可见的 message。
5. **API 约束很脆弱**：role alternation、tool_result 顺序、missing result、orphan result、duplicate id、thinking-only messages、media size 都会让 API 请求失败。

## 17. External Implementation Implications

如果外部系统要复现 Claude Code 风格 agent loop，建议把 MVP 拆成这些模块：

| 模块 | 最小职责 |
|---|---|
| `AgentLoop` | 持有 `State`，循环调用 context projector、model adapter、tool runtime。 |
| `ContextProjector` | 从 full transcript 生成本轮 `messagesForQuery`，先支持 max token truncation，后续加 compaction。 |
| `ModelAdapter` | 输入 normalized messages/system/tools，输出 assistant messages；streaming chunk 只在 adapter 内部处理。 |
| `MessageNormalizer` | 合并 user messages、规范 assistant tool inputs、保证 `tool_use` / `tool_result` 配对。 |
| `ToolRegistry` | 按 name / alias 查找工具，暴露 schema 和 prompt。 |
| `ToolRuntime` | 执行 schema parse、tool validation、hooks、permission、tool call、result mapping。 |
| `PermissionService` | 独立于工具 call，返回 allow / deny / ask 和 updated input。 |
| `ContinuationPolicy` | 处理 stop hooks、max turns、max output recovery、prompt-too-long recovery。 |
| `EventSink` | 把 assistant/progress/tool_result/attachment/tombstone 事件送给 UI 或 SDK。 |

必须保留的协议：

```ts
type AssistantMessage = {
  role: "assistant"
  content: Array<TextBlock | ThinkingBlock | ToolUseBlock>
}

type ToolUseBlock = {
  type: "tool_use"
  id: string
  name: string
  input: Record<string, unknown>
}

type UserToolResultMessage = {
  role: "user"
  content: Array<{
    type: "tool_result"
    tool_use_id: string
    content: string | ContentBlock[]
    is_error?: boolean
  }>
}
```

最小循环可以先不做 streaming tool execution，但必须做：

- 只根据 assistant content 中是否有 `tool_use` 判断是否继续。
- 所有 tool_use 都必须闭合为 tool_result，包括错误和拒绝。
- tool_result 必须作为 user message 回填。
- 下一轮请求必须包含上一轮 assistant tool_use 和 user tool_result。
- provider adapter 必须隔离 streaming chunk 与 loop message。
- 工具执行必须在 permission allow 后才调用真实副作用。

不要在 MVP 里走的捷径：

| 捷径 | 风险 |
|---|---|
| 把工具结果作为 assistant 文本补回去 | 模型看不到结构化 tool_result，下一轮协议不合法。 |
| 依赖 `stop_reason === "tool_use"` | Claude Code 源码明确认为不可靠。 |
| 工具执行直接写在 loop 中 | 后续 permission、hooks、concurrency、MCP、Skill、subagent 会让 loop 膨胀失控。 |
| streaming chunk 直接暴露给 loop reducer | 会把 partial JSON、thinking signature、fallback tombstone 等 provider 细节扩散。 |
| permission deny 直接中止整个 loop | 模型失去“工具被拒绝”的上下文；应返回 error tool_result。 |
| 允许 orphan tool_result 进入下一次 API 请求 | API 会 400，session 可能卡死在不可恢复状态。 |

## 18. 常见失败模式

| 失败模式 | 症状 | Claude Code 的防线 |
|---|---|---|
| tool_use 缺少 tool_result | 下一次 API 请求报 missing tool result / unexpected tool_use_id。 | `yieldMissingToolResultBlocks()`、`ensureToolResultPairing()`。 |
| streaming fallback 后旧结果泄漏 | 新 assistant message 的 tool ids 和旧工具结果不匹配。 | tombstone partial messages，discard executor。 |
| 权限拒绝后不回填结果 | 模型不知道工具被拒绝，会重复或误判状态。 | permission deny 映射为 `is_error` tool_result。 |
| 把普通附件插进工具结果中间 | API 报 tool_result 与 user message 交错错误。 | 工具批次完成后再处理 attachments。 |
| 并发工具乱序输出 | 模型把 A 的结果理解成 B 的结果，或 context modifier 应用错位。 | `partitionToolCalls()`、StreamingToolExecutor order buffering。 |
| provider 层不 parse streamed input_json | loop 看到字符串 input，工具 schema parse 失败。 | `normalizeContentFromAPI()`。 |
| 修改 API-bound assistant message | prompt cache hash / thinking signature / VCR fixture 不稳定。 | yield clone，原始 message 回流 API。 |
| API error 也跑 stop hooks | error -> hook blocking -> retry -> error 死循环。 | API error 直接 stop failure hooks 后返回。 |
| stream 静默挂死 | session 长时间无响应。 | streaming idle watchdog release resources。 |

## 19. Verification

本轮主要是源码阅读和文档更新，没有修改 `mini-cc` 代码，也没有新增运行时行为。

已完成的验证方式：

- 对照 `rg` 搜索结果重新定位了主入口：`query()`、`queryLoop()`、`while (true)`、`toolUseBlocks`、`runTools()`、`StreamingToolExecutor`。
- 顺读了 `src/query.ts` 主循环从 state 初始化到下一轮 state 写回的关键区间。
- 追到 provider 层 `queryModelWithStreaming()`、`normalizeMessagesForAPI()`、`ensureToolResultPairing()`、raw stream event reducer。
- 追到工具层 `runTools()`、`StreamingToolExecutor`、`runToolUse()`、`resolveHookPermissionDecision()`。
- 反向确认 REPL 与 SDK/headless 都通过 `for await` 消费同一个 `query()`。

建议后续如果要做 empirical verification，可用 `cc-practice-lab` 构造一个 fake `QueryDeps.callModel`：

```text
case 1: assistant text only -> query returns completed
case 2: assistant tool_use -> fake tool_result -> second assistant text
case 3: assistant tool_use then provider error -> yieldMissingToolResultBlocks fires
case 4: permission deny -> error tool_result still enters next messages
case 5: duplicate/orphan tool_result -> ensureToolResultPairing repairs or strict throws
```

## 20. 合理推断

- Claude Code 把 `query.ts` 保持为 transcript reducer，是为了让 REPL、SDK、subagent、forked agent 共享同一套 agent 行为，同时把 UI 和工具副作用隔离出去。
- `messagesForQuery` 每轮都重新投影，而不是直接追加，是为了支持 compaction、content replacement、context collapse、tool result budget、media stripping 等“读时视图”能力。
- `StreamingToolExecutor` 是性能优化，不是 agent loop 的语义基础；关闭它时普通 `runTools()` 仍能保证正确的工具闭环。
- `ensureToolResultPairing()` 说明生产 session 中 transcript corruption 是真实风险；外部系统如果支持 resume / compaction / remote replay，也需要类似防线。
- hook permission 不能绕过 deny / ask rules，反映出 Claude Code 的安全模型优先级：全局策略 > hook allow > normal prompt convenience。

## 21. 待验证

- `StreamingToolExecutor.getCompletedResults()` / `getRemainingResults()` 的完整输出排序细节、本轮只读到 class 上半段和 query 调用点，尚未逐行展开所有 yielded 状态转换。
- `handleStopHooks()` 的内部决策、stop hook blocking message 的具体 shape，需要单独分析 `src/query/stopHooks.ts`。
- `applyToolResultBudget()`、microcompact、autocompact、context collapse 的具体压缩算法，需要单独分析 context / compaction 主题。
- `canUseTool()` 具体如何连接 permission rules、classifier、UI prompt 和 headless structured IO，需要单独分析 permission pipeline。
- MCP tool result 的 `structuredContent` / `_meta` 如何进入 SDK consumer、本轮只确认了 `mcpMeta` 在 tool result message 中被保留。
- `ToolSearch` / deferred tools 对 tool schema、message normalization 和 tool invocation 的影响，本轮只确认了 schema 字段和 strip 逻辑。
