# ✅Claude Code Agent Loop：让模型的 tool_use 变成真实动作

这一节是 `project-cc` 的第一课，也是整个 Claude Code-like coding agent 最重要的底座：**Agent Loop**。

很多人在实现智能体时，第一反应是写一个很简单的流程：

```text
用户输入
  ↓
调用模型
  ↓
打印模型回答
```

这能做聊天机器人，但做不了 Claude Code 这样的 coding agent。原因很简单：coding agent 的价值不只是“回答”，而是能读文件、执行命令、观察结果、继续推理、再修改代码。模型本身不会真的执行命令，它只能表达“我想调用某个工具”。真正把这个想法变成动作的，是模型外面的 harness。

所以 Agent Loop 要解决的问题是：

```text
模型提出工具请求
  ↓
harness 执行真实工具
  ↓
工具结果写回对话
  ↓
模型基于结果继续推理
```

这一节我做的事情，就是从 Claude Code 源码里拆出这个最小闭环，并在 `mini-cc` 里实现一个可运行的教学版。

## 为什么第一课必须先做 Agent Loop？

Claude Code 后面所有能力都依赖这个 loop。

比如：

- Tool Dispatcher：模型发出 `read_file`、`write_file`、`bash`，谁来找到对应工具并执行？
- Permission：模型想执行危险命令，谁来判断是否允许？
- Context Compaction：多轮工具结果撑爆上下文后，谁来压缩 transcript？
- Session Resume：会话恢复时，如何保证 `tool_use` 和 `tool_result` 仍然配对？
- Streaming：模型的工具参数是 chunk 形式返回时，谁来聚合？
- Subagent：子 agent 其实也是一条独立 loop。

如果第一课把所有逻辑都塞进 `main.ts`，后面加这些机制时一定会推倒重来。因此这一节即使功能很小，也要先把边界立住。

## Claude Code 源码里看到的核心结构

这次读源码不是从 CLI 顶层一路扫到底，而是先找 loop 的中心。

最关键的入口在 `src/query.ts`：

- `src/query.ts:219`：`query()` 对外暴露核心事件流。
- `src/query.ts:241`：`queryLoop()` 是真正推进状态的函数。
- `src/query.ts:307`：内部有显式 `while (true)`，说明一次用户输入可能触发多轮模型调用。
- `src/query.ts:557`：`toolUseBlocks` / `needsFollowUp` 用来判断是否需要继续下一轮。
- `src/query.ts:1382`：工具执行进入 `runTools()` 或 `StreamingToolExecutor`，而不是直接写在主 loop 里。

然后再看谁在消费这条 loop：

- `src/screens/REPL.tsx:2793`：交互式 REPL 通过 `for await` 消费 `query()`。
- `src/QueryEngine.ts:675`：SDK / headless 路径也消费同一个 `query()`。

这说明 Claude Code 的核心 agent 行为没有写死在 REPL 里。REPL、headless、SDK 只是不同入口，真正的状态推进都进入 `query()` / `queryLoop()`。

工具层则继续下沉：

- `src/services/tools/toolOrchestration.ts:19`：`runTools()` 是非 streaming 工具调度入口。
- `src/services/tools/StreamingToolExecutor.ts:40`：streaming 工具执行有单独 executor。
- `src/Tool.ts:158`：`ToolUseContext` 定义工具执行上下文。
- `src/Tool.ts:402`：工具接口包含 `isConcurrencySafe(input)`，说明工具协议不仅有执行函数，还会影响并发调度。

最终能重建出一个边界：

```text
入口层：REPL / headless / SDK / CLI
  负责读取输入、准备上下文、消费事件

query.ts
  负责 transcript、模型调用、tool_use 判断、多轮推进

services/tools
  负责工具查找、校验、权限、并发、执行、错误映射

tools/*
  负责具体副作用，比如 bash、读文件、写文件、编辑文件
```

这个边界是 `mini-cc` 第一课的实现依据。

## 最小消息协议：tool_use 和 tool_result

Agent Loop 的核心不是 `while (true)`，而是 messages 的形状。

