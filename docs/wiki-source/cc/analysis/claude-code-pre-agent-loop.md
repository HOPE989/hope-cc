# Claude Code Pre-Agent Loop 源码分析：从用户提问到进入 Agent Loop 前的准备工作

## 如何阅读本文

本文是一份源码确认后的机制分析和实现指南，不是源码摘录清单。推荐按三条路径阅读：

- **快速路径**：读本节、§ Learning Question、§ Scope、§ 0 核心结论、§ 1 最小心智模型 和 § 2 端到端调用链。目标是在 20 分钟内理解 Claude Code 为什么不是“用户回车后直接进入 agent loop”。
- **实现路径**：从 § 3 REPL 提交流程 顺序读到 § 16 外部系统复现方案。目标是把同类准备阶段迁移到 IDE agent、企业工作流 agent、客服 agent、运维 agent 或低代码 agent。
- **核验路径**：重点读 § 12 `queryLoop` 前置引导、§ 13 SDK/headless 对照，以及附录 A 的源码依据表。目标是核对每个结论背后的路径、函数、状态流和边界。

本文把“进入 agent loop”的边界定义为 `src/query.ts` 中 `queryLoop()` 执行到 `while (true)` 开始的位置。交互式 REPL 会先调用 `query()`，`query()` 再进入 `queryLoop()`；`queryLoop()` 在 `while (true)` 之前还会做一小段内部引导。本文覆盖这两层准备：

1. **Host 准备**：用户输入从 REPL 或 SDK 入口进入，到调用 `query()` 之前。
2. **Loop 引导**：`query()` 进入 `queryLoop()` 后，到第一次 `while (true)` 迭代之前。

**文档地图：**

| 目标 | 主要章节 |
|---|---|
| 先建立主线 | § 0 核心结论、§ 1 最小心智模型、§ 2 端到端调用链 |
| 理解交互式用户输入 | § 3 REPL 提交流程、§ 4 并发与队列、§ 5 `handlePromptSubmit` |
| 理解输入如何变成消息 | § 6 `processUserInput`、§ 7 Attachments、§ 8 Slash / Skill / Bash 分流 |
| 理解进入 loop 前最后一道门 | § 10 `onQuery` / `onQueryImpl`、§ 11 System Prompt 与上下文 |
| 对比非交互入口 | § 13 SDK/headless QueryEngine |
| 复现到外部系统 | § 14 数据结构、§ 15 安全边界、§ 16 外部系统复现方案 |
| 核验源码依据 | 附录 A |

先记住这张最小闭环图。Claude Code 的准备阶段不是单一函数，而是一条把“用户输入”逐步变成“可交给 agent loop 的 turn”的流水线：

```text
User submit
    |
    v
REPL / SDK host gate
    |
    v
QueueGuard + CommandQueue
    |
    v
handlePromptSubmit / QueryEngine.submitMessage
    |
    v
processUserInput
    |         |             |
    |         |             v
    |         |       Slash / Skill / Bash router
    |         v
    |   Attachment collector
    v
User messages + context attachment messages
    |
    v
onQuery / onQueryImpl or QueryEngine finalization
    |
    v
System prompt + user context + system context + ToolUseContext
    |
    v
query()
    |
    v
queryLoop bootstrap
    |
    v
while (true)  <- agent loop begins
```

## Learning Question

本文回答一个可以脱离 Claude Code 源码独立使用的工程问题：

```text
当用户提交一个问题后，agent host 在真正进入 agent loop 前，
应该完成哪些输入规范化、上下文装配、命令分流、权限收敛、
hook 执行、并发保护和系统提示词准备？
```

这套准备阶段的核心价值是：

```text
把“不可信、带 UI 状态、带本地副作用、可能是命令或附件引用的用户事件”，
转换成“可审计、可排队、可权限控制、可恢复、可传入 agent loop 的 turn”。
```

如果外部系统跳过这层准备，常见后果包括：

- 同一时间多个 turn 竞争同一个会话状态。
- slash command、local command、bash command 和普通 prompt 混在一起，导致不该请求模型的输入进入模型。
- IDE 选区、文件引用、技能列表、记忆文件、任务提醒等上下文无边界地污染 prompt。
- 命令授权、model override、reasoning effort override 泄漏到后续 turn。
- 用户消息已被 UI 接受但未持久化，一旦崩溃无法恢复。
- hook 阻断、权限拒绝、附件读取失败等情况无法被表达为受控消息。

## Scope

**本文覆盖：**

- 交互式 REPL 从用户提交到调用 `query()` 前的准备工作。
- SDK/headless `QueryEngine.submitMessage()` 从 `prompt` 到调用 `query()` 前的准备工作。
- `query()` 进入 `queryLoop()` 后，到 `while (true)` 开始前的内部引导。
- `QueryGuard`、统一命令队列、`handlePromptSubmit`、`processUserInput`、attachment collector、slash/skill/bash 分流、prompt hooks、system prompt assembly 的职责边界。
- 可复现的数据结构、模块职责、失败模式、安全边界和最小实现骨架。

**本文不覆盖：**

- `while (true)` 内的一次 agent loop 迭代如何选择模型、调用工具、处理 tool result、压缩上下文或结束 turn。
- 具体模型响应流式渲染、tool dispatcher 执行、assistant message 合并等 loop 内机制。
- UI 组件视觉实现细节。
- 某个具体 feature flag 的产品策略，只在它影响准备阶段边界时说明。

## 0. 核心结论

### 0.1 一句话方案

Claude Code 在进入 agent loop 前，会先把一次用户提交转换成一个“受控 turn”：它要经过 host 层输入门禁、并发保护、队列协调、粘贴内容和附件展开、命令分流、hook 阻断、消息构造、权限与模型 override 收敛、系统提示词和上下文重建，最后才调用 `query()`；`queryLoop()` 自身还会在第一次 `while (true)` 前初始化不可变参数、依赖、会话状态、token budget tracker、query config 和相关记忆预取。

### 0.2 源码确认的主链路

交互式 REPL 主链路：

```text
src/screens/REPL.tsx:onSubmit
  -> awaitPendingHooks()
  -> handlePromptSubmit()
  -> executeUserInput()
  -> processUserInput()
  -> onQuery()
  -> onQueryImpl()
  -> query()
  -> queryLoop()
  -> while (true)
```

SDK/headless 主链路：

```text
src/QueryEngine.ts:ask()
  -> new QueryEngine(...).submitMessage()
  -> processUserInput()
  -> recordTranscript(...)
  -> buildSystemInitMessage(...)
  -> query()
  -> queryLoop()
  -> while (true)
```

### 0.3 准备阶段的关键设计点

1. **用户提交不是直接请求模型**
   REPL 的 `onSubmit` 先处理 UI 状态、remote mode、idle-return、history、stash、IDE selection、deferred SessionStart hooks，然后才把输入交给 `handlePromptSubmit`。源码入口是 `src/screens/REPL.tsx:3142-3545`。

2. **并发保护覆盖 dispatching 阶段，不只覆盖 running 阶段**
   `QueryGuard` 有 `idle`、`dispatching`、`running` 三态。`handlePromptSubmit` 在 `processUserInput` 前调用 `reserve()`，防止异步 gap 中第二个输入进入；`onQuery` 再调用 `tryStart()`。源码见 `src/utils/QueryGuard.ts:1-100`。

3. **加载中输入先进入统一命令队列**
   Claude Code 有 module-level unified command queue，用户输入、task notification、orphaned permission 都进入同一队列。队列按 `now > next > later` 排序，同优先级 FIFO。源码见 `src/utils/messageQueueManager.ts:41-193`。

4. **`handlePromptSubmit` 负责把 UI 事件变成可处理的 queued command**
   它处理 pasted text reference、image paste reference、exit/quit、本地 immediate command、loading 时排队或中断、fresh abort controller、workload 统计，最后调用 `processUserInput` 并根据结果决定是否 `onQuery`。源码见 `src/utils/handlePromptSubmit.ts:120-617`。

5. **`processUserInput` 是输入协议归一化层**
   它把 string 或 content blocks 变成 Claude Code 消息，处理 pasted images、attachments、slash command、bash mode、text prompt 和 UserPromptSubmit hooks。普通文本最终由 `processTextPrompt` 构造 user message。源码见 `src/utils/processUserInput/processUserInput.ts:85-604` 和 `src/utils/processUserInput/processTextPrompt.ts:19-99`。

6. **Attachments 是准备阶段最重要的 context patch 机制**
   `getAttachments` 会收集用户显式引用、MCP resource、agent mention、skill listing、nested memory、IDE selection、diagnostics、token usage、todo/task reminder 等，并把它们包装成 attachment messages。源码见 `src/utils/attachments.ts:743-1002`。

7. **slash / skill / bash 不一定进入 agent loop**
   local-jsx 和 local command 经常只更新 UI 或 transcript，不请求模型；bash mode 直接调用 shell tool 并把 stdout/stderr 写成 user message，通常 `shouldQuery:false`；prompt command 和 skill command 才会产生可进入 loop 的 meta prompt，并可携带 allowed tools、model、effort override。源码见 `src/utils/processUserInput/processSlashCommand.tsx:309-920` 和 `src/utils/processUserInput/processBashCommand.tsx:17-139`。

