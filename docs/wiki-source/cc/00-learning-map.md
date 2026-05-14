# Claude Code 源码学习地图

## TL;DR

本项目采用 **机制锚定 + frontier 扩展 + 注释驱动** 的学习方式：先完成当前机制的源码阅读和 `mini-cc` 最小实现，再把它牵出的后续学习点写回本文件。

当前状态：

- 已完成节点：`Agent Loop`
- 当前推荐节点：`Tool Dispatcher`
- `mini-cc` 状态：已完成第一课最小 agent loop，可跑 `tool_use -> tool_result -> final answer`
- 文档状态：Agent Loop 已有 analysis、build-along、raw 三类文档

## 使用方式

本文件是学习队列和索引，不是完整源码分析文档。每次开始新机制时只更新相关区域：

1. 在 `Current Node` 记录当前机制。
2. 在 `Frontier Queue` 写入它牵出的后续主题。
3. 在 `Priority Queue` 调整下一步顺序。
4. 在 `Source Index` 登记新增文档。

## Traversal Model

```text
选定机制
-> 精读 Claude Code 源码
-> 提炼源码事实、推断、待验证事项
-> 在 mini-cc 中实现最小对应能力
-> 用 Lxx-Sxx 注释形成阅读路径
-> 验证行为
-> 沉淀 analysis / build-along / raw
-> 回写 frontier
```

frontier 分类：

- `要学习`：需要继续精读 Claude Code 源码的机制。
- `要拓展`：需要在 `mini-cc` 中新增的能力。
- `要优化`：已有 `mini-cc` 能力后续要接近 Claude Code 的地方。

## Current Node

| 项目 | 内容 |
|---|---|
| 节点 | Agent Loop |
| 核心问题 | Claude Code-like coding agent 的最小主循环为什么不是一次模型调用？ |
| 源码结论 | 核心 loop 是基于 transcript 的异步状态机，使用 `tool_use` / `tool_result` 协议驱动多轮执行。 |
| mini-cc 结果 | Lesson 01 保留入口包装、核心 loop、模型 provider、工具协议、工具调度和 Bash 工具边界。 |
| 注释路径 | `L01-S01` 到 `L01-S25` |
| 后续牵引 | Tool Dispatcher、Permission / Tool Safety、Context / Compaction |

## Current Node Evidence

| 源码位置 | 关键符号 | 说明 |
|---|---|---|
| `src/query.ts:219` | `query()` | 核心 loop 暴露为异步生成器。 |
| `src/query.ts:241` | `queryLoop()` | 真正的 agent loop 实现。 |
| `src/query.ts:307` | `while (true)` | 主循环是跨轮状态机。 |
| `src/query.ts:557` | `toolUseBlocks` / `needsFollowUp` | `tool_use` 是继续下一轮的核心信号。 |
| `src/query.ts:1382` | `runTools()` / `StreamingToolExecutor` | 工具执行从主 loop 下沉到服务层。 |
| `src/Tool.ts:158` | `ToolUseContext` | 工具执行上下文边界。 |
| `src/QueryEngine.ts:675` | `for await (const message of query(...))` | SDK/headless 入口复用核心 loop。 |
| `src/screens/REPL.tsx:2793` | `for await (const event of query(...))` | REPL 入口复用核心 loop。 |

详细阅读过程见：

- `docs/wiki-source/cc/analysis/claude-code-agent-loop.md`
- `docs/build-along/cc/01-agent-loop.md`
- `docs/wiki-source/cc/raw/2026-05-14-claude-code-agent-loop.md`

## Frontier Queue