一个最小工具调用流程大概是这样：

```ts
{
  role: "user",
  content: "show node version",
}
```

模型第一轮不会直接回答，而是返回一条 assistant message：

```ts
{
  role: "assistant",
  content: [
    {
      type: "text",
      text: "我需要先观察工作区状态，所以调用 bash 工具。",
    },
    {
      type: "tool_use",
      id: "toolu_01",
      name: "bash",
      input: {
        command: "node --version",
      },
    },
  ],
}
```

这里有一个容易混淆的点：这不是两条 message，也不是两个 streaming chunk。它是一条 assistant message，里面有两个 content block。

三个概念要分开：

```text
message       = 对话里的一个 role 回合
content block = 一条 message 里的结构化片段
chunk         = streaming 传输中的碎片
```

真实 streaming 下，模型可能先返回 text delta，再返回 tool_use block start，再一点点返回 `partial_json`，最后 block stop。provider adapter 要先把这些 chunk 聚合成完整 content block，`queryLoop()` 才能处理。

`mini-cc` 第一课先不做真实 streaming。为了把主协议讲清楚，`MockClaudeProvider` 直接返回完整 `ContentBlock[]`。

## 为什么 tool_result 是 user message？

工具执行完以后，结果不是 assistant message，而是 user message 里的 `tool_result`：

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

这点一开始很容易误解。直觉上会觉得“工具是系统执行的，为什么放在 user message 里？”但从协议角度看，assistant message 是模型自己说的话；工具结果是外部世界对模型请求的反馈，应该作为用户侧 observation 回填。

源码里也能看到这个边界：

- `src/utils/attachments.ts:2460` 明确写着 `tool_use` 在 assistant content，`tool_result` 在 user content。
- `src/utils/queryHelpers.ts:52` 会识别“最后一条 user message 只包含 tool_result blocks”的状态。
- `src/query.ts:1536` 附近有注释说明，`tool_result` message 和普通 user message 的交错顺序会影响 API 合法性。

因此，`tool_result` 作为 user message 不是教学版的随意设计，而是 Anthropic message 协议和 Claude Code transcript 结构共同要求的边界。

## mini-cc 第一课的实现结构

为了复现这个闭环，我在 `mini-cc` 中保留了几个最小模块。

```text
mini-cc/src/
├── main.ts
├── QueryEngine.ts
├── query.ts
├── types.ts
├── Tool.ts
├── tools.ts
├── services/
│   ├── api/
│   │   └── mockClaude.ts
│   └── tools/
│       ├── toolExecution.ts
│       └── toolOrchestration.ts
└── tools/
    └── BashTool.ts
```

### main.ts：最小 CLI 入口

`main.ts` 只负责读取命令行参数，然后创建 `QueryEngine`：

```ts
const prompt = process.argv.slice(2).join(" ") || "List files in the current workspace";
```

这里还有一个小细节：运行

```powershell
npm run lesson:01 -- "列出目录"
```

中间的 `--` 是 npm 的参数分隔符，不会传给 Node。真实执行近似于：

```text
node --experimental-strip-types src/main.ts 列出目录
```

所以 `process.argv.slice(2)` 拿到的就是用户输入。

但这只是教学版入口。Claude Code 真实 CLI 在 `src/main.tsx:968` 使用 Commander 声明 `[prompt]`，还要处理 `--print`、REPL、resume、settings、tools、permission mode 等大量分支。第一课保留的是“入口层读取输入后交给 QueryEngine”的边界，而不是复刻完整 CLI。

### QueryEngine.ts：入口包装

`QueryEngine` 的作用是把启动入口和核心 loop 分开。它准备 provider、tools、cwd，然后用 `for await` 消费 `query()` 返回的事件。

这个设计对应 Claude Code 中 REPL / headless 在进入 `query()` 前准备上下文的边界。第一课只保留 `cwd`，后续可以继续加入权限、session、MCP、hooks。

### query.ts：主状态机

`query.ts` 是第一课最核心的文件。它维护一个简单状态：

```ts
type QueryState = {
  messages: Message[];
  turnCount: number;
};
```

