# Claude Code 上下文工程技术方案：面向外部系统的可复现 Context 架构

## 如何阅读本文

本文是一份源码机制分析加技术方案，不是命令日志。推荐按两条路径阅读：

- **快速理解路径**：读本节、§ Learning Question、§ Scope、§ 0 设计摘要、§ 1 全局心智模型、§ 2 最小闭环。目标是在 30 分钟内知道 Claude Code 的上下文工程解决什么问题，以及外部系统最小需要哪些模块。
- **实现路径**：从 § 3 到 § 13 顺序阅读。每一节都把 Claude Code 源码事实重构成可复现的模块职责、协议形状、状态流、失败模式和测试计划。

本文的结论已按当前仓库中的 Claude Code 源码镜像校验。需要核验具体来源时，见文末“附录 A：源码依据 / 设计来源校验”。正文面向外部 agent 系统工程团队，读者不需要理解本仓库的课程结构。

**文档地图：**

| 目标 | 主要章节 |
|---|---|
| 判断这套机制是否值得实现 | § 0 设计摘要、§ 1 全局心智模型、§ 2 最小闭环 |
| 分清 agent loop 边界 | § 2.1 到 § 2.5 |
| 分清 messages 如何成为上下文 | § 2.6、§ 6 |
| 设计上下文层级 | § 3 系统上下文架构、§ 4 静态上下文、§ 5 动态附件 |
| 控制 token 增长 | § 6 消息投影、§ 7 工具结果预算、§ 8 微压缩、§ 9 自动压缩 |
| 做恢复和长会话 | § 10 session memory、§ 11 compaction 后恢复 |
| 上生产 | § 12 观测、§ 13 安全边界、§ 14 测试计划、§ 15 失败模式 |

先记住这张最小闭环图：

```text
session / cwd / settings / tools / transcript
        |
        v
ContextSources
  |-- system context: git status, cache breaker
  |-- user context: CLAUDE.md, date
  |-- attachments: files, plans, tasks, skills, memories, reminders
        |
        v
MessageProjection
  compact boundary -> tool-result budget -> microcompact
     -> optional collapse -> autocompact
        |
        v
ProviderRequest
  systemPrompt + systemContext
  userContext as meta user reminder
  projected messages + attachment-rendered meta messages
  tools / tool search / cache metadata
        |
        v
model output -> tool results -> transcript -> next projection
```

Claude Code 的上下文工程不是单个“拼 prompt”函数，而是一组围绕长会话连续运行的治理机制：它决定哪些信息进入模型、以什么角色进入、什么时候被压缩、压缩后怎样恢复工作状态，以及这些改写如何不破坏工具协议、权限边界和 prompt cache。

## Learning Question

本文回答这个工程问题：

```text
如果一个 agent 应用想支持 Claude Code 风格的长会话代码协作，
应该如何设计上下文来源、消息投影、token 预算、压缩恢复、
文件/技能/计划等动态上下文，以及可观测的安全边界？
```

这里的“上下文工程”不是简单的 RAG，也不是把所有资料塞进 system prompt。更准确的定义是：

```text
在每次模型调用前，把会话状态投影成一个可发送、可恢复、可审计、
不破坏工具协议且尽量保留工作连续性的模型可见窗口。
```

这个定义包含四个关键词：

- **投影**：模型看到的是当前 transcript 的 API 视图，不等于 UI 中完整历史。
- **治理**：上下文进入模型前会经历预算、压缩、恢复、权限过滤和缓存稳定性处理。
- **连续性**：压缩不是结束会话，而是生成 summary、恢复关键文件、计划、skills 和 hook 结果后继续工作。
- **边界**：系统规则、用户指令、服务端 meta context、工具结果和附件不是同一种东西，不能混写。

## Scope

**本文覆盖：**

- Claude Code 上下文来源的分层：system prompt、system context、user context、attachments、transcript、tool schemas。
- `CLAUDE.md` / memory 文件发现、优先级、include、条件规则和注入方式。
- agent loop 每轮模型调用前的消息投影顺序。
- 工具结果持久化、每消息预算、microcompact、manual compact、autocompact、session memory compact 的职责边界。
- 压缩后如何恢复文件、计划、skills、异步 agent 和 hooks。
- `/context` 可视化如何近似“模型实际看到的 API 视图”。
- 外部系统可复现的模块设计、数据结构、测试计划和失败模式。

**本文不覆盖：**

- Claude Code 完整 agent loop。已有 `claude-code-agent-loop.md` 覆盖主循环。
- Skills 子系统完整设计。已有 `claude-code-skills-technical-scheme.md` 覆盖。
- synthetic file context 的专项方案。已有 `claude-code-synthetic-file-context-technical-scheme.md` 覆盖。
- 未出现在当前源码镜像中的 `contextCollapse` 和 `snipCompact` 具体算法。本文只写已确认的引用位置、顺序和边界。

## 0. 设计摘要

### 0.1 核心方案

Claude Code 把上下文工程拆成三层：

1. **来源层**：从系统、项目、用户、工具运行时、文件读缓存、hooks、计划、技能、任务、MCP、内存文件等位置收集上下文。
2. **投影层**：在 `query()` 每轮模型调用前，把当前消息历史投影为 `messagesForQuery`，并按固定顺序应用 compact boundary、工具结果预算、microcompact、context collapse、autocompact。
3. **请求层**：把投影后的 messages、追加了 system context 的 system prompt、前置的 user meta reminder、工具 schema 和 provider 选项发送给模型。

它的关键设计不是“尽量多给模型上下文”，而是“让模型看到足够、稳定、可继续工作的上下文”。

### 0.2 一句话机制

```text
Claude Code 在每次模型调用前动态构造 API 视图：
保留最近和关键状态，压缩或引用旧的大块内容，
并用 meta user message / attachment / compact summary 维持行为连续性。
```

> `meta user message` 建议译为“系统注入的 user 角色消息”，`meta user reminder` 建议译为“系统注入的 user 角色提醒消息”。拆开看：`user` 指 provider messages 里的角色是 `user`；`message` 指它仍是一条会发给模型的消息；`reminder` 指内容语气是提醒模型参考上下文；`meta` 指来源和性质是运行时注入的元信息，不是用户直接输入。对比普通 `user message` 只是辅助理解：二者发给模型时都可以是 `user` 角色，但 `meta user message` 会在内部消息上标记 `isMeta: true`，常用 `<system-reminder>` 包住 `CLAUDE.md`、当前日期、memory 等 `userContext`，提醒模型可参考这些信息，但不要把它当成用户刚刚提出的新请求。

### 0.3 最重要的工程取舍

| 取舍                     | Claude Code 的做法                                                                                                      | 外部系统启示                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| system vs user context | system context 追加到 system prompt；CLAUDE.md/date 作为 meta user reminder 前置。                                            | 稳定规则、运行环境、用户配置不要混成一个字符串。   |
| transcript vs API view | UI 历史可完整保留；模型调用前从 compact boundary 后开始投影。                                                                            | “会话记录”与“本轮发送给模型的窗口”必须分离。   |
| 大工具结果                  | 过大结果写入磁盘，模型只看预览和路径；预算按聚合后的消息计算，替换决策首次确定后保持不变。                                                                        | 长输出不要直接截断丢失，也不要每轮重传全文。     |
| 压缩                     | 压缩时会优先复用 session memory；如果不可用，再用 forked agent 生成摘要，并在失败时回退到普通流式摘要。压缩完成后，系统会按固定顺序重建上下文：压缩边界、摘要、保留的尾部消息、恢复附件和 hook 结果。 | 压缩应是状态转换，不是简单摘要文本替换。       |
| 文件上下文                  | 压缩后最多恢复近期文件，受文件数和 token 预算约束。                                                                                        | 文件内容要有生命周期，不能靠模型记忆。        |
| 技能上下文                  | skill listing 不在 compact 后无限重注入；已调用 skill 内容可作为 `invoked_skills` attachment 保留。                                      | 能力索引和已执行指令要分开治理。           |
| 观测                     | `/context` 按 API 视图估算 token，区分 system、tools、MCP、memory、skills、messages、buffer。                                       | 上下文工程必须可解释，否则用户无法判断为什么会溢出。 |

> 这里的 transcript 建议翻译成 **“会话记录”**，如果强调工程语义，可以写成 **“可回放会话记录”** 或 **“对话回放记录”**。
> transcript = 系统保存下来的、能够复现和解释一轮 agent 对话过程的记录。
## 1. 全局心智模型 / 关键术语

### 1.1 四种上下文不要混淆

| 名称                    | Claude Code 对应                                       | 语义                                               | 不应该做什么                                          |
| --------------------- | ---------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------- |
| `systemPrompt`        | `getSystemPrompt()` + `buildEffectiveSystemPrompt()` | 产品级、模式级、agent 定义级规则。                             | 不放每轮变化的大量文件正文。                                  |
| `systemContext`       | `getSystemContext()`                                 | 运行环境快照，例如 git 状态、cache breaker。                  | 不当作用户消息回复。                                      |
| `userContext`         | `getUserContext()`                                   | 用户/项目指令和日期，最后通过 meta user reminder 注入。           | 不伪装成真实用户请求。                                     |
| `attachment`          | `AttachmentMessage`                                  | 本轮或压缩后追加的服务端上下文片段，例如文件、计划、任务、skill listing。      | 不伪装成模型真实工具调用结果。                                 |
| `transcript messages` | `Message[]`                                          | UI、恢复、审计、下一轮投影的历史事实源。                            | 不直接等同于 provider 请求体，也不直接等同于“上下文”。               |
| `messagesForQuery`    | `query.ts` 中的本轮投影                                    | 每轮实际准备送入模型的内部消息窗口。                               | 不持久化为唯一历史。                                      |
| `provider messages`   | `normalizeMessagesForAPI()` 输出                       | Anthropic Messages API 可接受的 user/assistant 消息序列。 | 不保留 UI-only / virtual / progress / 不合法 pairing。 |

### 1.2 Claude Code 的上下文不是一次性构造

`getSystemContext()` 和 `getUserContext()` 都被 memoize，**注释说明它们会在会话期间缓存。compaction 后会清理相关缓存**，让 memory 文件和 hooks 能以 “compact” 原因重新加载。这意味着上下文工程具有生命周期：

```text
session start
  -> eager context load
  -> repeated query projections
  -> compact boundary
  -> cache cleanup / memory reload
  -> post-compact restored context
  -> repeated query projections
```

> **注释说明它们会在会话期间缓存。compaction 后会清理相关缓存**
> 面试可聊的点

> **post-compact restored context**
> 
> 可以理解成：
> ``` text
> 	压缩后重新补回模型继续工作所需的上下文
> ```
> 它不是 summary 本身。
> 一次 compact 后，旧对话的大部分原文会被摘要替代，但模型继续干活还需要一些“现场状态”。这些状态如果只靠摘要，可能不够精确，所以系统会在 summary 后面重新注入一批附件/上下文。
> 在 Claude Code 里，这类 restored context 大致包括：
> ``` text
> 	最近读过的文件内容
> 	当前 plan / todo 状态
> 	plan mode 指令
> 	已经调用过的 skill 信息
> 	deferred tool schemas / agent listing / MCP instructions
> 	post-compact hook 结果
> ```
> 所以整个 compact 后的上下文不是：
> ``` text
> 	压缩后重新补回模型继续工作所需的上下文
> ```
> 而是：
> ``` text
> 	compact boundary
> 	summary
> 	保留的最近原始消息
> 	restored context
> 	hook results
> ```
### 1.3 两类压缩

| 类型 | 作用 | 是否总结对话 | 源码确认 |
|---|---|---|---|
| tool result budget / microcompact | 清理或引用旧工具结果，控制局部 token 增长。 | 否。 | `src/utils/toolResultStorage.ts`、`src/services/compact/microCompact.ts` |
| compact / autocompact / session memory compact | 把对话前段压缩成 summary，保留最近片段和关键附件。 | 是。 | `src/services/compact/compact.ts`、`src/services/compact/autoCompact.ts`、`src/services/compact/sessionMemoryCompact.ts` |

## 2. 最小可用闭环

一个外部系统复现 Claude Code 上下文工程，最小需要这些模块：

```text
ContextLoader
  loadSystemContext()
  loadUserContext()
  loadAttachments(turnState)

MessageProjector
  afterCompactBoundary(messages)
  enforceToolResultBudget(messages)
  microcompact(messages)
  autocompactIfNeeded(messages)

CompactionService
  summarize(messages)
  buildPostCompactMessages(result)
  restoreRecentFiles(readFileState)

ProviderRequestBuilder
  appendSystemContext(systemPrompt, systemContext)
  prependUserContext(messages, userContext)
  normalizeMessagesForAPI(messages)
```

最小协议：

```ts
type ContextBundle = {
  systemPrompt: string[]
  systemContext: Record<string, string>
  userContext: Record<string, string>
  messages: AgentMessage[]
  attachments: AttachmentMessage[]
  tools: ToolDefinition[]
}

type ProjectedRequest = {
  systemPrompt: string[]
  messages: ProviderMessage[]
  tools: ProviderTool[]
  diagnostics: {
    estimatedTokens: number
    appliedTransforms: string[]
  }
}

type CompactionResult = {
  boundaryMarker: SystemMessage
  summaryMessages: UserMessage[]
  messagesToKeep?: AgentMessage[]
  attachments: AttachmentMessage[]
  hookResults: HookResultMessage[]
}
```

> State 是长期持有的会话状态；
> ContextBundle 是某一轮从 State 里抽取、加载、组装出来的上下文包。

最小运行流程：

```text
on user turn:
  userContext = getUserContext()
  systemContext = getSystemContext()
  messages = transcript + turn attachments

before model call:
  messagesForQuery = getMessagesAfterCompactBoundary(messages)
  messagesForQuery = applyToolResultBudget(messagesForQuery)
  messagesForQuery = microcompact(messagesForQuery)
  if shouldAutoCompact(messagesForQuery):
      result = compactConversation(messagesForQuery)
      messagesForQuery = buildPostCompactMessages(result)

request:
  fullSystemPrompt = appendSystemContext(systemPrompt, systemContext)
  requestMessages = prependUserContext(messagesForQuery, userContext)
  callModel(requestMessages, fullSystemPrompt, tools)
```

### 2.1 与 agent loop 的关系：先按时间边界看

Claude Code 的上下文工程跨越了 agent loop 前后，但不是所有机制都在同一个阶段发生。本文使用下面的边界：

```text
Host / Pre-Agent-Loop
  用户输入事件 -> processUserInput -> onQueryImpl -> query(params)

queryLoop bootstrap
  query() -> queryLoop() -> while(true) 之前

Agent Loop iteration
  while(true) 内：
    request-start
    -> context projection / compaction
    -> provider request
    -> assistant stream
    -> tool execution
    -> follow-up attachments
    -> state.messages update
```

最重要的结论：

```text
pre-agent loop 负责“把用户事件变成可进入 loop 的 turn”；
agent loop 内负责“每次模型调用前把 transcript 投影成可发送窗口，并在工具结果后继续推进状态”。
```

也就是说，`CLAUDE.md` 读取、system prompt 构建、用户显式附件收集，主要发生在进入 `query()` 前；而 compact boundary、工具结果预算、microcompact、autocompact、provider request 构建，发生在 `queryLoop()` 的 `while(true)` 内。

### 2.2 Pre-Agent-Loop 完成的上下文工程

Pre-agent loop 指 host 入口把用户提交交给 `query()` 之前的准备阶段。交互式 REPL 的主链路可由 `claude-code-pre-agent-loop.md` 和源码确认：

```text
REPL onSubmit
  -> handlePromptSubmit()
  -> processUserInput()
  -> processTextPrompt / processSlashCommand / processBashCommand
  -> onQuery()
  -> onQueryImpl()
  -> query(params)
```

这一阶段完成的是“turn 装配”，不是模型调用。

| 机制                                                            | 是否在 pre-agent loop | 源码依据                                                                         | 作用                                                                     |
| ------------------------------------------------------------- | -----------------: | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 用户输入排队、并发保护                                                   |                  是 | `src/utils/handlePromptSubmit.ts`                                            | 保证同一会话不会并发进入多个 turn。                                                   |
| 文本、图片粘贴、slash、bash、skill 分流                                   |                  是 | `src/utils/processUserInput/processUserInput.ts`                             | 决定输入是否应该请求模型。                                                          |
| 用户显式附件收集                                                      |                  是 | `src/utils/processUserInput/processUserInput.ts` 调 `getAttachmentMessages()` | 处理 at-mention 文件、MCP resource、IDE selection、skill listing 等首轮上下文。      |
| at-mention 文件预读                                               |                  是 | `src/utils/attachments.ts:processAtMentionedFiles()`                         | 把用户显式引用文件转成 attachment/meta context。                                   |
| slash/skill command 的 allowed tools / model / effort override |                  是 | `src/utils/processUserInput/processSlashCommand.tsx`、`src/screens/REPL.tsx`  | 为本 turn 收敛工具权限和运行参数。                                                   |
| fresh `ToolUseContext` 构建                                     |                  是 | `src/screens/REPL.tsx:onQueryImpl`                                           | 把工具、MCP、permission、app state、abort controller 等运行时上下文传入 `query()`。     |
| 默认 system prompt 获取                                           |                  是 | `src/screens/REPL.tsx:onQueryImpl` 调 `getSystemPrompt()`                     | 得到产品/工具/模式级基础系统提示。                                                     |
| `buildEffectiveSystemPrompt()`                                |                  是 | `src/utils/systemPrompt.ts`                                                  | 合并默认 system prompt、自定义 system prompt、append prompt、agent definition 等。 |
| `getUserContext()`                                            |         是，读取发生在此阶段 | `src/screens/REPL.tsx:onQueryImpl`、`src/context.ts`                          | 读取 CLAUDE.md/date，作为 `QueryParams.userContext` 传入 loop。                |
| `getSystemContext()`                                          |         是，读取发生在此阶段 | `src/screens/REPL.tsx:onQueryImpl`、`src/context.ts`                          | 读取 git status/cache breaker，作为 `QueryParams.systemContext` 传入 loop。    |