8. **turn-scoped tool authorization 必须在 `shouldQuery` gate 前写入，再由后续 turn 清理**
   REPL 的 `onQueryImpl` 会把 slash/skill 返回的 `additionalAllowedTools` 写入 `toolPermissionContext.alwaysAllowRules.command`，而且注释说明必须在 `!shouldQuery` gate 前做，避免 stale skill tools 泄漏。源码见 `src/screens/REPL.tsx:2701-2726`。

9. **进入 `query()` 前会重新构建 fresh ToolUseContext 和 system prompt**
   `onQueryImpl` 在最终调用 `query()` 前重新调用 `getToolUseContext(...)`，并并行获取 permission kill-switch、system prompt、user context、system context，然后 `buildEffectiveSystemPrompt(...)`。源码见 `src/screens/REPL.tsx:2746-2793`。

10. **`queryLoop()` 在 `while (true)` 前仍有内部引导**
    它会创建 immutable params、production deps、`State`、token budget tracker、query config，并启动相关记忆预取。源码见 `src/query.ts:219-305`，第一次 loop 迭代从 `src/query.ts:306-339` 的 `while (true)` 开始。

## 1. 最小心智模型与边界定义

### 1.1 两层边界

本文把准备阶段分成两层：

```text
Host preparation
    用户输入事件 -> 调用 query()

Loop bootstrap
    query() -> queryLoop() -> while (true) 前
```

这样划分能避免两个常见误解：

- **误解一：REPL 的 `onSubmit` 就是 agent loop 的入口。**
  源码确认不是。`onSubmit` 还会经过 `handlePromptSubmit`、`processUserInput`、`onQuery`、`onQueryImpl` 等多层准备。

- **误解二：调用 `query()` 就已经开始 loop。**
  更精确地说，REPL 在 `src/screens/REPL.tsx:2793-2803` 调用 `query()`，但真正循环体在 `queryLoop()` 的 `while (true)`。`queryLoop()` 在进入 `while` 前仍做状态初始化。

### 1.2 三类输入命运

用户提交进入准备阶段后，最终通常有三种命运：

| 命运 | 结果 | 典型来源 |
|---|---|---|
| 进入 agent loop | 产生 user/meta/attachment messages，`shouldQuery:true`，调用 `query()` | 普通 prompt、prompt slash command、skill prompt |
| 不进入 agent loop，但写入 transcript 或 UI | `shouldQuery:false`，可能更新 messages、local JSX 或 terminal output | bash mode、local command、compact boundary、本地 UI 命令 |
| 被 host 阻断或排队 | 当前不进入 `processUserInput` 或不进入 `query()` | 空输入、remote mode、idle-return、queryGuard active、hook blocking、loading queue |

### 1.3 准备阶段的核心不变量

Claude Code 准备阶段维护以下不变量：

1. **一次 turn 只能有一个 owner。**
   `QueryGuard` 和 unified command queue 保证同一会话不会同时进入多个 query。

2. **输入先规范化，再授权，再进入模型。**
   图片、附件、slash command、hook additional context 都先转成消息或受控 metadata。

3. **本地副作用和模型请求分离。**
   slash local command、local-jsx command、bash command 可以产生本地副作用，但不必请求模型。

4. **上下文在最后一刻重建。**
   `onQueryImpl` 重新获取 fresh tool context、system prompt、user context、system context，避免使用过期 MCP/tool/IDE 状态。

5. **进入 loop 的参数是完整 turn，而不是原始输入字符串。**
   `query()` 接收的是 messages、systemPrompt、userContext、systemContext、canUseTool、toolUseContext、querySource 等结构化参数。

## 2. 端到端调用链

### 2.1 交互式 REPL 链路

源码确认的交互式链路如下：

```text
src/screens/REPL.tsx:3142-3545
onSubmit(...)
    |
    | 处理 remote mode、loading immediate command、idle-return、
    | history、stash、IDE selection、pending SessionStart hooks
    v
src/utils/handlePromptSubmit.ts:120-617
handlePromptSubmit(...)
    |
    | expansion、queue、abort controller、queryGuard.reserve、
    | executeUserInput、workload tracing
    v
src/utils/processUserInput/processUserInput.ts:85-604
processUserInput(...)
    |
    | content block normalization、image paste、attachments、
    | slash/bash/text route、UserPromptSubmit hooks
    v
src/screens/REPL.tsx:2855-3024
onQuery(...)
    |
    | queryGuard.tryStart、append messages、before-query hooks、
    | turn completion cleanup
    v
src/screens/REPL.tsx:2661-2854
onQueryImpl(...)
    |
    | scoped allowed tools、fresh ToolUseContext、permission checks、
    | system prompt/user context/system context
    v
src/query.ts:219-239
query(...)
    |
    v
src/query.ts:241-305
queryLoop bootstrap
    |
    v
src/query.ts:306-339
while (true)
```

关键点是：REPL host 的准备链路比 `query()` 长很多。外部系统如果只实现“input -> model loop”，会遗漏大量安全和状态边界。

### 2.2 SDK/headless 链路

SDK/headless 不经过 REPL UI，但仍复用 `processUserInput` 和 `query()`：

```text
src/QueryEngine.ts:1186-1295
ask(...)
    |
    v
src/QueryEngine.ts:209-686
QueryEngine.submitMessage(prompt, options)
    |
    | cwd、permission wrapper、initial model、thinking config、
    | system prompt parts、noninteractive ProcessUserInputContext
    v
src/utils/processUserInput/processUserInput.ts:85-604
processUserInput(...)
    |
    | messagesFromUserInput、allowedTools、model、effort
    v
recordTranscript(messages)
    |
    | 在 API 响应前持久化已接受的用户消息
    v
buildSystemInitMessage(...)
    |
    | 告知 SDK consumer 工具、MCP、model、permissions、skills、plugins
    v
src/query.ts:219-305
query(...) -> queryLoop bootstrap
    |
    v
src/query.ts:306-339
while (true)
```

SDK/headless 的顺序和 REPL 有差异。例如 `QueryEngine.submitMessage()` 会更早获取 system prompt parts，并在调用 `query()` 前发出 system init message；REPL 则更强调 UI 队列、deferred hooks、IDE 状态和 interactive loading state。

### 2.3 两条链路的共同抽象

两条链路最后都收敛成同一个抽象：

```ts
type PreparedTurn = {
  messages: Message[];
  systemPrompt: SystemPromptBlock[];
  userContext: UserContext;
  systemContext: SystemContext;
  canUseTool: CanUseTool;
  toolUseContext: ToolUseContext;
  querySource: "primary" | "sdk" | string;
};
```

这不是源码中的完整类型定义，而是从调用参数抽象出的实现模型。源码确认 `query()` 接收这些核心字段，REPL 在 `src/screens/REPL.tsx:2789-2803` 传入，SDK/headless 在 `src/QueryEngine.ts:675-686` 传入。

## 3. REPL 提交流程：用户事件先经过 host 门禁

### 3.1 `onSubmit` 的职责边界

`src/screens/REPL.tsx:3142-3545` 的 `onSubmit` 是交互式用户输入入口。它的职责不是运行 agent，而是把一次 UI submit 事件整理成可以交给后续输入处理器的动作。

源码确认它至少处理以下事项：

| 阶段 | 源码位置 | 机制含义 |
|---|---|---|
| submit 入口和 UI 状态恢复 | `REPL.tsx:3142-3156` | repin scroll，必要时恢复 proactive loop mode |
| loading 时 immediate command | `REPL.tsx:3158-3281` | 正在 query 时，允许部分 local-jsx slash command 立即执行 |
| remote mode 空输入 | `REPL.tsx:3284-3287` | remote mode 下空输入直接返回 |
| idle-return / willow 检查 | `REPL.tsx:3289-3308` | 会话大且空闲久时可阻断当前提交并弹对话 |
| history 和 shell history | `REPL.tsx:3312-3326` | 直接用户提交写入 history，bash mode 更新 shell history cache |
| stash、清空输入、IDE selection、processing UI | `REPL.tsx:3328-3389` | 管理 UI 侧状态和当前输入镜像 |
| speculation accept | `REPL.tsx:3391-3405` | 特定分支可直接 `onQuery([], ...)` |
| remote mode 发送 | `REPL.tsx:3408-3486` | 将文本/图片发送给 remote session，本地不进入 `query()` |
| pending SessionStart hooks | `REPL.tsx:3488-3489` | 在第一 API call 前等待 deferred hook messages |
| 正常进入 `handlePromptSubmit` | `REPL.tsx:3490-3519` | 把 input、commands、context builder、messages、models、permissions 等交给后续处理 |

### 3.2 SessionStart hook 为什么在这里等待

`src/hooks/useDeferredHookMessages.ts:4-11` 说明 REPL 会先渲染，不阻塞 hook 执行；hook messages 异步注入。`REPL.tsx:1310-1313` 的注释明确指出，SessionStart hook messages 是 deferred 的，但在第一 API call 前必须可见。

因此 `onSubmit` 在 `REPL.tsx:3488-3489` 调用 `await awaitPendingHooks()`。这意味着：