每轮执行逻辑是：

```text
检查 maxTurns
  ↓
把当前 messages 和 tools 发给 provider
  ↓
把 assistant message 写回 transcript
  ↓
检查 assistant content 里有没有 tool_use
  ↓
没有 tool_use：结束
  ↓
有 tool_use：调用 runTools()
  ↓
把 tool_result 作为 user message 写回 transcript
  ↓
进入下一轮
```

这就是 `tool_use -> run tool -> tool_result -> next model call` 的最小闭环。

### types.ts：消息协议

`types.ts` 定义了第一课需要的三类 content block：

- `text`
- `tool_use`
- `tool_result`

也定义了 `QueryEvent`：

- `assistant`
- `tool_result`
- `done`

这不是为了写类型而写类型，而是为了让“消息协议”和“事件流”成为显式边界。后续接真实 streaming 时，事件类型会继续扩展。

### Tool.ts：工具协议

工具不是裸函数。第一课的 `Tool` 至少包含：

- schema：暴露给模型，让模型知道工具叫什么、需要什么参数。
- `call(input, context)`：真正执行工具。
- `isConcurrencySafe(input)`：后续判断是否可以并行执行。

`isConcurrencySafe()` 在第一课还没有发挥作用，但 Claude Code 源码里已经有这个压力点：

- `src/services/tools/toolOrchestration.ts:26` 会按 concurrency safe 分组。
- `src/services/tools/toolOrchestration.ts:98` 会在解析 input 后调用工具的 `isConcurrencySafe`。
- `src/services/tools/StreamingToolExecutor.ts:127` 会根据当前并发状态决定能否启动下一个工具。

所以我在 `mini-cc` 的工具协议里提前保留这个接口，避免后续 Tool Dispatcher 课程再改协议。

### mockClaude.ts：确定性的模型替身

第一课没有接真实模型，而是写了一个 deterministic mock provider。

它的行为很简单：

1. 如果当前 messages 里还没有 `tool_result`，就返回一个 `bash` 的 `tool_use`。
2. 如果最后一条 user message 里已经有 `tool_result`，就输出最终文本，结束 loop。

关键点是 `createMessage()` 接收的是当前完整 `messages`，不是只看最新 prompt。

这对应真实 provider 的基本形态：每一轮模型调用都基于当前 transcript。真实 Claude provider 还会处理 streaming chunk、partial JSON、thinking block、cache control、错误修复等复杂逻辑，但这些都可以放到后续课程。

### services/tools：工具执行和调度

工具服务层拆成两个文件：

- `toolExecution.ts`：执行单个 tool use。
- `toolOrchestration.ts`：调度多个 tool use。

第一课只做串行调度：

```text
for each tool_use:
  runToolUse()
```

单工具执行做三件事：

1. 按 `tool_use.name` 找具体工具。
2. 调用工具的 `call(input, context)`。
3. 把输出映射成 `tool_result`，并写入原始 `tool_use.id`。

这样 `query.ts` 不需要知道 BashTool 的实现细节，只依赖工具调度层。

### BashTool.ts：第一个具体工具

第一课只实现一个 `bash` 工具，用来证明模型请求可以变成真实系统动作。

它做了两件事：

- 执行 shell 命令。
- 做最小危险命令拦截。

这个安全检查还很粗糙，后续应该拆到 Permission / Tool Safety 课程中。但第一课先把这个意识放进去：工具不是随便执行，真实 coding agent 必须有权限边界。

## L01 注释驱动阅读路径

`mini-cc` 第一课的代码里使用 `L01-Sxx` 注释组织阅读顺序。

