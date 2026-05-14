# Claude Code 源码学习地图

## TL;DR

从 Agent Loop 出发学习 Claude Code，最稳的路线不是按目录遍历，而是沿着主循环依赖向外扩展：先理解 `query()` 如何驱动模型和工具，再学习工具协议、权限、上下文压缩、输入处理、Skills / Plugins / MCP、会话恢复、子 agent 和可观测性。这样每个主题都能回到同一条主干：模型如何看到上下文、如何行动、如何恢复、如何被约束。

## Core Spine: Agent Loop

已完成第一轮学习：

- 源码解析：`docs/wiki-source/cc/analysis/claude-code-agent-loop.md`
- build-along 笔记：`docs/build-along/cc/01-agent-loop.md`
- JOB-WIKI 候选 source：`docs/wiki-source/cc/raw/2026-05-14-claude-code-agent-loop.md`
- mini-cc 第一课：`mini-cc/src/query.ts`、`mini-cc/src/QueryEngine.ts`、`mini-cc/src/Tool.ts`

核心结论：

```text
query() / queryLoop()
→ callModel()
→ assistant message
→ tool_use
→ runTools() / runToolUse()
→ tool_result
→ next State.messages
→ next loop
```

## Traversal Model：Frontier 式学习

本项目的学习方式接近广度优先遍历，但锚点来自实际学习主题，而不是先按目录做全量规划。

每个主题的学习闭环是：

```text
选定当前机制
→ 精读源码并实现 mini-cc 的最小版本
→ 记录当前机制牵出的后续学习点
→ 把“要学习 / 要拓展 / 要优化”的内容写入 frontier
→ 下一轮从 frontier 中选择优先级最高的主题继续展开
```

当前遍历状态：

- 已完成节点：Agent Loop
- 当前主干：`query()` / `queryLoop()` 驱动 `tool_use` / `tool_result` 闭环
- Agent Loop 牵出的第一层 frontier：
  - Tool Dispatcher：工具 schema、执行、结果回填和并发安全。
  - Permission / Tool Safety：工具调用前后的安全边界。
  - Context / Compaction：每轮模型调用前如何构造和压缩上下文。
  - Input / Commands：用户输入进入 loop 前如何被解析和改写。
  - Session / Resume：transcript 如何持久化和恢复。

frontier 记录规则：

- `要学习`：需要继续精读 Claude Code 源码的机制。
- `要拓展`：需要在 `mini-cc` 中补齐的能力。
- `要优化`：已有 `mini-cc` 能力后续要接近 Claude Code 的地方。

每完成一个 frontier 主题，都要把它新牵出的下一层主题继续写回本文件。

## Codebase Map From Agent Loop

| 学习区域 | 关键源码 | 和 Agent Loop 的关系 | 学习价值 |
|---|---|---|---|
| Core Loop | `src/query.ts` | 主状态机，决定继续、停止、恢复和下一轮消息。 | 理解 Agent Harness 骨架。 |
| Entry Wrappers | `src/QueryEngine.ts`, `src/screens/REPL.tsx` | SDK/headless 和交互式 UI 都消费同一个 `query()`。 | 学习核心 loop 与入口层解耦。 |
| Model Adapter | `src/services/api/claude.ts`, `src/query/deps.ts` | 把模型 streaming event 规范化为内部 assistant message。 | 学习模型 API 适配边界。 |
| Tool Protocol | `src/Tool.ts`, `src/tools.ts`, `src/tools/` | 定义工具 schema、上下文、权限、UI、结果格式。 | 学习工具面设计。 |
| Tool Execution | `src/services/tools/toolExecution.ts`, `src/services/tools/toolOrchestration.ts`, `src/services/tools/StreamingToolExecutor.ts` | 执行 `tool_use` 并产出 `tool_result`。 | 学习工具调度、并发和副作用安全。 |
| Permission / Hooks | `src/hooks/useCanUseTool.tsx`, `src/services/tools/toolHooks.ts`, `src/utils/permissions/` | 在工具执行前后控制是否允许、阻断、修改上下文。 | 学习生产级安全边界。 |
| Context / Compaction | `src/services/compact/`, `src/utils/toolResultStorage.ts`, `src/query/tokenBudget.ts` | 每轮模型调用前重建和压缩 `messagesForQuery`。 | 学习长会话上下文工程。 |
| Input Processing | `src/utils/processUserInput/`, `src/commands/`, `src/commands.ts` | 用户输入进入 `query()` 前可能被命令、附件、local command 改写。 | 学习 CLI 命令和 prompt 边界。 |
| Skills / Attachments | `src/skills/`, `src/services/skillSearch/`, `src/utils/attachments.ts`, `src/memdir/` | 在 loop 周围动态补充知识和上下文。 | 学习按需上下文加载。 |
| Plugins / MCP | `src/services/plugins/`, `src/services/mcp/`, `src/tools/MCPTool/` | 外部能力进入工具面。 | 学习扩展工具协议。 |
| Session / Resume | `src/utils/sessionStorage.ts`, `src/utils/sessionRestore.ts`, `src/history.ts` | 保证 transcript、compact boundary、orphan tool_use 可恢复。 | 学习长会话可靠性。 |
| Subagent / Swarm | `src/tools/AgentTool/`, `src/utils/swarm/`, `src/tasks/` | 子 agent 复用主 loop，但隔离上下文和任务。 | 学习多 agent 架构。 |
| Observability | `src/utils/queryProfiler.ts`, `src/services/analytics/`, `src/utils/telemetry/`, `src/cost-tracker.ts` | 记录 loop、工具、成本、错误和延迟。 | 学习生产级诊断。 |

