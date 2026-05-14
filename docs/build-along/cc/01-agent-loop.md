# Lesson 01: Agent Loop Build-Along

## What We Built

本课在 `mini-cc` 中实现了最小 Agent Loop：

```text
CLI prompt
-> QueryEngine.submitMessage()
-> query() / queryLoop()
-> MockClaudeProvider.createMessage()
-> assistant message with tool_use
-> runTools()
-> runToolUse()
-> BashTool.call()
-> user message with tool_result
-> next MockClaudeProvider.createMessage()
-> final assistant text
```

机制教案见 `docs/wiki-source/cc/analysis/claude-code-agent-loop.md`。本文件只记录实现路线、文件变更、验证和注释 walkthrough。

## Source-To-Design Derivation

| Claude Code 边界 | mini-cc 文件 | 本课实现决策 |
|---|---|---|
| `query()` / `queryLoop()` | `mini-cc/src/query.ts` | 主 loop 独立成异步生成器，入口层只消费事件。 |
| `QueryEngine` / REPL 入口包装 | `mini-cc/src/QueryEngine.ts` | 入口负责准备 provider、tools、cwd。 |
| 消息协议 | `mini-cc/src/types.ts` | 定义 `text`、`tool_use`、`tool_result` 和 `QueryEvent`。 |
| 工具上下文 | `mini-cc/src/Tool.ts` | 第一课只保留 `cwd`，给权限、MCP、session 留接口。 |
| 工具服务层 | `mini-cc/src/services/tools/*` | 查找工具、执行工具、映射结果不写进 `query.ts`。 |
| 具体工具 | `mini-cc/src/tools/BashTool.ts` | 先实现一个 `bash` 工具，带最小危险命令拦截。 |
| 模型 provider | `mini-cc/src/services/api/mockClaude.ts` | 用 deterministic mock 验证闭环，不接真实 API。 |

## Files Changed

| 文件 | 变更 |
|---|---|
| `mini-cc/src/main.ts` | 最小 CLI 入口，读取 prompt 并创建 `QueryEngine`。 |
| `mini-cc/src/QueryEngine.ts` | 入口包装，调用 `query()` 并消费事件流。 |
| `mini-cc/src/query.ts` | 实现跨轮 `messages` 状态、模型调用、`tool_use` 检查、工具结果回填。 |
| `mini-cc/src/types.ts` | 定义消息块、模型请求 / 响应、查询事件。 |
| `mini-cc/src/Tool.ts` | 定义 `ToolUseContext` 和统一工具接口。 |
| `mini-cc/src/tools.ts` | 集中注册默认工具。 |
| `mini-cc/src/services/api/mockClaude.ts` | 模拟第一轮发 `tool_use`、第二轮看到 `tool_result` 后结束。 |
| `mini-cc/src/services/tools/toolExecution.ts` | 按 `tool_use.name` 查找工具并生成 `tool_result`。 |
| `mini-cc/src/services/tools/toolOrchestration.ts` | 串行调度多个工具调用。 |
| `mini-cc/src/tools/BashTool.ts` | 执行 shell 命令并返回截断后的输出。 |

## Implementation Steps

1. 定义 `types.ts`：固定 `tool_use.id` 和 `tool_result.tool_use_id` 的配对关系。
2. 定义 `Tool.ts`：工具暴露 schema，并通过 `call(input, context)` 执行。
3. 实现 `query.ts`：每轮调用 provider、保存 assistant message、筛选 `tool_use`。
4. 拆出 `services/tools`：工具查找、执行、结果映射不放进主 loop。
5. 实现 `MockClaudeProvider`：构造确定性的两轮对话，先工具调用，再最终回答。
6. 实现 `BashTool` 和 `main.ts`：从命令行跑通第一课。

## Annotated Code Walkthrough

这一节对应代码中的 `//L01-Sxx` 注释。阅读代码时按这个顺序走。

### 入口

| Step | 文件 | 本课作用 |
|---|---|---|
| L01-S01 | `mini-cc/src/main.ts` | 从 CLI 读取 prompt。 |
| L01-S02 | `mini-cc/src/main.ts` | 创建 `QueryEngine`，注入 provider、tools、cwd。 |
| L01-S03 | `mini-cc/src/main.ts` | 提交用户消息进入 engine。 |
| L01-S04 | `mini-cc/src/QueryEngine.ts` | 准备 `query()` 所需上下文。 |
| L01-S05 | `mini-cc/src/QueryEngine.ts` | 消费 `query()` 事件流，入口层不实现 loop。 |