| Step | 文件 | 作用 |
|---|---|---|
| L01-S01 | `mini-cc/src/main.ts` | 从 CLI 读取 prompt。 |
| L01-S02 | `mini-cc/src/main.ts` | 创建 `QueryEngine`，注入 provider、tools、cwd。 |
| L01-S03 | `mini-cc/src/main.ts` | 提交 user message。 |
| L01-S04 | `mini-cc/src/QueryEngine.ts` | 准备 `query()` 上下文。 |
| L01-S05 | `mini-cc/src/QueryEngine.ts` | 用 `for await` 消费 query events。 |
| L01-S06 | `mini-cc/src/types.ts` | 定义 `text`、`tool_use`、`tool_result`。 |
| L01-S07 | `mini-cc/src/types.ts` | 定义 query events。 |
| L01-S08 | `mini-cc/src/Tool.ts` | 定义 `ToolUseContext`。 |
| L01-S09 | `mini-cc/src/Tool.ts` | 定义 tool schema、call、concurrency flag。 |
| L01-S10 | `mini-cc/src/tools.ts` | 注册默认工具。 |
| L01-S11 | `mini-cc/src/query.ts` | 暴露 async generator `query()`。 |
| L01-S12 | `mini-cc/src/query.ts` | 初始化 messages 和 turn count。 |
| L01-S13 | `mini-cc/src/query.ts` | 添加 max-turn guard。 |
| L01-S14 | `mini-cc/src/query.ts` | 把当前 messages 和 tools 发给 provider。 |
| L01-S15 | `mini-cc/src/query.ts` | 追加 assistant message 并 yield event。 |
| L01-S16 | `mini-cc/src/query.ts` | 没有 `tool_use` 时停止。 |
| L01-S17 | `mini-cc/src/query.ts` | 将工具执行委托给 `runTools()`。 |
| L01-S18 | `mini-cc/src/query.ts` | 将 `tool_result` 作为 user message 追加。 |
| L01-S19 | `mini-cc/src/services/api/mockClaude.ts` | 看到 tool results 后结束工具循环。 |
| L01-S20 | `mini-cc/src/services/api/mockClaude.ts` | 生成第一轮 `bash` tool use。 |
| L01-S21 | `mini-cc/src/services/tools/toolExecution.ts` | 按 `tool_use.name` 查找工具。 |
| L01-S22 | `mini-cc/src/services/tools/toolExecution.ts` | 把工具输出映射为 `tool_result`。 |
| L01-S23 | `mini-cc/src/services/tools/toolOrchestration.ts` | 串行执行 tool uses。 |
| L01-S24 | `mini-cc/src/tools/BashTool.ts` | 加入最小危险命令拦截。 |
| L01-S25 | `mini-cc/src/tools/BashTool.ts` | 使用 tool context 执行具体命令。 |

这些注释不是普通代码说明，而是学习路径。读者可以按编号从入口一路走到工具执行，再回到模型下一轮。

## 运行效果

第一课可以这样运行：

```powershell
Set-Location C:\dev\workspace\hope-cc\mini-cc
npm run lesson:01 -- "List files"
```

期望行为是：

```text
用户输入
  ↓
MockClaudeProvider 生成 bash tool_use
  ↓
queryLoop 发现 tool_use
  ↓
runTools 调用 BashTool
  ↓
BashTool 返回命令输出
  ↓
queryLoop 追加 user message with tool_result
  ↓
MockClaudeProvider 第二轮看到 tool_result
  ↓
输出最终 assistant text
```

这说明最小 agent loop 已经成立。

## 这一课的工程取舍

第一课故意做得很小，但边界不能乱。

### 保留的东西

- 保留 `QueryEngine`，避免 CLI 直接拥有 agent loop。
- 保留 `query()` / `queryLoop()`，贴近 Claude Code 的主状态机边界。
- 保留 `ContentBlock`、`ToolUseBlock`、`ToolResultBlock`，明确协议不是日志。
- 保留工具服务层，让 `query.ts` 不直接知道具体工具。
- 保留 `ToolUseContext`，为权限、session、MCP、abort 留位置。
- 保留 `isConcurrencySafe()`，为后续工具并发调度留位置。

### 暂时省略的东西

- 不接真实 Anthropic API。
- 不实现 streaming chunk / partial JSON 聚合。
- 不实现完整 Tool Dispatcher。
- 不实现 permission hooks。
- 不实现 context compaction。
- 不实现 session resume。
- 不实现并发工具执行。

