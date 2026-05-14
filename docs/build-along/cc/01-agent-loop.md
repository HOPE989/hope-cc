# Lesson 01: Agent Loop

## Learning Question

第一课要解决的问题不是“写一个能跑的 demo”，而是：如果要边学 Claude Code 边实现一个简化版 coding agent，最小架构应该长什么样？

过于简单的实现会把所有逻辑写成：

```text
main.ts -> mock model -> if tool then exec -> print
```

这能跑，但学不到 Claude Code 的架构。Claude Code 的源码说明，第一课就应该保留入口包装、核心 loop、模型 provider、工具协议、工具调度和具体工具几个边界。这样后续加权限、上下文压缩、session resume 时不需要推倒重来。

## Source Basis

本课依据的源码分析见 `docs/wiki-source/cc/analysis/claude-code-agent-loop.md`。这里只保留和 `mini-cc` 设计直接相关的源码事实：

| Claude Code 源码 | 事实 | mini-cc 设计影响 |
|---|---|---|
| `src/query.ts:219` | `query()` 暴露异步生成器。 | `mini-cc/src/query.ts` 保留 `query()` 入口。 |
| `src/query.ts:241` | `queryLoop()` 承担核心状态机。 | `query()` 只委托 `queryLoop()`。 |
| `src/query.ts:307` | 主循环是 `while (true)`。 | 用 `messages` 和 `turnCount` 跨轮推进。 |
| `src/query.ts:557` | `tool_use` 是继续信号。 | 读取 assistant message 中的 `tool_use` 决定是否执行工具。 |
| `src/query.ts:1382` | 工具执行进入工具服务层。 | `query.ts` 只调用 `runTools()`。 |
| `src/Tool.ts:158` | 工具有 `ToolUseContext`。 | `Tool.ts` 定义工具协议和上下文。 |
| `src/QueryEngine.ts:675` | SDK/headless 消费 `query()` 事件。 | `QueryEngine.ts` 作为简化入口包装。 |

## Build-Along Derivation

第一课保留的边界：

| mini-cc 文件 | 对应 Claude Code 边界 | 为什么第一课保留 |
|---|---|---|
| `mini-cc/src/main.ts` | CLI / headless 入口 | 需要一个最小入口驱动学习闭环。 |
| `mini-cc/src/QueryEngine.ts` | REPL / SDK 进入 `query()` 前的包装 | 避免把入口和核心 loop 混在一起。 |
| `mini-cc/src/query.ts` | `src/query.ts` | 保留 agent loop 主状态机。 |
| `mini-cc/src/types.ts` | 消息和事件协议 | 明确 `tool_use` / `tool_result` 是协议，不是日志。 |
| `mini-cc/src/Tool.ts` | `src/Tool.ts` | 保留工具 schema、call 和上下文边界。 |
| `mini-cc/src/services/api/mockClaude.ts` | 模型 provider | 用 deterministic mock 验证 loop，不依赖真实 API。 |
| `mini-cc/src/services/tools/toolExecution.ts` | 单工具执行 | 工具查找和结果映射不写进主 loop。 |
| `mini-cc/src/services/tools/toolOrchestration.ts` | 工具调度 | 先串行，后续课程再扩展并发和安全分组。 |
| `mini-cc/src/tools/BashTool.ts` | 具体工具实现 | 具体副作用工具独立于 `query.ts`。 |

第一课有意省略：

- 真实 Anthropic API 和 streaming。
- permission / hook。
- context compaction。
- parallel tool execution。
- session persistence 和 resume。

这些不是不重要，而是本课目标是先把可演进的主循环骨架立住。

## What We Built

行为闭环：

```text
user prompt
-> QueryEngine.submitMessage()
-> query() / queryLoop()
-> MockClaudeProvider.createMessage()
-> assistant message with tool_use
-> runTools()
-> runToolUse()
-> BashTool.call()
-> tool_result user message
-> next MockClaudeProvider.createMessage()
-> final assistant text
```

## Annotated Code Walkthrough

这一节是本课主学习路径。阅读时按代码中的 `//L01-Sxx 步骤标题：具体注释内容` 顺序走，不要先从最终调用链倒推。

### 启动与入口包装

