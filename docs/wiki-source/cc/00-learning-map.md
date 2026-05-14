# Claude Code 源码学习地图

## TL;DR

本项目采用 **frontier 式学习**：从当前机制出发完成源码精读和 `mini-cc` 最小实现，再把它牵出的“要学习、要拓展、要优化”的下一层主题写回本文件，形成可持续推进的学习队列。

当前已完成第一个节点 **Agent Loop**。下一步应进入 **Tool Dispatcher**，因为 Agent Loop 已经能识别 `tool_use`，但真正的 coding agent 行动能力取决于工具 schema、工具查找、执行、结果回填和并发 / 副作用安全。

## 使用方式

每次开始一个新机制时，只更新和当前机制相关的部分，不做全量重写。

1. 在 `Current Node` 记录当前学习节点状态。
2. 在 `Frontier Queue` 写入当前节点牵出的下一层主题。
3. 在 `Priority Queue` 调整下一步顺序。
4. 在 `Learning Tracks` 更新相关 track 的学习问题、源码入口和 `mini-cc` 演进点。
5. 在 `Source Index` 登记新增的 analysis / build-along / raw 文档。

## Traversal Model

```text
选定当前机制
→ 精读 Claude Code 源码
→ 实现 mini-cc 的最小对应能力
→ 验证行为
→ 记录当前机制牵出的 frontier
→ 从 frontier 中选择下一优先级主题继续
```

frontier 分类：

- `要学习`：需要继续精读 Claude Code 源码的机制。
- `要拓展`：需要在 `mini-cc` 中新增的能力。
- `要优化`：已有 `mini-cc` 能力后续要接近 Claude Code 的地方。

## Current State

| 项目 | 当前状态 |
|---|---|
| 已完成节点 | Agent Loop |
| 当前推荐节点 | Tool Dispatcher |
| mini-cc 状态 | 已完成最小 agent loop，可跑 `tool_use -> tool_result -> final answer` |
| 文档状态 | Agent Loop 已有 analysis、build-along、raw 三类文档 |
| 下一步目标 | 补齐工具协议、工具调度和文件类工具，打开 Permission / Path Guard 后续 frontier |

## Current Node：Agent Loop

### 学习问题

如果要实现一个 Claude Code-like coding agent，最小主循环应该是什么？它为什么不能只是“一次模型调用 + 打印结果”？

### 已确认源码事实

| 源码位置 | 关键符号 | 说明 |
|---|---|---|
| `src/query.ts:219` | `query()` | 核心 loop 暴露为异步生成器。 |
| `src/query.ts:241` | `queryLoop()` | 真正的 agent loop 实现。 |
| `src/query.ts:307` | `while (true)` | 主循环是跨轮状态机。 |
| `src/query.ts:557` | `toolUseBlocks` / `needsFollowUp` | `tool_use` 是继续下一轮的核心信号。 |
| `src/query.ts:1382` | `runTools()` / `StreamingToolExecutor` | 工具执行从主 loop 下沉到服务层。 |
| `src/Tool.ts:158` | `ToolUseContext` | 工具执行上下文边界。 |
| `src/QueryEngine.ts:675` | `for await (const message of query(...))` | SDK/headless 入口复用核心 loop。 |

### mini-cc 已完成范围

| mini-cc 文件 | 作用 |
|---|---|
| `mini-cc/src/query.ts` | 最小 `query()` / `queryLoop()`。 |
| `mini-cc/src/QueryEngine.ts` | 入口包装。 |
| `mini-cc/src/Tool.ts` | 工具协议和 `ToolUseContext`。 |
| `mini-cc/src/types.ts` | 消息、content block、model provider、query event 类型。 |
| `mini-cc/src/services/api/mockClaude.ts` | 可控 mock model。 |
| `mini-cc/src/services/tools/toolExecution.ts` | 单工具执行。 |
| `mini-cc/src/services/tools/toolOrchestration.ts` | 最小工具调度。 |
| `mini-cc/src/tools/BashTool.ts` | 第一个具体工具。 |

### 核心闭环

```text
user prompt
→ QueryEngine.submitMessage()
→ query() / queryLoop()
→ model returns assistant message with tool_use
→ runTools() / runToolUse()
→ concrete tool call
→ tool_result user message
→ next model call
→ final assistant text
```

## Frontier Queue

