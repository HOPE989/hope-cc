# Lesson 01: Agent Loop

## Learning Question

第一课要解决的问题不是“写一个能跑的 demo”，而是：如果要边学 Claude Code 边实现一个简化版 coding agent，最小架构应该长什么样？

最容易犯的错是把所有东西写进一个文件：

```text
main.ts -> mock model -> if tool then exec -> print
```

这能跑，但学不到 Claude Code 的架构。Claude Code 的源码告诉我们，第一课就应该保留入口层、核心 loop、模型适配层、工具协议层、工具调度层和具体工具层。否则后面加权限、上下文压缩、session resume 时只能推倒重来。

## What We Read

- Real source paths:
  - `src/entrypoints/cli.tsx:33`：轻量 CLI bootstrap，先处理 fast path。
  - `src/entrypoints/cli.tsx:295`：普通路径动态导入完整 CLI。
  - `src/main.tsx:968`：Commander 根命令声明默认交互模式和 `-p/--print`。
  - `src/main.tsx:2584`：`--print` 非交互模式进入 headless 分支。
  - `src/main.tsx:3798`：普通交互模式调用 `launchRepl()`。
  - `src/replLauncher.tsx:12`：渲染 `<App><REPL /></App>`。
  - `src/screens/REPL.tsx:3142`：用户提交入口 `onSubmit`。
  - `src/screens/REPL.tsx:3490`：`onSubmit` 调用 `handlePromptSubmit()`。
  - `src/utils/handlePromptSubmit.ts:560`：输入处理后调用 `onQuery()`。
  - `src/screens/REPL.tsx:2793`：REPL 的 `onQuery` 进入 `query()`。
  - `src/cli/print.ts:2147`：headless 模式通过 `ask()` 进入 loop。
  - `src/query.ts:219`：`query()` 暴露核心异步生成器。
  - `src/query.ts:241`：`queryLoop()` 是真实主循环。
  - `src/query.ts:307`：显式 `while (true)` 表示跨轮状态机。
  - `src/query.ts:557`：`toolUseBlocks` / `needsFollowUp` 决定是否进入下一轮。
  - `src/query.ts:1382`：工具执行被交给 `runTools()` 或 `StreamingToolExecutor`。
  - `src/QueryEngine.ts:675`：SDK/headless 入口消费 `query()` 事件。
  - `src/Tool.ts:158`：`ToolUseContext` 是工具运行上下文边界。
  - `src/services/tools/toolOrchestration.ts:19`：`runTools()` 是工具调度层。
- Reading path:
  1. 先找启动入口，确认 `entrypoints/cli.tsx` 只是 bootstrap，完整 CLI 在 `main.tsx`。
  2. 再找模式分流，确认普通交互模式渲染 `REPL`，`-p/--print` 模式走 `runHeadless()`。
  3. 再追用户提交，确认 `PromptInput -> REPL.onSubmit -> handlePromptSubmit -> onQuery -> query()`。
  4. 再找 `query()` 和 `queryLoop()`，确认核心 loop 在哪里。
  5. 再找 `tool_use` 如何被收集，确认 loop 继续条件。
  6. 再找 `runTools()`，确认工具执行不属于主 loop 内部细节。
- Key discoveries:
  - Claude Code 有两层入口：CLI / UI 入口只负责启动、模式分流、输入规范化；agent loop 从 `query()` 才真正开始。
  - Claude Code 的 loop 是事件流，不是最终字符串返回。
  - `messages` 是事实源，`tool_use` 和 `tool_result` 是跨轮协议。
  - 工具执行层独立，是后续权限、并发、hook 的挂载点。

## Source-To-Design Derivation

Claude Code 的模块边界给第一课提供了直接设计约束：