| Step | 文件 | mini-cc 做什么 | 对应 Claude Code 机制 | 本课取舍 |
|---|---|---|---|---|
| L01-S01 读取参数 | `mini-cc/src/main.ts` | 从命令行读取 prompt，作为最小交互输入。 | `src/entrypoints/cli.tsx` / `src/main.tsx` 的 CLI 入口。 | 不复刻 Commander，只保留能驱动一轮学习的输入。 |
| L01-S02 创建入口包装 | `mini-cc/src/main.ts` | 创建 `QueryEngine`，传入 provider、tools、cwd。 | REPL/headless 在进入 `query()` 前准备上下文。 | 用一个类压缩 REPL 和 headless 两种入口。 |
| L01-S03 提交消息 | `mini-cc/src/main.ts` | 调用 `engine.submitMessage(prompt)`。 | `onSubmit -> handlePromptSubmit -> onQuery`。 | 先把“用户输入进入 loop”跑通。 |
| L01-S04 准备上下文 | `mini-cc/src/QueryEngine.ts` | 将 prompt、provider、tools、`toolUseContext` 传给 `query()`。 | `src/screens/REPL.tsx:2793` 调用 `query()` 前构造上下文。 | 只保留 `cwd`，后续再加入权限、MCP、session。 |
| L01-S05 消费事件流 | `mini-cc/src/QueryEngine.ts` | 用 `for await` 消费 `query()` 事件。 | REPL 和 SDK/headless 都消费核心 loop 事件。 | 不做 UI 渲染，只证明事件流边界。 |

### 协议与工具边界

| Step | 文件 | mini-cc 做什么 | 对应 Claude Code 机制 | 本课取舍 |
|---|---|---|---|---|
| L01-S06 定义消息块 | `mini-cc/src/types.ts` | 定义 `text`、`tool_use`、`tool_result`。 | Claude 工具调用协议。 | 只保留闭环需要的三类 block。 |
| L01-S07 定义事件流 | `mini-cc/src/types.ts` | 定义 `assistant`、`tool_result`、`done` 三类事件。 | `src/query.ts` 对外 yield 事件。 | 省略 request_start、tombstone、tool summary 等生产事件。 |
| L01-S08 定义工具上下文 | `mini-cc/src/Tool.ts` | `ToolUseContext` 只保存 `cwd`。 | `src/Tool.ts:158` 的工具上下文边界。 | 暂不放权限、AppState、MCP client、abort。 |
| L01-S09 定义工具协议 | `mini-cc/src/Tool.ts` | `Tool` 包含 name、schema、`call()`、并发安全占位。 | Claude Code 工具是 schema + 执行 + 上下文。 | 先保留接口压力点，复杂校验留到 Lesson 02。 |
| L01-S10 注册默认工具 | `mini-cc/src/tools.ts` | 集中返回默认工具列表。 | Claude Code 有集中工具池和工具过滤机制。 | 第一课只注册 `BashTool`。 |

### Agent Loop 主状态机

| Step | 文件 | mini-cc 做什么 | 对应 Claude Code 机制 | 本课取舍 |
|---|---|---|---|---|
| L01-S11 暴露 loop 入口 | `mini-cc/src/query.ts` | `query()` 只暴露异步生成器接口。 | `src/query.ts:219`。 | 保留同名边界，方便后续贴近源码。 |
| L01-S12 初始化状态 | `mini-cc/src/query.ts` | 初始化 `messages` 和 `turnCount`。 | Claude Code 的跨轮 `State`。 | 只保留跨轮推进必需状态。 |
| L01-S13 检查轮数上限 | `mini-cc/src/query.ts` | 达到 `maxTurns` 时停止。 | Claude Code 支持 max turns 和多种停止原因。 | 先保留防无限循环保护。 |
| L01-S14 调用模型 | `mini-cc/src/query.ts` | 每轮把 messages 和 tools 交给 provider。 | 每轮准备 `messagesForQuery` 后调模型。 | 不做 token budget、compact、memory、skills。 |
| L01-S15 记录模型输出 | `mini-cc/src/query.ts` | assistant message 写回 transcript 并 yield。 | Claude Code 输出事件同时更新状态。 | 简化为一次完整 assistant message。 |
| L01-S16 判断停止条件 | `mini-cc/src/query.ts` | 没有 `tool_use` 就结束。 | Claude Code 以真实 `tool_use` block 判断 follow-up。 | 省略 stop hook、错误恢复和续写路径。 |
| L01-S17 执行工具调度 | `mini-cc/src/query.ts` | 出现 `tool_use` 后调用 `runTools()`。 | `src/query.ts:1382` 进入工具调度。 | 第一课串行调度，不做 streaming tool execution。 |
| L01-S18 回填工具结果 | `mini-cc/src/query.ts` | `tool_result` 作为 user message 写回 transcript。 | 工具结果通过 user message 回填下一轮。 | 保留协议本质，不把工具结果当 assistant 输出。 |

### Mock Model 与工具执行