| 优先级 | Frontier | 类型 | 为什么由 Agent Loop 牵出 | mini-cc 影响 | 预期产物 |
|---|---|---|---|---|---|
| P0 | Tool Dispatcher | 要学习 / 要拓展 | Agent Loop 只识别 `tool_use`，真正行动依赖工具 schema、查找、执行、结果映射和调度。 | 增加 `read_file`、`write_file`、`edit_file`；扩展 `services/tools`。 | Lesson 02；tool dispatcher analysis / raw。 |
| P0 | Permission / Tool Safety | 要学习 / 要优化 | 工具会读写文件和执行命令，安全边界是 coding agent 的核心约束。 | 增加 path guard、危险命令分类、allow/deny/ask。 | Lesson 03；permission hooks analysis / raw。 |
| P0 | Context / Compaction | 要学习 / 要拓展 | 每轮 loop 都把 transcript 送回模型，长会话必须处理预算和压缩。 | 增加 token estimate、transcript、summary message。 | Lesson 05-06；context compaction raw。 |
| P1 | Input / Commands | 要学习 / 要拓展 | `query()` 前还有 slash command、附件、memory 和本地命令处理。 | 增加 command registry、`/help`、`/clear`、`/compact`。 | input command processing analysis。 |
| P1 | Session / Resume | 要学习 / 要优化 | transcript 是事实源，恢复必须保持 `tool_use` / `tool_result` 配对。 | 增加 conversation save/resume。 | session resume raw。 |
| P2 | Skills / Plugins / MCP | 要学习 / 要拓展 | 外部知识和外部工具最终会进入上下文面或工具面。 | 增加 skill index、外部工具 provider。 | skills / plugin MCP raw。 |
| P2 | Subagent / Swarm | 要学习 / 要拓展 | 子 agent 复用主 loop，但需要隔离上下文和任务。 | 增加 child loop 和 summary return。 | subagent loop raw。 |
| P3 | Observability / Recovery | 要优化 | 生产级 loop 需要 max turns、错误恢复、stream watchdog、cost、telemetry。 | 增加 event log、trace span、latency placeholder。 | observability raw。 |

## Priority Queue

### P0：Agent Loop 的直接依赖

1. **Tool Dispatcher**
   - 下一课优先做。
   - 目标是补齐 `Tool.ts`、`tools/`、`services/tools` 的机制理解和 `mini-cc` 文件工具。
2. **Permission / Tool Safety**
   - Tool Dispatcher 之后自然进入。
   - 目标是理解工具调用前后的安全边界。
3. **Context / Compaction**
   - Agent Loop 和工具调用跑起来后，需要处理 transcript 增长。
   - 目标是理解每轮 `messagesForQuery` 如何形成和压缩。

### P1：进入模型前后的上下文面

1. **Input / Slash Commands**
2. **Attachments / Memory / Skills**
3. **Session / Resume**

### P2：扩展能力和多 agent

1. **Plugins / MCP**
2. **Subagent / Swarm**
3. **Remote / Bridge**

### P3：生产质量

1. **Observability / Telemetry**
2. **Cost Tracking**
3. **Streaming Watchdog / Recovery**
4. **Eval / Quality Gates**

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

### 要回答的设计问题

- 工具如何暴露给模型？
- `tool_use.name` 如何找到具体工具？
- 工具 input 如何校验、执行并转成 `tool_result`？
- 多个工具调用何时并发，何时串行？
- 工具失败如何变成模型下一轮可理解的信息？

### 推荐源码入口

- `src/Tool.ts`
- `src/tools.ts`
- `src/tools/BashTool/`
- `src/tools/FileReadTool/`
- `src/tools/FileWriteTool/`
- `src/tools/FileEditTool/`
- `src/services/tools/toolExecution.ts`
- `src/services/tools/toolOrchestration.ts`
- `src/services/tools/StreamingToolExecutor.ts`

### 预期 mini-cc 改动

- 新增 `mini-cc/src/tools/FileReadTool.ts`
- 新增 `mini-cc/src/tools/FileWriteTool.ts`
- 新增 `mini-cc/src/tools/FileEditTool.ts`
- 更新 `mini-cc/src/tools.ts`
- 扩展 `mini-cc/src/services/tools/toolExecution.ts`
- 扩展 `mini-cc/src/services/tools/toolOrchestration.ts`

### 预期文档产物

- `docs/wiki-source/cc/analysis/claude-code-tool-dispatcher.md`
- `docs/build-along/cc/02-tool-dispatcher.md`
- `docs/wiki-source/cc/raw/YYYY-MM-DD-claude-code-tool-dispatcher.md`

## Source Index

### 已完成

| 主题 | analysis | build-along | raw |
|---|---|---|---|
| Agent Loop | `docs/wiki-source/cc/analysis/claude-code-agent-loop.md` | `docs/build-along/cc/01-agent-loop.md` | `docs/wiki-source/cc/raw/2026-05-14-claude-code-agent-loop.md` |

### 候选

- `docs/wiki-source/cc/raw/YYYY-MM-DD-claude-code-tool-dispatcher.md`
- `docs/wiki-source/cc/raw/YYYY-MM-DD-claude-code-tool-permission-hooks.md`
- `docs/wiki-source/cc/raw/YYYY-MM-DD-claude-code-context-compaction-flow.md`
- `docs/wiki-source/cc/raw/YYYY-MM-DD-claude-code-input-command-processing.md`
- `docs/wiki-source/cc/raw/YYYY-MM-DD-claude-code-skills-loading.md`
- `docs/wiki-source/cc/raw/YYYY-MM-DD-claude-code-plugin-mcp-tool-surface.md`
- `docs/wiki-source/cc/raw/YYYY-MM-DD-claude-code-session-resume.md`
- `docs/wiki-source/cc/raw/YYYY-MM-DD-claude-code-subagent-loop.md`
- `docs/wiki-source/cc/raw/YYYY-MM-DD-claude-code-observability.md`

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