- UI 可以先启动，避免打开会话时被 hooks 卡住。
- 用户第一次真正请求模型前，SessionStart 产生的上下文仍能进入 messages。
- 外部系统如果支持会话启动 hooks，也应区分“可延迟渲染”和“第一次模型请求前必须完成”。

`src/utils/sessionStart.ts:35-174` 进一步确认 SessionStart hooks 会收集 `message`、`additionalContexts`、`initialUserMessage`、`watchPaths`，其中 `additionalContexts` 会转成 `hook_additional_context` attachment message。

### 3.3 `getToolUseContext` 是 REPL 与后续处理器的桥

REPL 传给 `handlePromptSubmit` 的不是静态上下文，而是 `getToolUseContext(...)`。源码在 `src/screens/REPL.tsx:2392-2523`。

源码确认它会：

- 从当前 store 读取最新 state。
- 用 `assembleToolPool(state.toolPermissionContext, state.mcp.tools)` 和 `mergeAndFilterTools(...)` 生成可用工具集合。
- 如存在主线程 agent definition，再调用 `resolveAgentTools(...)` 收敛 agent tools。
- 返回包含 commands、tools、debug、verbose、mainLoopModel、thinkingConfig、MCP clients/resources、IDE 状态、dynamicMcpConfig、theme、agentDefinitions、customSystemPrompt、appendSystemPrompt、refreshTools 等字段的 `options`。
- 返回 getAppState/setAppState、messages/setMessages、readFileState、Tool JSX、notifications、IDE install、nested memory/dynamic skill/discovered skill sets、response length、stream mode、compact progress、in-progress tool IDs、resume、requestPrompt、contentReplacementState 等运行时能力。

外部系统实现时，不建议把这些状态一次性复制成全局变量。更稳妥的做法是像 Claude Code 一样提供一个 late-bound context builder，在进入 query 前重新获取 fresh context。

## 4. 并发与队列：准备阶段先保证 turn 所有权

### 4.1 `QueryGuard` 的三态模型

`src/utils/QueryGuard.ts:1-100` 定义了三态状态机：

```text
idle -> dispatching -> running -> idle
```

关键源码事实：

- `reserve()` 将 `idle` 改为 `dispatching`，用于用户输入已被接收但还没真正开始 query 的阶段。
- `tryStart()` 允许 `idle` 或 `dispatching` 进入 `running`，如果已经 `running` 则返回 `null`。
- `end(generation)` 只结束匹配 generation 的 running query。
- `forceEnd()` 强制恢复 idle 并递增 generation。
- `isActive` 对 `dispatching` 和 `running` 都返回 true。

这个设计解决的是一个细小但重要的问题：`processUserInput` 是异步的，若只在调用 `query()` 后才标记 running，用户可以在“输入已被接收但还没进入 query”的 gap 中再次提交，导致两个输入同时修改同一个会话状态。

### 4.2 统一命令队列

`src/utils/messageQueueManager.ts:41-51` 说明 Claude Code 使用 module-level unified command queue，所有 user input、task notification、orphaned permission 都进入同一个队列。队列优先级为：

```text
now > next > later
```

同优先级 FIFO。`enqueue(command)` 默认 priority 是 `next`，源码见 `messageQueueManager.ts:128-135`；task notification 默认 priority 是 `later`，源码见 `messageQueueManager.ts:142-149`；`dequeue(filter)` 从最高优先级、最早入队的 item 开始取，源码见 `messageQueueManager.ts:167-193`。

`src/hooks/useQueueProcessor.ts:16-60` 和 `src/utils/queueProcessor.ts:52-87` 说明队列只有在没有 active query、队列有 items、没有 local JSX UI 时才处理。队列处理还会把 slash/bash 和普通 prompt 分开：slash/bash 单独执行，普通 prompt 可按 mode 批量 drain。

### 4.3 队列与 guard 的分工

| 模块 | 负责什么 | 不负责什么 |
|---|---|---|
| `QueryGuard` | 当前是否允许开始或继续一个 query turn | 不保存待处理输入 |
| unified command queue | 保存 loading 期间或异步来源产生的命令，并按优先级处理 | 不判断 query 内部是否完成 |
| `handlePromptSubmit` | 在当前输入、loading、interruptible tool、queue 之间做决策 | 不执行 agent loop |
| `queueProcessor` | 在空闲时从队列取命令并重新走 submit pipeline | 不绕过 `processUserInput` |

外部系统复现时，应避免把“是否正在运行”和“待运行输入列表”塞进同一个布尔值或数组。Claude Code 的源码结构显示这两个职责是分开的。

## 5. `handlePromptSubmit`：把 UI 输入变成 queued command 和 messages

### 5.1 入口参数说明

`src/utils/handlePromptSubmit.ts:120-170` 是核心入口。它接收的不是单纯字符串，而是一组 host 能力：

- 原始 input、inputMode、pastedContents。
- queuedCommands，可由 queue processor 或 `nextInput` 继续触发。
- commands、debug、verbose、mainLoopModel。
- `getToolUseContext`，用于创建 `ProcessUserInputContext`。
- messages、messagesRef、setMessages、setUserInput、setToolJSX。
- queryGuard、abortController、canUseTool、ideSelection。
- onQuery、onBeforeQuery、enqueue、addToHistory、resetHistory 等回调。

这个入口设计说明：准备阶段横跨 UI、消息、队列、权限、工具上下文和查询生命周期，不能只用一个纯函数处理。

### 5.2 普通路径处理顺序

源码确认的普通路径如下：

1. **取输入与粘贴内容**
   `handlePromptSubmit.ts:172-189` 取 input、mode、pastedContents，并只保留仍被 `[Image #N]` 引用的 image paste。空输入直接返回。

2. **处理 exit/quit**
   `handlePromptSubmit.ts:190-214` 把 exit/quit 等本地退出词转换成 `/exit` 或 graceful shutdown。remote skipSlashCommands 时不会杀本地会话。

3. **展开 pasted text references**
   `handlePromptSubmit.ts:216-226` 调用 `expandPastedTextRefs(input, pastedContents)`，并记录 pasted text telemetry。

4. **loading 时处理 immediate local-jsx command**
   `handlePromptSubmit.ts:228-301` 允许某些 command 在 query 运行期间立即执行，例如 UI 侧 local-jsx 命令。执行后可更新 Tool JSX，也可 enqueue next input。

5. **loading 或 guard active 时排队或中断**
   `handlePromptSubmit.ts:304-345` 如果 queryGuard active 或 external loading，只有 prompt/bash 可排队；若有 interruptible tool，可 abort 当前 turn；随后把命令 enqueue 并清理输入 UI。

6. **正常路径创建 queued command**
   `handlePromptSubmit.ts:348-371` 调用 `startQueryProfile()`，把当前输入封装成 `QueuedCommand`，进入 `executeUserInput(...)`。

### 5.3 `executeUserInput` 的关键步骤

`src/utils/handlePromptSubmit.ts:386-617` 是真正把 queued command 转成消息并触发 query 的内部函数。

关键源码事实：

- `handlePromptSubmit.ts:386-424` 创建 fresh abort controller，调用 `setAbortController`，并用 `getToolUseContext(messages, [], abortController, mainLoopModel)` 构造上下文。
- `handlePromptSubmit.ts:426-435` 在 `processUserInput` 前调用 `queryGuard.reserve()`，进入 dispatching 状态。
- `handlePromptSubmit.ts:436-476` 初始化 `newMessages`、`shouldQuery`、`allowedTools`、`model`、`effort`、`nextInput`，并按 queued commands 计算 `turnWorkload`。
- `handlePromptSubmit.ts:478-583` 对每个 queued command 调用 `processUserInput(...)`。首个命令可携带 pasted contents、IDE selection、setUserInputOnProcessing；后续命令默认 `skipAttachments:true`。
- `handlePromptSubmit.ts:524-540` 若 file history enabled，会对 selectable user messages 做 snapshot。
- `handlePromptSubmit.ts:542-577` 若产生 `newMessages`，先 reset history、清 local JSX，再调用 `onQuery(newMessages, abortController, shouldQuery, allowedTools, model, onBeforeQuery, primaryInput, effort)`。
- `handlePromptSubmit.ts:584-599` 如果没有 newMessages，说明本地命令没有产生可查询消息，需要释放 guard、清 UI、清 abort controller。
- `handlePromptSubmit.ts:602-609` 命令返回的 `nextInput` 可 enqueue 或写回输入框。
- `handlePromptSubmit.ts:611-617` finally 中调用 `queryGuard.cancelReservation()` 并清理 `userInputOnProcessing` 作为安全网。

### 5.4 为什么 queued command 批处理只让首项带附件

`executeUserInput` 对 queued commands 批处理时，只有第一个 command 使用 pasted contents、IDE selection 和 attachments；后续 command 传 `skipAttachments: !isFirst`。

源码确认这个行为在 `handlePromptSubmit.ts:478-583`。合理推断它的目的有两点：

- 避免同一轮批量排队时重复注入 IDE selection、changed files、memory、diagnostics 等上下文。
- 让用户显式的当前输入成为主要上下文来源，后续 drained commands 更像连续文本，而不是每条都重新触发一整套上下文快照。

