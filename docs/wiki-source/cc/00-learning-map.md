# Claude Code 源码学习地图

## TL;DR

本项目采用 **机制锚定 + frontier 扩展 + 注释驱动** 的学习方式：先完成当前机制的源码阅读和 `mini-cc` 最小实现，再把它牵出的后续学习点写回本文件。

当前状态：

- 已完成节点：`Agent Loop`、`Anthropic Provider + Bash`
- 当前推荐节点：`Permission / Tool Safety` 或 `Streaming Provider`
- `mini-cc` 状态：已完成第一课最小 agent loop，并在第二课接入 Anthropic-compatible Messages API；现在是一次启动、持续输入的交互式 harness，可由真实模型发起 `bash` tool call
- 文档状态：Agent Loop 与 Anthropic Provider 已有 analysis / build-along；后续主题 raw 仍只在用户明确要求时生成

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
| 节点 | Anthropic Provider + Bash |
| 核心问题 | 如何把第一课 mock provider 换成真实 Anthropic-compatible Messages API，并让模型驱动最小 bash 操作？ |
| 源码结论 | Claude Code 的模型边界集中在 Anthropic client / Messages API；工具 schema 以 `name / description / input_schema` 暴露，loop 继续信号仍来自 content block 中的 `tool_use`。 |
| mini-cc 结果 | Lesson 02 新增 `AnthropicMessagesProvider`，并直接增强既有 `main.ts` 入口为持续交互 REPL；`QueryEngine` 保存跨输入 transcript，mock provider 在入口中注释保留，真实模型成为默认路径。 |
| 注释路径 | `L02-S01` 到 `L02-S08` |
| 后续牵引 | Permission / Tool Safety、Streaming Provider、Tool Dispatcher |

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
| `src/QueryEngine.ts:675` | `for await (const message of query(...))` | SDK/headless 入口复用核心 loop。 |
| `src/screens/REPL.tsx:2793` | `for await (const event of query(...))` | REPL 入口复用核心 loop。 |

详细阅读过程见：

- `docs/wiki-source/cc/analysis/claude-code-agent-loop.md`
- `docs/build-along/cc/01-agent-loop.md`
- `docs/wiki-source/cc/analysis/claude-code-anthropic-provider-tool-use.md`
- `docs/build-along/cc/02-anthropic-provider-bash.md`

## Frontier Queue

| 优先级 | Frontier | 类型 | 为什么由 Agent Loop 牵出 | mini-cc 影响 | 预期产物 |
|---|---|---|---|---|---|
| P0 | Permission / Tool Safety | 要学习 / 要优化 | 第二课已经让真实模型可以驱动 bash，安全边界立刻成为核心约束。 | 增加 path guard、危险命令分类、allow/deny/ask。 | Lesson 03；permission hooks analysis。 |
| P0 | Streaming Provider | 要学习 / 要拓展 | 第二课只做非 streaming；真实 Claude Code 主路径会处理 streaming chunk 和 `input_json_delta`。 | 增加 stream adapter，把 chunk 聚合成 `ContentBlock[]`。 | Lesson 03/04；analysis；raw 仅用户要求时生成。 |
| P0 | Tool Dispatcher | 要学习 / 要拓展 | Agent Loop 已能识别 `tool_use`，但真正行动依赖工具 schema、查找、执行、结果映射和调度。 | 增加 `read_file`、`write_file`、`edit_file`，扩展 `services/tools`。 | 后续 lesson；analysis；raw 仅用户要求时生成。 |
| P0 | Context / Compaction | 要学习 / 要拓展 | 每轮 loop 都把 transcript 送回模型，长会话必须处理预算和压缩。 | 增加 token estimate、transcript、summary message。 | 后续 lesson；analysis；raw 仅用户要求时生成。 |
| P1 | Input / Slash Commands | 要学习 / 要拓展 | `query()` 前还有 slash command、附件、memory 和本地命令处理。 | 增加 command registry、`/help`、`/clear`、`/compact`。 | input command analysis。 |
| P1 | Session / Resume | 要学习 / 要优化 | transcript 是事实源，恢复必须保持 `tool_use` / `tool_result` 配对。 | 增加 conversation save/resume。 | analysis；raw 仅用户要求时生成。 |
| P2 | Skills / Plugins / MCP | 要学习 / 要拓展 | 外部知识和外部工具最终会进入上下文面或工具面。 | 增加 skill index、external tool provider。 | analysis；raw 仅用户要求时生成。 |
| P2 | Subagent / Swarm | 要学习 / 要拓展 | 子 agent 复用主 loop，但需要隔离上下文和任务。 | 增加 child loop 和 summary return。 | analysis；raw 仅用户要求时生成。 |
| P3 | Observability / Recovery | 要优化 | 生产级 loop 需要 max turns、错误恢复、stream watchdog、cost、telemetry。 | 增加 event log、trace span、latency placeholder。 | analysis；raw 仅用户要求时生成。 |

## Priority Queue