### 协议与边界

| Step | 文件 | 本课作用 |
|---|---|---|
| L01-S06 | `mini-cc/src/types.ts` | 定义 `text`、`tool_use`、`tool_result`。 |
| L01-S07 | `mini-cc/src/types.ts` | 定义 `assistant`、`tool_result`、`done` 事件。 |
| L01-S08 | `mini-cc/src/Tool.ts` | 定义工具执行上下文，第一课只保留 `cwd`。 |
| L01-S09 | `mini-cc/src/Tool.ts` | 定义工具协议：schema、`call()`、并发安全占位。 |
| L01-S10 | `mini-cc/src/tools.ts` | 集中注册默认工具。 |

### 主循环

| Step | 文件 | 本课作用 |
|---|---|---|
| L01-S11 | `mini-cc/src/query.ts` | 暴露 `query()` 异步生成器入口。 |
| L01-S12 | `mini-cc/src/query.ts` | 初始化 `messages` 和 `turnCount`。 |
| L01-S13 | `mini-cc/src/query.ts` | 用 `maxTurns` 防止无限工具循环。 |
| L01-S14 | `mini-cc/src/query.ts` | 每轮把 messages 和 tools 交给 provider。 |
| L01-S15 | `mini-cc/src/query.ts` | assistant message 写回 transcript 并 yield。 |
| L01-S16 | `mini-cc/src/query.ts` | 没有 `tool_use` 时结束 loop。 |
| L01-S17 | `mini-cc/src/query.ts` | 有 `tool_use` 时调用 `runTools()`。 |
| L01-S18 | `mini-cc/src/query.ts` | 把 `tool_result` 作为 user message 回填。 |

### Mock Model 与工具执行

| Step | 文件 | 本课作用 |
|---|---|---|
| L01-S19 | `mini-cc/src/services/api/mockClaude.ts` | 看到 `tool_result` 后输出最终文本。 |
| L01-S20 | `mini-cc/src/services/api/mockClaude.ts` | 第一轮生成 `bash` 的 `tool_use`。 |
| L01-S21 | `mini-cc/src/services/tools/toolExecution.ts` | 按 `tool_use.name` 查找具体工具。 |
| L01-S22 | `mini-cc/src/services/tools/toolExecution.ts` | 把工具输出映射成 `tool_result` 并回连 id。 |
| L01-S23 | `mini-cc/src/services/tools/toolOrchestration.ts` | 串行执行多个 `tool_use`。 |
| L01-S24 | `mini-cc/src/tools/BashTool.ts` | 做最小危险命令拦截。 |
| L01-S25 | `mini-cc/src/tools/BashTool.ts` | 具体工具只接收 input 和 context，不接触 loop 状态。 |

## How To Run

```powershell
Set-Location C:\dev\workspace\hope-cc\mini-cc
npm run lesson:01 -- "List files"
node --experimental-strip-types src/main.ts "show node version"
```

## Verification

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
- chunk / `partial_json` 聚合成 `ContentBlock[]` 的 adapter 行为。

## Architecture Evolution

本课之前：没有 `mini-cc`。

本课之后：有了可运行的最小 agent loop，代码注释形成 `L01-S01` 到 `L01-S25` 的阅读路径。

下一课应该补：Tool Dispatcher。把 `bash` 扩展为 `read_file`、`write_file`、`edit_file`，并开始引入 path guard 和工具安全分类。

## Difference From Claude Code

- 使用 `MockClaudeProvider`，不接真实模型。
- 当前 provider 返回的是已聚合的完整 `ContentBlock[]`。
- 真实 streaming chunk / delta / `partial_json` 还没有实现 adapter 聚合。
- `runTools()` 只串行执行。
- `ToolUseContext` 只有 `cwd`。
- `QueryEngine` 只做入口包装，没有 transcript、resume、SDK result message。
- 没有 permission / hook、context compaction、parallel tool execution、复杂错误恢复。

## Next Frontier

- Tool Dispatcher：扩展 `read_file`、`write_file`、`edit_file`，完善工具查找和结果映射。
- Permission / Tool Safety：把 BashTool 的最小危险命令拦截拆成独立安全边界。
- Streaming Provider：补真实模型 chunk / `partial_json` 到 `ContentBlock[]` 的 adapter。