| Claude Code 边界 | mini-cc 对应 | 保留原因 |
|---|---|---|
| `src/entrypoints/cli.tsx` / `src/main.tsx` | `mini-cc/src/main.ts` | 第一课只保留最小 CLI，但要知道真实 Claude Code 在这里完成启动和模式分流。 |
| `src/screens/REPL.tsx` / `src/utils/handlePromptSubmit.ts` | `mini-cc/src/QueryEngine.ts` | mini-cc 暂时没有 TUI，所以用 QueryEngine 代表“输入进入 loop 前的入口包装”。 |
| `src/query.ts` | `mini-cc/src/query.ts` | 主 loop 必须独立，后续才能加 compaction、max turns、恢复路径。 |
| `src/QueryEngine.ts` | `mini-cc/src/QueryEngine.ts` | 入口包装不能和 loop 混在一起，后续才能支持 CLI / SDK / tests。 |
| `src/Tool.ts` | `mini-cc/src/Tool.ts` | 工具需要统一协议和上下文，不应该是裸函数。 |
| `src/services/api/claude.ts` | `mini-cc/src/services/api/mockClaude.ts` | 模型 provider 要可替换，第一课先用 mock。 |
| `src/services/tools/` | `mini-cc/src/services/tools/` | 工具调度和单工具执行要留出边界。 |
| `src/tools/` | `mini-cc/src/tools/BashTool.ts` | 具体工具实现放到工具目录。 |

暂时省略的复杂度：

- 真实 Anthropic streaming。
- permission / hooks。
- context compaction。
- `StreamingToolExecutor` 并发调度。
- session transcript 和 resume。

这些不是不重要，而是第一课的学习目标是先把主循环骨架立住。

## What We Built

- `mini-cc/src/main.ts`：最小 CLI 启动入口。它没有复刻 Claude Code 的 Commander / REPL，只负责接收 prompt 并创建 `QueryEngine`。
- `mini-cc/src/QueryEngine.ts`：在本课中承担简化版入口包装，等价于把真实 Claude Code 的 `REPL.onSubmit` / headless `ask()` 压缩成一个可测试入口。
- `mini-cc/src/types.ts`：定义 `Message`、`ContentBlock`、`ToolUseBlock`、`ToolResultBlock`、`ModelProvider`、`QueryEvent`。
- `mini-cc/src/query.ts`：实现 `query()` / `queryLoop()`，维护 `messages` 和 `turnCount`。
- `mini-cc/src/Tool.ts`：定义 `Tool` 和 `ToolUseContext`。
- `mini-cc/src/services/api/mockClaude.ts`：模拟模型第一次输出 `tool_use`，第二次看到 `tool_result` 后结束。
- `mini-cc/src/services/tools/toolOrchestration.ts`：实现串行 `runTools()`。
- `mini-cc/src/services/tools/toolExecution.ts`：实现 `runToolUse()`，把工具输出映射为 `tool_result`。
- `mini-cc/src/tools/BashTool.ts`：实现第一个具体工具。
- `mini-cc/src/main.ts`：CLI 入口。

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

## Implementation Steps

1. 先定义协议类型：`types.ts` 中的 `tool_use.id` 和 `tool_result.tool_use_id` 是主循环能闭环的关键。
2. 再写 `Tool.ts`，让工具有统一的 `call(input, context)`，并预留 `isConcurrencySafe()`。
3. 再写 `query.ts`，让 loop 每轮调用 provider，收集 assistant message，检查 `tool_use`。
4. 再写 `services/tools`，让 `query.ts` 不直接调用具体工具。
5. 再写 `MockClaudeProvider`，用可控输出验证两轮 loop。
6. 最后写 `BashTool` 和 `main.ts`，让第一课能实际运行。

## How To Run

```powershell
Set-Location C:\dev\workspace\hope-cc\mini-cc
npm run lesson:01 -- "List files"
node --experimental-strip-types src/main.ts "show node version"
```

## Verification Record

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
- 即使是学习版，也要保留后续能长出权限、上下文压缩和 session 的模块边界。

## Architecture Evolution

- 本课之前：没有 mini-cc。
- 本课之后：有了可运行的最小 agent loop，目录边界贴近 Claude Code。
- 下一课应该补：Tool Dispatcher，把 `bash` 扩展为 `read_file`、`write_file`、`edit_file`，并开始引入 path guard 和工具安全分类。

## Difference From Claude Code

- 简化：
  - 使用 `MockClaudeProvider`，不接真实模型。
  - `runTools()` 只串行执行。
  - `ToolUseContext` 只有 `cwd`。
  - `QueryEngine` 只做入口包装，没有 transcript、resume、SDK result message。
- Missing:
  - streaming。
  - permission / hook。
  - context compaction。
  - parallel tool execution。
  - orphan tool use 修复和复杂错误恢复。

## Candidate JOB-WIKI Mapping

- project: `project-cc`
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