这属于合理推断，因为源码显示了 `skipAttachments` 的传递，但没有在该处完整解释产品意图。

## 6. `processUserInput`：输入协议归一化层

### 6.1 总体职责

`src/utils/processUserInput/processUserInput.ts:85-604` 是准备阶段的协议归一化核心。它接收：

- `input`：string 或 content blocks。
- `preExpansionInput`：展开 pasted refs 前的输入，用于保留用户原始 intent。
- `mode`：prompt / bash 等输入模式。
- `context`：工具、命令、状态、权限、MCP、IDE、hooks、messages 等能力。
- `pastedContents`、`ideSelection`、`messages`、`uuid`、`querySource`。
- `canUseTool`、`skipSlashCommands`、`bridgeOrigin`、`isMeta`、`skipAttachments`。

输出是：

```ts
type ProcessUserInputResult = {
  messages: Message[];
  shouldQuery: boolean;
  allowedTools?: string[];
  model?: string;
  effort?: string;
  command?: SlashCommand;
  nextInput?: string;
};
```

这同样是抽象形状，不是完整源码类型。源码确认 `handlePromptSubmit` 会读取这些字段，并把 `allowedTools`、`model`、`effort` 传给后续 `onQuery`。

### 6.2 Base 阶段：从输入形状到 message candidates

`processUserInput` 先调用 `processUserInputBase(...)`。源码确认的关键步骤：

1. **processing UI**
   `processUserInput.ts:141-147`：prompt mode、string input、非 meta 时，先显示 `userInputOnProcessing`。

2. **读取 app state 和 permission mode**
   `processUserInput.ts:151-171`：读取当前 app state，并把 permission mode 传入 base 处理。

3. **归一化 content blocks**
   `processUserInput.ts:281-345`：如果输入是 content blocks，image block 会 `maybeResizeAndDownsampleImageBlock`，并收集 image metadata；最后一个 text block 作为 inputString，前置 blocks 保存为 `precedingInputBlocks`。

4. **处理 pasted images**
   `processUserInput.ts:351-420`：查找有效 image paste，调用 `storeImages(pastedContents)` 持久化到磁盘，并行 resize/downsample，生成 API image content blocks，同时记录 source path、dimensions 等 metadata。

5. **remote bridge slash 安全覆盖**
   `processUserInput.ts:422-453`：当 bridgeOrigin + skipSlashCommands 同时存在时，只允许 bridge-safe command；unsafe local UI command 返回提示；未知 slash 可当普通文本。

6. **ULTRAPLAN keyword route**
   `processUserInput.ts:455-493`：特性开启、prompt mode、非 slash、非 noninteractive、未启动时，可基于 `preExpansionInput` 检测关键词并重写为 `/ultraplan ...`。

7. **提取 attachments**
   `processUserInput.ts:495-514`：非 `skipAttachments`、inputString 非空、且不是普通 slash command 时，调用 `getAttachmentMessages(inputString, context, ideSelection, [], messages, querySource)`。

8. **按输入类型分流**
   `processUserInput.ts:516-588`：bash mode 进入 `processBashCommand`；slash command 进入 `processSlashCommand`；普通 prompt 进入 `processTextPrompt`。

9. **追加 image metadata message**
   `processUserInput.ts:591-604`：如有 image metadata，再追加一条 `isMeta:true` 的 user message。

### 6.3 Text prompt 如何变成 user message

`src/utils/processUserInput/processTextPrompt.ts:19-99` 确认普通文本 prompt 的行为：

- 生成 promptId，调用 `setPromptId`，启动 interaction span。
- 记录 OTEL user_prompt 事件和 `tengu_input_prompt` telemetry。
- 检测 negative / keep-going keyword。
- 如有 pasted image content blocks，则 user message content 是文本加图片 blocks，并带 `imagePasteIds`、permissionMode、isMeta。
- 普通文本则调用 `createUserMessage({ content, permissionMode, isMeta, uuid })`。
- 最终 messages 顺序为：

```text
[userMessage, ...attachmentMessages]
```

`src/utils/messages.ts:460-543` 确认 `createUserMessage` 会创建 type 为 user、role 为 user 的消息，设置 content、uuid、timestamp、imagePasteIds、permissionMode、origin 等字段；`prepareUserContent` 会把 preceding blocks 放到最后 text block 之前。

### 6.4 UserPromptSubmit hooks 在 base 之后运行

`processUserInput.ts:174-176` 说明，如果 base 返回 `shouldQuery:false`，不会运行 UserPromptSubmit hooks。只有 base 结果准备进入模型时，才执行 hook。

`processUserInput.ts:178-264` 确认 hook 结果有三类影响：

| Hook 结果 | 行为 |
|---|---|
| blockingError | 返回 warning system message，`shouldQuery:false` |
| preventContinuation | 追加 user message，但 `shouldQuery:false` |
| additionalContexts | 转为 `hook_additional_context` attachment message |

这说明 Claude Code 把 prompt hooks 设计成“进入模型前最后的用户输入审查和上下文补充层”，而不是普通 attachment collector 的一部分。

## 7. Attachments：准备阶段的上下文补丁系统

### 7.1 Attachments 的定位

`src/utils/attachments.ts:743-1002` 的 `getAttachments(...)` 是准备阶段的上下文补丁系统。它把各种非用户正文的信息转成 attachment，再由 `getAttachmentMessages(...)` 包装成消息。

这些信息包括：

- 用户输入中显式引用的文件、MCP resource、agent mention。
- 会话状态变化，例如 date change、deferred tools delta、agent listing delta。
- 工作区上下文，例如 changed files、nested memory、dynamic skill、skill listing。
- 模式提醒，例如 plan mode、auto mode、todo/task reminder、critical reminder、compaction reminder、context efficiency。
- 主线程环境，例如 IDE selection、opened file、diagnostics、LSP diagnostics、async hook responses、token usage、budget、output token usage。

### 7.2 三类 attachments

源码结构可以整理为三类：

| 类型 | 源码位置 | 说明 |
|---|---|---|
| user input attachments | `attachments.ts:772-815` | 依赖当前用户文本，例如 `@file`、MCP resource、agent mention、turn-zero skill discovery |
| thread-safe attachments | `attachments.ts:824-941` | 可并行于主线程环境收集，例如 queued commands、date change、memory、skills、tasks、reminders |
| main-thread-only attachments | `attachments.ts:943-987` | 依赖主线程 UI 或运行状态，例如 IDE selection、diagnostics、token usage |

`attachments.ts:989-1002` 确认 thread/mainThread attachments 会并行处理并过滤空结果。

### 7.3 1 秒超时与附件降级

`attachments.ts:763-768` 创建 1000ms timeout 的 `AbortController`。这说明 attachments 是 prompt 前准备，但不能无限阻塞用户提交。外部系统应采用类似策略：

- 文件、IDE、diagnostics、MCP、memory 等上下文允许失败或超时降级。
- 附件失败不应默认中断整个用户 prompt，除非是安全策略要求阻断。
- 超时要可观测，否则用户会感知为“回车后没反应”。

### 7.4 IDE selection 和 opened file 的安全边界

`attachments.ts:1614-1644` 的 `getSelectedLinesFromIDE` 确认：

- 需要 IDE connected。
- 需要有 selection 和 filePath。
- 会调用 `isFileReadDenied`，文件被拒绝时不返回 selection attachment。

`attachments.ts:1864-1892` 的 `getOpenedFileFromIDE` 确认：

- 只有没有选中文本且存在 IDE filePath 时才考虑 opened file。
- 会先取 nested memory attachments。
- 同样受文件读取权限影响。

这说明 IDE 上下文不是“当前打开就塞进 prompt”，而是受连接状态、选择状态和权限共同约束。

### 7.5 Nested memory 的状态写入

`attachments.ts:1691-1775` 的 `memoryFilesToAttachments` 确认 nested memory 会：

- 基于 loadedNestedMemoryPaths 和 readFileState 去重。
- 把读取到的内容写入 readFileState，区分原始内容与部分内容。
- 可能触发 InstructionsLoaded hook。

这解释了为什么 attachment collector 不只是“生成 prompt 文本”。它也会更新会话级状态，影响后续文件读取、memory 去重和 hooks。

### 7.6 Skill listing 的注入条件

`attachments.ts:2638-2751` 确认 skill listing 并非无条件注入：

- 只对拥有 Skill tool 的 agent 注入。
- 会加载本地 Skill tool commands 和 MCP skills。
- skill-search 开启时会过滤 bundled/MCP。
- 按 agentId 追踪 sentSkillNames，避免重复发送。
- 格式化时受 context budget 限制。
- 最终生成 `skill_listing` attachment。

这与 skills 机制的核心原则一致：准备阶段暴露轻量索引，而不是把所有 skill 全文加入上下文。

## 8. Slash / Skill / Bash 分流：不是所有输入都请求模型

### 8.1 Slash command 的三类命运

`src/utils/processUserInput/processSlashCommand.tsx:309-920` 确认 slash command 经过解析和命令类型分流。

