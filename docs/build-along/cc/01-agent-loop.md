# Lesson 01: Agent Loop

## What We Read

- `src/query.ts`：`query()` / `queryLoop()` 是真实 Claude Code agent loop 主体。
- `src/QueryEngine.ts`：SDK/headless 入口包装核心 loop。
- `src/screens/REPL.tsx`：交互式 UI 构造 `ToolUseContext` 并消费事件。
- `src/Tool.ts`：工具协议与工具上下文边界。
- `src/services/tools/toolOrchestration.ts`：工具调度层。
- `src/services/tools/toolExecution.ts`：单工具执行层。

## What We Built

第一课建立 `mini-cc` 的 Claude Code-like 架构骨架：

- `src/query.ts`：核心 loop。
- `src/QueryEngine.ts`：入口包装。
- `src/Tool.ts`：工具抽象。
- `src/services/api/mockClaude.ts`：模型 provider 适配。
- `src/services/tools/toolExecution.ts`：单工具执行。
- `src/services/tools/toolOrchestration.ts`：工具调度。
- `src/tools/BashTool.ts`：第一个具体工具。

行为闭环：

```text
user prompt
→ QueryEngine.submitMessage()
→ query() / queryLoop()
→ MockClaudeProvider returns tool_use
→ runTools() / runToolUse()
→ BashTool.call()
→ append tool_result
→ next model call
→ final assistant text
```

## How To Run

```powershell
Set-Location C:\dev\workspace\hope-cc\mini-cc
npm run lesson:01 -- "List files"
node --experimental-strip-types src/main.ts "show node version"
```

## What This Teaches

- `messages` 是 loop 的事实源。
- `tool_use.id` 和 `tool_result.tool_use_id` 是工具调用协议核心。
- 核心 loop 不应该直接塞具体工具逻辑。
- 即使是最小实现，也应保留入口层、核心 loop、模型适配、工具协议和工具执行层。

## Difference From Claude Code

- 没有真实 LLM API，只用 `MockClaudeProvider`。
- 没有 streaming block，只返回完整 assistant message。
- 没有权限、hook、上下文压缩和 session transcript。
- `runTools()` 目前是串行执行，没有实现并发安全分组。
- `QueryEngine` 只做入口包装，还没有持久化和 SDK result message。

## Candidate JOB-WIKI Mapping

- project: cc
- entry candidates:
  - Agent Harness
  - Agent Loop
  - Agent工具调用与协议
- question candidates:
  - Agent loop 的最小协议是什么？
  - 为什么 `tool_use` / `tool_result` 配对是 Agent Harness 的核心？
- scenario candidates:
  - 模型输出 `tool_use` 后工具失败，loop 如何继续？
  - 多个工具调用如何保持结果顺序和副作用安全？