| 优先级 | Frontier | 类型 | 为什么由 Agent Loop 牵出 | mini-cc 影响 | 预期产物 |
|---|---|---|---|---|---|
| P0 | Tool Dispatcher | 要学习 / 要拓展 | Agent Loop 已能识别 `tool_use`，但真正行动依赖工具 schema、查找、执行、结果映射和调度。 | 增加 `read_file`、`write_file`、`edit_file`，扩展 `services/tools`。 | Lesson 02；analysis；可选 raw。 |
| P0 | Permission / Tool Safety | 要学习 / 要优化 | 工具会读写文件和执行命令，安全边界是 coding agent 的核心约束。 | 增加 path guard、危险命令分类、allow/deny/ask。 | Lesson 03；permission hooks analysis。 |
| P0 | Context / Compaction | 要学习 / 要拓展 | 每轮 loop 都把 transcript 送回模型，长会话必须处理预算和压缩。 | 增加 token estimate、transcript、summary message。 | Lesson 04/05；context compaction raw。 |
| P1 | Input / Slash Commands | 要学习 / 要拓展 | `query()` 前还有 slash command、附件、memory 和本地命令处理。 | 增加 command registry、`/help`、`/clear`、`/compact`。 | input command analysis。 |
| P1 | Session / Resume | 要学习 / 要优化 | transcript 是事实源，恢复必须保持 `tool_use` / `tool_result` 配对。 | 增加 conversation save/resume。 | session resume raw。 |
| P2 | Skills / Plugins / MCP | 要学习 / 要拓展 | 外部知识和外部工具最终会进入上下文面或工具面。 | 增加 skill index、external tool provider。 | skills/plugin/MCP raw。 |
| P2 | Subagent / Swarm | 要学习 / 要拓展 | 子 agent 复用主 loop，但需要隔离上下文和任务。 | 增加 child loop 和 summary return。 | subagent loop raw。 |
| P3 | Observability / Recovery | 要优化 | 生产级 loop 需要 max turns、错误恢复、stream watchdog、cost、telemetry。 | 增加 event log、trace span、latency placeholder。 | observability raw。 |

## Priority Queue

### P0：Agent Loop 的直接依赖

1. **Tool Dispatcher**
   - 下一课优先做。
   - 目标：理解工具如何从 schema 变成真实行动。
   - 预期注释：`L02-Sxx`。
2. **Permission / Tool Safety**
   - Tool Dispatcher 之后自然进入。
   - 目标：理解工具调用前后的安全边界。
   - 预期注释：`L03-Sxx`。
3. **Context / Compaction**
   - 工具闭环跑通后进入。
   - 目标：理解 `messagesForQuery` 如何形成和压缩。
   - 预期注释：`L04-Sxx` 或 `L05-Sxx`。

### P1：进入模型前后的上下文面

- Input / Slash Commands
- Attachments / Memory / Skills
- Session / Resume

### P2：扩展能力和多 agent

- Plugins / MCP
- Subagent / Swarm
- Remote / Bridge

### P3：生产质量

- Observability / Telemetry
- Cost Tracking
- Streaming Watchdog / Recovery
- Eval / Quality Gates

## Learning Tracks

| Track | 学习目标 | 关键源码 | mini-cc 演进 |
|---|---|---|---|
| Agent Loop / Query | 理解“模型 -> 工具 -> 模型”的主状态机。 | `src/query.ts`, `src/QueryEngine.ts`, `src/screens/REPL.tsx` | 已完成最小 loop。 |
| Tool Calling / Dispatcher | 理解工具如何从 schema 变成真实行动。 | `src/Tool.ts`, `src/tools.ts`, `src/tools/`, `src/services/tools/` | 增加文件工具和调度策略。 |
| Permission / Hooks | 理解工具执行前后的安全和 hook 边界。 | `src/hooks/useCanUseTool.tsx`, `src/services/tools/toolHooks.ts`, `src/utils/permissions/` | 增加 path guard 和权限模型。 |
| Context / Compaction | 理解长会话如何控制上下文预算。 | `src/services/compact/`, `src/query/tokenBudget.ts`, `src/utils/toolResultStorage.ts` | 增加 transcript 和 summary。 |
| Input / Commands | 理解用户输入如何进入 loop。 | `src/utils/processUserInput/`, `src/commands.ts`, `src/commands/` | 增加 command registry。 |
| Skills / Plugins / MCP | 理解外部知识和外部工具如何进入上下文 / 工具面。 | `src/skills/`, `src/services/plugins/`, `src/services/mcp/`, `src/tools/MCPTool/` | 增加 skill index 和 external provider。 |
| Session / Subagent / Remote | 理解长会话、多 agent、远程入口如何复用主 loop。 | `src/utils/sessionStorage.ts`, `src/tools/AgentTool/`, `src/remote/`, `src/bridge/` | 增加 save/resume 和 child loop。 |
| Observability / Quality | 理解 loop、工具、成本和错误如何被诊断。 | `src/utils/queryProfiler.ts`, `src/services/analytics/`, `src/cost-tracker.ts` | 增加 event log 和 trace span。 |