| 命令类型 | 行为 | 是否进入 loop |
|---|---|---|
| parse 失败 | 返回错误 user message | 否 |
| unknown slash 且像 command | 返回 “Unknown skill” | 否 |
| unknown slash 且不像 command | 退化为普通 user prompt | 是 |
| local-jsx command | load/call，更新 JSX 或 metaMessages | 视结果 |
| local command | 运行本地逻辑，常返回文本或 compact 结果 | 多数否 |
| prompt command | 生成 prompt/meta messages | 是 |
| skill prompt | 生成 skill meta message、attachments、command permissions | 是 |

`processSlashCommand.tsx:397-449` 还确认，newMessages 为空的本地命令不会查询模型，只记录 telemetry。

### 8.2 Prompt skill 如何把权限和模型 override 传给下一层

`processSlashCommand.tsx:869-920` 确认 prompt slash command 或 skill command 会：

- 调用 `command.getPromptForCommand(args, context)` 生成 command prompt。
- 允许时注册 skill hooks。
- 记录 invoked skill。
- 从 `command.allowedTools` 解析 additional allowed tools。
- 生成 user message、meta skill message、attachment messages。
- 生成 `command_permissions` attachment，包含 allowedTools 和 model。
- 返回 `shouldQuery:true`、allowedTools、model、effort、command。

注意：源码显示 processSlashCommand 负责返回 turn-scoped authorization intent；真正把 allowed tools 写入 tool permission context 的动作在 `onQueryImpl` 中执行。

### 8.3 Bash mode 是本地执行，不是 agent loop

`src/utils/processUserInput/processBashCommand.tsx:17-139` 确认 bash mode 会：

- 根据 default shell 和 PowerShell feature 选择 BashTool 或 PowerShellTool。
- 创建 `<bash-input>` user message。
- 显示 BashModeProgress UI。
- 对用户 `!` 命令调用 shell tool，且使用 `dangerouslyDisableSandbox:true`。
- 将 stdout/stderr 映射成 `<bash-stdout>`、`<bash-stderr>` user message。
- 返回 `shouldQuery:false`。
- finally 清理 Tool JSX。

因此 bash mode 的语义是“用户直接执行本地 shell，并把结果写入 transcript”，而不是让 agent 决定是否执行 shell。外部系统如果实现类似模式，应把它和 tool-use loop 严格分开。

## 9. Hooks：进入 loop 前的可阻断扩展点

### 9.1 SessionStart hook

`src/utils/sessionStart.ts:35-174` 确认 SessionStart hooks 可产生：

- 普通 message。
- additionalContexts。
- initialUserMessage。
- watchPaths。

REPL 通过 `useDeferredHookMessages` 延迟执行，但在第一次 API call 前等待。这使 SessionStart hook 同时满足“启动不阻塞 UI”和“首次模型请求前上下文完整”。

### 9.2 UserPromptSubmit hook

UserPromptSubmit hook 在 `processUserInputBase` 之后、进入 query 之前运行。它看到的是已经规范化出的 input message，而不是原始 DOM/UI 事件。

源码确认它可以：

- 阻断继续执行，返回 warning system message。
- 阻止 continuation，但保留 user message。
- 添加 additional context。

这个设计让 hook 既能作为安全门，也能作为上下文增强器。外部系统应避免让 hook 直接修改未规范化的 UI input，否则会让后续引用展开、attachment collection 和 slash routing 难以审计。

## 10. `onQuery` / `onQueryImpl`：调用 `query()` 前的最后一道门

### 10.1 `onQuery` 先确认 running 所有权

`src/screens/REPL.tsx:2855-3024` 的 `onQuery` 接收 `handlePromptSubmit` 产生的 `newMessages`、`abortController`、`shouldQuery`、`additionalAllowedTools`、model 和 effort。

源码确认：

- `REPL.tsx:2866-2886` 调用 `queryGuard.tryStart()`。如果已有 running query，会把非 meta user messages 重新 enqueue，然后返回。
- `REPL.tsx:2887-2918` 把 `newMessages` append 到 messages，reset response length、token budget snapshot、streaming tool/text，并执行 before-query callbacks。
- 如果 `onBeforeQueryCallback` 返回 false，则不继续进入 `onQueryImpl`。
- `REPL.tsx:2919-3024` finally 中调用 `queryGuard.end(thisGeneration)`、记录 completion time、resetLoadingState、执行 turn complete hooks、处理 bridge result、清 abort controller。用户取消且没有 meaningful response 时可能回滚并恢复 prompt。

这说明 `onQuery` 是 query 生命周期管理层，而不是输入解析层。

### 10.2 `onQueryImpl` 的最终准备

`src/screens/REPL.tsx:2661-2854` 的 `onQueryImpl` 是 REPL 调用 `query()` 前最后一层。

源码确认的步骤：

1. **shouldQuery 时启动 IDE diagnostic tracker 并关闭 IDE diffs**
   `REPL.tsx:2661-2672`。

2. **标记 onboarding complete**
   `REPL.tsx:2674-2675`。

3. **首条真实 user message 触发 session title**
   `REPL.tsx:2677-2699`，会跳过 synthetic breadcrumbs。

4. **写入 turn-scoped allowed tools**
   `REPL.tsx:2701-2726` 把 slash/skill scoped `additionalAllowedTools` 写入 `toolPermissionContext.alwaysAllowRules.command`。源码注释说明必须在 `!shouldQuery` gate 前执行，防止 stale skill tools 泄漏。

5. **`shouldQuery:false` 直接返回**
   `REPL.tsx:2728-2745` 处理 compact boundary 和 UI 清理，然后返回，不调用 `query()`。

6. **重新构建 fresh ToolUseContext**
   `REPL.tsx:2746-2755` 调用 `getToolUseContext(messagesIncludingNewMessages, newMessages, abortController, mainLoopModelParam)`，取得最新 tools 和 MCP clients。

7. **turn-local effort override**
   `REPL.tsx:2757-2766` 如果 skill effort override 存在，只包装 `toolUseContext.getAppState` 注入 effort，不污染 global store。

8. **并行构建上下文**
   `REPL.tsx:2767-2780` 并行执行：
   - `checkAndDisableBypassPermissionsIfNeeded(...)`
   - 特性开启时的 `checkAndDisableAutoModeIfNeeded(...)`
   - `getSystemPrompt(freshTools, mainLoopModelParam, additionalWorkingDirectories, freshMcpClients)`
   - `getUserContext()`
   - `getSystemContext()`

9. **合成最终 system prompt**
   `REPL.tsx:2781-2788` 调用 `buildEffectiveSystemPrompt(...)`，并写入 `toolUseContext.renderedSystemPrompt`。

10. **调用 `query()`**
    `REPL.tsx:2789-2803` 进入：

```ts
query({
  messages: messagesIncludingNewMessages,
  systemPrompt,
  userContext,
  systemContext,
  canUseTool,
  toolUseContext,
  querySource,
})
```

### 10.3 为什么 final context 要 late-bound

源码显示 `handlePromptSubmit` 已经构造过一次 context，但 `onQueryImpl` 仍重新调用 `getToolUseContext`。这是准备阶段的一个重要设计信号：

- 输入解析需要一个当时可用的 context。
- 进入 query 前需要最新的 tools、MCP clients、permissions、IDE 状态和 rendered system prompt。
- 两者之间可能执行 hooks、commands、queue draining、allowed tools 写入、permission mode 变化。

合理推断：Claude Code 通过 late-bound context 降低 stale context 风险，尤其是 MCP 工具变更、skill command 授权、IDE 状态和权限模式改变时。

## 11. System Prompt、User Context 与 System Context

### 11.1 `buildEffectiveSystemPrompt` 的优先级

`src/utils/systemPrompt.ts:41-123` 确认 `buildEffectiveSystemPrompt` 的优先级大致是：

```text
override
  > coordinator
  > agent prompt
  > custom system prompt
  > default prompt
```

`appendSystemPrompt` 会追加到最终 prompt，但 override 分支除外。

这说明 system prompt 不是简单字符串拼接，而是按运行模式和 agent 身份收敛的结构化决策。

### 11.2 `fetchSystemPromptParts`

`src/utils/queryContext.ts:44-74` 的 `fetchSystemPromptParts(...)` 会并行获取：

- default system prompt。
- user context。
- system context。

如果有 customSystemPrompt，则跳过 default prompt 和 systemContext。这个行为说明 custom prompt 是强覆盖，不只是追加。

### 11.3 User context

`src/context.ts:155-188` 的 `getUserContext` 会：

- 读取 CLAUDE.md / memory files，受 env 和 `--bare` 影响。
- 写入 `setCachedClaudeMdContent`。
- 返回 `claudeMd` 和 `currentDate`。

这意味着“用户上下文”不是用户消息本身，而是与项目说明、记忆文件和当前日期有关的会话上下文。

### 11.4 System context

`src/context.ts:116-149` 的 `getSystemContext` 会构建系统环境上下文，其中 git status 由 `getGitStatus` 提供。

`src/context.ts:36-111` 的 `getGitStatus` 会在 git repo 且启用 git instructions 时收集 branch、default branch、status、log、userName 等信息，并把 status 截断到 2000 字符。

这说明 git context 属于进入 loop 前的系统上下文，而不是 attachment collector 的普通文件附件。

### 11.5 Default system prompt 的动态部分

