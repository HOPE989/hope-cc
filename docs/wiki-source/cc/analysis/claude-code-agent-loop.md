# Claude Code Agent Loop 源码分析

## Learning Question / 问题

Claude Code 为什么不能只是“调用一次模型，然后打印结果”？

因为 coding agent 的工作不是只生成文本。它需要读文件、执行命令、接收报错、再继续推理。模型第一轮经常不会给最终答案，而是发出一个结构化工具请求：

```text
assistant: 我需要调用工具
```

如果没有 agent loop，人就得手动执行工具，再把结果粘回对话。Claude Code 的 loop 把这件事自动化：

```text
模型请求工具 -> harness 执行工具 -> 工具结果回填 messages -> 模型继续
```

本文要讲清楚这个闭环在源码中的位置、消息形状和模块边界。

## Scope / 范围

本文覆盖：

- `query()` / `queryLoop()` 如何形成主循环。
- `tool_use` / `tool_result` 如何驱动下一轮模型调用。
- `message / content block / streaming chunk` 的区别。
- 为什么工具执行不直接写在 `query.ts`。
- 这个机制如何约束 `mini-cc` Lesson 01 的设计。

本文不覆盖：

- `StreamingToolExecutor` 的完整并发、取消和结果排序。
- 权限 hook 的完整判定链。
- context compaction、session resume、subagent、MCP。

这些会作为后续机制单独分析。

## 解决方案 / Mental Model

Agent Loop 的核心是一条消息循环：

```text
+--------+      +------------+      +----------+
|  User  | ---> | queryLoop  | ---> |  Model   |
| prompt |      | messages[] |      |          |
+--------+      +-----+------+      +----+-----+
                     ^                  |
                     |                  |
                     |        assistant message
                     |        text + tool_use
                     |                  |
                     |                  v
                +----+------+      +----------+
                | user msg  | <--- |  Tool    |
                | tool_res  |      | execute  |
                +-----------+      +----------+

直到 assistant message 里没有 tool_use，loop 才结束。
```

关键点不是 `while (true)` 本身，而是 transcript 的形状：

```text
user: prompt
assistant: text + tool_use
user: tool_result
assistant: final text or more tool_use
```

工具请求和工具结果都不是日志。它们是 messages 的一部分，下一轮模型只能从 messages 里理解真实世界发生了什么。

## 工作原理 / Execution Flow

### 1. 用户输入先进入核心 loop

REPL、headless、SDK 入口不同，但最终都进入同一个 `query()`。

源码确认：

- `src/screens/REPL.tsx:2793`：REPL 用 `for await` 消费 `query(...)`。
- `src/QueryEngine.ts:675`：SDK / headless 也消费 `query(...)`。
- `src/query.ts:219`：`query()` 对外暴露异步生成器。

设计结论：

入口层负责交互形态、UI 状态、abort controller 和工具上下文。真正的 agent 状态推进不写在入口里，而是进入 `query.ts`。

### 2. `queryLoop()` 负责跨轮状态

`query()` 是外部接口，真正的状态机在 `queryLoop()`。

源码确认：

- `src/query.ts:241`：`queryLoop()` 是核心实现。
- `src/query.ts:307`：显式 `while (true)` 推进多轮。

这意味着一次用户请求可能经历：

```text
model -> tool -> model -> tool -> model -> done
```

设计结论：

Agent Loop 的事实源是 transcript。每轮模型调用都基于当前 messages，而不是基于某个孤立变量。

### 3. `tool_use` 是继续信号

模型不会直接执行工具。它只能在 assistant message 里返回结构化 `tool_use`：

```ts
{
  type: "tool_use",
  id: "toolu_01",
  name: "bash",
  input: {
    command: "node --version",
  },
}
```

源码确认：

- `src/query.ts:557` 附近维护 `toolUseBlocks` / `needsFollowUp`。

设计结论：