这里要特别区分“读取”和“注入”：

- `getUserContext()` / `getSystemContext()` 的读取在进入 `query()` 前完成。
- `systemContext` 真正追加到 system prompt，是在 `queryLoop()` 每轮迭代内调用 `appendSystemContext()`。
- `userContext` 真正变成模型可见 meta user reminder，是在 `queryLoop()` 调 provider 时调用 `prependUserContext()`。

### 2.3 `queryLoop()` bootstrap 完成的上下文工程

`query()` 被调用后，还没有立刻进入一次 agent loop iteration。`queryLoop()` 在 `while(true)` 前会建立 loop 级状态。

源码确认来自 `src/query.ts`：

| 机制                          | 阶段               | 作用                                                                                        |
| --------------------------- | ---------------- | ----------------------------------------------------------------------------------------- |
| 解构 immutable params         | `queryLoop()` 开始 | 固定 `systemPrompt`、`userContext`、`systemContext`、`canUseTool`、`querySource` 等本次 query 不变量。 |
| 注入 production deps          | `queryLoop()` 开始 | 把 `callModel`、`microcompact`、`autocompact`、`uuid` 绑定到生产实现。                                |
| 初始化 `State`                 | `while(true)` 前  | 保存 `messages`、`toolUseContext`、autocompact tracking、max output recovery、turn count。       |
| 初始化 token budget tracker    | `while(true)` 前  | 支持 `+500k` 这类 turn token budget 自动续跑。                                                     |
| 计算 `QueryConfig`            | `while(true)` 前  | 快照 feature/config/session 值，避免每轮重复读取部分环境。                                                 |
| 启动 relevant memory prefetch | `while(true)` 前  | 用 `startRelevantMemoryPrefetch()` 预取相关记忆，稍后在 loop 内消费。                                    |
> token budget tracker 用来追踪本轮已经输出了多少 token、续跑了几次、最近续跑是否还有产出；如果没达到用户指定的 token 目标，就自动注入提醒让 agent 继续。
> 它的工作方式是：
> 1. 用户输入里解析出预算，比如 +500k -> 500000。见 src/utils/tokenBudget.ts (line 21)。
> 2. REPL 在 turn 开始时记录当前输出 token 起点和本轮目标预算。见 src/screens/REPL.tsx (line 2893)。
> 3. queryLoop() 初始化 budgetTracker。见 src/query.ts (line 280)。
> 4. 每次模型没有继续调用工具、准备结束时，checkTokenBudget() 检查本轮输出 token 是否达到目标。
> 5. 如果还没到 90%，它会注入一条 meta user message，让模型继续工作。
> 
> 它还会防止无意义续跑：如果已经续跑 3 次以上，而且最近两次新增输出都少于 500 tokens，就认为收益递减，停止。
> 自动续“期”，自动续token，面试可聊

> relevant memory prefetch就是长期记忆召回：根据当前用户问题，从 memory directory 里挑出可能相关的记忆文件，并异步注入给模型。
> `startRelevantMemoryPrefetch()`是 **异步预取 + 延迟注入** 
> startRelevantMemoryPrefetch() 在进入 while(true) 前就启动了，但它不等结果，后面每一轮 agent loop 到某个检查点时，会看这个预取任务有没有完成：
> ``` text
> 	  如果 memory 预取已经完成：
> 		  把找到的 memory 文件渲染成 attachment message
> 		  注入到当前上下文里
> 		  后续模型就能看到这些记忆
>  
> 	  如果 memory 预取还没完成：
> 		  不等待
> 		  本轮继续走
> 		  下一次 loop 迭代再检查一次
> ```
> 异步任务，面试可聊

这部分不是 host pre-agent loop，但也还没有进入“模型请求前上下文投影”。它的角色是建立整个 `query()` 调用期间共享的 loop state。

### 2.4 Agent Loop iteration 内完成的上下文工程

一次 `while(true)` 迭代中，上下文工程主要分成两段：模型调用前的投影，以及工具执行后的 follow-up context 注入。

**模型调用前：**

|  顺序 | 机制                                         | 源码依据                                                  | 作用                                                                            |
| --: | ------------------------------------------ | ----------------------------------------------------- | ----------------------------------------------------------------------------- |
|   1 | `getMessagesAfterCompactBoundary()`        | `src/query.ts`                                        | 丢弃 compact boundary 前的旧原文，只保留 post-compact view。                              |
|   2 | `applyToolResultBudget()`                  | `src/query.ts`、`src/utils/toolResultStorage.ts`       | 对大工具结果做稳定预览替换和 transcript record。                                             |
|   3 | `snipCompactIfNeeded()`                    | `src/query.ts` feature-gated 引用                       | 在 microcompact 前尝试历史裁剪：移除部分模型可见历史并记录边界，减少后续上下文压力；当前源码镜像缺具体算法。                 |
|   4 | `deps.microcompact()`                      | `src/query.ts`、`src/services/compact/microCompact.ts` | 清理旧工具结果或生成 cache edits。                                                       |
|   5 | `contextCollapse.applyCollapsesIfNeeded()` | `src/query.ts` feature-gated 引用                       | 在 autocompact 前把历史投影为折叠视图：部分历史区间以摘要占位替代，若已足够降上下文，就避免触发完整 compact；当前源码镜像缺具体算法。 |
|   6 | `deps.autocompact()`                       | `src/query.ts`、`src/services/compact/autoCompact.ts`  | 超阈值时生成 compact summary 和恢复附件。                                                 |
|   7 | `appendSystemContext()`                    | `src/query.ts`、`src/utils/api.ts`                     | 把 pre-agent loop 读到的 `systemContext` 追加到 system prompt。                       |
|   8 | `prependUserContext()`                     | `src/query.ts`、`src/utils/api.ts`                     | 把 pre-agent loop 读到的 `userContext` 注入为 meta user reminder。                    |
|   9 | `deps.callModel()`                         | `src/query.ts`、`src/services/api/claude.ts`           | 发送 provider request。                                                          |
> applyToolResultBudget()就是之前说的“过大结果写入磁盘，模型只看预览和路径；预算按聚合后的消息计算，替换决策首次确定后保持不变。”
> 注意这个机制发现的时机。
> applyToolResultBudget() 这个过程是在 **每次 loop 迭代较前的位置、模型调用前** 完成的，不是在工具刚输出结果的那一刻立刻做“聚合预算判断”。
> ``` text
> 	第 N 轮模型调用
> 	  -> assistant 发出 tool_use
> 	  -> 执行工具，产生 tool_result
> 	  -> tool_result 被加入后续上下文
> 	  -> continue 到下一次 while 迭代\
> 	第 N+1 轮 loop 开头
> 	  -> getMessagesAfterCompactBoundary(messages)
> 	  -> applyToolResultBudget(messagesForQuery)
> 	  -> microcompact / autocompact / provider normalize
> 	  -> 发给模型
> ```
> 不过有一点值得注意：如果**单个工具结果过大**：工具执行生成结果时，processToolResultBlock() / maybePersistLargeToolResult() 就可能直接把它写盘并替换成预览。

**模型返回和工具执行后：**

| 机制                                      | 是否在 agent loop 内 | 源码依据                                  | 作用                                                                         |
| --------------------------------------- | ---------------: | ------------------------------------- | -------------------------------------------------------------------------- |
| assistant stream 收集                     |                是 | `src/query.ts`                        | 收集 text/thinking/tool_use blocks。                                          |
| streaming tool execution / `runTools()` |                是 | `src/query.ts`、`src/services/tools/*` | 执行工具并生成 user-side tool_result。                                             |
| tool result 回填                          |                是 | `src/query.ts`                        | 把工具结果作为下一轮模型调用的事实输入。                                                       |
| post-tool `getAttachmentMessages()`     |                是 | `src/query.ts`                        | 在工具结果后注入 queued command、memory、skill discovery、task 状态等 follow-up context。 |
| tools refresh                           |                是 | `src/query.ts`                        | 工具执行后可能刷新工具列表，供下一轮使用。                                                      |
| `state.messages` 更新                     |                是 | `src/query.ts`                        | 用 `messagesForQuery + assistantMessages + toolResults` 推进下一轮。              |

因此，动态附件有两类时机：

```text
pre-agent loop attachments:
  用户本轮输入显式触发，例如 @file、IDE selection、slash/skill prompt 附件。

agent-loop follow-up attachments:
  工具执行后或下一轮前注入，例如 queued notifications、relevant memory prefetch、
  skill discovery、task 状态、plan/auto mode reminders。
```

### 2.5 不在 agent loop 内、但会影响下一次 loop 的机制

还有一些机制发生在 loop 之外，但会改变下一次进入 loop 时的上下文：

| 机制                         | 阶段                                      | 影响                                                                                 |
| -------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------- |
| manual `/compact`          | pre-agent loop 的 slash/local command 路径 | 直接生成 compact result，替换/裁剪会话历史，下一次 query 从新 boundary 后开始。                           |
| `runPostCompactCleanup()`  | compact 成功后                             | 清理 microcompact state、memory caches、system prompt sections、classifier approvals 等。 |
| session restore            | 新会话/恢复前                                 | 重建 transcript、content replacement state、collapsed view 所需状态。                       |
| `/clear`、rewind、resume     | host/session 层                          | 改变 transcript 或缓存，间接改变下一次 `messagesForQuery`。                                      |
| `InstructionsLoaded` hooks | memory reload 时                         | 作为上下文加载事件，而不是一次普通模型消息。                                                             |
> 这里有笔误：
> `runPostCompactCleanup()`是在compact 成功后，在 **auto-compact 和 manual /compact** 后都调用。
> 所以严格来说不算**发生在 loop 之外**。接在**auto-compact**后的就在loop内，接在**manual /compact**后的就在loop外。 

这就是 Claude Code 上下文工程和 agent loop 的真实关系：

```text
pre-agent loop 决定“这次 turn 带什么上下文进入 query”；
agent loop 每轮决定“这批上下文如何投影成当前 provider request”；
工具执行后决定“哪些新事实和动态上下文进入下一轮”；
compact/restore 决定“长会话历史如何变成可继续的短窗口”。
```

### 2.6 Messages 不是天然上下文：四层 message 模型

需要单独强调：历史消息不是直接作为上下文送给模型的。Claude Code 里的 `messages` 至少要分成四层：

```text
1. durable transcript messages
   UI / session / resume / audit 的事实源
        |
        | getMessagesAfterCompactBoundary
        | applyToolResultBudget
        | snip / microcompact / collapse / autocompact
        v
2. messagesForQuery
   queryLoop 本轮内部 API view
        |
        | prependUserContext
        | appendSystemContext goes to system prompt, not messages
        v
3. request messages before provider normalization
   带 userContext meta reminder 的内部 messages
        |
        | normalizeMessagesForAPI
        | ensureToolResultPairing
        | strip unsupported media/tool-search/advisor blocks
        v
4. provider messages
   最终进入 Anthropic Messages API token context 的 user/assistant 消息
```

这四层解决的是不同问题：

| 层级                                    | 主要用途                      | 关键处理                                                                                   |
| ------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------- |
| durable transcript messages           | 保留完整工作事实、UI 回放、恢复、审计。     | 写入 assistant/tool result/attachment/boundary；不等于每轮发送内容。                                |
| `messagesForQuery`                    | 本轮模型调用前的内部上下文窗口。          | compact boundary、tool result budget、microcompact、autocompact。                          |
| request messages before normalization | 把本轮投影和 user context 合并。   | `prependUserContext(messagesForQuery, userContext)`。                                   |
| provider messages                     | 满足 provider 协议、真正计入模型上下文。 | attachment 渲染、连续 user 合并、assistant sibling 合并、tool pairing 修复、媒体/unsupported block 过滤。 |

因此，“历史消息成为上下文”不是一个静态包含关系，而是一个读时转换关系：

```text
历史消息是上下文候选源；
只有经过本轮投影和 provider normalization 后，
幸存下来的消息块才成为本次模型请求的上下文。
```

这也解释了为什么同一段历史在不同时间点可能有不同可见性：

- compact 后，compact boundary 前的旧原文不再进入 `messagesForQuery`。
- 大工具结果可能在 transcript 中仍有原始记录，但本轮 request 中只剩 persisted-output 预览。
- attachment 在 transcript 中是 typed `AttachmentMessage`，到 provider 前才被渲染为 user/meta 文本或 content blocks。
- 连续 user messages 在 transcript 中可能是多条，到 provider 前会合并成一个 user turn。
- 同一 provider response 被 streaming 拆成多个 assistant records，到 provider 前会按 `message.id` 合并。
- orphan/missing tool_use/tool_result 在 transcript 恢复、远程 replay 或 compact 后可能出现，provider 前还要经 `ensureToolResultPairing()` 修复或严格报错。

## 3. 系统上下文架构

### 3.1 模块职责表

| 模块                       | 负责                                                  | 不负责                              |
| ------------------------ | --------------------------------------------------- | -------------------------------- |
| `ContextLoader`          | 收集 system/user context，读取 memory 文件，生成当前日期和 git 快照。 | 不执行工具，不改写 transcript。            |
| `AttachmentBuilder`      | 把本轮服务端上下文渲染成 `AttachmentMessage`。                   | 不把附件伪造成真实工具结果。                   |
| `MessageProjector`       | 把 transcript 投影成本轮 provider 可见窗口。                   | 不删除 UI 历史，除非 compact 结果被上层接受。    |
| `ToolResultBudgeter`     | 对大工具结果做磁盘持久化和稳定替换。                                  | 不处理 `Read` 这类自带 maxTokens 的工具全文。 |
| `MicrocompactService`    | 清理旧的可压缩工具结果或通过 cache editing 删除服务端缓存内容。             | 不生成对话 summary。                   |
| `CompactionService`      | 生成 compact summary、boundary、恢复附件。                   | 不把所有旧消息原样保留。                     |
| `ContextVisualizer`      | 按 API 视图估算上下文占用。                                    | 不改变上下文。                          |
| `ProviderRequestBuilder` | 组装 system prompt、messages、tools、cache 参数。           | 不决定业务上下文是否应该存在。                  |

> 注意区分 memory 。
> 这里的`ContextLoader`负责读取 memory 文件，其中的memory，指的是：
> CLAUDE.md / instruction memory 。这是 getUserContext() 读取的东西，类型包括 Managed、User、Project、Local、AutoMem、TeamMem。
> 
> 而上文startRelevantMemoryPrefetch()读取长期记忆的memory，指的是长期记忆：
> auto-memory / relevant memories 。这是自动记忆目录里的文件，默认路径类似
> ``` text
> <Claude config>/projects/<project>/memory/
> ```
> 入口是 MEMORY.md。startRelevantMemoryPrefetch() 处理的是这类：根据当前用户输入，从记忆目录中挑选相关文件，再读取内容作为 relevant_memories attachment。
> 
> 后面还会有一种记忆：
> session memory compact
> 这个指的是：这是压缩机制里的“会话记忆”，用于替代或辅助 compact summary，不等同于 CLAUDE.md，也不等同于 relevant memory prefetch。其实就是之前compact过，保存的上一次compact的summary。

### 3.2 Claude Code 的关键入口

源码确认：

- `src/context.ts` 提供 `getSystemContext()`、`getUserContext()`、`getGitStatus()`。
- `src/query.ts` 的 `queryLoop()` 是模型调用前上下文投影主入口。
- `src/utils/api.ts` 提供 `appendSystemContext()`、`prependUserContext()`、`toolToAPISchema()`。
- `src/utils/messages.ts` 提供消息创建、attachment 渲染、normalize、compact boundary 过滤。
- `src/services/compact/autoCompact.ts`、`compact.ts`、`microCompact.ts`、`sessionMemoryCompact.ts` 负责上下文收缩。
- `src/utils/analyzeContext.ts` 和 `src/commands/context/context.tsx` 负责上下文可视化。

## 4. 静态上下文：system context 与 user context

### 4.1 `getSystemContext()` 做什么

源码确认：

- `src/context.ts` 中 `getSystemContext()` 是 memoized async 函数。
- 它会按条件调用 `getGitStatus()`，收集当前分支、默认分支、git user、`git status --short`、最近 5 个 commit。
- git status 最多保留 2000 字符，超过后追加==截断==提示。
- 在 `BREAK_CACHE_COMMAND` feature 下可加入 `cacheBreaker`。
- remote 模式或禁用 git instructions 时跳过 git status。

设计结论：

```text
systemContext 是运行环境快照，不是持续同步状态。
```

`getGitStatus()` 生成的文本明确说明这是“conversation start”的快照，不会在会话中自动更新。外部系统应把这类上下文看作启动时环境，不应让模型误以为它是最新 git 状态。

>  memoized async 函数:
>  返回Promise的异步函数，同时这个Promise会被缓存。
>  ``` ts
> 	const load = memoize(async () => {
> 		return await readFile(...)
> 	})
>  ```

> BREAK_CACHE_COMMAND 是一个内部/实验功能开关。
> 它开启后，Claude Code 支持把某个临时 cache breaker 字符串塞进 system prompt，
> 从而故意打破 prompt cache。
> 但当前源码镜像没有显示一个公开用户命令来设置这个值。
> 这个点不关键

> remote 模式是指：
> 如果当前 Claude Code 是跑在远程会话/远程容器环境里，getSystemContext() 就不执行 getGitStatus()。
> 这个点不关键
### 4.2 `getUserContext()` 做什么

源码确认：