这些不是不重要，而是第一课的目标很明确：先让 `tool_use -> tool_result -> next model call` 跑通。

## 和真实 Claude Code 的差距

真实 Claude Code 比这节课复杂得多。

入口层方面，真实 Claude Code 有 Commander CLI、REPL、headless、SDK、resume、settings、permission mode 等分支。`mini-cc` 只有一个 `process.argv` 教学入口。

Provider 方面，真实 Claude provider 要处理 streaming chunks、thinking blocks、partial JSON、cache control、错误恢复。`mini-cc` 的 mock provider 直接返回完整 content blocks。

Tool execution 方面，真实 Claude Code 有工具 schema 校验、权限检查、hook、并发分组、streaming executor、UI 展示和复杂错误映射。`mini-cc` 第一课只有串行 `bash`。

Context 方面，真实 Claude Code 需要处理长会话、compaction、resume、orphan tool result、max turns 等问题。`mini-cc` 第一课只保留 `messages` 和 `turnCount`。

但这些差距是有意保留的。第一课不是要复刻 Claude Code，而是先把它最小可演进的骨架搭出来。

## 这份资料可以抽取哪些 wiki 词条？

这份 raw 作为 `raw/Projects/cc/` 下的项目资料时，建议优先抽取这些语义对象。

### project

- [[project-cc]]：Claude Code-like coding agent 学习与实现项目。

### entry

- [[Agent Loop]]：模型、工具、transcript 的多轮控制循环。
- [[Agent Harness]]：模型外部负责工具、状态、上下文和安全的基础设施。
- [[Tool Use与Tool Result协议]]：模型请求工具和 harness 回填结果的最小协议。
- [[Transcript驱动的Agent状态]]：用 messages 作为 agent 状态源。
- [[Provider Adapter]]：模型 API 到 agent loop 消息形态的适配层。
- [[Tool Dispatcher]]：从 `tool_use.name` 到具体工具执行的调度层。
- [[Streaming Chunk聚合]]：把 streaming delta / partial JSON 聚合成 content block。
- [[Agent工具并发调度]]：用 `isConcurrencySafe()` 等信号决定工具并发策略。
- [[工具权限边界]]：工具执行前的安全和权限控制边界。

### question

- [[q-agent-loop-why-needed]]：为什么 coding agent 需要 Agent Loop，而不是一次模型调用？
- [[q-tool-use-tool-result-protocol]]：`tool_use` 和 `tool_result` 如何配对？
- [[q-message-content-block-chunk]]：message、content block、streaming chunk 有什么区别？
- [[q-tool-execution-not-in-query-loop]]：为什么工具执行不应该直接写在主 loop 里？

### scenario

- [[scenario-tool-use-followup-loop]]：模型返回 text + tool_use 时，harness 如何进入下一轮？
- [[scenario-orphan-tool-result]]：会话恢复或中断后出现 orphan tool result 怎么处理？
- [[scenario-streaming-tool-use-partial-json]]：streaming 下 tool input 是 partial JSON 时如何聚合？
- [[scenario-agent-tool-concurrency]]：多个工具调用如何判断串行还是并行？

## 后续 TODO

下一步最自然的学习节点是 Tool Dispatcher。

第一课已经能识别 `tool_use`，但只有一个 `bash` 工具。第二课应该补：

- 工具注册表。
- `read_file`、`write_file`、`edit_file`。
- schema validation。
- unknown tool 的错误映射。
- 工具结果大小限制。
- path guard。
- 更明确的 permission / tool safety 边界。

再往后可以继续补：

- Streaming Provider：真实 chunk / partial JSON 聚合。
- Permission Hooks：工具执行前后的权限与 hook 链路。
- Context Compaction：长会话下 transcript 如何压缩。
- Session Resume：如何保持 `tool_use` / `tool_result` 配对合法。
- Subagent：如何复用主 loop，但隔离上下文。

## Raw Reference

- source candidate: `docs/wiki-source/cc/raw/2026-05-14-claude-code-agent-loop.md`
- intended JOB-WIKI path: `raw/Projects/cc/2026-05-14-claude-code-agent-loop.md`