Claude Code 不是靠自然语言判断“模型是否要继续”，而是靠 assistant content 中的结构化 `tool_use`。只要存在工具请求，loop 就需要继续。

### 4. 工具执行下沉到 `services/tools`

`query.ts` 识别 `tool_use`，但不直接执行 bash、read、edit。工具执行进入服务层。

源码确认：

- `src/query.ts:1382`：工具执行进入 `runTools()` 或 `StreamingToolExecutor`。
- `src/services/tools/toolOrchestration.ts:19`：`runTools()` 是非 streaming 调度入口。
- `src/services/tools/StreamingToolExecutor.ts:40`：`StreamingToolExecutor` 处理 streaming 工具执行。
- `src/Tool.ts:158`：`ToolUseContext` 定义工具运行上下文。

设计结论：

加工具不应该改主 loop。`query.ts` 只认 `tool_use` 和 `tool_result`；工具查找、input 校验、权限、hook、执行、错误映射属于 `services/tools` 和具体工具层。

### 5. `tool_result` 作为 user message 回填

工具执行完以后，结果不是 assistant message，而是 user message 中的 `tool_result`：

```ts
{
  role: "user",
  content: [
    {
      type: "tool_result",
      tool_use_id: "toolu_01",
      content: "v22.18.0",
    },
  ],
}
```

`tool_use_id` 必须回连上一轮的 `tool_use.id`。否则模型不知道哪个工具请求得到了哪个结果。

设计结论：

这一步完成了闭环：模型发工具请求，harness 执行真实动作，再把真实结果作为用户侧事实交回模型。

## Message / Content Block / Chunk

这三个概念必须分清：

```text
message       = 对话里的一个 role 回合
content block = 一条 message 里的结构化片段
chunk         = streaming 传输中的碎片
```

所以这个数组：

```ts
[
  { type: "text", text: "我需要先观察工作区状态。" },
  {
    type: "tool_use",
    id: "toolu_01",
    name: "bash",
    input: { command: "node --version" },
  },
]
```

不是两条 message，也不是两个 chunk。它是**一条 assistant message 里的两个 content block**：

```ts
{
  role: "assistant",
  content: [
    { type: "text", text: "我需要先观察工作区状态。" },
    {
      type: "tool_use",
      id: "toolu_01",
      name: "bash",
      input: { command: "node --version" },
    },
  ],
}
```

真实 streaming 还要再低一层。模型可能先返回这些 chunk：

```text
chunk 1: text block start
chunk 2: text delta "我需要先"
chunk 3: text delta "观察工作区状态"
chunk 4: text block stop
chunk 5: tool_use block start, id/name
chunk 6: partial_json "{\"command\":"
chunk 7: partial_json "\"node --version\"}"
chunk 8: tool_use block stop
```

provider adapter 聚合后，才得到完整 `ContentBlock[]`。因此合理分层是：

```text
streaming chunk / partial_json
-> provider adapter 聚合成 ContentBlock[]
-> queryLoop 处理 tool_use
-> services/tools 执行工具
-> tool_result 回填 messages
```

`mini-cc` Lesson 01 只做协议层：mock provider 直接返回完整 `ContentBlock[]`，没有实现真实 streaming adapter。

## 追问修正点 / Comment-Driven Corrections

下面四点来自 `mini-cc` 代码里新增的补充注释。它们不只是实现备注，而是对上一版 analysis 需要补强的追问。

### 1. L01-S01 为什么变成启动交互式入口？

早期 Lesson 01 为了快速跑通闭环，曾经用 `process.argv.slice(2)` 从命令行读取一次性 prompt。第二课接入真实模型后，这个入口被收敛成持续交互式 harness：

```ts
//L01-S01 启动入口：main.ts 只负责启动 mini-cc 应用；用户消息统一从交互式提示符进入。
```

现在运行路径是：

```text
访问 npm run dev
-> node --experimental-strip-types src/main.ts
-> main.ts 启动 mini-cc >> 提示符
-> 用户输入 prompt
-> prompt 进入 QueryEngine
```