- `src/context.ts` 中 `getUserContext()` 读取 `CLAUDE.md` / memory 文件并加入 `currentDate`。
- `CLAUDE_CODE_DISABLE_CLAUDE_MDS` 会硬禁用 CLAUDE.md。
- bare mode 会跳过自动发现，但如果有显式 add-dir 仍可读取对应目录。
- 读取结果会通过 `setCachedClaudeMdContent()` 缓存给 auto-mode classifier 使用，避免 import cycle。
- 返回形状是 `{ claudeMd?, currentDate }`。

> bare mode:
> ``` text
> 	--bare 默认不做当前目录到上级目录的 CLAUDE.md 自动发现；
> 	但如果用户显式传了 --add-dir，并且 add-dir 的 CLAUDE.md 加载开关开启，
> 	Claude Code 仍会尊重这个显式目录，把该目录下的 CLAUDE.md / .claude rules 加入 user context。
> ```
> 源码注释:
> ``` text
> 	--bare means "skip what I didn't ask for", not "ignore what I asked for".
> 	--bare 跳过“自动找来的上下文”，但不忽略用户明确指定的上下文。
> ```

设计结论：

```text
userContext 是用户/项目指令和日期上下文，最终作为 meta user reminder 注入。
```

它不是 system prompt 的一部分。`prependUserContext()` 会把它渲染成：

```text
<system-reminder>
As you answer the user's questions, you can use the following context:
# claudeMd
...
# currentDate
...
IMPORTANT: this context may or may not be relevant...
</system-reminder>
```

并设置 `isMeta: true`。这是一条重要边界：这些内容对模型可见，但不等同于用户刚刚说的话。

### 4.3 CLAUDE.md / memory 文件的发现与优先级

源码确认来自 `src/utils/claudemd.ts`：

- 文件加载顺序：Managed memory、User memory、Project memory、Local memory。
- 注释说明“reverse order of priority”，越后加载优先级越高。
- Project memory 会从当前目录向上遍历，查找 `CLAUDE.md`、`.claude/CLAUDE.md`、`.claude/rules/*.md`。
- Local memory 查找 `CLAUDE.local.md`。
- memory 文件支持 `@include`，include 在 leaf text nodes 中识别，跳过 code block/code span。
- include 深度上限是 `MAX_INCLUDE_DEPTH = 5`。
- 支持 frontmatter `paths`，用于条件规则匹配。
- 非文本扩展会被跳过，避免二进制文件进入 memory。
- HTML block comment 会被剥离，但 code / codespan 内的内容保留。
- `MAX_MEMORY_CHARACTER_COUNT = 40000` 用于识别大 memory 文件。

> 这里的memory指的是**Claude Code 自动加载进 userContext 的 Markdown 指令文件**，不是聊天历史，也不是 LLM 内部记忆。
> 
> Managed memory：企业/机器级托管指令，典型位置：macOS: /Library/Application Support/ClaudeCode/CLAUDE.md；Windows: C:\Program Files\ClaudeCode\CLAUDE.md；Linux: /etc/claude-code/CLAUDE.md，管理员/组织策略。
> 
> User memory：用户全局私人指令，典型位置：~/.claude/CLAUDE.md，以及 ~/.claude/rules/\*.md，当前用户所有项目。
> 
> Project memory：项目内共享指令，通常可提交进仓库，典型位置：每一级目录下的 CLAUDE.md、.claude/CLAUDE.md、.claude/rules/\*.md，项目团队。
> 
> Local memory：项目内私人本地指令，通常不提交，典型位置：每一级目录下的 CLAUDE.local.md，当前用户当前机器。

> 从当前目录向上遍历。指的就是在当前目录找查找 `CLAUDE.md`、`.claude/CLAUDE.md`、`.claude/rules/*.md`，找不到再去`../`去查找 `CLAUDE.md`、`.claude/CLAUDE.md`、`.claude/rules/*.md`，逐渐向上遍历，但实际处理时会 reverse()，所以加载顺序是从更上层到更具体目录。

> @include 的机制可以理解成：在 memory 文件（这里指的就是CLAUDE.md）正文里写一个 @路径，Claude Code 会把那个文件也读进来。例如：
> ``` markdown
> 	请遵守项目规范。
> 	
> 	@./docs/coding-style.md
> 	@~/common/agent-rules.md
> 	@/absolute/path/shared.md
> ```
> 
> “leaf text nodes” 的意思是：
> Claude Code 会用 Markdown lexer 把文件解析成 token，只在普通文本节点里找 @路径，但如果出现在代码块或行内代码里，就不会当成 include。

设计结论：

```text
CLAUDE.md 是一套 instruction loading 子系统，不是单文件读取。
```

外部系统实现时，不应只读当前目录的一个 `AGENTS.md` 或 `CLAUDE.md`。更接近 Claude Code 的机制是：

```text
global managed instructions
  -> user global instructions
  -> cwd-to-root project instructions
  -> local private instructions
  -> conditionally matched rules
  -> include-expanded dependencies
```

> conditionally matched rules：条件规则匹配
> include-expanded dependencies：因为 @include 被展开后，一起进入上下文的依赖文件。
### 4.4 注入格式

`getClaudeMds()` 会把 memory 文件渲染为：

```text
Codebase and user instructions are shown below...

Contents of <path> (<description>):

<content>
```

Team memory 会额外包在 `<team-memory-content source="shared">` 中。

外部系统可采用类似格式，但建议额外增加结构化字段，便于观测和安全：

```ts
type MemoryContextEntry = {
  path: string
  type: "Managed" | "User" | "Project" | "Local" | "AutoMem" | "TeamMem"
  content: string
  parent?: string
  globs?: string[]
  contentDiffersFromDisk?: boolean
}
```

## 5. 动态附件：把服务端上下文变成 meta messages

### 5.1 Attachment 是 Claude Code 的动态上下文总线

源码确认：

- `src/utils/attachments.ts` 定义大量 `Attachment` 类型。
- `src/utils/messages.ts` 的 `createAttachmentMessage()` 和后续 attachment 渲染逻辑会把附件转成 `UserMessage`，多数带 `isMeta: true`。
- attachment 类型包括 file、directory、selected_lines_in_ide、todo/task reminder、nested_memory、relevant_memories、skill_listing、skill_discovery、plan_mode、plan_file_reference、mcp_resource、task_status、token_usage、compaction_reminder、context_efficiency 等。

设计结论：

```text
attachment 是服务端上下文，不是工具调用结果。
```

它的作用是把“本轮模型应该知道的状态”注入消息流，同时保留来源类型，方便 UI、压缩、分析和恢复逻辑区别处理。

### 5.2 常见 attachment 的上下文含义

| Attachment 类型                       | 上下文意义                            | 关键边界                    |
| ----------------------------------- | -------------------------------- | ----------------------- |
| `file` / `already_read_file`        | at-mention 或恢复时注入文件内容。           | 需要权限、大小、token 限制。       |
| `compact_file_reference`            | 压缩后文件太大，仅保留引用。                   | 提醒模型需要时重新 Read。         |
| `nested_memory`                     | 访问子目录时发现的更具体 memory 规则。          | 不等同于全局 CLAUDE.md。       |
| `relevant_memories`                 | memory surfacing 找到的相关记忆。        | 有单文件和会话总 byte cap。      |
| `skill_listing` / `skill_discovery` | 轻量暴露可用 skills 或发现候选。             | 不等同于加载完整 skill。         |
| `invoked_skills`                    | compact 后保留已经调用过的 skill 内容。      | 按 agent scope 过滤，按预算截断。 |
| `plan_mode` / `plan_file_reference` | 让模型持续知道 plan mode 或计划文件。         | 压缩后也要恢复。                |
| `task_status`                       | 异步 agent / task 状态。              | 避免重复 spawn 或丢失结果。       |
| `compaction_reminder`               | 告诉模型 auto-compact 可用，不必因上下文紧张停止。 | 只在特定条件下出现。              |
| `context_efficiency`                | 提醒模型使用 snip 类上下文效率工具。            | 当前具体 snip 算法在源码镜像中待验证。  |

### 5.3 Relevant memories 的预算策略

源码确认：

- `src/utils/attachments.ts` 中 `MAX_MEMORY_LINES = 200`。
- `MAX_MEMORY_BYTES = 4096` 限制单个 memory surfacing 文件。
- `RELEVANT_MEMORIES_CONFIG.MAX_SESSION_BYTES = 60 * 1024` 限制会话内累计注入。
- 注释说明 compact 会自然重置计数，因为旧 attachments 已从上下文中消失，重新 surfacing 是合理的。

> 如何理解 **relevant memory surfacing**？
> relevant = 和当前问题相关的，memory = Claude Code 自动记忆目录里的持久化记忆文件，surfacing = 把它“浮上来”，也就是注入到本轮模型上下文里。
> 从一堆长期保存的 memory 文件里，找出和当前用户问题最相关的几条，读取一小段内容，作为 attachment 提供给主模型。

> MAX_MEMORY_LINES：单文件限制，**单个被选中的 relevant memory 文件，最多读取前 200 行**。如果文件更长，就只 surfacing 前 200 行，并提示模型可用 Read 工具读取完整文件。
> 
> MAX_MEMORY_BYTES：单文件限制，**单个 relevant memory 文件最多注入 4096 bytes 内容**。和 200 行同时生效，哪个先到就截断。
> 
> RELEVANT_MEMORIES_CONFIG.MAX_SESSION_BYTES：会话累计限制，扫描历史消息中已经注入过的 relevant_memories attachments，把其中 mem.content.length 加起来；如果累计达到 60KB，就不再启动新的 relevant memory prefetch。

设计结论：

```text
动态记忆不只要相关性，还必须有 per-turn 和 per-session 预算。
```

==否则长会话中“看似小的相关记忆”会不断累积，变成上下文污染。==

## 6. 消息投影：从 transcript 到 `messagesForQuery`

### 6.0 Message 处理链总览

Claude Code 的 message 处理链可以写成下面的伪代码：

```ts
// queryLoop 内：从历史事实源得到本轮内部投影
let messagesForQuery = getMessagesAfterCompactBoundary(state.messages)
messagesForQuery = await applyToolResultBudget(messagesForQuery, ...)
messagesForQuery = maybeSnip(messagesForQuery)
messagesForQuery = await microcompact(messagesForQuery)
messagesForQuery = maybeContextCollapse(messagesForQuery)

const compact = await autocompact(messagesForQuery, ...)
if (compact) {
  messagesForQuery = buildPostCompactMessages(compact)
}

// queryLoop 调 provider 前：把 userContext 作为 meta message 加进 request messages
const requestMessages = prependUserContext(messagesForQuery, userContext)

// provider 层：把内部 messages 变成 API 合法 messages
let messagesForAPI = normalizeMessagesForAPI(requestMessages, filteredTools)
messagesForAPI = ensureToolResultPairing(messagesForAPI)
messagesForAPI = stripUnsupportedBlocks(messagesForAPI)
```

这条链路里，`state.messages` 是历史事实源，`messagesForQuery` 是内部上下文投影，`messagesForAPI` 才是真正 provider request 的消息上下文。

### 6.1 query loop 中的投影顺序

源码确认来自 `src/query.ts`：

```text
messagesForQuery = getMessagesAfterCompactBoundary(messages)
messagesForQuery = applyToolResultBudget(messagesForQuery, ...)
messagesForQuery = snipCompactIfNeeded(messagesForQuery)        // feature-gated,源码镜像缺实现
messagesForQuery = microcompact(messagesForQuery, ...)
messagesForQuery = contextCollapse.applyCollapsesIfNeeded(...)  // feature-gated,源码镜像缺实现
compactionResult = autocompact(messagesForQuery, ...)
if compactionResult:
    messagesForQuery = buildPostCompactMessages(compactionResult)
toolUseContext.messages = messagesForQuery
```

关键点：

- compact boundary 是第一步，说明旧 compact 之前的原始历史不会进入本轮模型请求。
- 工具结果预算在 microcompact 前执行，注释说明 cached microcompact 只按 `tool_use_id` 操作，不检查内容，因此先替换内容不会破坏 ID 级缓存。
- context collapse 在 autocompact 前执行，注释说明如果 collapse 已把上下文降到阈值下，就避免 autocompact 把粒度上下文替换成单一 summary。
- autocompact 成功后，`buildPostCompactMessages()` 输出的 post-compact messages 会在当前 query 调用内继续作为本轮上下文。

### 6.2 为什么 transcript 不能直接发送

源码确认：

- `/context` 命令的 `toApiView()` 先调用 `getMessagesAfterCompactBoundary()`，如果 feature 开启再调用 `projectView()`，注释明确说 `/context` 应显示模型实际看到的内容，而不是 REPL raw history。
- `normalizeMessagesForAPI()` 负责把内部消息结构转成 provider 可接受格式，并处理 attachment、meta、tool pairing 等问题。

设计结论：

```text
外部系统应维护两个视图：
1. durable transcript：完整历史、UI 回放、审计、恢复。
2. API projection：本轮模型实际可见窗口。
```

如果只维护一个数组，会出现三类问题：

- UI 想看完整历史，但模型不能承受完整历史。
- 压缩后 summary 与旧原文同时进入模型，造成重复和矛盾。
- 工具结果配对、thinking block、attachment meta 需要 provider-specific normalize，不能在存储层提前写死。

### 6.3 `normalizeMessagesForAPI()`：message 成为 provider 上下文的最后一道转换

源码确认来自 `src/utils/messages.ts` 和 `src/services/api/claude.ts`：

`query.ts` 调 `deps.callModel()` 时传入的仍是内部 messages。到 `queryModelWithStreaming()` 内部，provider 层会先执行：

```text
messagesForAPI = normalizeMessagesForAPI(messages, filteredTools)
messagesForAPI = ensureToolResultPairing(messagesForAPI)
messagesForAPI = stripAdvisorBlocks(messagesForAPI)
messagesForAPI = stripExcessMediaItems(messagesForAPI)
```

`normalizeMessagesForAPI()` 做的关键转换包括：

| 转换                                          | 目的                                                                     |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| `reorderAttachmentsForAPI()`                | attachment 会向前冒泡，直到遇到 tool result 或 assistant message，避免附件位置破坏工具结果批次。  |
| 过滤 virtual messages                         | display-only / REPL inner tool call 不能进入 API。                          |
| 过滤 progress、普通 system、synthetic API error   | 这些是 UI/内部状态，不是 provider 消息上下文。                                         |
| local command system message 转 user message | 让模型能引用历史本地命令输出。                                                        |
| 连续 user messages 合并                         | Bedrock 不支持连续 user messages；一方 API 也会合并成单个 user turn。                  |
| attachment 转 user/meta messages             | typed attachment 在这里变成模型可见上下文。                                         |
| unavailable tool references 过滤              | tool search 不可用或工具已不存在时，移除不合法 tool_reference。                          |
| assistant tool input normalize              | 移除 ExitPlanModeV2 这类工具的注入字段，或去掉 tool-search-only 字段。                   |
| 同 `message.id` assistant 合并                 | streaming 拆分的 assistant content blocks 在 API 前合并回同一 assistant message。 |
| trailing/orphan thinking 过滤                 | 避免 provider 因 thinking block 规则报错。                                     |
| whitespace-only assistant 修复                | 避免 API 拒绝空 assistant content。                                          |
| error tool_result media 清理                  | resumed session 中错误 tool_result 里的媒体不会反复导致 400。                        |

然后 `ensureToolResultPairing()` 在 API boundary 前修复或拒绝 tool_use/tool_result mismatch：

- assistant `tool_use` 缺少 user `tool_result` 时，插入 synthetic error tool_result。
- orphan tool_result 引用不存在的 tool_use 时，剥离。
- duplicate tool result 等结构异常会被处理；严格模式下会 throw。

设计结论：

```text
历史消息只有经过 normalizeMessagesForAPI 和 pairing 修复，
才变成 provider 可接受、真正计入模型上下文的 messages。
```

所以外部系统不能把“数据库里的会话消息”直接称为“模型上下文”。更准确的说法是：

```text
transcript 是模型上下文的候选材料；
MessageProjector 和 ProviderNormalizer 决定本轮哪些消息块实际进入上下文。
```

### 6.4 Attachment message 的两次身份变化

Attachment 特别容易混淆，因为它在不同层有不同身份：

```text
Attachment object
  -> AttachmentMessage in transcript / query state
  -> UserMessage produced by createAttachmentMessage or normalizeAttachmentForAPI
  -> provider user content block / text context
```

源码确认：

- `src/utils/attachments.ts` 定义 typed `Attachment`。
- `src/utils/messages.ts:createAttachmentMessage()` 把 attachment 包成内部 message。
- `normalizeMessagesForAPI()` 遇到 `case 'attachment'` 时调用 `normalizeAttachmentForAPI()`，再合并进 user messages。

设计结论：

```text
attachment 在 transcript 中保留类型，是为了恢复、UI、压缩和分析；
它进入模型上下文时，才被渲染成 provider user message。
```

这也是为什么 analysis 中要把 `AttachmentBuilder` 和 `ProviderNormalizer` 分开：前者决定“有什么上下文”，后者决定“这份上下文在 provider 协议里如何表达”。

### 6.5 工具结果消息也不是原样上下文

工具结果同样会经历多层处理：

```text
tool execution result
  -> ToolResultBlockParam / UserMessage
  -> maybePersistLargeToolResult()
  --- next iteration
  -> applyToolResultBudget()
  -> microcompact / cached cache_edits
  -> normalizeMessagesForAPI()
  -> ensureToolResultPairing()
```

典型变化：

- 空结果会变成 `(<toolName> completed with no output)`。
- 大结果可能变成 `<persisted-output>` 预览。
- 老结果可能被 microcompact 清成 `[Old tool result content cleared]`。
- tool_reference block 可能按 tool-search 可用性被保留或剥离。
- 并行/streaming 产生的多个 tool_result 会按 provider user turn 合并。

设计结论：

```text
工具结果是上下文增长的主要来源之一，因此 Claude Code 不把它们当作不可变全文上下文，而是持续治理其可见形态。
```