## Next Lesson：Tool Dispatcher

### Learning Questions

- 工具如何暴露给模型？
- `tool_use.name` 如何找到具体工具？
- 工具 input 如何校验、执行并转成 `tool_result`？
- 多个工具调用何时并发，何时串行？
- 工具失败如何变成模型下一轮可理解的信息？

### Recommended Source Entry

- `src/Tool.ts`
- `src/tools.ts`
- `src/tools/BashTool/`
- `src/tools/FileReadTool/`
- `src/tools/FileWriteTool/`
- `src/tools/FileEditTool/`
- `src/services/tools/toolExecution.ts`
- `src/services/tools/toolOrchestration.ts`
- `src/services/tools/StreamingToolExecutor.ts`

### Expected mini-cc Work

- 新增或扩展工具注册表。
- 增加 `read_file`、`write_file`、`edit_file`。
- 扩展工具 input 校验和错误映射。
- 保持 `query.ts` 只依赖工具调度层。
- 增加 `L02-Sxx` 注释路径和 Lesson 02 build-along 文档。

## Source Index

| 主题 | 状态 | analysis | build-along | raw |
|---|---|---|---|---|
| Agent Loop | 完成 | `docs/wiki-source/cc/analysis/claude-code-agent-loop.md` | `docs/build-along/cc/01-agent-loop.md` | `docs/wiki-source/cc/raw/2026-05-14-claude-code-agent-loop.md` |
| Tool Dispatcher | 待开始 | `docs/wiki-source/cc/analysis/claude-code-tool-dispatcher.md` | `docs/build-along/cc/02-tool-dispatcher.md` | `docs/wiki-source/cc/raw/YYYY-MM-DD-claude-code-tool-dispatcher.md` |

## Candidate JOB-WIKI Mapping

- project candidate: `project-cc`
- entry candidates:
  - Agent Harness
  - Agent Loop
  - Agent 工具调用与协议
  - 工具权限模型
  - 上下文工程
  - 多轮对话上下文压缩
  - Agent Skills
  - MCP 工具集成
  - AI Coding 会话管理
  - Agent 可观测性
- question candidates:
  - Agent loop 的最小协议是什么？
  - Claude Code 如何执行工具并回填结果？
  - Claude Code 如何避免长会话上下文爆炸？
  - Skill / Plugin / MCP 如何扩展工具面？
- scenario candidates:
  - 工具调用失败后如何保持 transcript 一致？
  - 权限拒绝后模型如何继续？
  - 上下文过长时如何压缩且不破坏工具历史？
  - 多 agent 如何共享主循环但隔离上下文？

## Open Questions

- `StreamingToolExecutor` 的结果排序、取消和 context modifier 合并细节是什么？
- permission hook、pre tool hook、post tool hook 的优先级如何？
- `messagesForQuery` 在 compact、attachment、skill discovery 之后的最终形态如何确定？
- MCP 工具进入 `ToolUseContext.options.tools` 前做了哪些 normalize 和权限包装？
- 子 agent 复用 `query()` 时，哪些上下文共享，哪些隔离？