`src/constants/prompts.ts:444-576` 确认 `getSystemPrompt(tools, model, additionalWorkingDirectories, mcpClients)` 会：

- SIMPLE 模式返回最小 prompt。
- 普通模式并行获取 Skill tool commands、output style config、simple env info。
- 组装 static sections 和 dynamic sections，包括 session guidance、memory、model override、env info、language、output style、MCP instructions、scratchpad、function result clearing、summarize_tool_results 等。

`src/constants/prompts.ts:606-700` 确认 env info 会包含 working directory、是否 git repo、additional directories、platform、shell、OS、model/cutoff 等信息。

## 12. `query()` 与 `queryLoop` 前置引导

### 12.1 `query()` 是包装器

`src/query.ts:219-239` 导出 `query(params)`，内部调用 `queryLoop(params, consumedCommandUuids)`。这说明 `query()` 是外部入口，但还不是本文定义的 loop body。

### 12.2 `queryLoop()` 在 `while` 前做什么

`src/query.ts:241-305` 确认 `queryLoop(params, consumedCommandUuids)` 在第一次 `while (true)` 前会：

1. 初始化 immutable params。
2. 创建 `deps = productionDeps()`。
3. 创建 `State`，包含 messages、toolUseContext、autoCompactTracking、turnCount 等。
4. 创建 token budget tracker。
5. 调用 `buildQueryConfig()`。
6. 启动 `startRelevantMemoryPrefetch(...)`。

随后 `src/query.ts:306-339` 的 `while (true)` 才开始一次真正的 agent loop iteration。

### 12.3 这段引导的工程含义

Host 准备阶段把 turn 交给 `query()`，但 `queryLoop()` 仍需要把它转换成 loop 内部状态：

| Host 传入 | Loop 引导后 |
|---|---|
| messages | state.messages |
| toolUseContext | state.toolUseContext |
| systemPrompt/userContext/systemContext | immutable params / query config 输入 |
| canUseTool | loop 内 tool permission gate |
| querySource | loop 内 telemetry / behavior source |
| taskBudget / maxTurns | budget tracker / loop control |

外部系统复现时可以把这层看作 `LoopRuntime.prepare(preparedTurn)`：它不再解析用户输入，但负责创建 loop 内部依赖、状态和预算。

## 13. SDK/headless QueryEngine 对照

### 13.1 QueryEngine 的定位

`src/QueryEngine.ts:177-183` 注释说明 QueryEngine 把 ask 的核心逻辑抽成 class；每个 conversation 一个 engine；每个 `submitMessage()` 是一个 turn，state 持久。

这与 REPL 的差异是：REPL 状态分布在 React store、hooks、refs 和 UI callbacks 中；QueryEngine 把非交互会话状态集中在 class instance 上。

### 13.2 `submitMessage` 的准备步骤

`src/QueryEngine.ts:209-686` 确认 `submitMessage(prompt, options)` 的主要准备阶段：

1. **基本配置**
   `QueryEngine.ts:209-240` 解构 config，清 discoveredSkillNames，`setCwd(cwd)`，确定是否 persist session。

2. **权限包装**
   `QueryEngine.ts:243-271` 包装 `canUseTool`，记录 permission denials。

3. **初始 app state、model、thinking config**
   `QueryEngine.ts:273-282` 取 initialAppState，确定 initialMainLoopModel 和 initialThinkingConfig。

4. **system prompt parts**
   `QueryEngine.ts:284-325` 获取 system prompt parts，合并 coordinator userContext，处理 custom prompt、memory mechanics、appendSystemPrompt。

5. **structured output enforcement**
   `QueryEngine.ts:327-333` 在 jsonSchema + SyntheticOutput tool 时注册 structured output enforcement。

6. **构建 noninteractive ProcessUserInputContext**
   `QueryEngine.ts:335-395` 构造 context，`isNonInteractiveSession:true`，含 commands、tools、mcpClients、mainLoopModel、thinking、agentDefinitions、theme、maxBudgetUsd、readFileState、loadedNestedMemoryPaths、discoveredSkillNames 等。

7. **orphaned permission**
   `QueryEngine.ts:397-408` 处理 orphaned permission，且只处理一次。

8. **调用 `processUserInput`**
   `QueryEngine.ts:410-428` 以 mode `prompt` 调用 `processUserInput(...)`，querySource 为 `sdk`。

9. **先持久化已接受用户消息**
   `QueryEngine.ts:430-463` 把 `messagesFromUserInput` push 到 mutableMessages，并在进入 query loop 前 `recordTranscript(messages)`。这样即使 API 尚未响应，也能恢复已接受的用户输入。

10. **处理 command allowed tools**
    `QueryEngine.ts:476-486` 把 allowedTools 写入 AppState 的 `toolPermissionContext.alwaysAllowRules.command`。

11. **加载 skills/plugins 并发出 system init message**
    `QueryEngine.ts:529-551` 并行获取 slash command tool skills 和 plugins，然后 yield `buildSystemInitMessage(...)` 给 SDK consumer。

12. **`shouldQuery:false` 快速返回**
    `QueryEngine.ts:556-639` 对 local command / compact output 进行回放和持久化，yield success result 后 return。

13. **file history snapshot**
    `QueryEngine.ts:641-655` 对文件历史做 snapshot。

14. **调用 `query()`**
    `QueryEngine.ts:675-686` 传入 messages、systemPrompt、userContext、systemContext、wrappedCanUseTool、toolUseContext、fallbackModel、querySource、maxTurns、taskBudget。

### 13.3 SDK/headless 与 REPL 的差异

| 维度 | REPL | SDK/headless |
|---|---|---|
| 输入入口 | React `onSubmit` | `QueryEngine.submitMessage(prompt, options)` |
| UI 状态 | scroll、input、Tool JSX、IDE selection、loading UI | 无交互 UI，面向 stream consumer |
| 队列 | unified command queue + queue processor | class 内状态和 submitMessage 调用 |
| SessionStart | deferred hook messages，首 API call 前等待 | 由 engine/context 流程处理相关配置 |
| transcript 持久化 | messages state 与 query event 流协同 | 用户消息进入 query 前即 `recordTranscript` |
| system init | UI 内部状态 | 显式 yield `buildSystemInitMessage` |
| fresh context | `onQueryImpl` 最后一刻重建 | submitMessage 内构建 noninteractive context |

共同点是：两者都不把原始 prompt 直接交给 loop，都先经过 `processUserInput`，再调用同一个 `query()`。

## 14. 数据结构与状态流

### 14.1 Turn 准备阶段的关键对象

| 对象 | 主要来源 | 进入下一层的方式 | 说明 |
|---|---|---|---|
| `QueuedCommand` | `handlePromptSubmit`、message queue | `executeUserInput` 批处理 | 保存 value、preExpansionValue、mode、pastedContents、uuid、skipSlashCommands 等 |
| `ProcessUserInputContext` | `getToolUseContext` 或 QueryEngine 构造 | 传给 `processUserInput` | 提供 commands、tools、state、MCP、IDE、hooks、messages、permissions |
| `UserMessage` | `createUserMessage` | `newMessages` / `mutableMessages` | 表示用户正文、bash 输入、meta prompt、image metadata 等 |
| `AttachmentMessage` | `getAttachmentMessages` | 跟随 user message 进入 messages | 表示文件、memory、IDE、skill listing、hooks、diagnostics 等 context patch |
| `CommandResult` | `processSlashCommand` | `allowedTools`、model、effort、messages | prompt command 或 skill command 的 turn-scoped override 来源 |
| `ToolUseContext` | REPL `getToolUseContext` 或 QueryEngine context | 传给 `query()` 和 loop | 包含工具、状态、权限、MCP、UI/非 UI 能力 |
| `QueryParams` | `onQueryImpl` 或 QueryEngine | `query(params)` | loop 外部传入的完整 turn |
| `State` | `queryLoop` | loop 内部使用 | 持有 messages、toolUseContext、autoCompactTracking、turnCount 等 |

### 14.2 消息状态流

交互式 REPL 的消息流可以概括为：

```text
messagesRef.current
    |
    | processUserInput reads old messages for context
    v
newMessages = user/meta/attachment messages
    |
    | onQuery appends
    v
messagesIncludingNewMessages
    |
    | onQueryImpl passes to query()
    v
queryLoop state.messages
```

SDK/headless 的消息流可以概括为：

```text
this.mutableMessages
    |
    | processUserInput reads current conversation
    v
messagesFromUserInput
    |
    | push before API response
    v
recordTranscript(messages)
    |
    v
query({ messages })
```

REPL 更偏 UI 状态同步，SDK/headless 更偏可恢复 transcript。

### 14.3 准备阶段的输出契约

外部系统可以把准备阶段输出设计为：

```ts
type PreAgentLoopResult =
  | {
      kind: "query";
      messages: Message[];
      systemPrompt: SystemPromptBlock[];
      userContext: UserContext;
      systemContext: SystemContext;
      toolUseContext: ToolUseContext;
      canUseTool: CanUseTool;
      querySource: string;
      model?: string;
      effort?: string;
      budget?: Budget;
    }
  | {
      kind: "local-result";
      messages: Message[];
      uiPatch?: unknown;
      transcriptPatch?: unknown;
    }
  | {
      kind: "queued";
      queueItem: QueuedCommand;
    }
  | {
      kind: "blocked";
      reason: string;
      messages?: Message[];
    };
```