源码对应关系：

- Claude Code 的真实 CLI 在 `src/main.tsx:968` 使用 Commander 声明根命令和 `[prompt]` 参数。
- `src/main.tsx:2584` 附近处理 `--print` 非交互模式。
- `src/main.tsx:3798` 附近进入交互 REPL。
- `mini-cc/src/main.ts` 没有复刻这些分支，只保留一个交互式提示符，建立“用户输入进入 QueryEngine，再进入 agent loop”的最小可运行入口。

设计修正：

`L01-S01` 不应该被理解成某种特定 argv 解析方式。真正要保留的机制是入口边界：入口层负责启动应用、读取用户输入，然后把 prompt 交给 `QueryEngine`，不要把 agent loop 写进 CLI 入口里。

### 2. `tool_result` 为什么必须是 user message？

`mini-cc/src/query.ts` 里补了一句：

```ts
// 注意，anthropic将工具结果作为 user message
```

这句话应该进入 analysis，因为它解释的是协议边界，不是代码风格。

修正后的理解：

- assistant message 负责表达模型输出，里面可以包含 `text` 和 `tool_use`。
- harness 执行工具以后，不能把结果伪装成 assistant 自己说的话。
- 工具结果要作为 user message 里的 `tool_result` 回填，因为它代表外部世界对模型工具请求的响应。

源码确认：

- `src/query.ts:1536` 的注释说明，如果把 `tool_result` message 和普通 user message 交错，会触发 API 侧错误。
- `src/utils/attachments.ts:2460` 明确写出：`tool_use` 在 assistant content 中，`tool_result` 在 user content 中。
- `src/utils/queryHelpers.ts:52` 把“最后一条 message 是只包含 `tool_result` blocks 的 user message”作为一种特殊状态识别。

所以，`tool_result` 作为 user message 不是 mini-cc 的简化选择，而是 Anthropic message 协议和 Claude Code transcript 结构共同要求的边界。

### 3. `createMessage()` 不是“根据 prompt 生成文本”

`mini-cc/src/services/api/mockClaude.ts` 里补了：

```ts
/**
 * createMessage 是 mock 的 llm 生成结果
 * @param messages 当前的对话消息列表，包含用户消息、模型消息和工具结果消息
 */
```

这句话修正了一个容易误解的点：provider 入口不是只看最新 prompt，而是看当前 transcript。

修正后的理解：

```text
messages = user prompt
        + assistant tool_use
        + user tool_result
        + later assistant text / tool_use
```

因此，mock provider 直接返回完整 `ContentBlock[]` 只是教学简化。真实 Claude provider 还要处理 streaming chunk、partial JSON、thinking block、cache control、错误修复等 adapter 工作，但它们最后都服务于同一个目标：把“当前 messages”送给模型，并把模型输出转换成 loop 能处理的 assistant message。

### 4. `isConcurrencySafe()` 是工具调度的压力点

`mini-cc/src/Tool.ts` 里补了：

```ts
// 工具协议里还包含了 isConcurrencySafe 方法，后续课程会在并发执行工具时使用它来判断是否可以安全地并行调用工具。
```

这句话应该写进 analysis，因为它说明 `Tool` 协议不只包含 schema 和 call，还提前承载了调度策略。

源码确认：

- `src/Tool.ts:402`：真实 `Tool` 接口包含 `isConcurrencySafe(input)`。
- `src/services/tools/toolOrchestration.ts:26`：非 streaming 工具调度按 concurrency safe 分组执行。
- `src/services/tools/toolOrchestration.ts:98`：调度前会解析 input，并调用工具的 `isConcurrencySafe`。
- `src/services/tools/StreamingToolExecutor.ts:127`：streaming 工具执行器也用 concurrency safe 状态决定是否能启动下一个工具。

设计修正：