| Step | 文件 | mini-cc 做什么 | 对应 Claude Code 机制 | 本课取舍 |
|---|---|---|---|---|
| L01-S19 结束工具循环 | `mini-cc/src/services/api/mockClaude.ts` | mock model 看到 `tool_result` 后输出最终文本。 | 真实模型读取工具结果后继续或结束。 | 用 deterministic mock 便于验证。 |
| L01-S20 生成工具请求 | `mini-cc/src/services/api/mockClaude.ts` | 第一轮生成 `tool_use(name="bash")`。 | assistant message 中包含 `tool_use` block。 | 不做复杂 tool choice。 |
| L01-S21 查找工具 | `mini-cc/src/services/tools/toolExecution.ts` | 按 `tool_use.name` 找具体工具。 | 工具执行层按工具名匹配定义。 | 未知工具先映射为错误结果，schema 校验留到 Lesson 02。 |
| L01-S22 映射工具结果 | `mini-cc/src/services/tools/toolExecution.ts` | 将工具输出转成 `tool_result`，并写入 `tool_use_id`。 | `tool_result` 必须回连 `tool_use.id`。 | 省略 rich content、图片、metadata。 |
| L01-S23 串行调度工具 | `mini-cc/src/services/tools/toolOrchestration.ts` | 逐个执行 tool use。 | Claude Code 有串行/并发和 streaming executor。 | 第一课先保证顺序可读。 |
| L01-S24 拦截危险命令 | `mini-cc/src/tools/BashTool.ts` | Bash 工具做最小危险命令拦截。 | Bash/PowerShell 工具有权限和安全分类边界。 | 临时内联安全检查，后续拆到 Permission 课程。 |
| L01-S25 执行具体工具 | `mini-cc/src/tools/BashTool.ts` | 具体工具只接收 input 和 context。 | 具体工具在 `src/tools/`，主 loop 只依赖工具协议。 | 保持 `query.ts` 不接触具体工具细节。 |

## Implementation Steps

1. 先定义 `types.ts`：`tool_use.id` 和 `tool_result.tool_use_id` 是闭环关键。
2. 再写 `Tool.ts`：工具有统一 `call(input, context)` 和并发安全占位。
3. 再写 `query.ts`：每轮调用 provider，收集 assistant message，检查 `tool_use`。
4. 再写 `services/tools`：让 `query.ts` 不直接调用具体工具。
5. 再写 `MockClaudeProvider`：用可控输出验证两轮 loop。
6. 最后写 `BashTool` 和 `main.ts`：让第一课能从命令行运行。

## How To Run

```powershell
Set-Location C:\dev\workspace\hope-cc\mini-cc
npm run lesson:01 -- "List files"
node --experimental-strip-types src/main.ts "show node version"
```

## Verification

已验证：

- 输入 `List files` 时，mock model 会先发出 `bash` 的 `tool_use`。
- `runTools()` 会调用 `runToolUse()`。
- `BashTool.call()` 在当前 cwd 执行命令。
- 工具结果会作为 `tool_result` 放回 user message。
- 第二轮 mock model 看到 `tool_result` 后输出最终文本并停止。

仍未验证：

- 多工具调用顺序。
- 工具失败后的恢复行为。
- 并发安全分组。
- 真实模型 streaming 下的事件顺序。

## What This Teaches

- Agent loop 的事实源是 `messages`，不是临时变量。
- `tool_use` / `tool_result` 配对是 agent harness 的最小协议。
- 主 loop 应该依赖工具协议，不应该知道具体工具细节。
- 教学版也要保留后续能长出权限、上下文压缩和 session 的模块边界。

## Architecture Evolution

- 本课之前：没有 `mini-cc`。
- 本课之后：有了可运行的最小 agent loop，且代码注释形成 `L01-S01` 到 `L01-S25` 的阅读路径。
- 下一课应该补：Tool Dispatcher，把 `bash` 扩展为 `read_file`、`write_file`、`edit_file`，并开始引入 path guard 和工具安全分类。

## Difference From Claude Code

- 使用 `MockClaudeProvider`，不接真实模型。
- `runTools()` 只串行执行。
- `ToolUseContext` 只有 `cwd`。
- `QueryEngine` 只做入口包装，没有 transcript、resume、SDK result message。
- 没有 streaming、permission / hook、context compaction、parallel tool execution、复杂错误恢复。

## Candidate JOB-WIKI Mapping

- project candidate: `project-cc`
- entry candidates:
  - Agent Harness
  - Agent Loop
  - Agent 工具调用协议
  - Coding Agent 架构边界
- question candidates:
  - Agent loop 的最小协议是什么？
  - 为什么 `tool_use` / `tool_result` 配对是 Agent Harness 的核心？
  - 为什么工具执行不应该写在主 loop 里？
- scenario candidates:
  - 模型输出 `tool_use` 后工具失败，loop 如何继续？
  - 多个工具调用如何保持顺序、副作用安全和 transcript 一致？
