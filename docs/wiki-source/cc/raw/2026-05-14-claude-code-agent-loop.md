# Claude Code Agent Loop 主循环机制

## TL;DR

我通过精读 Claude Code 的 `src/query.ts`、`src/QueryEngine.ts`、`src/screens/REPL.tsx`、`src/Tool.ts` 和 `src/services/tools/`，复原了 Agent Loop 的核心设计：它不是一次模型调用，而是一个以 transcript 为事实源的异步状态机，通过 `tool_use` / `tool_result` 协议驱动“模型输出 -> 工具执行 -> 结果回填 -> 下一轮模型调用”。

基于这条源码链路，我完成了 `mini-cc` 第一课，保留入口包装、核心 loop、模型 provider、工具协议、工具调度和具体工具边界，并用 `L01-S01` 到 `L01-S25` 的代码注释形成可复盘学习路径。

## Learning Question

这次学习最初要解决的问题是：如果我要渐进式实现一个 Claude Code-like coding agent，第一步应该写什么？

过于简单的答案是：

```text
用户输入 -> 调模型 -> 如果模型说要执行命令，就执行命令 -> 打印结果
```

但这个答案解释不了 Claude Code 为什么要有 `query.ts`、`QueryEngine.ts`、`Tool.ts`、`services/tools` 这些边界。真正的问题应该是：

- Claude Code 的核心 loop 在哪里？
- 这个 loop 如何判断下一轮是否继续？
- 模型请求工具调用时，工具请求用什么结构表示？
- 工具结果如何回填到模型上下文？
- UI / SDK 为什么能复用同一个 loop？
- 第一版 `mini-cc` 应该保留哪些架构边界，哪些复杂度可以暂时省略？

## Reading Path

我按“先找主循环，再找入口，再找工具协议，再找工具执行”的顺序读源码。

1. 搜索 `query`、`queryLoop`、`while (true)`，定位到 `src/query.ts`。
2. 在 `src/query.ts:219` 看到 `query()` 是异步生成器入口，在 `src/query.ts:241` 看到 `queryLoop()` 是核心实现。
3. 在 `src/query.ts:307` 看到显式 `while (true)`，确认它是跨轮状态机。
4. 搜索谁消费 `query()`，在 `src/QueryEngine.ts:675` 看到 SDK/headless 入口用 `for await` 消费 query 事件，在 `src/screens/REPL.tsx:2793` 看到 REPL 也进入 `query()`。
5. 继续追 `tool_use`，在 `src/query.ts:557` 看到 `toolUseBlocks` 和 `needsFollowUp`。
6. 继续追工具执行，在 `src/query.ts:1382` 看到进入 `runTools()` 或 `StreamingToolExecutor`，在 `src/services/tools/toolOrchestration.ts:19` 看到工具调度层。
7. 最后回到 `src/Tool.ts:158` 看 `ToolUseContext`，确认工具不是裸函数，而是运行在会话上下文里。

## Discovery Log

1. `query()` 是 `AsyncGenerator`。这说明 Claude Code 需要持续输出中间事件，而不是只返回最终答案。
2. `queryLoop()` 里有 `while (true)`。这说明 agent 的一次用户请求可能包含多轮模型调用。
3. `toolUseBlocks` 和 `needsFollowUp` 决定是否继续。继续条件来自 transcript 中的结构化工具请求。
4. 工具执行进入 `runTools()` / `StreamingToolExecutor`。主 loop 不负责具体工具细节。
5. `ToolUseContext` 把工具调用和 cwd、权限、会话状态、MCP、abort 等运行上下文连接起来。
6. `QueryEngine` 和 `REPL` 都消费 `query()`。交互形态和 agent 状态推进被拆开。

这些发现把第一课设计从“写一个脚本”推到了“搭一个可演进的 harness 骨架”。

## Study Scope

覆盖范围：

- `query()` / `queryLoop()` 主状态机。
- `tool_use` / `tool_result` 协议。
- REPL / SDK / headless 与核心 loop 的关系。
- 工具执行边界。
- `mini-cc` 第一课的架构推导和注释驱动实现。

不覆盖范围：

- 上下文压缩算法。
- permission / hook 完整链路。
- `StreamingToolExecutor` 的完整并发模型。
- Claude Code 所有工具内部实现。

## Source Evidence

