# Claude Code Agent Loop 源码分析

## Learning Question

这次源码阅读要回答的问题是：Claude Code-like coding agent 的最小主循环到底是什么，为什么它不能只是“一次模型调用 + 打印结果”？

这个问题需要拆成几个更具体的设计问题：

- 用户输入从 CLI / REPL / headless 入口如何进入核心 loop？
- 核心 loop 如何跨轮保存状态？
- 模型请求工具调用时，工具请求如何表示？
- 工具结果如何回填给下一轮模型？
- 工具执行为什么不直接写在 `query.ts` 里？
- 这套边界如何指导 `mini-cc` 第一课？

## Reading Path

阅读顺序不是从 CLI 顶层一路扫到底，而是先找机制中心，再向两侧展开。

1. 搜索 `query`、`queryLoop`、`while (true)`，定位 `src/query.ts`。
2. 在 `src/query.ts:219` 找到 `query()`，在 `src/query.ts:241` 找到 `queryLoop()`。
3. 在 `src/query.ts:307` 看到显式 `while (true)`，确认这是跨轮状态机。
4. 反向搜索谁消费 `query()`：在 `src/screens/REPL.tsx:2793` 看到 REPL 入口，在 `src/QueryEngine.ts:675` 看到 SDK/headless 入口。
5. 向上追交互输入链路：`src/entrypoints/cli.tsx`、`src/main.tsx`、`src/replLauncher.tsx`、`src/screens/REPL.tsx`、`src/utils/handlePromptSubmit.ts`。
6. 回到 `src/query.ts` 追 `tool_use`：在 `src/query.ts:557` 附近看到 `toolUseBlocks` / `needsFollowUp`。
7. 继续追工具执行：在 `src/query.ts:1382` 看到 `runTools()` / `StreamingToolExecutor`，再进入 `src/services/tools/`。
8. 最后看 `src/Tool.ts:158` 的 `ToolUseContext`，确认工具执行上下文边界。

这条路径把分析焦点固定在 Agent Loop，而不是泛读整个 CLI。

## Discovery Log

1. **`query()` 是异步生成器**
   - 位置：`src/query.ts:219`
   - 发现：核心 loop 以事件流形式对外暴露。
   - 含义：REPL、SDK、headless 可以消费同一条状态流，而不是等待最终字符串。

2. **`queryLoop()` 是真正状态机**
   - 位置：`src/query.ts:241`、`src/query.ts:307`
   - 发现：`queryLoop()` 内部有显式 `while (true)`。
   - 含义：一次用户请求可能触发多轮“模型 -> 工具 -> 模型”。

3. **继续条件依赖结构化 `tool_use`**
   - 位置：`src/query.ts:557`
   - 发现：`toolUseBlocks` / `needsFollowUp` 决定是否继续。
   - 含义：主 loop 看 transcript 中的真实工具请求，而不是只看高层 stop reason。

4. **工具执行从主 loop 下沉到服务层**
   - 位置：`src/query.ts:1382`、`src/services/tools/toolOrchestration.ts:19`
   - 发现：工具执行进入 `runTools()` 或 `StreamingToolExecutor`。
   - 含义：并发、权限、hook、错误恢复等复杂度不应堆进 `query.ts`。

5. **工具不是裸函数**
   - 位置：`src/Tool.ts:158`
   - 发现：`ToolUseContext` 是工具执行边界。
   - 含义：工具执行依赖 cwd、权限、会话状态、MCP、abort 等上下文。

6. **多个入口复用同一个 loop**
   - 位置：`src/screens/REPL.tsx:2793`、`src/QueryEngine.ts:675`
   - 发现：REPL 和 SDK/headless 都通过 `for await` 消费 `query()`。
   - 含义：入口层负责交互形态，`query.ts` 负责 agent 状态推进。

## Source Evidence

| 源码位置 | 关键符号 / 线索 | 源码确认 |
|---|---|---|
| `src/entrypoints/cli.tsx:33` | `main()` | CLI bootstrap 先处理 fast path。 |
| `src/entrypoints/cli.tsx:295` | `await import('../main.js')` | 普通路径进入完整 CLI。 |
| `src/main.tsx:968` | `program.name('claude')` | Commander 根命令声明交互和 headless 形态。 |
| `src/main.tsx:2584` | `--print mode` | 非交互模式进入 headless 分支。 |
| `src/main.tsx:3798` | `launchRepl(...)` | 交互模式启动 REPL。 |
| `src/screens/REPL.tsx:3142` | `onSubmit` | 用户提交入口。 |
| `src/utils/handlePromptSubmit.ts:560` | `onQuery(...)` | 输入处理后进入查询链路。 |
| `src/screens/REPL.tsx:2793` | `for await (const event of query(...))` | REPL 消费核心 loop。 |
| `src/QueryEngine.ts:675` | `for await (const message of query(...))` | SDK/headless 消费核心 loop。 |
| `src/query.ts:219` | `query()` | 对外暴露异步生成器。 |
| `src/query.ts:241` | `queryLoop()` | 核心 loop 实现。 |
| `src/query.ts:307` | `while (true)` | 跨轮状态机。 |
| `src/query.ts:557` | `toolUseBlocks` / `needsFollowUp` | `tool_use` 触发 follow-up。 |
| `src/query.ts:1382` | `runTools()` / `StreamingToolExecutor` | 工具执行进入服务层。 |
| `src/Tool.ts:158` | `ToolUseContext` | 工具执行上下文边界。 |