第一课的 `runTools()` 只是串行执行多个 `tool_use`，但 `Tool` 协议里保留 `isConcurrencySafe()` 是合理的。它把“工具是否可以并行”这个问题留给工具调度层，而不是塞进 `queryLoop()`。

## Reading Path / 阅读路径

本轮阅读不是从 CLI 顶层一路扫到底，而是先抓机制中心：

1. 搜索 `query`、`queryLoop`、`while (true)`，定位 `src/query.ts`。
2. 在 `src/query.ts:219` 找到 `query()`。
3. 在 `src/query.ts:241` 找到 `queryLoop()`。
4. 在 `src/query.ts:307` 看到 `while (true)`。
5. 反向找谁消费 `query()`：`src/screens/REPL.tsx:2793`、`src/QueryEngine.ts:675`。
6. 回到 `src/query.ts:557` 看 `toolUseBlocks` / `needsFollowUp`。
7. 继续追 `src/query.ts:1382`，看到工具执行进入 `runTools()` / `StreamingToolExecutor`。
8. 最后看 `src/Tool.ts:158`，确认 `ToolUseContext` 是工具运行边界。

这条路径的目的，是先确定 loop 的中枢，再解释入口层和工具层为什么要拆开。

## Discovery Log / 发现记录

1. `query()` 是异步生成器，不是返回最终字符串的函数。
2. `queryLoop()` 内部有 `while (true)`，说明一次请求可能多轮执行。
3. REPL 和 SDK / headless 都消费 `query()`，说明核心 loop 被多个入口复用。
4. `toolUseBlocks` / `needsFollowUp` 说明 `tool_use` 是继续信号。
5. 工具执行进入 `services/tools`，说明 `query.ts` 不拥有具体工具逻辑。
6. `ToolUseContext` 说明工具不是裸函数，它运行在会话上下文里。

一句话总结：

```text
入口准备上下文，queryLoop 推进 transcript，工具服务层执行副作用，tool_result 回到 transcript。
```

## Source Evidence / 源码证据

| 源码位置 | 说明 |
|---|---|
| `src/query.ts:219` | `query()` 对外暴露异步生成器。 |
| `src/query.ts:241` | `queryLoop()` 是核心状态机。 |
| `src/query.ts:307` | `while (true)` 推进多轮。 |
| `src/query.ts:557` | `toolUseBlocks` / `needsFollowUp` 判断是否继续。 |
| `src/query.ts:1382` | 工具执行进入 `runTools()` 或 `StreamingToolExecutor`。 |
| `src/main.tsx:968` | Commander 根命令声明 `[prompt]`，真实 CLI 入口比 `mini-cc` 的 argv 读取复杂。 |
| `src/screens/REPL.tsx:2793` | REPL 消费 `query()`。 |
| `src/QueryEngine.ts:675` | SDK / headless 消费 `query()`。 |
| `src/services/tools/toolOrchestration.ts:19` | `runTools()` 是工具调度入口。 |
| `src/services/tools/StreamingToolExecutor.ts:40` | streaming 工具执行器。 |
| `src/services/api/claude.ts:752` | streaming 模型查询入口。 |
| `src/Tool.ts:158` | `ToolUseContext` 定义工具运行边界。 |

## Design Reconstruction / 设计推导

Claude Code 这样拆 Agent Loop，是因为它承受三种压力。

第一，模型输出不一定是最终答案。它可能先输出 `tool_use`。没有 loop，工具结果回不到模型。

第二，入口很多。REPL 有 UI，headless 有结构化输出，SDK 有自己的消费方式。它们需要同一套 agent 行为，所以核心 loop 不能写在入口里。

第三，工具执行会变复杂。权限、hook、取消、并发、错误映射、UI 展示、context modifier 都会进入工具层。如果放进 `query.ts`，主状态机会失控。

所以边界应该是：

```text
entrypoints / REPL / QueryEngine
  prepare context

query.ts
  own loop and transcript

services/tools
  own dispatch, permission, execution, result mapping

tools/*
  own concrete side effects
```