### P0：Agent Loop 的直接依赖

1. **Permission / Tool Safety**
   - 真实模型接入 bash 后优先做。
   - 目标：理解工具调用前后的安全边界。
   - 预期注释：`L03-Sxx`。
2. **Streaming Provider**
   - 目标：理解真实 Claude Code streaming 下 chunk / `partial_json` 如何聚合成完整 content block。
   - 预期注释：`L03-Sxx` 或 `L04-Sxx`。
3. **Tool Dispatcher**
   - 目标：理解工具如何从 schema 变成真实行动。
   - 预期注释：`L04-Sxx`。
4. **Context / Compaction**
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
| Model Provider / API | 理解 transcript 和工具 schema 如何进入 Anthropic Messages API。 | `src/services/api/client.ts`, `src/services/api/claude.ts`, `src/utils/api.ts` | 已完成非 streaming Anthropic provider。 |
| Tool Calling / Dispatcher | 理解工具如何从 schema 变成真实行动。 | `src/Tool.ts`, `src/tools.ts`, `src/tools/`, `src/services/tools/` | 增加文件工具和调度策略。 |
| Permission / Hooks | 理解工具执行前后的安全和 hook 边界。 | `src/hooks/useCanUseTool.tsx`, `src/services/tools/toolHooks.ts`, `src/utils/permissions/` | 增加 path guard 和权限模型。 |
| Context / Compaction | 理解长会话如何控制上下文预算。 | `src/services/compact/`, `src/query/tokenBudget.ts`, `src/utils/toolResultStorage.ts` | 增加 transcript 和 summary。 |
| Input / Commands | 理解用户输入如何进入 loop。 | `src/utils/processUserInput/`, `src/commands.ts`, `src/commands/` | 增加 command registry。 |
| Skills / Plugins / MCP | 理解外部知识和外部工具如何进入上下文 / 工具面。 | `src/skills/`, `src/services/plugins/`, `src/services/mcp/`, `src/tools/MCPTool/` | 增加 skill index 和 external provider。 |
| Session / Subagent / Remote | 理解长会话、多 agent、远程入口如何复用主 loop。 | `src/utils/sessionStorage.ts`, `src/tools/AgentTool/`, `src/remote/`, `src/bridge/` | 增加 save/resume 和 child loop。 |
| Observability / Quality | 理解 loop、工具、成本和错误如何被诊断。 | `src/utils/queryProfiler.ts`, `src/services/analytics/`, `src/cost-tracker.ts` | 增加 event log 和 trace span。 |

## Next Lesson：Permission / Tool Safety 或 Streaming Provider

### Learning Questions

- 真实模型能调用 bash 后，哪些命令必须被拒绝、询问或限制？
- Claude Code 的 permission hook 如何插入工具执行前后？
- streaming provider 中，`content_block_start`、`input_json_delta`、`content_block_stop` 如何聚合成完整 `tool_use`？
- streaming 失败时，Claude Code 为什么需要 fallback / discard pending results？

### Recommended Source Entry

- `src/tools/BashTool/bashPermissions.ts`
- `src/tools/BashTool/bashSecurity.ts`
- `src/hooks/useCanUseTool.tsx`
- `src/services/tools/toolHooks.ts`
- `src/services/api/claude.ts`
- `src/utils/messages.ts`
- `src/services/tools/toolExecution.ts`
- `src/services/tools/StreamingToolExecutor.ts`

### Expected mini-cc Work

- 把 BashTool 的危险命令拦截拆出安全模块。
- 给工具执行前增加最小 permission decision。
- 或者先实现非执行型 streaming adapter，把 API chunk 聚合成 `ContentBlock[]`。
- 保持 `query.ts` 不直接拥有安全策略或 streaming 细节。
- 增加 `L03-Sxx` 注释路径和 Lesson 03 build-along 文档。

## Source Index

| 主题 | 状态 | analysis | build-along | raw |
|---|---|---|---|---|
| Agent Loop | 完成 | `docs/wiki-source/cc/analysis/claude-code-agent-loop.md` | `docs/build-along/cc/01-agent-loop.md` | `docs/wiki-source/cc/raw/2026-05-14-claude-code-agent-loop.md` |
| Anthropic Provider + Bash | 完成 | `docs/wiki-source/cc/analysis/claude-code-anthropic-provider-tool-use.md` | `docs/build-along/cc/02-anthropic-provider-bash.md` | `docs/wiki-source/cc/raw/2026-05-15-claude-code-anthropic-provider-bash.md` |
| Permission / Tool Safety | 待开始 | `docs/wiki-source/cc/analysis/claude-code-permission-tool-safety.md` | `docs/build-along/cc/03-permission-tool-safety.md` | 仅用户明确要求时生成 |
| Streaming Provider | 待开始 | `docs/wiki-source/cc/analysis/claude-code-streaming-provider.md` | `docs/build-along/cc/03-streaming-provider.md` | 仅用户明确要求时生成 |
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