## 7. 工具结果预算：大输出的引用化与稳定替换

### 7.1 单个工具结果持久化

源码确认来自 `src/utils/toolResultStorage.ts`：

- `persistToolResult()` 把大工具结果写入 session 目录下的 `tool-results` 子目录。
- `buildLargeToolResultMessage()` 生成 `<persisted-output>` 包裹的模型可见消息，包含文件路径、预览和是否有更多内容。
- 空工具结果会替换成 `(<toolName> completed with no output)`，避免空 tool_result 在 prompt tail 触发异常停止模式。
- 图片内容不会被持久化为文本引用。
- `Read` 这类 `maxResultSizeChars: Infinity` 的工具可跳过聚合预算，因为它自身用 maxTokens 约束。

设计结论：

```text
大工具输出应转为“可追溯引用 + 小预览”，而不是粗暴截断。
```

推荐协议：

```text
<persisted-output>
Output too large (2.3 MB). Full output saved to: /session/tool-results/call_01.txt

Preview (first 2 KB):
...
</persisted-output>
```

### 7.2 每消息聚合预算

源码确认：

- `ContentReplacementState` 包含 `seenIds` 和 `replacements`。
- 注释明确说明状态必须稳定，以保持 prompt cache：一旦某个 tool result 被看见，其替换或不替换的命运会被冻结。
- `enforceToolResultBudget()` 按 API-level user message group 收集候选，考虑 `normalizeMessagesForAPI()` 会合并连续 user messages。
- 只替换 fresh 且超预算的最大结果；已经见过但未替换的结果不再改变。
- 新替换记录可写入 transcript，resume 时用 `reconstructContentReplacementState()` 重建。

>  新替换记录，指的不是工具消息被替换了。
>  指的是，新产生的工具result，假设结果太大：
> ``` text
> 	tool_use_id = toolu_123
> 	原始结果 = 200KB 输出
> ```
> Claude Code 决定不把 200KB 全量发给模型，而是替换成：
> ``` text
> 	Output too large. Full output saved to: .../tool-results/toolu_123.txt
> 	Preview: 前 2000 bytes...
> ```
> 这时它会额外写一条 transcript 元数据：
> ``` json
> 	{
> 	  type: "content-replacement",
> 	  replacements: [
> 	    {
> 	      kind: "tool-result",
> 	      toolUseId: "toolu_123",
> 	      replacement: "Output too large. Full output saved to: ..."
> 	    }
> 	  ]
> 	}
> ```
> 这个 transcript 元数据，就是上述的新替换记录。
> 
> resume 就是重新打开旧会话。重新打开时，内存里的 seenIds / replacements 状态已经没了，所以要从 transcript 里恢复。
> reconstructContentReplacementState() 会做两件事：
> ``` text
> 	扫描历史 messages：
> 	  看到 toolu_123 这个工具结果存在
> 	  -> 标记为 seen，表示它以前已经被模型见过，不能重新做不同决定
> 
> 	读取 content-replacement 记录：
> 	  发现 toolu_123 当时替换成了某段 preview 文本
> 	  -> 放回 replacements map
> ```
> 这样 resume 后再次投影上下文时，Claude Code 会继续把 toolu_123 替换成**同一段文本**，而不是重新生成一个可能不同的 preview。

设计结论：

```text
工具结果预算不是“每轮重新算一遍”，而是会话状态机。
```

否则同一个旧工具结果有时全文、有时预览，==会破坏 prompt cache==，也会让模型对历史事实的可见性不稳定。

外部系统应保存：

```ts
type ContentReplacementState = {
  seenIds: Set<string>
  replacements: Map<string, string>
}

type ContentReplacementRecord = {
  kind: "tool-result"
  toolUseId: string
  replacement: string
}
```

## 8. Microcompact：不总结对话，只治理旧工具结果

### 8.1 可压缩工具集合

源码确认来自 `src/services/compact/microCompact.ts`：

`COMPACTABLE_TOOLS` 包括：

- `Read`
- shell 工具集合
- `Grep`
- `Glob`
- `WebSearch`
- `WebFetch`
- `Edit`
- `Write`

这说明 microcompact 面向“工具结果内容”，不是任意消息。

> microcompact 在每轮模型调用前都会被 queryLoop 调用一次；
> 但它内部有两条可能生效的路径：
> 1. time-based microcompact
> 2. cached microcompact
> 
> microcompactMessages() 内部先判断：
> ``` text
> 1. time-based trigger 是否触发？
> 	   是 -> 直接返回 time-based 结果，跳过 cached microcompact
>
> 2. 如果 time-based 没触发，再看 cached microcompact 是否可用？
> 	   feature 开启 + 模型支持 + main thread
> 	   是 -> 走 cached microcompact
>
> 3. 都不满足 -> 不做 microcompact，原样返回 messages
> ```

### 8.2 time-based microcompact

源码确认：

- `evaluateTimeBasedTrigger()` 只对 main-thread querySource 生效。
- 如果距离上一次 assistant message 的时间超过配置阈值，会触发 time-based microcompact。
- `maybeTimeBasedMicrocompact()` 会保留最近 N 个 compactable tool results，把更旧的结果替换成 `[Old tool result content cleared]`。
- 它会重置 cached microcompact 状态，并通知 cache deletion，避免把人为内容改写误报为 prompt cache break。

设计结论：

```text
当 server cache 已冷，继续保留旧工具结果全文只会浪费下一次 prompt 写入。
```

time-based microcompact 利用这个事实：既然 cache prefix 已经失效，不如在发请求前清理旧工具结果，减少重写成本。

> time-based microcompact
> 确实是按时间间隔来触发的，它判断的不是“对话该不该清理”，而是判断“服务端 prompt cache 大概率是不是已经过期了。”所以它的核心逻辑不是：我跑了多少轮，所以清理一次。而是：
> 	距离上一次 assistant 消息已经太久，server-side prompt cache 很可能冷了；
> 	反正下一次请求也要重新写完整 prefix，
> 	那不如在发送前先把旧工具结果清掉，减少要重写的内容。
> 	
> 源码中的配置：gapThresholdMinutes: 60（分钟）

> prompt prefix：本轮请求里，从开头开始那一大段稳定上下文。
> 在 Claude Code 里，它通常包括：
> ``` text
> 	system prompt
> 	system context
> 	userContext meta reminder
> 	历史 messages 的前半段
> 	旧工具结果
> ```
> 
> prompt cache :服务端(llm)复用前缀计算结果，不是我们所说的redis那种cache，是KV cache（底层实现可能类似或包含 KV cache，总之是命中能省token的那种cache）

^e33907

> 为什么 time-based microcompact 说“prompt prefix 本来就要重写，所以可以直接替换旧工具结果”？
> 因为 prompt cache 有有效期。源码默认按 60 分钟判断：
> 	距离上次 assistant 消息超过 60 分钟
> 	-> 服务端 prompt cache 已经过期
> 	-> 下一次请求即使前缀字节完全一样，也不能复用旧缓存
> 	-> 服务端本来就要重新处理整段 prefix
> 既然整段 prefix 都要重新处理，那保留旧的大工具结果全文就没有 cache 收益了，只会增加本次请求成本。

> 源码标注：Legacy microcompact path removed
> 也就是说，以前可能还有传统 microcompact 路径，但当前镜像里已经移除了，当前源码里的 microcompact 只有 time-based content clearing 一种触发路径。对于外部构建、非 ant 用户、不支持 cached microcompact 的模型、sub-agent 等场景，microcompact 本身不会做事；==上下文压力交给 autocompact 处理。==
### 8.3 cached microcompact

源码确认：

- cached microcompact 只在 feature 开启、模型支持、main thread source 下运行。
- 它不修改本地 message content，而是创建 `cache_edits`，通过 API 层删除服务端缓存里的旧 tool results。
- boundary message 会延迟到 API 响应后，用实际 `cache_deleted_input_tokens` 生成。

设计结论：

```text
当 prompt cache 仍热时，不应改写本地消息内容；应通过 provider 支持的 cache editing 删除缓存内容。
```

外部系统如果没有 cache editing 能力，可以只实现 time-based content clearing 和 full compaction。

> 实验/内部 机制。了解，不关键
> cached microcompact 可以理解成一个“**不改本地历史，但让服务端缓存删除旧工具结果**”的优化。
> 怎么做到**本地照发这么多内容，但让服务端的上下文忽视，同时又不影响KV cache命中**，源码中没有，是Claude code服务端的内部机制。



## 9. Autocompact 与 manual compact：把旧对话变成可继续的 summary

### 9.1 自动压缩阈值

源码确认来自 `src/services/compact/autoCompact.ts`：

- `MODEL_CONTEXT_WINDOW_DEFAULT = 200_000` 在 `src/utils/context.ts` 中定义。
- `getEffectiveContextWindowSize(model)` 会从模型上下文窗口中预留 summary 输出 token，最多预留 `20_000`。
- `AUTOCOMPACT_BUFFER_TOKENS = 13_000`。
- `WARNING_THRESHOLD_BUFFER_TOKENS = 20_000`。
- `MANUAL_COMPACT_BUFFER_TOKENS = 3_000`。
- `getAutoCompactThreshold()` 返回 effective window 减 autocompact buffer。
- `calculateTokenWarningState()` 同时计算 warning、error、auto compact threshold、blocking limit。

> **MODEL_CONTEXT_WINDOW_DEFAULT**上下文窗口默认上限
> 是模型输入上下文窗口的默认上限。它表示模型最多能承载多少上下文 token，后续所有阈值都从这个上限派生。
> 
> **effective context window**有效上下文窗口大小
> 先拿模型真实窗口，再减掉压缩摘要可能需要的输出空间：
> 	effectiveWindow = modelContextWindow - min(modelMaxOutputTokens, 20_000)
> 	
>  **auto compact threshold** 触发auto compact阈值
> 	 autoCompactThreshold = effectiveWindow - 13_000
> 	 
> **warning / error threshold**告警阈值
> 	auto compact 开启: threshold = autoCompactThreshold
> 	auto compact 关闭: threshold = effectiveWindow
> 	warningThreshold or errorThreshold = threshold - 20_000
> 	
> **manual compact / blocking buffer**
> 这是更靠后的硬保护线。主查询循环里如果没有自动压缩、reactive compact、context collapse 等恢复路径接管，达到这个线会提前返回 prompt-too-long，而不是继续把请求发给 API。
> 	blockingLimit = effectiveWindow - 3_000
> 它保留最后 3k 余量，避免上下文完全顶满后连错误处理、手动 /compact、恢复逻辑或下一次请求都没有操作空间。
> 
> claude code的默认配置：
	147k   warning/error: 开始提醒用户上下文紧张
	167k   auto compact: 自动压缩触发
	177k   blocking limit: 没有恢复路径时直接阻止继续请求
	--- 阻止请求
	180k   effective window: 已扣除 summary 输出预留后的可用输入边界
	200k   raw model window: 模型原始上下文窗口

设计结论：

```text
压缩阈值不是模型最大 context window，而是扣除了未来 summary 输出空间后的有效窗口。
```

这避免“到了极限才压缩，压缩请求本身也放不下”的失败。

### 9.2 `shouldAutoCompact()` 的保护条件

源码确认：

- `querySource === 'session_memory'` 或 `'compact'` 时不自动压缩，避免 forked compact agent 死锁。
- `DISABLE_COMPACT`、`DISABLE_AUTO_COMPACT`、用户设置 `autoCompactEnabled` 可关闭。
- reactive-only mode 会抑制 proactive autocompact。
- context-collapse mode 下 autocompact 被抑制，因为 collapse 拥有 headroom 管理。
- token 计算使用 `tokenCountWithEstimation(messages) - snipTokensFreed`。

设计结论：

```text
自动压缩不是全局无脑触发，它必须知道自己是否处在压缩子流程、reactive fallback 或其他上下文管理系统中。
```

> querySource 可以理解为：每次进入 query() 主模型循环时传入的“本次调用来源标签”。它告诉 query loop：这次模型调用是主 REPL、SDK、子 agent、压缩 agent、session memory agent，还是其他后台任务。
> 
> 'session_memory'和'compact'是不一样的两种标签，但它们都属于 **forked agent / side query** 这一类“后台子查询”。
> session_memory按当前 session 生成的单个 session 范围内的结构化工作记忆。
	- 它会维护一个 markdown 形式的 session memory 文件。
	- 后台在主对话结束后通过 post-sampling hook 触发。
	- 它只在 querySource === 'repl_main_thread' 的主线程上启动。
	- 启动后用 runForkedAgent() 开一个隔离子 agent，querySource 标记为 'session_memory'。
	- 这个子 agent 的任务不是回答用户，而是读取当前会话，更新 session memory 文件。
>
> 但它们有一个交集：**session memory 可以被拿来做 compaction**。
> 
> 为什么**session memory 可以被拿来做 compaction**？
> 因为 session_memory 和 compact 产物在语义上有重叠：它们都试图回答同一个问题：
> 	如果旧对话不能完整放进上下文，后续模型最少需要知道什么，才能继续工作？
> 传统 compact 是在压缩触发时临时跑一个 compact agent，总结旧 transcript。session_memory 是平时后台持续维护一份结构化工作笔记。
> 所以当自动压缩发生时，如果 session memory 已经存在且不是空模板，Claude Code 可以直接把它当作“已提前维护好的摘要材料”。
> 源码里的做法不是简单塞原文件，而是包装成 compact summary：
	1. 读取当前 session memory 内容。
	2. 如果内容为空模板，就放弃，回退到传统 compact。
	3. 根据 lastSummarizedMessageId 找到 memory 已覆盖到哪条消息。
	4. 保留这之后的最近消息，避免丢掉 memory 尚未覆盖的新上下文。
	5. 把 session memory 内容通过 getCompactUserSummaryMessage(...) 包成 compact summary message。
	6. 构造并返回 CompactionResult，让主 query loop 像处理普通 compact 一样替换上下文。
>
> 所以它是 **auto-compact 路径里的优先优化分支**。
	query() 主循环
	  -> deps.autocompact(...)
	  -> autoCompactIfNeeded(...)
	  -> trySessionMemoryCompaction(...)
	  -> 如果成功，直接返回 CompactionResult
	  -> 如果失败/不可用，再走 compactConversation(...)
>
> 总结：当上下文接近 auto compact 阈值时，先看已有 session_memory/summary.md 是否足够可用。如果可用，就用它快速构造 compact summary，避免再启动传统 compact agent 重新总结整段历史。


### 9.3 连续失败熔断

源码确认：

- `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`。
- `autoCompactIfNeeded()` 如果连续失败达到上限，会停止继续尝试。
- 失败时如果不是用户 abort，会 log error，并递增 `consecutiveFailures`。

设计结论：

```text
自动压缩必须有熔断，否则不可恢复的超长上下文会每轮浪费 API 调用。
```

### 9.4 manual `/compact`

源码确认来自 `src/commands/compact/compact.ts`：

- 手动 compact 先用 `getMessagesAfterCompactBoundary()` 投影，避免 summarize 已被 snip/compact 移除的内容。
- 如果无 custom instructions，优先尝试 session memory compaction。
- reactive-only mode 下走 reactive compact。
- 传统路径先 microcompact，再 `compactConversation()`。
- compact 成功后清理 `getUserContext` cache，运行 post compact cleanup，抑制 compact warning。

设计结论：

```text
手动 compact 和自动 compact 共用核心压缩服务，但触发、hook、显示和恢复路径略有不同。
```

外部系统应避免把 `/compact` 写成“调用 summarizer 并替换历史”的独立逻辑，而应复用 compaction service。

> 正常的autocompact是proactive autocompact = **预防式自动压缩**，系统根据 token 估算发现“快到阈值了”，就提前压缩。
> reactive compact = **出错后的反应式压缩**。它不是提前压缩，而是先让请求真的发给模型。如果 provider 返回 prompt too long，说明上下文确实太长了，Claude Code 再捕获这个错误，执行 compact，然后重试。
> reactive-only mode 下走 reactive compact。
> 意思是：禁用 proactive autocompact，不再“提前根据估算压缩”；等真实 prompt-too-long 错误发生后，再用 reactive compact 来恢复。

## 10. CompactConversation：压缩是状态转换

### 10.1 压缩流程

源码确认来自 `src/services/compact/compact.ts`：

`compactConversation()` 的主要步骤：

1. 检查 messages 非空，记录 `preCompactTokenCount`。
2. 执行 `PreCompact` hooks，并合并用户 custom instructions 与 hook instructions。
3. 构造 `getCompactPrompt(customInstructions)`。
4. 优先尝试 cache-sharing forked agent 生成 summary。
5. 若失败，使用 streaming summarizer fallback。
6. 如果 compact 请求本身 prompt-too-long，调用 `truncateHeadForPTLRetry()` 丢弃最老 API round group 后重试。
7. 生成 summary 后，清理 `readFileState` 和 `loadedNestedMemoryPaths`。
8. 并行创建 post-compact file attachments 和 async agent attachments。
9. 创建 plan attachment、invoked skill attachment、plan mode attachment 等恢复上下文。
10. 返回 `CompactionResult`，由 `buildPostCompactMessages()` 按固定顺序组装。

> custom instructions 与 hook instructions
> 这两个都是给“压缩摘要模型”的**附加说明**，区别在来源。
> custom instructions = **用户自定义压缩指令**。
> 
> 比如用户手动执行：
> 	/compact 请重点保留我对权限系统的设计结论，丢掉中间调试日志
> 	
> 这里 /compact 后面的这段话，就是 custom Instructions。它会被追加到 compact prompt 的 Additional Instructions: 里，告诉 summarizer 这次压缩时要特别注意什么。
> 
> hook instructions = **PreCompact hook 输出的新压缩指令**。
> 
> 比如某个 hook 在压缩前检查项目状态，然后输出：
> 	Preserve current git branch, failing test names, and active TODO list.
> 	
> 这段输出会被当成额外压缩指令，合并进 compact prompt。