## Key Data Structures

| 结构 | 作用 |
|---|---|
| `State` | `queryLoop()` 的跨轮状态。 |
| `AssistantMessage` | 模型输出，可能包含 text、thinking、tool_use。 |
| `ToolUseBlock` | 工具请求，核心字段是 `id`、`name`、`input`。 |
| `ToolResultBlock` | 工具结果，通过 `tool_use_id` 回连 `tool_use.id`。 |
| `ToolUseContext` | 工具执行上下文，连接 cwd、权限、AppState、MCP、abort、UI 更新等信息。 |
| `Tool.isConcurrencySafe(input)` | 工具调度策略入口，用来判断某个工具调用是否可以和其他 safe 工具并发执行。 |

## Error / Edge Paths

本轮只定位到边界，没有完整展开错误路径：

- 没有 `tool_use`：`queryLoop()` 结束或进入停止 / hook 路径。
- 有 `tool_use`：进入 `runTools()` 或 `StreamingToolExecutor`。
- 工具失败：工具层需要把错误也映射为合法 `tool_result`，避免 transcript 断裂。
- 权限拒绝：会进入 permissions / hooks 链路，后续单独分析。
- streaming 未完成：chunk 聚合、取消和结果排序需要继续精读 `StreamingToolExecutor`。
- 并发工具：`isConcurrencySafe()` 影响工具能否并行，且非 safe 工具会阻塞后续执行队列。

## Build-Along Derivation

这些源码事实约束了 `mini-cc` Lesson 01：

| Claude Code 边界 | mini-cc 对应 | 保留理由 |
|---|---|---|
| `src/query.ts` | `mini-cc/src/query.ts` | 主状态机独立，后续才能加 compact、max turns、resume。 |
| `src/main.tsx` / CLI / REPL 入口 | `mini-cc/src/main.ts` | 教学版入口启动交互式提示符，只保留入口把用户输入交给 `QueryEngine` 的边界。 |
| `src/QueryEngine.ts` / REPL | `mini-cc/src/QueryEngine.ts` | 入口包装和核心 loop 分开。 |
| `src/Tool.ts` | `mini-cc/src/Tool.ts` | 工具有 schema、call 和上下文。 |
| `src/services/api/claude.ts` | `mini-cc/src/services/api/mockClaude.ts` | provider 可替换，第一课用 mock。 |
| `src/services/tools/` | `mini-cc/src/services/tools/` | 工具查找、执行、结果映射不写进 loop。 |
| `src/tools/` | `mini-cc/src/tools/BashTool.ts` | 具体副作用工具独立。 |

`mini-cc` Lesson 01 故意不做真实 streaming。它只验证：

```text
tool_use -> run tool -> tool_result -> next model call
```

实现记录见 `docs/build-along/cc/01-agent-loop.md`。

## Verification

行为验证放在 build-along 文档中记录：`docs/build-along/cc/01-agent-loop.md`。

本轮源码分析确认：

- `query()` 是核心事件流入口。
- `queryLoop()` 是跨轮状态机。
- `tool_use` / `tool_result` 是 Agent Loop 的最小协议。
- `tool_result` 属于 user message，不是 assistant message。
- 工具执行进入 `services/tools`。
- `Tool.isConcurrencySafe()` 是工具调度层的并发判断入口。
- REPL 和 SDK / headless 复用同一个 `query()`。

## 待验证

- `StreamingToolExecutor` 的结果排序、取消、context modifier 合并。
- permission hook、pre tool hook、post tool hook 如何插入 `runToolUse()`。
- auto compact / microcompact 如何改写每轮 `messagesForQuery`。
- 工具失败、orphan tool use、max turns 等错误路径如何保持 transcript 合法。
- 真实 Claude streaming 下 `partial_json` 的完整组装时机。
- Tool Dispatcher 课程需要继续展开 `partitionToolCalls()` 和 `StreamingToolExecutor.canExecuteTool()` 的并发调度细节。