Claude Code 源码没有直接暴露这个 union，但它的准备阶段行为可映射到这四种结果。

## 15. 失败模式与安全边界

### 15.1 输入层失败或短路

| 场景 | 源码确认 | 行为 |
|---|---|---|
| 空输入 | `handlePromptSubmit.ts:172-189` | 直接返回 |
| exit/quit | `handlePromptSubmit.ts:190-214` | 转成 `/exit` 或 graceful shutdown |
| remote mode 空输入 | `REPL.tsx:3284-3287` | 直接返回 |
| remote mode 正常输入 | `REPL.tsx:3408-3486` | 发给 remote session，本地不进入 `query()` |
| idle-return | `REPL.tsx:3289-3308` | 可阻断并提示 |
| loading 且不可立即执行 | `handlePromptSubmit.ts:304-345` | enqueue 或 interrupt |

### 15.2 命令与权限安全

| 场景 | 源码确认 | 行为 |
|---|---|---|
| unsafe bridge local UI command | `processUserInput.ts:422-453` | 返回提示，不执行 unsafe command |
| skill allowed tools | `processSlashCommand.tsx:880-920`、`REPL.tsx:2701-2726` | 作为 turn-scoped command permission 写入 |
| stale skill tools | `REPL.tsx:2701-2726` | allowed tools 写入必须早于 `!shouldQuery` gate，防止泄漏 |
| bypass permissions kill-switch | `REPL.tsx:2767-2780` | 调用 `checkAndDisableBypassPermissionsIfNeeded` |
| auto mode kill-switch | `REPL.tsx:2767-2780` | 特性开启时调用 `checkAndDisableAutoModeIfNeeded` |
| IDE 文件读取拒绝 | `attachments.ts:1614-1644`、`attachments.ts:1864-1892` | 不注入 selection/opened file |

### 15.3 Hook 阻断

| Hook 结果 | 源码确认 | 行为 |
|---|---|---|
| SessionStart pending | `useDeferredHookMessages.ts:36-45`、`REPL.tsx:3488-3489` | 首次 API call 前等待 |
| UserPromptSubmit blockingError | `processUserInput.ts:178-264` | warning system message，`shouldQuery:false` |
| UserPromptSubmit preventContinuation | `processUserInput.ts:178-264` | 保留 user message，但不继续 |
| additionalContexts | `sessionStart.ts:129-174`、`processUserInput.ts:178-264` | 转成 `hook_additional_context` attachment |

### 15.4 上下文收集降级

| 场景 | 源码确认 | 行为 |
|---|---|---|
| attachments 超时 | `attachments.ts:763-768` | 1 秒 AbortController timeout |
| skill listing 预算限制 | `attachments.ts:2638-2751` | 格式化到 context budget |
| git status 太长 | `context.ts:36-111` | status 截断到 2000 字符 |
| custom system prompt | `queryContext.ts:44-74` | 跳过 default prompt 和 systemContext |

## 16. 外部系统复现方案

### 16.1 模块职责表

| 模块 | 应该做什么 | 不应该做什么 |
|---|---|---|
| `InputHost` | 接收 UI/SDK 输入，处理 remote/empty/exit/history/selection 等 host 状态 | 不直接请求模型 |
| `TurnGuard` | 管理 idle/dispatching/running，防止同会话并发 turn | 不保存完整队列 |
| `CommandQueue` | 保存 loading 期间和异步来源产生的命令，按优先级 drain | 不绕过输入规范化 |
| `PromptSubmitter` | 展开 paste refs，处理 immediate command、abort、queue、fresh abort controller | 不解析所有附件细节 |
| `InputNormalizer` | 规范化 string/content blocks/images，构造 user message | 不访问最终 system prompt |
| `AttachmentCollector` | 生成文件、IDE、memory、skill、diagnostics 等 context patches | 不无限阻塞用户提交 |
| `CommandRouter` | 区分 slash/local-jsx/local/prompt/skill/bash，返回 shouldQuery 和 overrides | 不把本地副作用混入 agent loop |
| `HookRunner` | 运行 SessionStart、UserPromptSubmit 等可阻断 hook | 不直接修改原始 UI input |
| `ContextAssembler` | 最后一刻重建 tools、permissions、system prompt、user context、system context | 不复用陈旧 tool registry |
| `LoopInvoker` | 把 PreparedTurn 传给 agent loop runtime | 不再做用户输入解析 |
| `LoopBootstrap` | 创建 loop 内 state、deps、budget、config、prefetch | 不执行 host 侧 UI 逻辑 |

### 16.2 最小可用闭环

```ts
async function submitUserTurn(input: HostInput): Promise<TurnOutcome> {
  const hostDecision = await inputHost.accept(input);
  if (hostDecision.kind !== "continue") return hostDecision;

  if (!turnGuard.reserve()) {
    commandQueue.enqueue(hostDecision.command);
    return { kind: "queued" };
  }

  try {
    const abortController = new AbortController();
    const submitContext = contextFactory.forInput(abortController);

    const normalized = await inputNormalizer.process({
      command: hostDecision.command,
      context: submitContext,
      skipAttachments: false,
    });

    if (normalized.messages.length === 0) {
      return { kind: "local-result", messages: [] };
    }

    const generation = turnGuard.tryStart();
    if (generation == null) {
      commandQueue.enqueue(hostDecision.command);
      return { kind: "queued" };
    }

    try {
      transcript.append(normalized.messages);

      if (!normalized.shouldQuery) {
        return { kind: "local-result", messages: normalized.messages };
      }

      const finalContext = await contextAssembler.build({
        messages: transcript.messages(),
        newMessages: normalized.messages,
        abortController,
        allowedTools: normalized.allowedTools,
        model: normalized.model,
        effort: normalized.effort,
      });

      return await loopInvoker.invoke(finalContext);
    } finally {
      turnGuard.end(generation);
    }
  } finally {
    turnGuard.cancelReservation();
  }
}
```

这个骨架保留了 Claude Code 源码中最关键的顺序：

```text
reserve before async input processing
  -> normalize input and commands
  -> tryStart before final query lifecycle
  -> append messages
  -> shouldQuery gate
  -> late-bound final context
  -> invoke loop
```

### 16.3 实现优先级建议

如果从零实现，建议按以下 MVP 顺序：

1. `TurnGuard` 三态并发保护。
2. `InputNormalizer` 支持普通文本 user message。
3. `ContextAssembler` 生成基础 system prompt、user context、system context。
4. `LoopInvoker` 调用 agent loop。
5. `CommandQueue` 支持 loading 时排队。
6. `AttachmentCollector` 支持文件引用和 IDE selection，并加超时。
7. `CommandRouter` 支持 local command、prompt command、bash mode。
8. `HookRunner` 支持 prompt submit 阻断和 additional context。
9. turn-scoped allowed tools、model、effort override。
10. SDK/headless transcript pre-write 和 system init event。

## 17. 源码确认、合理推断与待验证

### 17.1 源码确认

本文以下结论由源码路径直接支撑：

- REPL `onSubmit` 不是 agent loop，它会在调用 `handlePromptSubmit` 前处理 UI、remote、history、SessionStart hooks 等准备工作。
- `QueryGuard` 有 idle/dispatching/running 三态，dispatching 也算 active。
- `handlePromptSubmit` 在 `processUserInput` 前 reserve queryGuard，并在 finally 中 cancel reservation。
- `processUserInput` 负责 content blocks、pasted images、attachments、slash/bash/text 分流和 UserPromptSubmit hooks。
- Attachments 被分成 user input、thread-safe、main-thread-only 三组收集。
- Slash/skill command 可返回 allowedTools、model、effort，并由 `onQueryImpl` 写入 command permission scope。
- Bash mode 执行 shell tool 后返回 `shouldQuery:false`。
- `onQueryImpl` 在调用 `query()` 前重新构建 fresh ToolUseContext 和 system prompt。
- `queryLoop()` 在 `while (true)` 前初始化 state、deps、token budget tracker、query config 和 memory prefetch。
- SDK/headless QueryEngine 复用 `processUserInput`，并在进入 query 前持久化已接受用户消息。

### 17.2 合理推断

以下结论是基于源码结构、命名、调用顺序和注释的工程推断：

- queued commands 只有首项带附件，是为了避免批量 drain 时重复注入 IDE、memory、diagnostics 等上下文。
- `onQueryImpl` late-bound ToolUseContext 的主要目的，是降低 MCP/tool/IDE/permission 状态在异步准备阶段变陈旧的风险。
- `queryLoop` 前的 memory prefetch 是为了让 loop 内相关记忆可更快使用，但不阻断 host 输入解析。
- SDK/headless 的 `recordTranscript` 前置，是为了在 API 响应前崩溃时仍能恢复用户已提交消息。

这些推断与源码事实一致，但如果需要写入更强产品语义，应继续搜索设计注释或运行实验验证。

### 17.3 待验证

以下行为需要实验或更深源码阅读才能完全确认：