## Learning Tracks

### Track 1：Agent Loop 主干

目标：能讲清楚 Claude Code 如何完成一轮“模型 -> 工具 -> 模型”的闭环。

已完成：

- `query()` / `queryLoop()`
- `tool_use` / `tool_result`
- `QueryEngine` / `REPL` / `Tool` / `services/tools` 的初步边界

下一步补充：

- `query/deps.ts` 如何绑定生产模型调用。
- `query.ts` 中 stop hook、max turns、error recovery 的终止路径。

### Track 2：Tool Calling / Dispatcher

目标：理解工具如何从模型可见 schema 变成真实行动。

重点源码：

- `src/Tool.ts`
- `src/tools.ts`
- `src/tools/BashTool/`
- `src/tools/FileReadTool/`
- `src/tools/FileWriteTool/`
- `src/tools/FileEditTool/`
- `src/services/tools/toolExecution.ts`
- `src/services/tools/toolOrchestration.ts`

关键问题：

- 工具 schema、input parse、permission、call、result 如何串起来？
- 什么时候并发，什么时候串行？
- 工具失败如何变成模型可理解的结果？

mini-cc 下一步：

- 增加 `read_file`、`write_file`、`edit_file`。
- 把 `runTools()` 从纯串行升级为按工具安全性分组。

### Track 3：Permission / Hooks

目标：理解工具执行前后如何被安全边界约束。

重点源码：

- `src/hooks/useCanUseTool.tsx`
- `src/services/tools/toolHooks.ts`
- `src/utils/permissions/`
- `src/tools/BashTool/bashPermissions.ts`
- `src/tools/PowerShellTool/powershellPermissions.ts`

关键问题：

- permission mode 如何影响工具？
- dangerous command 如何识别？
- pre/post hook 如何阻断或修改结果？
- 用户拒绝后，模型下一轮看到什么？

mini-cc 对应：

- 加 workspace path guard。
- 加危险命令分类。
- 加 allow/deny/ask 的最小权限模型。

### Track 4：Context / Compaction

目标：理解长会话如何不被历史和工具结果撑爆。

重点源码：

- `src/services/compact/autoCompact.ts`
- `src/services/compact/compact.ts`
- `src/services/compact/microCompact.ts`
- `src/utils/toolResultStorage.ts`
- `src/query/tokenBudget.ts`
- `src/utils/sessionStorage.ts`

关键问题：

- 每轮 `messagesForQuery` 如何形成？
- tool result 如何被预算化或替换？
- compact boundary 如何保持 resume 语义？
- reactive compact 和 auto compact 有什么区别？

mini-cc 对应：

- 先做简单 token estimate。
- 保存 transcript。
- 用 summary message 替换旧历史。

### Track 5：Input / Command / Attachment

目标：理解用户输入如何变成进入模型的消息。

重点源码：

- `src/utils/processUserInput/processUserInput.ts`
- `src/utils/processUserInput/processSlashCommand.tsx`
- `src/utils/processUserInput/processTextPrompt.ts`
- `src/commands.ts`
- `src/commands/`
- `src/utils/attachments.ts`
- `src/memdir/`

关键问题：

- slash command 什么时候本地处理，什么时候进入模型？
- queued command、memory、附件如何进入上下文？
- command handler 与 agent loop 的边界在哪里？

mini-cc 对应：

- 加 `/help`、`/clear`、`/compact`。
- 加简单 command registry。

### Track 6：Skills / Plugins / MCP

目标：理解扩展能力如何进入 agent 的工具面或上下文面。

重点源码：

- `src/skills/`
- `src/services/skillSearch/`
- `src/services/plugins/`
- `src/services/mcp/`
- `src/tools/MCPTool/`
- `src/tools/SkillTool/`

关键问题：

- Skill 是上下文、工具，还是两者结合？
- Skill discovery 如何避免一次性塞满上下文？
- MCP 工具如何 normalize 并进入 `ToolUseContext.options.tools`？