| 源码位置 | 关键符号 / 线索 | 证明了什么 |
|---|---|---|
| `src/query.ts:219` | `query()` | 核心 loop 暴露为异步生成器。 |
| `src/query.ts:241` | `queryLoop()` | 真正的 agent loop 实现。 |
| `src/query.ts:307` | `while (true)` | 主循环是显式状态机。 |
| `src/query.ts:557` | `toolUseBlocks` / `needsFollowUp` | 真实 `tool_use` 是继续下一轮的核心信号。 |
| `src/query.ts:1382` | `runTools()` / `StreamingToolExecutor` | 工具执行从主 loop 下沉到工具服务层。 |
| `src/QueryEngine.ts:675` | `for await (const message of query(...))` | SDK/headless 入口复用核心 loop。 |
| `src/screens/REPL.tsx:2793` | `for await (const event of query(...))` | REPL 入口复用核心 loop。 |
| `src/Tool.ts:158` | `ToolUseContext` | 工具执行依赖会话上下文。 |
| `src/services/tools/toolOrchestration.ts:19` | `runTools()` | 工具调度有独立边界。 |

## Design Reconstruction

Claude Code 的设计可以从三个核心压力推导出来。

第一，coding agent 需要跨轮执行。模型第一次输出可能不是最终答案，而是 `tool_use`。工具执行后，结果必须作为 `tool_result` 回到 transcript，模型才能继续推理。因此主 loop 必须围绕消息协议设计。

第二，coding agent 需要多入口复用。REPL、SDK、headless 模式都需要跑同一个 agent loop。如果把 loop 写进 UI，SDK 就无法复用；如果把 SDK 逻辑写进 loop，UI 状态又会污染核心状态机。所以 Claude Code 让 `query.ts` 做核心 loop，让 `QueryEngine.ts` 和 `REPL.tsx` 做入口包装。

第三，工具执行复杂度会持续增长。第一眼看工具执行只是 `tool.call()`，但生产系统里还有权限、hook、并发安全、取消、错误恢复、结果展示、context modifier。把这些复杂度放进 `query.ts` 会让主状态机失控，所以 Claude Code 把工具执行拆到 `services/tools`。

## Mechanism Walkthrough

```text
入口层构造 messages / system prompt / ToolUseContext
-> 调用 query(params)
-> queryLoop 初始化 State
-> while true
-> 根据 state.messages 准备本轮模型输入
-> 调模型 streaming
-> 收集 assistant message
-> 如果没有 tool_use：完成或进入停止 / 恢复路径
-> 如果有 tool_use：交给工具执行层
-> 工具结果变成 tool_result
-> tool_result 作为 user message 追加到 transcript
-> 进入下一轮
```

关键点是：`tool_use` 和 `tool_result` 不是日志，而是协议。`tool_result.tool_use_id` 必须回连到 `tool_use.id`，否则下一轮模型无法知道哪个工具请求得到了哪个结果。

## Architecture Notes

- `src/query.ts`：核心状态机，负责推进 agent turn。
- `src/QueryEngine.ts`：SDK/headless 会话包装，消费 query 事件。
- `src/screens/REPL.tsx`：交互式 UI，负责输入、显示、权限弹窗和 app state。
- `src/services/api/claude.ts`：模型 streaming 适配层。
- `src/Tool.ts`：工具协议和工具上下文。
- `src/services/tools/`：工具调度和执行。
- `src/tools/`：具体工具实现。

## Key Data Structures

- `State`：跨轮状态，保存 messages、turn count、恢复状态、压缩状态等。
- `ToolUseContext`：工具执行上下文，后续权限、MCP、abort、UI 更新都依赖它。
- `ToolUseBlock`：模型发出的工具调用请求。
- `ToolResultBlock`：工具执行结果，通过 `tool_use_id` 回连。
- `QueryEvent`：核心 loop 向入口层发出的事件。

## Design Decisions & Trade-offs

- 用 `AsyncGenerator` 暴露事件流，而不是 Promise 返回最终答案。
- 用显式 `State` 和 `while (true)` 管理跨轮状态，而不是递归或散落变量。
- 用结构化 `tool_use` 判断是否继续，而不是只相信 `stop_reason`。
- 工具执行独立到 `services/tools`，为权限、hook、并发和错误恢复留边界。
- 工具失败也应尽量变成协议内结果，维护 transcript 合法性。

## Build-Along Derivation

基于源码事实，我把 `mini-cc` 第一课拆成这些文件：