- 各 feature flag 组合下，ULTRAPLAN、proactive loop、auto mode、remote bridge 的所有交互边界。
- Attachments timeout 后具体哪些 warning 会暴露给用户，哪些只进入 telemetry。
- 不同 slash command 类型在 local-jsx UI 出错时的完整恢复路径。
- QueryEngine 在长期多 turn 会话中 readFileState、loadedNestedMemoryPaths、discoveredSkillNames 的累积与清理策略。

## 18. 验证与测试计划

### 18.1 本文源码核验方法

本文基于以下源码入口交叉核验：

- `src/screens/REPL.tsx`：交互式提交流程、ToolUseContext、onQuery/onQueryImpl。
- `src/utils/handlePromptSubmit.ts`：输入提交、队列、guard、processUserInput 调用。
- `src/utils/QueryGuard.ts`：并发状态机。
- `src/utils/messageQueueManager.ts`、`src/hooks/useQueueProcessor.ts`、`src/utils/queueProcessor.ts`：统一队列。
- `src/utils/processUserInput/processUserInput.ts`：输入规范化和分流。
- `src/utils/processUserInput/processTextPrompt.ts`：普通文本消息构造。
- `src/utils/processUserInput/processSlashCommand.tsx`：slash/skill command。
- `src/utils/processUserInput/processBashCommand.tsx`：bash mode。
- `src/utils/attachments.ts`：attachment collector。
- `src/utils/sessionStart.ts`、`src/hooks/useDeferredHookMessages.ts`：SessionStart hooks。
- `src/utils/queryContext.ts`、`src/utils/systemPrompt.ts`、`src/context.ts`、`src/constants/prompts.ts`：system/user/system context。
- `src/QueryEngine.ts`：SDK/headless 对照。
- `src/query.ts`：`query()` 和 `queryLoop()` 引导。

### 18.2 外部系统测试计划

如果复现这套机制，建议至少覆盖以下测试：

| 测试 | 期望 |
|---|---|
| 普通 prompt | 生成 user message 和必要 attachments，调用 loop |
| 空输入 | 不产生消息，不调用 loop |
| loading 时提交 prompt | enqueue，当前 loop 不被并发打断 |
| loading 时可立即执行 local command | 执行 local command，不进入 loop |
| prompt submit hook blocking | 生成阻断消息，`shouldQuery:false` |
| hook additional context | 追加 attachment message，继续 loop |
| slash prompt command | 生成 meta prompt，携带 allowedTools/model/effort |
| local slash command | 更新 UI 或 transcript，不调用 loop |
| bash mode | 执行 shell，写 stdout/stderr message，不调用 loop |
| IDE selection 被权限拒绝 | 不注入 selected lines attachment |
| attachment collector 超时 | prompt 可降级继续或按策略阻断 |
| allowedTools 不泄漏 | 当前 turn 后后续普通 prompt 不继承 command-scoped tools |
| SDK submit 崩溃恢复 | 用户消息在 API 响应前已持久化 |
| `queryLoop` bootstrap | loop state、budget、config 在第一次 iteration 前存在 |

## 附录 A：源码依据表

| 主题 | 源码位置 | 关键符号 / 函数 | 源码事实 |
|---|---|---|---|
| REPL 提交入口 | `src/screens/REPL.tsx:3142-3545` | `onSubmit` | 用户提交先经过 UI、remote、history、hooks、handlePromptSubmit |
| deferred SessionStart | `src/hooks/useDeferredHookMessages.ts:4-45` | `useDeferredHookMessages` | REPL 不阻塞初始渲染，但首 API call 前等待 pending hook messages |
| SessionStart hook | `src/utils/sessionStart.ts:35-174` | `processSessionStartHooks` | 收集 message、additionalContexts、initialUserMessage、watchPaths |
| ToolUseContext | `src/screens/REPL.tsx:2392-2523` | `getToolUseContext` | 组装 commands、tools、MCP、IDE、state、permissions、system prompt options |
| 并发 guard | `src/utils/QueryGuard.ts:1-100` | `QueryGuard` | idle/dispatching/running 三态，dispatching 也 active |
| 统一队列 | `src/utils/messageQueueManager.ts:41-193` | `enqueue`、`dequeue` | 所有 command queue items 按 now/next/later 和 FIFO 处理 |
| 队列处理 | `src/hooks/useQueueProcessor.ts:16-60`、`src/utils/queueProcessor.ts:52-87` | `processQueueIfReady` | 空闲且无 local JSX UI 时 drain queue |
| submit 入口 | `src/utils/handlePromptSubmit.ts:120-170` | `handlePromptSubmit` | queuedCommands 可跳过普通 UI 输入校验，直接 executeUserInput |
| pasted refs / exit / queue | `src/utils/handlePromptSubmit.ts:172-345` | `expandPastedTextRefs`、`enqueue` | 处理空输入、exit、pasted text、loading command、排队和中断 |
| executeUserInput | `src/utils/handlePromptSubmit.ts:386-617` | `executeUserInput` | fresh abort controller、queryGuard.reserve、processUserInput、onQuery |
| 输入规范化入口 | `src/utils/processUserInput/processUserInput.ts:85-176` | `processUserInput` | 接收 input/context，base 返回 shouldQuery false 时不跑 UserPromptSubmit hooks |
| content blocks / images | `src/utils/processUserInput/processUserInput.ts:281-420` | `processUserInputBase` | 归一化 blocks、resize/downsample images、storeImages |
| bridge slash / attachments / routes | `src/utils/processUserInput/processUserInput.ts:422-604` | `processUserInputBase` | safe bridge slash、ULTRAPLAN route、attachments、bash/slash/text 分流、image metadata |
| text prompt | `src/utils/processUserInput/processTextPrompt.ts:19-99` | `processTextPrompt` | 生成 user message，messages 顺序为 user message 后跟 attachments |
| user message | `src/utils/messages.ts:460-543` | `createUserMessage`、`prepareUserContent` | 构造 role=user message，支持 preceding blocks、uuid、timestamp、permissionMode |
| attachments 总入口 | `src/utils/attachments.ts:743-1002` | `getAttachments`、`getAttachmentMessages` | 收集 user input、thread-safe、main-thread-only attachments |
| IDE selection | `src/utils/attachments.ts:1614-1644` | `getSelectedLinesFromIDE` | IDE connected、selection、filePath、read permission 都满足才注入 |
| opened file | `src/utils/attachments.ts:1864-1892` | `getOpenedFileFromIDE` | 无 selection 且允许读取时注入 opened file，并可触发 nested memory |
| nested memory | `src/utils/attachments.ts:1691-1775` | `memoryFilesToAttachments` | 去重、写 readFileState、可能触发 InstructionsLoaded hook |
| skill listing | `src/utils/attachments.ts:2638-2751` | skill listing collector | 只对有 Skill tool 的 agent 注入，按 agentId 去重，受 context budget 限制 |
| slash command | `src/utils/processUserInput/processSlashCommand.tsx:309-920` | `processSlashCommand` | parse、unknown、local-jsx、local、prompt、skill command 分流 |
| skill prompt | `src/utils/processUserInput/processSlashCommand.tsx:869-920` | `getMessagesForPromptSlashCommand` | 生成 meta prompt、attachments、command_permissions、allowedTools/model/effort |
| bash mode | `src/utils/processUserInput/processBashCommand.tsx:17-139` | `processBashCommand` | 调 shell tool，写 bash input/stdout/stderr messages，`shouldQuery:false` |
| onQuery | `src/screens/REPL.tsx:2855-3024` | `onQuery` | tryStart、append messages、before query hooks、finally cleanup |
| onQueryImpl | `src/screens/REPL.tsx:2661-2854` | `onQueryImpl` | allowedTools、shouldQuery gate、fresh ToolUseContext、system prompt、query() |
| query context | `src/utils/queryContext.ts:44-74` | `fetchSystemPromptParts` | 并行取 default prompt/user context/system context，custom prompt 跳过部分默认项 |
| effective prompt | `src/utils/systemPrompt.ts:41-123` | `buildEffectiveSystemPrompt` | override/coordinator/agent/custom/default 优先级，append prompt 追加 |
| user/system context | `src/context.ts:36-188` | `getGitStatus`、`getSystemContext`、`getUserContext` | git、memory、date、system env 等进入上下文 |
| default system prompt | `src/constants/prompts.ts:444-700` | `getSystemPrompt`、`computeEnvInfo` | 默认 prompt 包含 tools、skills、env、language、MCP、output style 等动态项 |
| SDK QueryEngine | `src/QueryEngine.ts:177-686` | `QueryEngine.submitMessage` | 非交互入口，构造 context、processUserInput、recordTranscript、query() |
| SDK ask wrapper | `src/QueryEngine.ts:1186-1295` | `ask` | 一次性创建 QueryEngine 并调用 submitMessage |
| query wrapper | `src/query.ts:219-239` | `query` | 包装 `queryLoop(params, consumedCommandUuids)` |
| queryLoop bootstrap | `src/query.ts:241-305` | `queryLoop` | 初始化 params、deps、state、token budget tracker、query config、memory prefetch |
| agent loop 开始 | `src/query.ts:306-339` | `while (true)` | 第一次真正 loop iteration 从这里开始 |