> cache-sharing forked agent
> 它会 fork 一个“看到主会话当前投影上下文”的摘要子 agent，但不是上下文和状态完全一致的子 agent；它主要保持 API 请求前缀一致，以便命中主会话已经建立的 prompt cache，降低压缩摘要请求的成本和延迟。

> truncateHeadForPTLRetry() 可以理解成：**compact 自己也因为 prompt-too-long 失败时，砍掉最早的一部分对话，再重试生成 summary 的兜底函数。**
> 这里 PTL = Prompt Too Long。

### 10.2 compact prompt 的内容要求

源码确认来自 `src/services/compact/prompt.ts`：

- compact prompt 明确要求模型==不要调用任何工具，只输出文本==。
- summary 要包含用户请求、技术概念、文件和代码段、错误与修复、所有非工具用户消息、待办、当前工作、可选下一步。
- summary 先要求 `<analysis>` 草稿，再要求 `<summary>`，`formatCompactSummary()` 会剥离 `<analysis>`。
- `getCompactUserSummaryMessage()` 会把 summary 包装为“previous conversation ran out of context”的 continuation message。
- 自动压缩可设置 `suppressFollowUpQuestions`，要求模型直接继续，不要承认 summary 或重新 recap。

设计结论：

```text
高质量 compact summary 是长会话上下文工程的核心资产。
```

它不是普通摘要，而是 continuation contract：必须保留当前任务、用户反馈、代码状态、错误、待办和下一步。

> 经典的Claude八段式摘要

> “previous conversation ran out of context”的 continuation message。
> 原文：This session is being continued from a previous conversation that ran out of context.
> The summary below covers the earlier portion of the conversation.
> 本会话是从一个因为上下文耗尽而中断的先前会话继续而来。下面的摘要覆盖了该会话较早部分的内容。

> suppressFollowUpQuestions 可以译成：**抑制追问** / **禁止后续追问**
> 这句话是在说：**自动压缩完成后，Claude Code 不希望模型停下来问用户“接下来要做什么”，也不希望模型复述一遍“我看到你之前在做……”；它希望模型像没中断过一样直接继续干活。**

### 10.3 post-compact message 顺序

源码确认：

`buildPostCompactMessages(result)` 顺序固定：

```text
boundaryMarker
summaryMessages
messagesToKeep
attachments
hookResults
```

设计结论：

```text
compact 后的上下文要先声明边界，再给摘要，再给保留原文，再给恢复附件和 hook 结果。
```

这个顺序让模型先理解“历史已被压缩”，再读取连续工作所需状态。

## 11. Session Memory Compact：用**后台维护的**会话记忆替代重复总结

### 11.1 机制定位

源码确认来自 `src/services/compact/sessionMemoryCompact.ts`：

- session memory compact 是实验机制。
- `shouldUseSessionMemoryCompaction()` 受 env 和 GrowthBook flag 控制。
- 默认配置：
  - `minTokens: 10_000`
  - `minTextBlockMessages: 5`
  - `maxTokens: 40_000`
- 它会等待正在进行的 session memory extraction。
- 如果 session memory 不存在或为空模板，返回 `null`，让传统 compact 接管。

设计结论：

```text
session memory compact 把“已总结的长期记忆”和“最近未总结消息”分离。
```

相比每次 compact 都重新 summarize 全部上下文，它可以复用持续维护的 session memory，只保留最近增量。