## Mechanism Walkthrough

```text
CLI / REPL / headless 入口
-> 输入规范化和上下文准备
-> query(params)
-> queryLoop 初始化 State
-> while true
-> 准备 messagesForQuery
-> 调用模型
-> 收集 assistant message
-> 如果没有 tool_use：完成或进入停止 / 恢复路径
-> 如果有 tool_use：交给 runTools / StreamingToolExecutor
-> 工具结果映射为 tool_result
-> tool_result 作为 user message 回填 transcript
-> 下一轮模型调用
```

## Design Reconstruction

Claude Code 的 Agent Loop 至少承受三类架构压力。

第一，coding agent 需要跨轮执行。模型第一次输出可能不是最终答案，而是 `tool_use`。工具执行结果必须回到 transcript，模型才能继续推理。因此主循环必须围绕消息协议和状态推进设计。

第二，Claude Code 有多个入口。REPL、headless、SDK 都要复用同一个核心 loop。入口层如果拥有主状态机，其他入口就很难复用；主 loop 如果拥有 UI 细节，也会污染 SDK/headless。

第三，工具执行复杂度会持续增长。真实工具执行涉及 input 校验、权限、hook、并发安全、取消、错误映射、结果展示和 context modifier。把工具执行拆进 `services/tools`，是为了让 `query.ts` 保持为状态机，而不是工具大杂烩。

## Key Data Structures

- `State`：`queryLoop()` 的跨轮状态，保存 messages、turn count、恢复和压缩相关状态。
- `AssistantMessage`：模型输出，可能包含 text、thinking、tool_use。
- `ToolUseBlock`：模型请求工具调用的结构化块，关键字段是 `id`、`name`、`input`。
- `ToolResultBlock`：工具结果块，通过 `tool_use_id` 回连 `tool_use.id`。
- `ToolUseContext`：工具执行上下文，是工具层和会话层之间的接口。

## Build-Along Derivation

这些源码事实给 `mini-cc` 第一课带来直接约束：

| Claude Code 边界 | mini-cc 对应 | 保留理由 |
|---|---|---|
| `src/query.ts` | `mini-cc/src/query.ts` | 主状态机必须独立，后续才能加 compaction、max turns、恢复。 |
| `src/QueryEngine.ts` / REPL query 入口 | `mini-cc/src/QueryEngine.ts` | 入口包装和核心 loop 分开，便于 CLI、SDK、测试复用。 |
| `src/Tool.ts` | `mini-cc/src/Tool.ts` | 工具必须有协议和上下文，不是裸函数。 |
| `src/services/api/claude.ts` | `mini-cc/src/services/api/mockClaude.ts` | 模型 provider 要可替换，第一课用 mock 验证。 |
| `src/services/tools/` | `mini-cc/src/services/tools/` | 工具调度和单工具执行要独立。 |
| `src/tools/` | `mini-cc/src/tools/BashTool.ts` | 具体工具实现不进入主 loop。 |

本分析不展开 `mini-cc` 的每个注释步骤；注释驱动实现见 `docs/build-along/cc/01-agent-loop.md`。

## Source Confirmed

- `query()` 是核心事件流入口。
- `queryLoop()` 是跨轮状态机。
- `tool_use` / `tool_result` 是 Agent Loop 的最小协议。
- 工具执行不在 `query.ts` 内直接展开，而是进入 `services/tools`。
- REPL 和 SDK/headless 入口复用同一个 `query()`。

## Reasonable Inference

- `tool_use` / `tool_result` 配对完整性是 session resume、错误恢复和下一轮模型调用的基础约束。
- 工具调度独立成服务层，是为了隔离并发、权限、hook、context modifier 等复杂度。
- `AsyncGenerator` 形式是为了让 UI、SDK、日志、恢复路径共享中间事件，而不是只拿最终答案。

## To Verify Later

- `StreamingToolExecutor` 的结果排序、取消、context modifier 合并。
- permission hook、pre tool hook、post tool hook 如何插入 `runToolUse()`。
- auto compact / microcompact 如何改写每轮 `messagesForQuery`。
- 工具失败、orphan tool use、max turns 等错误路径如何保持 transcript 合法。

## Verification

本轮分析的行为验证放在 build-along 文档中记录：`docs/build-along/cc/01-agent-loop.md`。

仍未验证：

- 真实 Claude streaming 下的事件顺序。
- 多工具并发和副作用安全分组。
- 权限拒绝后的 transcript 形态。
