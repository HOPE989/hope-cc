# Claude Code 源码学习地图

## TL;DR

本项目采用 **机制锚定 + frontier 扩展 + 注释驱动** 的学习方式：先完成当前机制的源码阅读和 `mini-cc` 最小实现，再把它牵出的后续学习点写回本文件。

当前状态：

- 已完成节点：`Agent Loop`、`Anthropic Provider + Bash`、`Permission / Tool Safety`
- 当前推荐节点：`Streaming Provider` 或 `Tool Dispatcher`
- `mini-cc` 状态：已完成第一课最小 agent loop、第二课 Anthropic-compatible Messages API、第三课最小工具权限层；现在真实模型发起 `bash` tool call 前会先经过 allow / ask / deny 决策
- 文档状态：Agent Loop、Anthropic Provider、Permission / Tool Safety 已有 analysis / build-along；Permission / Tool Safety raw 已按用户要求生成，后续主题 raw 仍只在用户明确要求时生成

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
-> 沉淀 analysis / build-along
-> 用户明确要求时再生成 raw
-> 回写 frontier
```

frontier 分类：

- `要学习`：需要继续精读 Claude Code 源码的机制。
- `要拓展`：需要在 `mini-cc` 中新增的能力。
- `要优化`：已有 `mini-cc` 能力后续要接近 Claude Code 的地方。

## Current Node

| 项目 | 内容 |
|---|---|
| 节点 | Permission / Tool Safety |
| 核心问题 | 真实模型能发起 `bash` 后，系统如何在执行前决定 allow / ask / deny，并把拒绝结果回填给模型？ |
| 源码结论 | Claude Code 的权限边界在工具执行前：工具级 `checkPermissions` 产出 `PermissionResult`，统一 `hasPermissionsToUseTool` 合成最终决策，非 allow 会作为错误 `tool_result` 回填。Bash 权限检查还包含规则、路径约束、子命令和 shell 安全解析。 |
| mini-cc 结果 | Lesson 03 新增 `PermissionResult` 类型、统一 `hasPermissionToUseTool()`、`bashSafety.ts` 和交互式 ask；`BashTool.call()` 不再持有危险命令判断。 |
| 注释路径 | `L03-S01` 到 `L03-S23` |
| 后续牵引 | Streaming Provider、Tool Dispatcher、Permission Hooks |

## Current Node Evidence

| 源码位置 | 关键符号 | 说明 |
|---|---|---|
| `src/query.ts:219` | `query()` | 核心 loop 暴露为异步生成器。 |
| `src/query.ts:241` | `queryLoop()` | 真正的 agent loop 实现。 |
| `src/query.ts:307` | `while (true)` | 主循环是跨轮状态机。 |
| `src/query.ts:557` | `toolUseBlocks` / `needsFollowUp` | `tool_use` 是继续下一轮的核心信号。 |
| `src/services/api/client.ts:88` | `getAnthropicClient()` | Anthropic SDK client 创建入口。 |
| `src/services/api/claude.ts:864` | `anthropic.beta.messages.create(...)` | 非 streaming 模型请求使用 Messages API。 |
| `src/services/api/claude.ts:1822` | `anthropic.beta.messages.create({ stream: true })` | 主路径使用 streaming Messages API。 |
| `src/utils/api.ts:136` | tool schema | 工具 schema 以 `name / description / input_schema` 暴露。 |
| `src/query.ts:1382` | `runTools()` / `StreamingToolExecutor` | 工具执行从主 loop 下沉到服务层。 |
| `src/Tool.ts:158` | `ToolUseContext` | 工具执行上下文边界。 |
| `src/services/tools/toolExecution.ts:800` | `runPreToolUseHooks()` | 工具执行前先跑 PreToolUse hooks。 |
| `src/services/tools/toolExecution.ts:921` | `resolveHookPermissionDecision()` | hook 结果和 `canUseTool` 合成最终权限决策。 |
| `src/services/tools/toolExecution.ts:995` | permission decision gate | 非 allow 决策不会执行工具。 |
| `src/utils/permissions/permissions.ts:473` | `hasPermissionsToUseTool()` | 主 permission 决策入口。 |
| `src/tools/BashTool/bashPermissions.ts:1663` | `bashToolHasPermission()` | Bash 工具级权限检查入口。 |
| `src/QueryEngine.ts:675` | `for await (const message of query(...))` | SDK/headless 入口复用核心 loop。 |
| `src/screens/REPL.tsx:2793` | `for await (const event of query(...))` | REPL 入口复用核心 loop。 |

详细阅读过程见：

- `docs/wiki-source/cc/analysis/claude-code-agent-loop.md`
- `docs/build-along/cc/01-agent-loop.md`
- `docs/wiki-source/cc/analysis/claude-code-anthropic-provider-tool-use.md`
- `docs/build-along/cc/02-anthropic-provider-bash.md`
- `docs/wiki-source/cc/analysis/claude-code-permission-tool-safety.md`
- `docs/build-along/cc/03-permission-tool-safety.md`

## Frontier Queue

| 优先级 | Frontier | 类型 | 为什么由 Agent Loop 牵出 | mini-cc 影响 | 预期产物 |
|---|---|---|---|---|---|
| P0 | Streaming Provider | 要学习 / 要拓展 | 第二课只做非 streaming；真实 Claude Code 主路径会处理 streaming chunk 和 `input_json_delta`。 | 增加 stream adapter，把 chunk 聚合成 `ContentBlock[]`。 | Lesson 04；analysis；raw 仅用户要求时生成。 |
| P0 | Tool Dispatcher | 要学习 / 要拓展 | Agent Loop 已能识别 `tool_use`，Lesson 03 已有最小权限层；下一步可以扩展工具 schema、查找、执行、结果映射和调度。 | 增加 `read_file`、`write_file`、`edit_file`，复用 permission pipeline。 | 后续 lesson；analysis；raw 仅用户要求时生成。 |
| P0 | Permission Hooks | 要学习 / 要拓展 | Lesson 03 只做静态 permission decision；Claude Code 在执行前后还有 PreToolUse / PostToolUse / PermissionRequest hooks。 | 增加最小 hook registry，并让 hook 不能绕过 hard deny。 | 后续 lesson；analysis；raw 仅用户要求时生成。 |
| P0 | Context / Compaction | 要学习 / 要拓展 | 每轮 loop 都把 transcript 送回模型，长会话必须处理预算和压缩。 | 增加 token estimate、transcript、summary message。 | 后续 lesson；analysis；raw 仅用户要求时生成。 |
| P1 | Input / Slash Commands | 要学习 / 要拓展 | `query()` 前还有 slash command、附件、memory 和本地命令处理。 | 增加 command registry、`/help`、`/clear`、`/compact`。 | input command analysis。 |
| P1 | Session / Resume | 要学习 / 要优化 | transcript 是事实源，恢复必须保持 `tool_use` / `tool_result` 配对。 | 增加 conversation save/resume。 | analysis；raw 仅用户要求时生成。 |
| P2 | Skills / Plugins / MCP | 要学习 / 要拓展 | 外部知识和外部工具最终会进入上下文面或工具面。 | 增加 skill index、external tool provider。 | analysis；raw 仅用户要求时生成。 |
| P2 | Subagent / Swarm | 要学习 / 要拓展 | 子 agent 复用主 loop，但需要隔离上下文和任务。 | 增加 child loop 和 summary return。 | analysis；raw 仅用户要求时生成。 |
| P3 | Observability / Recovery | 要优化 | 生产级 loop 需要 max turns、错误恢复、stream watchdog、cost、telemetry。 | 增加 event log、trace span、latency placeholder。 | analysis；raw 仅用户要求时生成。 |

## Priority Queue

### P0：Agent Loop 的直接依赖

1. **Streaming Provider**
   - 目标：理解真实 Claude Code streaming 下 chunk / `partial_json` 如何聚合成完整 content block。
   - 预期注释：`L04-Sxx`。
2. **Tool Dispatcher**
   - 目标：理解工具如何从 schema 变成真实行动。
   - 预期注释：`L04-Sxx` 或 `L05-Sxx`。
3. **Permission Hooks**
   - 目标：在 Lesson 03 静态权限层之后理解 PreToolUse / PostToolUse / PermissionRequest hooks。
   - 预期注释：`L05-Sxx`。
4. **Context / Compaction**
   - 工具闭环跑通后进入。
   - 目标：理解 `messagesForQuery` 如何形成和压缩。
   - 预期注释：`L05-Sxx` 或 `L06-Sxx`。

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
| Model Provider / API | 理解 transcript 和工具 schema 如何进入 Anthropic Messages API。 | `src/services/api/client.ts`, `src/services/api/claude.ts`, `src/utils/api.ts` | 已完成非 streaming Anthropic provider。 |
| Tool Calling / Dispatcher | 理解工具如何从 schema 变成真实行动。 | `src/Tool.ts`, `src/tools.ts`, `src/tools/`, `src/services/tools/` | 增加文件工具和调度策略。 |
| Permission / Hooks | 理解工具执行前后的安全和 hook 边界。 | `src/hooks/useCanUseTool.tsx`, `src/services/tools/toolHooks.ts`, `src/utils/permissions/` | 已完成最小 permission decision；hooks 待拓展。 |
| Context / Compaction | 理解长会话如何控制上下文预算。 | `src/services/compact/`, `src/query/tokenBudget.ts`, `src/utils/toolResultStorage.ts` | 增加 transcript 和 summary。 |
| Input / Commands | 理解用户输入如何进入 loop。 | `src/utils/processUserInput/`, `src/commands.ts`, `src/commands/` | 增加 command registry。 |
| Skills / Plugins / MCP | 理解外部知识和外部工具如何进入上下文 / 工具面。 | `src/skills/`, `src/services/plugins/`, `src/services/mcp/`, `src/tools/MCPTool/` | 增加 skill index 和 external provider。 |
| Session / Subagent / Remote | 理解长会话、多 agent、远程入口如何复用主 loop。 | `src/utils/sessionStorage.ts`, `src/tools/AgentTool/`, `src/remote/`, `src/bridge/` | 增加 save/resume 和 child loop。 |
| Observability / Quality | 理解 loop、工具、成本和错误如何被诊断。 | `src/utils/queryProfiler.ts`, `src/services/analytics/`, `src/cost-tracker.ts` | 增加 event log 和 trace span。 |

## Next Lesson：Streaming Provider 或 Tool Dispatcher

### Learning Questions

- streaming provider 中，`content_block_start`、`input_json_delta`、`content_block_stop` 如何聚合成完整 `tool_use`？
- streaming 失败时，Claude Code 为什么需要 fallback / discard pending results？
- 文件工具进入 dispatcher 后，如何复用 Lesson 03 的 permission pipeline？
- Claude Code 的 permission hook 如何插入工具执行前后？

### Recommended Source Entry

- `src/services/api/claude.ts`
- `src/utils/messages.ts`
- `src/services/tools/toolExecution.ts`
- `src/services/tools/StreamingToolExecutor.ts`
- `src/tools.ts`
- `src/tools/`
- `src/services/tools/toolHooks.ts`

### Expected mini-cc Work

- 先实现非执行型 streaming adapter，把 API chunk 聚合成 `ContentBlock[]`。
- 或者新增 read/write/edit 工具，并让文件写入复用 permission decision。
- 保持 `query.ts` 不直接拥有安全策略或 streaming 细节。
- 增加 `L04-Sxx` 注释路径和 Lesson 04 build-along 文档。

## Source Index

| 主题 | 状态 | analysis | build-along | raw |
|---|---|---|---|---|
| Agent Loop | 完成 | `docs/wiki-source/cc/analysis/claude-code-agent-loop.md` | `docs/build-along/cc/01-agent-loop.md` | `docs/wiki-source/cc/raw/2026-05-14-claude-code-agent-loop.md` |
| Anthropic Provider + Bash | 完成 | `docs/wiki-source/cc/analysis/claude-code-anthropic-provider-tool-use.md` | `docs/build-along/cc/02-anthropic-provider-bash.md` | `docs/wiki-source/cc/raw/2026-05-15-claude-code-anthropic-provider-bash.md` |
| Permission / Tool Safety | 完成 | `docs/wiki-source/cc/analysis/claude-code-permission-tool-safety.md` | `docs/build-along/cc/03-permission-tool-safety.md` | `docs/wiki-source/cc/raw/2026-05-15-claude-code-permission-tool-safety.md` |
| Streaming Provider | 待开始 | `docs/wiki-source/cc/analysis/claude-code-streaming-provider.md` | `docs/build-along/cc/04-streaming-provider.md` | 仅用户明确要求时生成 |
| Tool Dispatcher | 待开始 | `docs/wiki-source/cc/analysis/claude-code-tool-dispatcher.md` | 待定 | 仅用户明确要求时生成 |

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