| mini-cc 文件 | 对应 Claude Code 边界 | 学习目的 |
|---|---|---|
| `mini-cc/src/main.ts` | CLI / headless 入口 | 提供最小可运行入口。 |
| `mini-cc/src/QueryEngine.ts` | `src/QueryEngine.ts` / REPL query 入口 | 保留入口包装层。 |
| `mini-cc/src/query.ts` | `src/query.ts` | 实现最小主循环。 |
| `mini-cc/src/types.ts` | 消息和事件协议 | 明确 `tool_use` / `tool_result`。 |
| `mini-cc/src/Tool.ts` | `src/Tool.ts` | 定义工具协议和上下文。 |
| `mini-cc/src/services/api/mockClaude.ts` | 模型 provider | 隔离模型调用，便于测试。 |
| `mini-cc/src/services/tools/toolOrchestration.ts` | 工具调度层 | 保留后续并发和安全分组位置。 |
| `mini-cc/src/services/tools/toolExecution.ts` | 单工具执行层 | 保留工具查找和结果映射边界。 |
| `mini-cc/src/tools/BashTool.ts` | `src/tools/` | 放具体工具实现。 |

## Annotated Code Walkthrough

第一课代码注释从 `L01-S01` 到 `L01-S25`，完整 walkthrough 见 `docs/build-along/cc/01-agent-loop.md`。这里保留可摄入摘要：

| 阶段 | 注释范围 | 学习重点 |
|---|---|---|
| 启动与入口包装 | `L01-S01` 到 `L01-S05` | 用户输入如何进入 `QueryEngine`，入口层如何消费 `query()` 事件。 |
| 协议与工具边界 | `L01-S06` 到 `L01-S10` | `text`、`tool_use`、`tool_result`、`ToolUseContext` 和工具注册表。 |
| Agent Loop 主状态机 | `L01-S11` 到 `L01-S18` | `query()` / `queryLoop()`、messages、max turns、工具调度和结果回填。 |
| Mock Model 与工具执行 | `L01-S19` 到 `L01-S25` | mock provider 如何触发工具请求，工具如何查找、执行、映射为 `tool_result`。 |

## What I Practiced

- 从 `src/query.ts` 定位 Claude Code 主 loop。
- 追踪 REPL 和 SDK/headless 如何复用 `query()`。
- 追踪 `tool_use` 如何进入 `runTools()`。
- 把源码中的架构边界映射到 `mini-cc`。
- 实现并验证最小闭环：`prompt -> tool_use -> bash -> tool_result -> final answer`。

## Difference From Claude Code

- `mini-cc` 使用 mock model，不接真实 Claude API。
- `mini-cc` 没有 streaming block。
- `mini-cc` 的 `ToolUseContext` 只有 `cwd`。
- `mini-cc` 的 `runTools()` 只串行执行。
- `mini-cc` 没有 permission、hook、context compaction、session resume。

## Failure Modes

- 如果 `tool_use.id` 和 `tool_result.tool_use_id` 不匹配，下一轮模型无法可靠理解工具结果。
- 如果工具失败不回填为 `tool_result`，transcript 会中断。
- 如果具体工具逻辑写进 `query.ts`，后续权限和并发会污染主 loop。
- 如果入口层和 loop 耦合，SDK、REPL 和测试无法复用同一机制。

## Candidate JOB-WIKI Mapping

- project candidate: `project-cc`
- entry candidates:
  - Agent Harness
  - Agent Loop
  - Agent 工具调用协议
  - AI Coding 会话管理
- question candidates:
  - Agent loop 的最小协议是什么？
  - 为什么 `tool_use` / `tool_result` 是 Agent Harness 的核心？
  - 如何设计可扩展的工具执行层？
  - UI / SDK 如何复用同一个 agent loop？
- scenario candidates:
  - 工具执行失败后的 transcript 恢复。
  - 多工具调用的顺序和副作用安全。
  - UI / SDK 复用同一个 agent loop。

## Weak Spots / TODO

- 待继续精读 `StreamingToolExecutor`。
- 待继续精读 permission / hook 如何介入 `runToolUse()`。
- 待继续精读 context compaction 如何在每轮模型调用前改写 `messagesForQuery`。
- `mini-cc` 还缺少自动化测试。

## Suggested Ingest Plan

- 新建 source 页：`src-2026-05-14-claude-code-agent-loop`
- 更新 project 页：`project-cc`
- 候选 entry 方向：Agent Harness、Agent Loop、Agent 工具调用协议、AI Coding 会话管理
- 候选 question 方向：Agent loop 最小协议、tool_use/tool_result 配对、UI/SDK 与核心 loop 解耦
- 候选 scenario 方向：工具失败恢复、多工具顺序和并发安全、入口层复用核心 loop
- 需要 JOB-WIKI ingest 阶段确认 / 合并的页面：是否已有 Agent Loop、Agent Harness、工具调用协议相关词条
