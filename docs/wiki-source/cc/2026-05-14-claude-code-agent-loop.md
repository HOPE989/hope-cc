# Claude Code：Agent Loop 主循环机制

## TL;DR

我通过阅读 `src/query.ts`、`src/QueryEngine.ts`、`src/Tool.ts` 和 `src/services/tools/`，梳理了 Claude Code agent loop 的核心机制：它以消息 transcript 为事实源，通过 `tool_use` / `tool_result` 协议驱动“模型调用 -> 工具执行 -> 下一轮模型调用”的循环。随后我按相似架构边界实现了一个简化版 `mini-cc` 第一课，用来验证这个 harness 主循环的最小形态。

## Why This Matters

Agent 产品的核心不只是调用模型，而是给模型提供一个稳定、可恢复、可扩展的执行环境。Claude Code 的 agent loop 展示了一个生产级 harness 如何把模型、工具、权限、上下文、UI/SDK 事件和错误恢复组织在同一条主状态机里。

## Study Scope

- 覆盖范围：
  - `query()` / `queryLoop()` 主状态机。
  - `tool_use` / `tool_result` 协议。
  - 入口层、模型层、工具层的架构边界。
  - 简化实现中的第一版 agent loop。
- 不覆盖范围：
  - 上下文压缩算法。
  - 权限和 hook 完整优先级。
  - StreamingToolExecutor 的完整并发模型。

## Source Evidence

| 源码位置 | 关键符号 / 线索 | 证明了什么 |
|---|---|---|
| `src/query.ts:219` | `query()` | 核心 loop 暴露为异步生成器。 |
| `src/query.ts:241` | `queryLoop()` | 真正的 agent loop 实现。 |
| `src/query.ts:307` | `while (true)` | 主循环是显式状态机。 |
| `src/query.ts:551` 附近 | `toolUseBlocks` / `needsFollowUp` | 真实 `tool_use` 是继续下一轮的核心信号。 |
| `src/query.ts:1382` 附近 | `runTools()` / `StreamingToolExecutor` | 工具执行从主 loop 下沉到 services 层。 |
| `src/query.ts:1714` 附近 | `messagesForQuery + assistantMessages + toolResults` | 下一轮模型输入来自更新后的 transcript。 |
| `src/services/tools/toolOrchestration.ts` | `runTools()` | 工具调度按并发安全性分批。 |
| `src/Tool.ts` | `ToolUseContext` | 工具上下文承载 tools、app state、权限、abort、MCP 等运行信息。 |

## Mechanism Walkthrough

Claude Code 的主循环可以简化为：

```text
准备 messagesForQuery
→ 调模型 streaming
→ 收集 assistant message
→ 如果没有 tool_use：完成或进入 stop/recovery 路径
→ 如果有 tool_use：执行工具
→ 生成 tool_result user message
→ 拼接下一轮 State.messages
→ continue while(true)
```

重要细节是：代码注释明确 `stop_reason === 'tool_use'` 不可靠，主循环实际以是否看到结构化 `tool_use` block 作为继续信号。这说明生产级 harness 更信任结构化 transcript，而不是单个 API 高层字段。

## Architecture Notes

Claude Code 的 agent loop 不是单文件脚本，而是多层边界：

- `src/query.ts`：核心状态机。
- `src/QueryEngine.ts`：SDK/headless 会话包装。
- `src/screens/REPL.tsx`：交互式 UI 包装。
- `src/services/api/claude.ts`：模型 streaming 适配。
- `src/Tool.ts`：工具协议和上下文。
- `src/services/tools/`：工具执行和调度。
- `src/tools/`：具体工具实现。

我在简化实现中保留了这些边界的最小版本，而不是把所有代码写到一个 agent loop 文件里。

## Key Data Structures

- `State`：跨轮状态，保存消息、工具上下文、turn count、恢复状态和 transition。
- `ToolUseContext`：工具执行上下文，后续权限、MCP、UI、abort 都会依赖它。
- `ToolUseBlock`：模型发出的工具调用请求。
- `tool_result`：工具结果回填给模型的协议块。

## Design Decisions & Trade-offs

- 用 `AsyncGenerator` 暴露 loop 事件，让 REPL、SDK、print 等入口以统一方式消费。
- 用显式 `State` 管理下一轮，而不是递归调用。
- 用结构化 `tool_use` 判断是否继续，而不是只相信 `stop_reason`。
- 工具执行独立到 `services/tools`，避免主循环被权限、hook、并发和工具细节污染。
- 失败也要尽量产生协议内结果，维护 transcript 合法性。

## What I Practiced

- 我阅读了 `src/query.ts` 的主状态机和工具执行路径。
- 我追踪了 `query()` 到 `runTools()` / `runToolUse()` 的关键链路。
- 我按 Claude Code 的架构边界实现了 `mini-cc` 第一课：
  - `query.ts`
  - `QueryEngine.ts`
  - `Tool.ts`
  - `services/api/mockClaude.ts`
  - `services/tools/toolExecution.ts`
  - `services/tools/toolOrchestration.ts`
  - `tools/BashTool.ts`
- 我验证了简化 loop 能完成 `tool_use -> tool_result -> final answer` 闭环。

## Difference From Claude Code

- 简化实现用 mock model，不接真实模型。
- 简化实现没有 streaming、permission、hook、context compaction、session resume。
- 工具调度只做串行执行，还没有并发安全分组。
- `QueryEngine` 还没有真实 transcript、SDK message 和错误恢复。

## Candidate JOB-WIKI Mapping

- project candidate: project-cc
- entry candidates:
  - Agent Harness
  - Agent Loop
  - Agent工具调用与协议
  - AI Coding会话管理
- question candidates:
  - Agent loop 的最小协议是什么？
  - 为什么 `tool_use` / `tool_result` 配对是 Agent Harness 的核心？
  - Claude Code 如何把 UI / SDK 和核心 loop 解耦？
- scenario candidates:
  - 模型输出 `tool_use` 后 API 或工具失败，如何保持 transcript 一致？
  - 多工具调用如何兼顾并发、顺序和副作用安全？

## Weak Spots / TODO

- 待继续精读 StreamingToolExecutor。
- 待继续精读 permission / hook 如何介入 `runToolUse()`。
- 待继续精读上下文压缩如何在每轮模型调用前改写 `messagesForQuery`。
- 简化实现还没有真实模型 provider 和测试套件。

## Suggested Ingest Plan

- 新建 source 页：`src-2026-05-14-claude-code-agent-loop`
- 更新 project 页：`project-cc`
- 候选 entry 方向：Agent Harness、Agent Loop、Agent工具调用与协议、AI Coding会话管理
- 候选 question 方向：Agent loop 最小协议、tool_use/tool_result 配对、UI/SDK 与核心 loop 解耦
- 候选 scenario 方向：orphan tool_use 修复、工具失败恢复、多工具顺序和并发安全
- 需要 JOB-WIKI ingest 阶段确认 / 合并的页面：是否已有 Agent Loop 或 Agent Harness 相关词条