mini-cc 对应：

- 加 skill index。
- 加按需读取 `SKILL.md`。
- 加 external tool provider 接口。

### Track 7：Session / Subagent / Remote

目标：理解长会话、多 agent 和远程会话如何复用主循环。

重点源码：

- `src/utils/sessionStorage.ts`
- `src/utils/sessionRestore.ts`
- `src/history.ts`
- `src/tools/AgentTool/`
- `src/utils/swarm/`
- `src/remote/`
- `src/bridge/`

关键问题：

- transcript 如何保证 `tool_use` / `tool_result` 配对？
- 子 agent 如何复用 `query()` 但隔离上下文？
- remote / bridge 如何把事件送回 UI 或外部入口？

mini-cc 对应：

- 加 conversation save/resume。
- 加 child loop，返回 summary。

### Track 8：Observability / Quality

目标：理解生产级 agent harness 如何诊断和持续改进。

重点源码：

- `src/utils/queryProfiler.ts`
- `src/services/analytics/`
- `src/utils/telemetry/`
- `src/cost-tracker.ts`
- `src/services/api/claude.ts`

关键问题：

- 每轮 query 如何打点？
- 工具调用、stream stall、cost、usage 如何记录？
- 哪些错误是用户可见，哪些是 telemetry？

mini-cc 对应：

- 加 event log。
- 加 trace span。
- 加 tool call latency 和 cost placeholder。

## Priority Queue

### P0：Agent Loop 的直接依赖

1. **Tool Dispatcher**
   - 因为没有工具协议，就无法理解 agent loop 的“行动”。
   - 下一课优先做。
2. **Permission / Tool Safety**
   - 因为 coding agent 的工具会写文件、跑 shell，权限是 harness 核心。
3. **Context / Compaction**
   - 因为真实 Claude Code 的 loop 每轮都围绕上下文预算运转。

### P1：进入模型前后的上下文面

1. **Input / Slash Commands**
   - 理解用户输入什么时候进入模型，什么时候本地处理。
2. **Attachments / Memory / Skills**
   - 理解知识如何按需注入，而不是全塞 system prompt。
3. **Session / Resume**
   - 理解长会话如何持久化和恢复。

### P2：扩展能力和多 agent

1. **Plugins / MCP**
   - 理解外部工具如何进入工具面。
2. **Subagent / Swarm**
   - 理解多 agent 如何复用主 loop。
3. **Remote / Bridge**
   - 理解非本地 UI 的会话和事件通道。

### P3：生产质量

1. **Observability / Telemetry**
2. **Cost Tracking**
3. **Streaming Watchdog / Recovery**
4. **Eval / Quality Gates**

## Recommended Study Order

1. Agent Loop：已完成第一轮。
2. Tool Dispatcher：补齐 `Tool.ts`、`tools/`、`services/tools`。
3. Permission / Hooks：补齐工具安全边界。
4. Context / Compaction：补齐长会话核心能力。
5. Input / Commands：补齐进入 loop 前的用户输入处理。
6. Skills / Attachments：补齐按需知识加载。
7. Session / Resume：补齐持久化和恢复。
8. Plugins / MCP：补齐外部工具扩展。
9. Subagent / Swarm：补齐多 agent。
10. Observability / Cost：补齐生产诊断。

## Candidate JOB-WIKI Mapping

- project candidate: project-cc
- entry candidates:
  - Agent Harness
  - Agent Loop
  - Agent工具调用与协议
  - 工具权限模型
  - 上下文工程
  - 多轮对话上下文压缩
  - Agent Skills
  - MCP 工具集成
  - AI Coding会话管理
  - Agent可观测性
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

## Source Candidates

- `raw/2026-05-14-claude-code-agent-loop.md`：已完成候选草稿。
- `2026-05-14-claude-code-tool-dispatcher.md`
- `2026-05-14-claude-code-tool-permission-hooks.md`
- `2026-05-14-claude-code-context-compaction-flow.md`
- `2026-05-14-claude-code-input-command-processing.md`
- `2026-05-14-claude-code-skills-loading.md`
- `2026-05-14-claude-code-plugin-mcp-tool-surface.md`
- `2026-05-14-claude-code-session-resume.md`
- `2026-05-14-claude-code-subagent-loop.md`
- `2026-05-14-claude-code-observability.md`

## Open Questions

- `StreamingToolExecutor` 的结果排序、取消和 context modifier 合并细节是什么？
- permission hook、pre tool hook、post tool hook 的优先级如何？
- `messagesForQuery` 在 compact、attachment、skill discovery 之后的最终形态如何确定？
- MCP 工具进入 `ToolUseContext.options.tools` 前做了哪些 normalize 和权限包装？
- 子 agent 复用 `query()` 时，哪些上下文共享，哪些隔离？