> 见笔记： [[#9.2 `shouldAutoCompact()` 的保护条件]]

### 11.2 保留消息的 API 不变量

源码确认：

- `adjustIndexToPreserveAPIInvariants()` 会向前扩展 start index，确保 tool_use/tool_result pair 不被切开。
- 它也会保留同一 `message.id` 的 assistant sibling，防止 thinking blocks 在 `normalizeMessagesForAPI()` 合并时丢失。
- `calculateMessagesToKeepIndex()` 从 last summarized message 后开始，向前扩展直到满足 token 和 text block 最小值，且不越过 compact boundary floor。

设计结论：

```text
压缩保留尾部消息不能只按 token 或条数切片，必须保留 provider 协议不变量。
```

外部系统的 compact 保留策略至少要处理：

- tool_result 必须有对应 tool_use。
- 同一 provider response 被拆成多个 assistant records 时，不能只保留其中一段。
- thinking blocks 和后续 tool_use/result 轨迹要满足 provider 规则。

> calculateMessagesToKeepIndex() 计算 compact 后要保留的尾部消息起点。默认起点是 lastSummarizedMessageId 的下一条消息，也就是只保留 session memory 尚未覆盖的新消息；如果这段尾部不足 minTokens 或 minTextBlockMessages，就把起点向更旧的消息移动，扩大尾部保留范围。扩展最多只能到最近 compact boundary 之后，不能跨回已经压缩过的区域。最后再用 adjustIndexToPreserveAPIInvariants() 修正起点，避免切断 tool_use/tool_result 等 provider 协议配对。

> 值得注意的是，假如“向更旧的消息移动”，这会导致session memory的summary和toKeep的messages有一定程度的重合。但这不是逻辑矛盾，而是一个有意的工程取舍：**宁愿保留一点重复的近期原文，也不要压缩后只剩抽象 memory，导致模型失去最近语境。**
> 原因如下：
> 1. **session memory 是结构化工作记忆，不是逐字 transcript**  
    它可能记录“当前状态、错误、下一步”，但不会完整保留最近几轮措辞、工具结果细节、模型刚刚说过的话。向左扩是为了补足这部分原文语境，并不会产生冲突。
> 2. **minTokens 和 minTextBlockMessages 是“尾部新鲜度”要求**  
    如果 last summarized 后只有一两条很短消息，compact 后模型看到的是：一大段结构化 memory + 很少的真实最近对话。这样继续任务容易断。向左扩就是保证有足够“最近原文尾巴”。
> 3. **重叠比断裂更安全**  
    少量重复通常只是浪费 token；但没有足够近期原文，模型可能误解当前状态，导致这次会话失败会浪费更多token。Claude Code 这里显然选择了 continuity 优先。
> 4. **还要维护 provider 协议完整性**  
    后面 adjustIndexToPreserveAPIInvariants() 还可能继续把起点往左挪，避免切断 tool_use/tool_result。这也可能扩大重叠，但能避免 API 消息序列非法。

## 12. 压缩后的上下文恢复

### 12.1 文件恢复

源码确认来自 `src/services/compact/compact.ts`：

- `POST_COMPACT_MAX_FILES_TO_RESTORE = 5`。
- `POST_COMPACT_TOKEN_BUDGET = 50_000`。
- `POST_COMPACT_MAX_TOKENS_PER_FILE = 5_000`。
- `createPostCompactFileAttachments()` 从 `readFileState` 中选择最近文件，排除 plan files 和 memory files。
- 如果 preserved tail 中已经有真实 Read 结果，则跳过相同路径，避免重复注入。
- 使用 `generateFileAttachment()` 重新读文件，因此会走文件读取限制和权限。

设计结论：

```text
压缩后恢复文件不是“把旧 Read 结果复制回来”，而是重新生成受权限和预算约束的附件。
```

这避免压缩后模型失去关键文件，也避免无限重复同一文件内容。

> **POST_COMPACT_MAX_FILES_TO_RESTORE**压缩后最多恢复几个最近读过的文件
> **POST_COMPACT_MAX_TOKENS_PER_FILE**每个恢复文件最多给多少token
> **POST_COMPACT_TOKEN_BUDGET**所有恢复文件 attachment 加起来最多多少token
>  preserved tail **压缩后保留下来的尾部原始消息**，不重复读取
### 12.2 Skills 恢复

源码确认：

- `POST_COMPACT_MAX_TOKENS_PER_SKILL = 5_000`。
- `POST_COMPACT_SKILLS_TOKEN_BUDGET = 25_000`。
- `createSkillAttachmentIfNeeded(agentId)` 只包含当前 agent scope 的 invoked skills。
- skills 按最近调用优先，每个 skill 保留开头并加截断标记。
- `runPostCompactCleanup()` 明确不清除 invoked skill content。
- compact 后也不 reset sentSkillNames，注释说明重新注入 full skill_listing 是 token 浪费，已调用 skill 由 invoked_skills 保存。

设计结论：

```text
skill listing 是发现索引；invoked skill content 是已生效指令。二者在 compact 后应区别处理。
```

> Skills 恢复，恢复的是“已经调用并影响当前任务的 skill 内容”，不是“重新广播所有可用 skill 目录”。
> 
> skill_listing 是**发给模型看的 attachment**。
> 它的内容是“当前有哪些 skills 可用”，类似一个技能目录：
> Available skills:
	- code-review
	- frontend-design
	- git-workflow
> 模型能看到的是 skill_listing。
> 
> sentSkillNames 是**Claude Code 内部的去重状态**。
> 是一个 Map\<agentId, Set\<skillName>>，用来记录“哪些 skill 名称已经给这个 agent 发过 listing 了”。模型看不到 sentSkillNames，也不能通过它调用 skill。
> 
> invoked_skills 和 skill_listing 是同级的 attachment 类型，但语义不同：
> skill_listing:
	  发现索引
	  告诉模型有哪些 skill 可以调用
	  通常只包含名称/描述等轻量信息
> invoked_skills:
	  已调用 skill 的正文内容
	  告诉模型这些 skill 指令已经在当前任务里生效过
	  compact 后用于恢复已生效的操作规则
>  
> AttachmentMessage
	├─ skill_listing       // 可用技能目录
	├─ skill_discovery     // 技能发现结果
	├─ invoked_skills      // 已调用技能正文
	├─ compact_file_reference
	├─ plan_mode
	└─ ...
>
> compact 后模型看到的是新的 post-compact messages，大致是：
	compact boundary
	summary
	messagesToKeep / preserved tail
	restored attachments:
	  - restored files
	  - invoked_skills
	  - plan/task/hooks...
>
> 旧的 skill_listing 如果在 compact boundary 之前，就不会进入下一轮 messagesForQuery。它还在 transcript / 历史记录里，但不在模型本轮 API view 里。
> 
> sentSkillNames 不变，只表示 Claude Code 内部还记得：
> 	这些 skill 名称已经给这个 agent 发过 listing 了，不要因为 compact 再重发一遍完整目录。
> 它不是模型可见上下文。
> 
> LLM 还是看得到原 skill_listing？
> 答案是：**通常看不到。**
>  除非有这些情况：
>  1. skill_listing 恰好在 messagesToKeep / preserved tail 里。
>  2. compact summary 把可用 skill 名称总结进去了。
>  3. 后续 skill 集合变化，resetSentSkillNames() 被触发，重新生成新的 skill_listing。
>  4. resume/recovery 路径里旧 transcript 中的 listing 仍在当前可见窗口内。（本质同1）
> 
> 但正常 compact 后，Claude Code 的设计是：
> 	不重发完整 skill_listing
> 	只恢复 invoked_skills
> 	保留 SkillTool 调用能力
> 这意味着模型仍然**能调用 skills**，因为 SkillTool 还在工具 schema 里；但它未必还能完整看见“所有可用 skill 的目录”。它主要能继续依赖已经调用过的 skill 内容，也就是 invoked_skills。
> 
> 那模型要调用其他skills呢？
> 如果 compact 后需要调用**还没调用过的其他 skills**，Claude Code 主要依赖两条路：
> 1. **模型已经知道 skill 名称**
> 	比如 compact summary、preserved tail、用户当前消息里提到了某个 skill 名，或者模型之前看过 skill_listing 并在上下文/summary 中保留了这个名字。这时 SkillTool 还在工具 schema 里，模型可以直接调用对应 skill。
> 2. **后续重新触发 skill 发现 / listing 更新**
> 	如果 skill 集合发生变化，比如插件 reload、skill 文件变化，内部会 resetSentSkillNames()，下一次就可能重新注入新的 skill_listing。如果有 skill search / discovery 机制，也可以通过发现流程找候选 skills，而不是依赖全量 listing 重注入。
> 
> 但如果满足下面这种情况：
	compact 前有完整 skill_listing
		-> compact 后 listing 被压掉
		-> sentSkillNames 没 reset，所以不重发 listing
		-> summary 里也没提某个未调用 skill
		-> 用户也没提
		-> 模型不知道那个 skill 名称
>
> 那模型确实不太可能主动调用那个 skill。
> 这是 Claude Code 的取舍：**compact 后优先保持已生效 skill 的连续性，而不是反复广播完整技能目录。**
### 12.3 Plan mode 和计划文件恢复

源码确认：

- `createPlanAttachmentIfNeeded()` 如果当前 session 有 plan，会生成 `plan_file_reference`。
- `createPlanModeAttachmentIfNeeded()` 在 plan mode 下生成 `plan_mode` attachment，确保模型压缩后仍知道自己处于计划模式。
- `/compact` 和 autocompact 都会把这些 attachment 放回 post-compact messages。

设计结论：

```text
模式状态不能只存在于 UI 或 app state；如果它影响模型行为，compact 后必须重新注入模型可见上下文。
```

### 12.4 异步 agent / task 状态恢复

源码确认：

- `createAsyncAgentAttachmentsIfNeeded()` 会扫描 `appState.tasks` 中 local_agent。
- 排除 pending、已 retrieved、以及当前 agent 自己。
- 对 running 或 completed 但未 retrieved 的 agent 创建 `task_status` attachment。

设计结论：

```text
压缩不能让模型忘记后台任务，否则容易重复创建任务或丢失结果。
```

## 13. Provider 请求构建与缓存稳定性

### 13.1 system prompt 分块和 cache scope

源码确认来自 `src/utils/api.ts`：

- `splitSysPromptPrefix()` 会按 attribution header、CLI system prompt prefix、static blocks、dynamic blocks 分块。
- 如果启用 global cache 且找到 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`，边界前 static blocks 可标记 `cacheScope: 'global'`，边界后 dynamic blocks 不缓存。
- MCP tools 存在时可跳过 global system prompt cache，改用 org-level。

设计结论：

```text
system prompt 内部也要区分稳定部分和动态部分，不能整段统一缓存或统一不缓存。
```

> system prompt 分块 指的是：Claude Code 内部的 `systemPrompt` 是 `string[]`，不是单个大字符串。
>
> 大致可以理解成：
>
> ```text
> systemPrompt[]
>   attribution header / CLI prefix
>   静态产品说明
>   静态工具使用规则
>   tone / style / output efficiency
>   [可选] SYSTEM_PROMPT_DYNAMIC_BOUNDARY
>   session guidance
>   memory prompt
>   env info
>   language / output style
>   MCP instructions
> ```
>
> cache scope 指的是：某个 system prompt block 的 prompt cache 复用范围。
>
> 在源码里主要会出现两种缓存语义：
>
> ```text
> org-level cache:
>   普通 prompt cache，默认不跨组织 / 租户边界复用。
>   适合当前用户、组织或会话相关的 system prompt 内容。
>
> global cache:
>   更大范围的公共缓存，只适合非常稳定、非用户特定的公共前缀。
>   例如 Claude Code 内置静态说明。
> ```
>
> 为什么要分块？
>
> 因为 prompt cache 依赖请求前缀字节稳定。如果把 system prompt 全部拼成一个字符串，只要其中一小段变化，比如 cwd、env info、MCP instructions、language、output style 或用户/session 相关配置变化，就可能影响整段缓存复用。
>
> 所以 Claude Code 不是简单地“整段缓存”或“整段不缓存”，而是先把 system prompt 拆成 block，再给不同 block 决定不同的 cache scope。
>
> 常规 / 降级路径可以理解成：
>
> ```text
> splitSysPromptPrefix()
>   attribution header        -> cacheScope: null
>   system prompt prefix      -> cacheScope: org
>   rest system prompt        -> cacheScope: org
> ```
>
> 也就是说，即使不走 global cache，Claude Code 仍然会做 system prompt 分块，并给可缓存部分使用普通 org-level prompt cache。
>
> `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 是 global cache mode 下使用的分界 marker。
>
> 当 global cache mode 启用、边界存在，并且没有因为 MCP tools 等条件降级时，Claude Code 会把边界前后的内容区别处理：
>
> ```text
> splitSysPromptPrefix()
>   attribution header        -> cacheScope: null
>   CLI system prompt prefix  -> cacheScope: null
>   boundary 前 static blocks -> cacheScope: global
>   boundary 后 dynamic blocks-> cacheScope: null
> ```
>
> 边界前是相对稳定的 Claude Code 内置规则，例如 intro、system section、工具使用规则、tone/style 等，适合 global cache。
>
> 边界后是更容易随用户、session 或运行环境变化的内容，例如 session guidance、memory prompt、env info、language、output style、MCP instructions 等，不适合 global cache。
>
> MCP tools 存在时的“跳过”不要理解成“不做 cache”。
>
> 它跳过的是 global system prompt cache 策略，而不是跳过 system prompt 分块或跳过 prompt cache 本身。
>
> 原因是 MCP tools 是用户/会话相关的动态工具，工具 schema 区域会强烈依赖当前用户连接了哪些 MCP server。为了避免把用户特定工具上下文混进跨用户可复用的 global cache 策略里，Claude Code 会降级为 org-level cache：
>
> ```text
> 有实际 MCP tools，需要跳过 global:
>   attribution header        -> cacheScope: null
>   system prompt prefix      -> cacheScope: org
>   rest system prompt        -> cacheScope: org
> ```
>
> 所以 13.1 的重点不是“system prompt 一定按 static/global 和 dynamic/null 拆”，而是：
>
> system prompt 内部要按稳定性和信任/复用范围分块；global cache 只是其中一种优化路径。默认或降级情况下仍然分块，只是使用更保守的 org-level cache。
> 
> 在本地 Claude Code 进程里，org-level cache 和 global cache ，除了**构造 API 请求时给 cache_control 打的标记不同**，似乎就没有区别了。区别主要在Claude code的服务端，是否会命中跨用户/跨组织的全局公共缓存。
### 13.2 tool schema 缓存

源码确认：

- `toolToAPISchema()` 中 base schema 以 tool name 或 input JSON schema 为 cache key。
- 注释说明这是为了避免 mid-session GrowthBook flips 或 tool.prompt drift 改变 serialized tool array bytes。
- per-request overlay 才加入 `defer_loading`、`cache_control` 等可变字段。

设计结论：

```text
工具 schema 是上下文的一部分，也会影响 prompt cache。稳定字段和 per-request 字段应分开。
```

> 这一节讲的不是“工具执行结果缓存”，而是：**工具定义本身也是模型上下文的一部分，工具 schema 的字节变化会影响 prompt cache 命中，所以 Claude Code 要尽量让工具 schema 稳定。**
> 源码注释：
> Tool schemas render at server position 2 ... any byte-level change busts the entire tool block AND everything downstream.
> 服务端 prompt cache 不是只看 messages。tools 数组也在缓存前缀里，而且位置很靠前。只要 tool schema 字节变了，后面的缓存都可能失效。
> 
> 所以 Claude Code 做了一个本地 session 级缓存：
> 	const TOOL_SCHEMA_CACHE = new Map<string, CachedSchema>()
> 
> toolToAPISchema() 第一次渲染某个工具 schema 后，把 base schema 缓存起来。后续同一 session 里尽量复用第一次渲染结果，避免中途 GrowthBook feature flag 翻转、tool.prompt() 动态变化等导致 serialized tools array 改字节。
> 第一点和第二点说的就是这个。
> 
> "per-request overlay 才加入 `defer_loading`、`cache_control` 等可变字段。"
> per-request overlay：**每次请求临时叠加的配置层**。
> defer_loading：**延迟加载**
> cache_control：**缓存控制**
> 这一句想说的是：缓存的不是最终完整对象，而是稳定的基础部分。然后每次请求再复制一份，加上本轮才决定的字段。为什么这么做？因为 defer_loading 这类字段每轮可能不同。比如 tool search 开启后，有些 MCP tools 先不完整加载，只打一个 defer_loading: true。如果把这些动态字段写进缓存 base，就会污染后续请求。所以这里的设计原则是：稳定字段缓存；每轮变化字段临时叠加。
### 13.3 user context 前置

源码确认：

- `prependUserContext()` 在非 test 环境中，把 userContext 渲染为第一条 meta user message。
- `query.ts` 在调用模型时传入的 messages 会经过 `prependUserContext(messagesForQuery, userContext)`。

设计结论：

```text
用户/项目指令以 meta user reminder 形式前置，可以让它靠近消息开头，同时避免污染 system prompt cache 的动态部分。
```

> user context 前置不是前置到整个 API prompt 的最最开头。Anthropic 请求里大致有几个区域：
	tools
	system
	messages
> prependUserContext() 做的是：**把 userContext 插到 messages 数组的第一条**。
> 所以准确的说法是：前置到 conversation messages 的第一条，作为 meta user message。不是前置到 tools/system prompt 前面。
> 
> user context 不是用户当前输入的那条消息。基础 userContext 主要是：claudeMd: CLAUDE.md / memory files 聚合内容、currentDate: 今日日期。另外在主线程里还可能叠加一些 coordinator/scratchpad/proactive 状态。
>
> 关于user context和system prompt 静态段中间夹了一个动态段的疑问：user context会不会因为动态段而不命中缓存？
> 
> 这里容易被 `system prompt` / `user context` 这两个名字误导。它们不是按“静态 / 动态”命名的，而是按**注入通道和语义位置**命名的。
> 
> Claude Code 里大致有几类上下文：
> 
> ```text
> tools
> system prompt 静态段
> system prompt 动态段
> messages[0] userContext meta reminder
> messages[1..] transcript
> ```
> 
> `userContext` 走的是 `messages` 通道，作为第一条 meta user message 注入；`systemContext` 走的是 system prompt 通道，会追加到 system prompt 末尾。这样做的一个重要原因是保护 system prompt cache：CLAUDE.md、日期、项目上下文这类用户 / 项目相关内容如果直接塞进 system prompt，会让 system prompt 更容易变化。
>
> ### prefix cache 的缓存点
>
> `cache_control` 标记的不是“只缓存当前这一段”，而是告诉服务端：**从 prompt 开头到这个标记位置为止的前缀可以缓存**。
>
> 简化看，Claude Code 可能形成两个层次的缓存点：
>
> ```text
> tools
> system attribution
> system prefix
> system 静态规则                 <- 缓存点 A：短前缀，高稳定性
> system 动态内容
> messages[0] userContext
> messages[1..n] 历史对话
> messages[n+1] 当前用户消息       <- 缓存点 B：长前缀，高收益
> ```
>
> 缓存点 A 主要服务于 Claude Code 内置静态规则的复用。它命中率最高，但仍依赖前面的 tool schema 等内容稳定。
>
> 缓存点 B 是 message-level cache marker，默认放在最后一条 message 上。它缓存的是从 prompt 开头到本轮最后一条 message 的整个长前缀。下一轮请求时，上一轮的 userContext、旧 transcript、上一轮用户消息等都变成可复用前缀。
>
> 因此，`messages` 里的旧对话不是没吃到 prefix cache；它吃的是上一轮 message-level cache marker 写下的长前缀缓存。
>
> ### 为什么 system 动态段不会让缓存完全失效？
>
> system 动态段确实会影响缓存点 B，因为缓存点 B 覆盖了 system 动态段和 messages。如果 system 动态段字节变化，长前缀缓存可能 miss。
>
> 但 Claude Code 有两层缓冲：
>
> 1. system 静态段前后的边界让缓存点 A 仍然可以命中较短但稳定的前缀。
> 2. system 动态段虽然叫“动态”，但很多内容在会话内会被 memoize 或保持快照，例如 user/system context、tool schema、beta header、TTL eligibility 等都尽量保持稳定。
>
> 所以实际效果是：
>
> ```text
> 缓存点 A：收益较小，但命中率最高。
> 缓存点 B：收益最大，通常也能命中，但依赖 tools、system 动态段、userContext、旧 transcript 都稳定。
> ```
>
> 最终心智模型：
>
> ```text
> Claude Code 不是只缓存 system prompt，也不是只缓存 messages；
> 它通过多个 cache_control 点，把“高稳定短前缀”和“高收益长前缀”分层缓存。
> ```
>
> 这也解释了为什么它要做 tool schema cache、system prompt 分块、userContext 前置、context memoize 和 beta header latch：这些设计都在减少 API prompt 前缀的字节抖动，从而提高 prompt cache 命中率。

## 14. 上下文观测：`/context` 不是装饰功能

### 14.1 `/context` 显示 API view

源码确认：

- `src/commands/context/context.tsx` 的注释明确说要应用 query.ts 同样的 context transforms，让 `/context` 显示模型实际看到的内容，而不是 REPL raw history。
- 它调用 `getMessagesAfterCompactBoundary()`，可选 `projectView()`，再 `microcompactMessages()`。
- 然后调用 `analyzeContextUsage()`。

### 14.2 `analyzeContextUsage()` 的分类

源码确认来自 `src/utils/analyzeContext.ts`：

它会统计：

- system prompt tokens 和 system prompt sections。
- memory files / CLAUDE.md tokens。
- built-in tools tokens。
- MCP tools tokens，以及 deferred MCP tools。
- custom agents tokens。
- slash commands tokens。
- skills frontmatter tokens。
- messages breakdown，包括 tool calls、tool results、attachments、assistant messages、user messages。
- auto compact threshold、reserved buffer、free space。
- last API response usage。

设计结论：

```text
上下文工程必须有用户可理解的 token 账本。
```

否则用户只会看到“上下文满了”，但无法判断是工具结果、MCP schema、memory 文件、skills 还是普通消息导致的。

## 15. 安全与信任边界

### 15.1 文件和 memory 不是可信指令的同一层

源码确认：

- `generateFileAttachment()` 和 file read path 会检查权限、大小、PDF、图片等。
- `claudemd.ts` 对 include 扩展名、include 深度、exclude pattern、外部 include warning 有明确处理。
- `getExternalClaudeMdIncludes()` 会识别 User memory include 了原始 cwd 外部路径。

设计结论：

```text
用户/项目 instruction 文件可以影响行为，但仍需受文件发现、include、路径和权限边界约束。
```

外部系统不能允许任意二进制或无限 include 进入上下文。

### 15.2 工具结果不能破坏工具协议

源码确认：

- `sessionMemoryCompact.ts` 保留尾部消息时专门防止 tool_use/tool_result pair 被切开。
- `toolResultStorage.ts` 的预算 grouping 模拟 `normalizeMessagesForAPI()` 合并连续 user messages 的行为。
- `messages.ts` 中存在 `SYNTHETIC_TOOL_RESULT_PLACEHOLDER`，说明缺失工具结果只可作为内部占位，不能污染训练/真实事实。

设计结论：

```text
任何上下文裁剪都必须先满足 provider 的消息协议，再考虑 token 最优。
```

### 15.3 压缩 hooks 和恢复 hooks 是信任边界

源码确认：

- `compactConversation()` 执行 `executePreCompactHooks()`，并把 hook instructions 合并进 custom instructions。
- `sessionMemoryCompact.ts` 会在 compact 后运行 `processSessionStartHooks('compact')`。
- `compact.ts` 的 `CompactionResult` 包含 `hookResults`。

设计结论：

```text
hooks 可以改变压缩指令和压缩后上下文，因此必须被视为上下文写入者。
```

外部系统应记录 hook 来源、输出和是否阻塞，避免不可解释的 summary 改写。

## 16. 外部实现方案

### 16.1 推荐模块划分

| 模块                          | 接口                                               | 核心职责                                                                   |
| --------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------- |
| `MemoryLoader`              | `loadMemoryFiles(cwd, settings)`                 | 发现、include、条件规则、过滤 memory 文件。                                          |
| `ContextBuilder`            | `buildContextBundle(session)`                    | 收集 system/user context 和本轮 attachments。                                |
| `AttachmentRenderer`        | `renderAttachment(attachment)`                   | 把 typed attachment 转为 meta user messages。                              |
| `MessageProjector`          | `projectForModel(transcript, context)`           | compact boundary、预算、microcompact、autocompact。                          |
| `ProviderMessageNormalizer` | `normalizeForProvider(projectedMessages, tools)` | 合并、过滤、attachment 渲染、tool pairing 修复，让内部 messages 变成 provider messages。 |
| `ToolResultStore`           | `persistToolResult(block)`                       | 大工具结果落盘、预览、恢复决策。                                                       |
| `CompactionService`         | `compact(messages, options)`                     | 生成 summary、boundary、messagesToKeep、attachments。                        |
| `ContextLedger`             | `analyze(projectedRequest)`                      | token 分类、阈值、buffer、来源解释。                                               |
| `CacheCoordinator`          | `splitSystemPrompt()`, `freezeToolSchemas()`     | 管理 prompt cache 稳定性。                                                   |

### 16.2 推荐状态模型

```ts
type AgentSessionState = {
  transcript: Message[]
  readFileState: Map<string, { content: string; timestamp: number }>
  loadedNestedMemoryPaths: Set<string>
  invokedSkills: Map<string, InvokedSkill>
  contentReplacementState?: ContentReplacementState
  autoCompactTracking?: {
    compacted: boolean
    turnCounter: number
    turnId: string
    consecutiveFailures?: number
  }
  mode: "default" | "plan" | "auto"
  tasks: Record<string, TaskState>
}
```

### 16.3 推荐投影 API

```ts
async function projectForModel(input: {
  transcript: Message[]
  systemPrompt: string[]
  userContext: Record<string, string>
  systemContext: Record<string, string>
  toolContext: ToolUseContext
  querySource: QuerySource
}): Promise<ProjectedRequest> {
  let messages = getMessagesAfterCompactBoundary(input.transcript)

  messages = await applyToolResultBudget(
    messages,
    input.toolContext.contentReplacementState,
  )

  messages = await microcompact(messages, input.toolContext, input.querySource)

  const compactResult = await autocompactIfNeeded(
    messages,
    input.toolContext,
    {
      systemPrompt: input.systemPrompt,
      userContext: input.userContext,
      systemContext: input.systemContext,
      toolUseContext: input.toolContext,
      forkContextMessages: messages,
    },
    input.querySource,
  )

  if (compactResult.compactionResult) {
    messages = buildPostCompactMessages(compactResult.compactionResult)
  }

  return {
    systemPrompt: appendSystemContext(input.systemPrompt, input.systemContext),
    messages: normalizeMessagesForAPI(
      prependUserContext(messages, input.userContext),
    ),
    tools: await buildToolSchemas(input.toolContext),
    diagnostics: {
      estimatedTokens: tokenCountWithEstimation(messages),
      appliedTransforms: [],
    },
  }
}
```

### 16.4 MVP 到生产的迁移路径

| 阶段 | 实现内容 | 可以暂缓 |
|---|---|---|
| MVP | system/user context、attachment meta messages、manual compact、大工具结果持久化、`/context` 账本。 | cached microcompact、session memory compact、context collapse。 |
| v1 | autocompact、post-compact file/plan/skill/task restore、content replacement resume。 | provider cache editing。 |
| v2 | session memory compact、tool schema deferred loading、memory surfacing。 | 多 agent mailbox。 |
| v3 | context collapse、reactive compact、cache editing、细粒度 prompt cache observability。 | provider-specific beta 功能可按需启用。 |

## 17. 测试计划

### 17.1 单元测试

- `getMessagesAfterCompactBoundary()`：compact boundary 前消息不进入 API view。
- `prependUserContext()`：user context 渲染为 `isMeta: true`，空 context 不注入。
- `appendSystemContext()`：system context 追加到 system prompt 数组尾部。
- `processMemoryFile()`：include、循环 include、非文本扩展、frontmatter paths、HTML comment stripping。
- `enforceToolResultBudget()`：同一 tool_use_id 的替换决策跨轮稳定。
- `reconstructContentReplacementState()`：resume 后 replacement 字符串与原 transcript record 一致。
- `adjustIndexToPreserveAPIInvariants()`：不切断 tool_use/tool_result pair 和同 message.id 的 assistant siblings。

### 17.2 集成测试

- 长工具输出后下一轮请求只包含 `<persisted-output>` 预览，不包含全文。
- 手动 compact 后消息顺序为 boundary、summary、kept messages、attachments、hook results。
- compact 后最近读过的文件被恢复，但 memory files 和 plan files 不被重复作为普通文件恢复。
- plan mode 下 compact 后仍有 plan mode attachment。
- invoked skills 在 compact 后按预算恢复，未调用 skill listing 不被无限重注入。
- auto compact 连续失败三次后停止重试。

### 17.3 可观测性测试

- `/context` 或等价 ContextLedger 显示 API view，而不是 raw transcript。
- token 分类能区分 system prompt、tools、MCP、memory、skills、messages、buffers。
- deferred tools 不计入实际 context usage，但在详情中可见。
- API usage 存在时，总量与 last API response usage 一致。

### 17.4 回归测试

- parallel tool calls 下多个 assistant records 共享同一 message.id 时，token estimation 不漏算中间 tool results。
- compact summary request prompt-too-long 时，可以丢弃最老 API round group 重试。
- 子 agent compact 不清理 main thread 的 module-level context collapse / memory cache 状态。
- time-based microcompact 触发后 cached microcompact state 被重置。

## 18. 常见失败模式

| 失败模式 | 后果 | 规避方式 |
|---|---|---|
| 把 transcript 直接发给模型 | compact 前旧历史和 summary 重复，超窗，矛盾，且可能包含 provider 不接受的内部消息。 | 始终通过 MessageProjector 和 ProviderMessageNormalizer 生成 provider messages。 |
| 把 `messagesForQuery` 当作最终上下文 | attachment、连续 user、assistant sibling、tool pairing 仍未按 provider 协议规范化。 | `messagesForQuery` 之后仍必须执行 `prependUserContext()`、`normalizeMessagesForAPI()`、`ensureToolResultPairing()`。 |
| 把 CLAUDE.md 拼进 system prompt | 动态用户/项目指令破坏 system cache，边界不清。 | 用 userContext meta reminder。 |
| 每轮重新决定大工具结果是否替换 | prompt cache 不稳定，模型可见历史跳变。 | 用 seenIds/replacements 冻结决策。 |
| compact 时按 token 直接切尾部 | tool_result 找不到 tool_use，provider 报错。 | 保留 API invariants。 |
| compact 后不恢复文件/计划/skills | 模型忘记当前工作状态。 | 构造 post-compact attachments。 |
| 无限重注入 skill listing | compact 后 token 浪费和 cache_creation 增长。 | listing 和 invoked skill 分离。 |
| 没有 autocompact 熔断 | 不可恢复超窗导致每轮浪费 API。 | 连续失败计数和上限。 |
| `/context` 显示 raw history | 用户误判上下文占用来源。 | 显示经过 compact boundary / microcompact 的 API view。 |
| memory include 无限制 | 二进制、循环、外部路径污染上下文。 | 扩展名、深度、路径、warning、exclude。 |
| 子 agent compact 清理全局缓存 | 主线程上下文状态被破坏。 | post-compact cleanup 按 querySource 分支。 |

## 19. 源码确认、合理推断、待验证

### 19.1 源码确认

- `query.ts` 每轮模型调用前执行 compact boundary、tool result budget、microcompact、context collapse 引用、autocompact，并在 compact 成功后使用 `buildPostCompactMessages()` 替换本轮内部投影视图。
- `services/api/claude.ts` 在 provider request 前执行 `normalizeMessagesForAPI()`、模型相关后处理、`ensureToolResultPairing()`、advisor/media stripping，说明 `messagesForQuery` 仍不是最终 provider 上下文。
- `screens/REPL.tsx` 的 `onQueryImpl` 在调用 `query()` 前获取 default system prompt、user context、system context，并构造 effective system prompt。
- `processUserInput()` / `getAttachmentMessages()` 在进入 agent loop 前处理用户显式输入附件、slash/skill/bash 分流和首轮 context attachments。
- `context.ts` 将 git status/cache breaker 作为 system context，将 CLAUDE.md/date 作为 user context。
- `api.ts` 将 system context 追加到 system prompt，将 user context 前置为 meta user reminder。
- `claudemd.ts` 实现 memory 文件发现、include、frontmatter paths、HTML comment stripping、exclude、conditional rules。
- `toolResultStorage.ts` 实现大工具结果落盘、预览替换、每消息预算和 resume 状态重建。
- `microCompact.ts` 实现 time-based microcompact 和 cached microcompact 的引用逻辑。
- `autoCompact.ts` 实现阈值、buffer、禁用条件和失败熔断。
- `compact.ts` 实现 compact summary、PTL retry、post-compact file/skill/plan/task attachments。
- `sessionMemoryCompact.ts` 实现 session memory compact 和保留尾部消息的 API invariant 修正。
- `analyzeContext.ts` 和 `commands/context/context.tsx` 实现上下文可视化和 API view 分析。

### 19.2 合理推断

- Claude Code 将上下文工程设计为“投影 + 规范化系统”而不是“prompt 拼接器”，因为源码中 transcript、messagesForQuery、attachments、system/user context、compact boundary、provider normalization 都是独立处理的。
- `isMeta` 是区分服务端注入上下文和用户真实输入的重要标记，因为多数 attachment 和 userContext 都以 `isMeta: true` 注入。
- prompt cache 稳定性是多处上下文设计的核心约束，因为 tool schema caching、content replacement freeze、microcompact cache editing、system prompt split 都围绕 serialized bytes 稳定展开。

### 19.3 待验证

- 当前源码镜像中没有 `src/services/contextCollapse/*` 文件，但 `query.ts`、`commands/context/context.tsx`、`postCompactCleanup.ts`、`analyzeContext.ts` 都有 feature-gated 引用。因此本文只能确认调用位置、执行顺序和与 autocompact 的边界，不能确认 collapse 的具体算法。
- 当前源码镜像中没有 `src/services/compact/snipCompact.ts` 文件，但 `query.ts` 和 `attachments.ts` 有 feature-gated 引用。因此本文只能确认 snip 在 microcompact 前执行，以及 context efficiency attachment 的存在，不能确认 snip 具体选择和删除策略。
- reactive compact 的具体实现文件在当前阅读中未展开，本文只依据 `query.ts`、`commands/compact/compact.ts` 和 `autoCompact.ts` 中的引用说明其边界。

## 附录 A：源码依据 / 设计来源校验

| 结论 | 源码路径 | 关键符号 |
|---|---|---|
| pre-agent loop 调用 query 前装配上下文 | `src/screens/REPL.tsx` | `onQueryImpl`, `getSystemPrompt()`, `getUserContext()`, `getSystemContext()`, `buildEffectiveSystemPrompt()`, `query()` |
| 用户输入处理和首轮附件收集 | `src/utils/processUserInput/processUserInput.ts`, `src/utils/attachments.ts` | `processUserInput()`, `getAttachmentMessages()`, `processAtMentionedFiles()` |
| host 提交、队列和并发保护 | `src/utils/handlePromptSubmit.ts` | `handlePromptSubmit()`, `processUserInput()` |
| system/user context 分离 | `src/context.ts` | `getSystemContext()`, `getUserContext()`, `getGitStatus()` |
| system context 追加到 system prompt | `src/utils/api.ts` | `appendSystemContext()` |
| user context 前置为 meta reminder | `src/utils/api.ts` | `prependUserContext()` |
| query 前投影顺序 | `src/query.ts` | `queryLoop()`, `messagesForQuery`, `getMessagesAfterCompactBoundary()`, `applyToolResultBudget()`, `deps.microcompact()`, `deps.autocompact()` |
| provider message normalization | `src/utils/messages.ts`, `src/services/api/claude.ts` | `normalizeMessagesForAPI()`, `ensureToolResultPairing()`, `stripExcessMediaItems()` |
| queryLoop bootstrap | `src/query.ts`, `src/query/config.ts`, `src/query/deps.ts` | `State`, `buildQueryConfig()`, `productionDeps()`, `startRelevantMemoryPrefetch()` |
| 工具执行后 follow-up context | `src/query.ts`, `src/utils/attachments.ts` | `runTools()`, `toolResults`, `getAttachmentMessages()` |
| 生产 deps 注入 | `src/query/deps.ts` | `productionDeps()`, `QueryDeps` |
| compact boundary 后消息截取 | `src/utils/messages.ts` | `getMessagesAfterCompactBoundary()`, `createCompactBoundaryMessage()` |
| attachment 渲染为 meta user messages | `src/utils/messages.ts`, `src/utils/attachments.ts` | `createAttachmentMessage()`, `Attachment` |
| CLAUDE.md 发现和 include | `src/utils/claudemd.ts` | `getMemoryFiles()`, `processMemoryFile()`, `getClaudeMds()` |
| 大工具结果落盘 | `src/utils/toolResultStorage.ts` | `persistToolResult()`, `buildLargeToolResultMessage()`, `processToolResultBlock()` |
| 每消息工具结果预算 | `src/utils/toolResultStorage.ts` | `ContentReplacementState`, `enforceToolResultBudget()`, `applyToolResultBudget()` |
| microcompact | `src/services/compact/microCompact.ts` | `microcompactMessages()`, `maybeTimeBasedMicrocompact()`, `cachedMicrocompactPath()` |
| autocompact 阈值和熔断 | `src/services/compact/autoCompact.ts` | `getEffectiveContextWindowSize()`, `getAutoCompactThreshold()`, `autoCompactIfNeeded()` |
| compact summary | `src/services/compact/compact.ts`, `src/services/compact/prompt.ts` | `compactConversation()`, `streamCompactSummary()`, `getCompactPrompt()`, `getCompactUserSummaryMessage()` |
| post-compact message 顺序 | `src/services/compact/compact.ts` | `buildPostCompactMessages()` |
| post-compact 文件恢复 | `src/services/compact/compact.ts` | `createPostCompactFileAttachments()` |
| post-compact skill 恢复 | `src/services/compact/compact.ts` | `createSkillAttachmentIfNeeded()` |
| post-compact cleanup | `src/services/compact/postCompactCleanup.ts` | `runPostCompactCleanup()` |
| session memory compact | `src/services/compact/sessionMemoryCompact.ts` | `trySessionMemoryCompaction()`, `calculateMessagesToKeepIndex()`, `adjustIndexToPreserveAPIInvariants()` |
| `/compact` 命令 | `src/commands/compact/compact.ts` | `call()`, `getCacheSharingParams()` |
| `/context` API view | `src/commands/context/context.tsx` | `toApiView()`, `call()` |
| context token 账本 | `src/utils/analyzeContext.ts`, `src/utils/contextAnalysis.ts` | `analyzeContextUsage()`, `analyzeContext()` |
| token 估算 | `src/utils/tokens.ts` | `tokenCountWithEstimation()`, `finalContextTokensFromLastResponse()`, `getCurrentUsage()` |
| 上下文窗口 | `src/utils/context.ts` | `getContextWindowForModel()`, `MODEL_CONTEXT_WINDOW_DEFAULT`, `COMPACT_MAX_OUTPUT_TOKENS` |

## 附录 B：数据库持久化 messages 的外部系统如何重建上下文

很多外部 agent 系统会把多轮对话存在数据库里。类比 Claude Code，最容易犯的错误是：

```text
每轮从数据库取最近 N 条 messages，直接塞进模型。
```

这不等价于 Claude Code 的上下文工程。更准确的做法是：

```text
数据库 messages 是 durable transcript；
模型上下文是每轮根据 transcript、当前 turn、动态上下文和 token 预算生成的读时投影视图；
provider request 是投影视图再经过 provider 协议规范化后的最终消息。
```

### B.1 推荐端到端流程

```text
DB messages
  -> load durable transcript
  -> find last compact boundary
  -> rebuild candidate transcript window
  -> append current user turn + dynamic attachments
  -> project to model window
  -> normalize for provider
  -> call model
  -> persist assistant/tool/result/context events back to DB
```

伪代码：

```ts
async function buildModelContext(sessionId: string, currentTurn: UserTurn) {
  const transcript = await db.messages.listBySession(sessionId)

  let messages = afterLastCompactBoundary(transcript)

  const turnMessages = await buildTurnMessages(currentTurn)
  messages.push(...turnMessages)

  messages = await applyToolResultBudget(messages)
  messages = await microcompactOldToolResults(messages)

  if (estimateTokens(messages) > AUTO_COMPACT_THRESHOLD) {
    const compactResult = await compactConversation(messages)
    await persistCompactResult(sessionId, compactResult)
    messages = buildPostCompactMessages(compactResult)
  }

  const userContext = await loadUserContext(sessionId)
  const systemContext = await loadSystemContext(sessionId)

  const requestMessages = prependUserContext(messages, userContext)

  return normalizeForProvider({
    systemPrompt: appendSystemContext(baseSystemPrompt, systemContext),
    messages: requestMessages,
    tools: await buildToolSchemas(sessionId),
  })
}
```

关键不是“取多少条历史消息”，而是“每轮如何从历史事实源投影出当前模型应该看到的窗口”。

### B.2 数据库里应该存什么

至少建议分三类表或集合。

**1. `messages`：完整 transcript**

```text
messages
  id
  session_id
  seq
  role                         // user | assistant | system | attachment
  type                         // normal | tool_result | compact_boundary | compact_summary | ...
  content_json
  is_meta
  provider_message_id           // assistant streaming fragments 合并用
  tool_use_id                   // tool_result 配对用
  source_tool_assistant_id       // 可选：结果来自哪个 assistant tool_use
  compact_boundary_id            // 可选：属于哪个 compact epoch
  created_at
```

这张表是事实源，服务 UI、恢复、审计和下一轮上下文投影。它不应该被等同为每轮 provider request。

**2. `context_events` / `attachments`：typed 服务端上下文**

```text
context_events
  id
  session_id
  message_id
  type                         // file_context | skill_listing | plan | task_status | memory | ...
  payload_json
  source                       // user_explicit | server | hook | retriever | compact_restore
  created_at
```

如果你的系统有文件预读、检索结果、计划状态、任务状态、memory surfacing，建议先存成 typed context event，再在 provider normalize 阶段渲染成 meta user message。不要一开始就丢成普通 user 文本，否则后续很难审计、压缩和去重。

**3. `content_replacements`：大工具结果替换决策**

```text
content_replacements
  session_id
  tool_use_id
  replacement_text
  original_ref                 // 文件路径、对象存储 key、blob id
  original_size
  created_at
```

这类记录用于 resume 后重建“哪些工具结果已经被替换成预览”。它的目标是保证 prompt cache 和模型可见历史稳定：同一个 tool result 不要这轮全文、下轮预览、再下轮又全文。

### B.3 每轮如何从 DB 重建历史会话

推荐步骤：

1. **读取完整 transcript 或当前 compact epoch**

   如果数据量可控，可以读取完整 session transcript，再在应用层找最近 compact boundary。如果数据很大，可以在 DB 中给 compact epoch 建索引，直接读取最近 epoch：

   ```text
   latest compact_boundary
   + compact summary
   + boundary 后 messages
   ```

2. **不要直接使用 boundary 前旧原文**

   compact boundary 前的消息可以保留在数据库中供 UI 和审计使用，但默认不进入本轮模型上下文。模型看到的是 compact summary 和 boundary 后的消息。

3. **追加当前 turn**

   当前用户输入、显式引用文件、上传图片、检索命中、计划状态等，先构造成内部 messages / attachments。

4. **应用读时投影**

   对候选 messages 应用：

   - compact boundary 过滤。
   - content replacement 重放。
   - 大工具结果落盘和预览。
   - 旧工具结果 microcompact。
   - token 超阈值时 compact。
   - 保留 tool_use/tool_result pair。
   - 保留同一 provider response 的 assistant fragments。

5. **做 provider normalization**

   进入模型前再做：

   - typed attachment 渲染成 meta user message。
   - 连续 user messages 合并。
   - assistant streaming fragments 按 provider message id 合并。
   - orphan/missing tool_use/tool_result 修复或报错。
   - provider 不支持的 block 过滤。
   - userContext 前置、systemContext 追加。

### B.4 上下文窗口推荐组成

不要用“最近 N 条消息”作为主要策略。更稳的窗口形状是：

```text
base system prompt
+ system context
+ user context meta reminder
+ latest compact summary
+ recent unsummarized tail
+ current user turn
+ current turn explicit attachments
+ task / plan / skill / memory 状态
+ tool result previews or references
```

其中：

- `latest compact summary` 负责旧历史连续性。
- `recent unsummarized tail` 负责最近细节和工具轨迹。
- `current turn explicit attachments` 负责用户当前明确指向的资料。
- `task / plan / skill / memory 状态` 负责长期工作状态。
- `tool result previews or references` 负责保留可追溯性但不撑爆上下文。

### B.5 什么时候触发 compact

建议同时支持手动 compact 和自动 compact：

| 触发 | 建议 |
|---|---|
| token 达到模型有效窗口的 80% 到 90% | 自动 compact。 |
| 用户显式要求“总结 / 压缩 / 继续上下文” | 手动 compact。 |
| 工具结果巨大但对话本身不长 | 优先 content replacement，不要立刻总结整个会话。 |
| 数据库历史很长但当前任务只依赖最近局部 | 可以只读取最近 compact epoch。 |

compact 结果应写回 DB：

```text
compact_boundary message
compact_summary message
messages_to_keep metadata
restored attachment messages
```

旧消息不必删除。它们仍用于 UI、审计、debug 和必要时重新 compact。

### B.6 Provider request 前必须检查的协议不变量

类比 Claude Code 的 `normalizeMessagesForAPI()` 和 `ensureToolResultPairing()`，外部系统至少检查：

- 第一条 provider message 是否是合法 role。
- 连续 user messages 是否需要合并。
- assistant `tool_use.id` 是否有对应 user `tool_result.tool_use_id`。
- orphan tool_result 是否需要剥离或报错。
- 同一 provider response 被拆分的 assistant fragments 是否已合并。
- thinking / reasoning blocks 是否满足 provider 规则。
- 图片、文件、tool reference、检索块是否被当前 provider 支持。
- system/user/meta context 是否没有混成同一个普通 user prompt。

### B.7 一个最小实现切分

```ts
type DurableMessage = {
  id: string
  sessionId: string
  seq: number
  role: "user" | "assistant" | "system" | "attachment"
  type: string
  content: unknown
  isMeta?: boolean
  providerMessageId?: string
  toolUseId?: string
}

type BuildContextResult = {
  systemPrompt: string[]
  providerMessages: ProviderMessage[]
  diagnostics: {
    transcriptCount: number
    projectedCount: number
    providerCount: number
    estimatedTokens: number
    transforms: string[]
  }
}

async function buildContextForTurn(
  sessionId: string,
  currentTurn: UserTurn,
): Promise<BuildContextResult> {
  const transcript = await transcriptStore.load(sessionId)
  const epoch = selectLatestCompactEpoch(transcript)
  const currentAttachments = await attachmentBuilder.fromTurn(currentTurn)

  let projected = messageProjector.project([
    ...epoch.messages,
    ...currentAttachments,
  ])

  projected = await toolResultBudgeter.apply(projected)

  if (tokenEstimator.count(projected) > thresholds.autoCompact) {
    const result = await compactor.compact(projected)
    await transcriptStore.appendCompactResult(sessionId, result)
    projected = buildPostCompactMessages(result)
  }

  const systemContext = await contextLoader.system(sessionId)
  const userContext = await contextLoader.user(sessionId)

  const providerMessages = providerNormalizer.normalize(
    prependUserContext(projected, userContext),
  )

  return {
    systemPrompt: appendSystemContext(baseSystemPrompt, systemContext),
    providerMessages,
    diagnostics: {
      transcriptCount: transcript.length,
      projectedCount: projected.length,
      providerCount: providerMessages.length,
      estimatedTokens: tokenEstimator.countProvider(providerMessages),
      transforms: providerNormalizer.transforms,
    },
  }
}
```

### B.8 常见误区

| 误区 | 问题 | 更好的做法 |
|---|---|---|
| 每轮取最近 N 条 DB messages | 会切断工具调用、丢失旧任务意图、忽略 compact summary。 | 按 compact epoch + recent tail 重建。 |
| compact 后删除旧消息 | 丢失审计、debug、重新总结能力。 | 保留旧消息，只让 boundary 前旧原文默认不进上下文。 |
| 把附件直接存成普通 user 文本 | 后续无法区分检索、文件、计划、hook、用户输入。 | 存 typed attachment/context event，provider 前再渲染。 |
| 大工具结果只截断 | 失去可追溯性，模型无法知道完整结果在哪里。 | 写对象存储/文件，消息中保留预览和引用。 |
| 不保存 replacement 决策 | resume 后同一结果可见性变化，cache 和行为不稳定。 | 保存 `content_replacements`。 |
| 忽略 provider normalization | DB 消息看似合理，API 请求却因 role/tool/media 规则失败。 | 引入独立 `ProviderMessageNormalizer`。 |

### B.9 关于当前用户消息和历史消息的关键澄清

如果类比 Claude Code，数据库项目里需要分清三件事：

```text
DB 中的完整 messages
  ≈ Claude Code 的 durable transcript / state.messages 的来源

本轮候选消息数组
  ≈ history + 当前 turn messages

本轮模型内部投影
  ≈ messagesForQuery
```

#### B.9.1 `UserContext` 不是数据库 messages

`UserContext` 不是你项目里数据库存的多轮对话消息。

更准确的映射是：

| 你的项目概念 | Claude Code 类比 | 含义 |
|---|---|---|
| 数据库存的多轮对话消息 | `messages` / `transcript` / `state.messages` | 历史事实源：用户说过什么、assistant 回过什么、工具调用和结果是什么。 |
| 每轮处理后的历史窗口 | `messagesForQuery` 的一部分 | 从历史 messages 投影出来的本轮候选上下文。 |
| 用户/项目长期指令 | `userContext` | 例如用户偏好、项目规则、当前日期、长期记忆等。 |
| 最终发给模型的消息 | provider messages | `messagesForQuery + userContext meta reminder` 再 normalize 后的结果。 |

Claude Code 的 `userContext` 主要来自 `getUserContext()`，包括 `CLAUDE.md` / memory files 和 `currentDate`。它会通过 `prependUserContext(messagesForQuery, userContext)` 变成一条前置 meta user message。

所以在外部系统中：

```text
数据库 messages 不是 UserContext；
UserContext 是额外的用户/项目/租户/环境级上下文；
最终 provider messages 由处理后的历史 messages、当前 turn、UserContext、SystemContext 和 attachments 共同组成。
```

#### B.9.2 重建出来的 history messages 什么时候等价于 `messagesForQuery`

如果你只是从数据库读取：

```sql
select * from messages where session_id = ? order by seq;
```

这更像 Claude Code 的 transcript / `state.messages`，不是 `messagesForQuery`。

只有当你重建 history 时已经做了以下处理，才可以把它类比为 `messagesForQuery` 的历史部分：

- 找到最近 compact boundary。
- 保留 compact summary。
- 保留最近未压缩 tail。
- 重放 content replacement 决策。
- 大工具结果替换成预览和引用。
- 恢复当前任务相关 attachment。
- 保证 tool_use/tool_result 不被切断。
- 控制 token 预算。

也就是说：

```text
原始 DB history = transcript
处理后的本轮可发送 history = messagesForQuery 的历史部分
最终发给模型的 messages = prepend userContext 后再 normalize 的 provider messages
```

#### B.9.3 Claude Code 会维护原始对话数组，但注入上下文的是处理后的投影视图

Claude Code 里确实维护一个原始会话状态：

```text
state.messages
```

它像当前 loop 持有的 transcript / 历史事实源，里面有用户消息、assistant 消息、tool result、attachment、compact boundary、summary 等。

但模型每轮看到的不是直接的 `state.messages`。`queryLoop()` 会先生成：

```text
messagesForQuery
```

处理包括：

- 从最近 compact boundary 后开始取。
- 应用大工具结果预算。
- 可能做 snip。
- 可能做 microcompact。
- 可能做 context collapse。
- 可能触发 autocompact，并替换成 compact summary + 保留尾部 + 恢复附件。
- 更新 `toolUseContext.messages = messagesForQuery`。

然后真正请求模型时，还会继续：

```text
prependUserContext(messagesForQuery, userContext)
-> normalizeMessagesForAPI(...)
-> ensureToolResultPairing(...)
-> provider messages
```

所以外部系统的对应关系是：

```text
数据库里的完整 messages
  ≈ Claude Code state.messages / transcript

每轮从数据库历史处理出来的上下文窗口
  ≈ Claude Code messagesForQuery

最终发给模型 API 的 messages
  ≈ prependUserContext + normalizeMessagesForAPI 后的 provider messages
```

#### B.9.4 当前用户消息是单独追加，还是和历史一起处理

更准确的答案是：

```text
当前消息会和历史消息一起进入同一条处理管线；
但多数处理主要影响历史部分，当前消息通常作为 protected recent tail 保留。
```

Claude Code 的结构更像：

```text
state.messages = history + current turn messages

messagesForQuery =
  getMessagesAfterCompactBoundary(state.messages)
  -> applyToolResultBudget(...)
  -> snip / microcompact / context collapse
  -> autocompact if needed
```

而不是：

```text
只处理 history
+ 原样追加 current message
```

但“当前消息一起处理”不代表它会被随意压缩或裁剪。通常：

| 机制 | 对当前用户消息的影响 |
|---|---|
| compact boundary | 只影响旧 boundary 前消息，当前消息保留。 |
| tool result budget | 主要处理工具结果，当前普通 user message 通常不受影响。 |
| microcompact | 主要处理旧工具结果，当前普通 user message 通常不受影响。 |
| autocompact | 如果触发，会生成 summary，但应保留最近尾部，当前用户意图必须保留。 |
| provider normalize | 当前消息一定参与，例如连续 user/meta attachment 合并、content block 规范化。 |

外部系统可以这样实现：

```ts
const history = await loadDbMessages(sessionId)
const currentTurnMessages = normalizeCurrentUserInput(input)

const candidateMessages = [
  ...history,
  ...currentTurnMessages,
]

const messagesForQuery = await projectMessages(candidateMessages, {
  protectedTailMessageIds: currentTurnMessages.map(m => m.id),
})

const providerMessages = normalizeForProvider(
  prependUserContext(messagesForQuery, userContext),
)
```

这里的 `protectedTailMessageIds` 表示：当前 turn 参与整体投影，但压缩、裁剪、summary 切片时要保护它，避免模型丢失本轮用户真实意图。

#### B.9.5 当前 turn 不只是一个原始字符串

当前用户输入进入上下文前，也会先被规范化成内部消息：

```text
raw user input
  -> text user message
  -> optional attachment messages
  -> optional slash/skill command context
  -> optional file/image/resource context
```

因此，不建议把当前消息理解成“原始字符串原封追加”。更准确是：

```text
当前 turn 规范化后的内部 messages
追加到历史 transcript 后，
再一起进入投影和 provider normalization。
```

如果当前用户消息带文件引用或附件，它可能变成多条内部消息：

```ts
const currentTurnMessages = [
  createUserMessage(userText),
  createAttachmentMessage(fileContext),
  createAttachmentMessage(selectedIdeLines),
]
```

这些消息都属于本轮 protected tail，但在 provider 前仍会被 `normalizeForProvider()` 合并、渲染或过滤。

## 附录 C：后续子专题拆分指南

本附录记录本文的定位和后续 analysis 拆分边界。它不是新增源码结论，而是用于指导后续任务规划：本文负责保证 Claude Code 上下文工程主线完整，具体机制细节应拆成专题 analysis 逐步深挖。

### C.1 本文定位：总方案 / 母文档

本文是 Claude Code 上下文工程的总方案或母文档。它要回答的是：

```text
Claude Code 的上下文体系由哪些层组成，
每轮模型调用前上下文如何被投影、压缩、恢复、规范化和观测，
外部系统复现这套体系时需要哪些模块边界。
```

本文需要保持主线完整，但不追求把每个子机制写到最终实现细节。后续如果要回答“某个机制源码上到底如何做、有哪些边界条件、外部系统如何实现到可运行”，应创建或补充对应专题 analysis，并从本文链接过去。

### C.2 总文档必须保住的主线

无论后续拆出多少专题，本文都应持续维护这条总链路：

```text
Context Producers
  system prompt / system context / user context
  memory / files / attachments / skills / plan / task / MCP / hooks / settings
        |
        v
Transcript and Turn State
  raw session messages + current turn normalized messages
        |
        v
Message Projection
  compact boundary
  -> tool result budget
  -> snip / microcompact / context collapse
  -> autocompact / manual compact / session memory compact / reactive compact
        |
        v
Post-Compact Continuity
  compact summary + recent tail + restored files / skills / plan / task / hooks
        |
        v
Provider Request
  prepend user context
  -> normalize messages for API
  -> enforce tool-use/tool-result invariants
  -> system prompt / tool schema / cache options
        |
        v
Observability and Recovery
  /context, token accounting, session resume, transcript persistence
```

这条主线是本文的职责。专题 analysis 的职责是把其中某个节点拆成源码级机制、状态流、失败模式、测试计划和外部复现方案。

### C.3 子专题覆盖矩阵

如果目标是通过逐步实施专题 analysis，最终复现一个 Claude Code-like 的上下文体系，后续子专题至少应覆盖以下矩阵。

#### C.3.1 总清单与边界专题

| 子专题 | 必须回答的问题 |
|---|---|
| Context Mechanism Inventory | Claude Code 里所有会生产、修改、恢复、压缩、隐藏、观测或约束模型可见上下文的机制清单。 |
| 上下文层级与信任边界 | system prompt、system context、user context、attachment、tool result、transcript、provider messages 的职责和禁止混写边界。 |
| Agent loop state model | `State`、`messages`、`toolUseContext`、turn/recovery/compact tracking 各自保存什么，哪些属于 transcript，哪些属于 loop 控制态。 |
| agent loop 与 context pipeline 的边界 | 哪些发生在 pre-agent-loop，哪些发生在 query loop，每轮迭代中哪些状态会被推进到下一轮。 |

#### C.3.2 核心请求构建链路

| 子专题 | 必须回答的问题 |
|---|---|
| `messagesForQuery` 投影链路 | transcript 如何经过 compact boundary、tool result budget、snip、microcompact、context collapse、autocompact 变成本轮内部 API 视图。 |
| provider normalization | `normalizeMessagesForAPI()` 如何处理 attachment、连续 user message、assistant sibling、tool-use/tool-result pairing、thinking block 和 provider 协议不变量。 |
| user context / meta reminder 注入 | `CLAUDE.md`、日期和用户上下文为什么作为 meta user reminder 前置，而不是混入 system prompt 或普通 user message。 |
| system prompt / system context / cache 稳定性 | system context 如何追加到 system prompt，tool schema 和 system prompt 分块如何影响 prompt cache 稳定性。 |

#### C.3.3 Context Producers：上下文来源体系

| 子专题 | 必须回答的问题 |
|---|---|
| `CLAUDE.md` / memory 文件体系 | 发现顺序、优先级、include、条件规则、缓存、禁用开关、compact 后重新加载。 |
| attachment 总线 | typed attachment 如何被创建、去重、排序、渲染成 meta messages，以及哪些 attachment 只在特定阶段出现。 |
| synthetic file context | 文件内容如何被合成、引用、恢复，以及它和 Read/Edit/Grep/Glob 等工具状态的关系。 |
| 工具结果与文件状态 | 工具执行结果、文件读取缓存、编辑结果和后续上下文之间如何关联。 |
| Plan / Todo / task 状态 | 计划、待办、异步任务状态如何进入上下文、如何 compact 后恢复、如何避免重复注入。 |
| Skills lifecycle | skill listing、skill discovery、invoked skills、compact 后恢复、预算截断和作用域过滤。 |
| MCP context | MCP resources、MCP tools、外部服务上下文和 pending MCP servers 如何影响上下文与能力可见性。 |
| IDE / editor context | 当前文件、选区、诊断等编辑器侧上下文入口是否存在、如何注入、如何与用户显式附件区分。 |
| hooks context | hook 产物如何注入、compact 后如何恢复、信任边界如何隔离。 |
| settings / permission / model profile | 权限模式、配置、模型选择、thinking 设置、tool 可用性如何改变上下文和工具 schema。 |

#### C.3.4 Token 治理与局部压缩

| 子专题 | 必须回答的问题 |
|---|---|
| tool result storage | 大工具结果如何落盘、预览替换、resume 后如何重建 replacement state。 |
| tool result budget | 每条 API-level user message 的工具结果预算如何计算，为什么要先于 microcompact 运行。 |
| Microcompact | compactable tools、time-based microcompact、cached microcompact、cache edits、boundary message、warning suppression、状态 reset。 |
| snip compact | snip 在 microcompact 前运行的原因、如何释放 token、如何影响 autocompact threshold；具体算法以源码可见性为准。 |
| context collapse | collapse 为什么在 autocompact 前运行，如何保存 granular context；具体算法以源码可见性为准。 |

#### C.3.5 Full Compaction 家族

| 子专题 | 必须回答的问题 |
|---|---|
| manual `/compact` | 手动 compact 的入口、custom instructions、session memory compact 优先级、compact 前 microcompact。 |
| Autocompact | 阈值、buffer、禁用条件、reactive-only 抑制、context-collapse 抑制、session memory compact 优先、失败熔断。 |
| session memory compact | 外部会话记忆如何替代重复 summarization，如何选择保留尾部，如何维护 API pairing 不变量。 |
| compact conversation | summary prompt、fork summarizer、streaming summarizer、PTL retry、summary message、messagesToKeep。 |
| reactive compact | prompt-too-long 后如何恢复、与 autocompact / context collapse 的边界；具体实现以源码可见性为准。 |
| post-compact cleanup | microcompact state、memory cache、system prompt sections、classifier approvals、context collapse state 如何清理。 |

#### C.3.6 Compact 后恢复与长会话连续性

| 子专题 | 必须回答的问题 |
|---|---|
| post-compact message build | compact boundary、summary、kept messages、attachments、hook results 的顺序和语义。 |
| 文件恢复 | 最近读过的文件如何恢复，哪些文件只保留引用，memory / plan 文件为何要特殊处理。 |
| Skills 恢复 | invoked skills 如何恢复，skill listing 为什么不能无限重注入。 |
| Plan / task / async agent 恢复 | 计划文件、plan mode、task 状态、异步 agent 结果如何在 compact 后维持连续性。 |
| hook 恢复 | compact hooks / session start hooks 如何作为恢复上下文进入后续 turn。 |

#### C.3.7 会话持久化、恢复与多 agent

| 子专题 | 必须回答的问题 |
|---|---|
| transcript persistence | 原始 messages、compact boundary、summary、attachment、tool result replacement record 应如何持久化。 |
| session resume / conversation recovery | resume 后如何重建 messagesForQuery、content replacement、context collapse commits/snapshot 和 provider pairing。 |
| subagent context isolation | 子 agent / forked agent 如何继承、隔离、compact、回填上下文。 |
| background task / async task context | 后台任务、任务摘要、task status 如何影响主会话上下文。 |

#### C.3.8 可观测性与安全边界

| 子专题 | 必须回答的问题 |
|---|---|
| `/context` API view | `/context` 为什么显示投影后的 API view，而不是 raw transcript。 |
| token accounting | system、tools、MCP、memory、skills、messages、autocompact buffer、manual compact buffer 如何分类估算。 |
| context warnings | warning、error、blocking limit、autocompact threshold、compact suggestions 如何触发。 |
| prompt cache observability | cache read / cache creation / cache deletion / cache break detection 如何与 context 改写关联。 |
| context safety | memory、文件、hooks、tool result、MCP resource 如何保持不同信任层，避免伪装成用户指令或工具协议事实。 |

### C.4 推荐实施顺序

后续实施子专题时，建议按“先闭合主线，再补来源，再补压缩细节，最后补观测和恢复”的顺序推进：

1. **Context Mechanism Inventory**：先列清所有上下文机制，建立覆盖表，避免后续漏掉 microcompact、autocompact、session resume、MCP、hooks 等边界。
2. **Agent loop state model**：先规范 `State`、transcript、`toolUseContext`、turn tracking、compact/recovery flags 的边界，避免把所有上下文状态都塞进 messages。
3. **`messagesForQuery` 投影链路**：这是上下文工程中轴，确认 transcript 到内部 API view 的完整顺序。
4. **provider normalization 与协议不变量**：确保外部系统知道 `messagesForQuery` 不是最终 provider messages，避免 tool pairing 和 attachment 渲染错误。
5. **Context Producers 总表与 attachment 总线**：把 memory、files、skills、plan、task、MCP、IDE、hooks、settings 归位。
6. **tool result storage 与 tool result budget**：先解决大输出持久化和预算，因为它是 microcompact 和 full compact 的前置治理。
7. **Microcompact 专题**：单独研究 time-based 和 cached microcompact，明确它不总结对话，只治理旧工具结果和 cache edits。
8. **Autocompact 专题**：单独研究阈值、buffer、禁用条件、session memory 优先、context-collapse 抑制和失败熔断。
9. **manual compact / compact conversation / session memory compact**：补齐 full compaction 家族的 summary、保留尾部和 API invariant。
10. **post-compact restoration**：研究文件、skills、plan、task、hooks 如何恢复工作连续性。
11. **session resume / persistence / subagent context**：补齐长会话、多 agent、恢复和审计。
12. **`/context`、token accounting、warnings、cache observability**：补齐可观测性，使外部系统能解释上下文窗口构成。
13. **context collapse / snip compact / reactive compact**：这些机制受源码可见性和 feature gate 影响，先在总链路中保留边界，待源码确认后补专题细节。

### C.5 子专题完成标准

每篇子专题 analysis 完成时，至少满足：

- 明确它补的是 C.3 覆盖矩阵中的哪一格。
- 给出源码路径、关键符号、调用链、状态流或数据流。
- 说明该机制的输入、输出、状态、生命周期和与上下游专题的接口。
- 给出外部系统最小可复现设计：模块职责、核心数据结构、关键 API、测试计划。
- 明确失败模式和安全边界，尤其是 tool-use/tool-result pairing、meta context、cache 稳定性、compact 后恢复。
- 明确区分 `源码确认`、`合理推断`、`待验证`。
- 不写 `mini-cc` lesson、课程注释或 build-along walkthrough；这些属于 build-along。

### C.6 拆分原则

后续新增专题 analysis 时，遵循这些原则：

- 总文档只保主线和索引，不承载每个细机制的全部源码细节。
- 子专题必须围绕可验证机制拆分，避免按宽泛名词堆目录。
- 子专题之间允许交叉引用，但不要互相替代：例如 `messagesForQuery` 可以说明 microcompact 的位置，Microcompact 专题负责解释具体实现。
- 如果源码不可见或 feature-gated，只写已确认的调用位置、顺序和边界，把具体算法标为 `待验证`。
- 每完成一个专题，应回到本文检查主线、覆盖矩阵和链接是否需要更新。

[^1]: 
