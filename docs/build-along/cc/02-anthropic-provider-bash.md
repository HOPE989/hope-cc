# Lesson 02: Anthropic Provider + Bash Build-Along

## What We Built

本课把 `mini-cc` 从 mock model 接到真实 Anthropic-compatible Messages API，让真实模型可以通过 `bash` 工具完成最基本的本地操作。

实现后的路径是：

```text
start once
-> mini-cc >> user input
-> QueryEngine appends user message to saved transcript
-> queryLoop()
-> AnthropicMessagesProvider.createMessage()
-> assistant text/tool_use
-> runTools()
-> BashTool.call()
-> user tool_result
-> next Anthropic Messages request
-> final assistant text
-> back to mini-cc >> with transcript preserved
```

机制分析见 `docs/wiki-source/cc/analysis/claude-code-anthropic-provider-tool-use.md`。

## Source-To-Design Derivation

这张表不是列“方向”，而是说明第二课具体把源码事实落到了哪些 `mini-cc` 代码上。

| 源码事实 | mini-cc 具体改动 | 为什么这样改 |
|---|---|---|
| Claude Code 通过 Anthropic Messages API 调模型。 | 新增 `mini-cc/src/services/api/anthropicMessages.ts`，实现 `AnthropicMessagesProvider.createMessage()`；它把 `ModelRequest` 发送到 `${ANTHROPIC_BASE_URL}/v1/messages`，并带上 `x-api-key`、`anthropic-version`、`model`、`system`、`messages`、`tools`。 | 第一课的 `MockClaudeProvider` 只是假模型；第二课要让真实模型成为 provider，但不能把 HTTP 请求写进 `query.ts`。 |
| 工具 schema 通过 `name / description / input_schema` 发给模型。 | 在 `AnthropicMessagesProvider` 里新增 `normalizeTools()`，直接把 `Tool` 上已有的 `name`、`description`、`input_schema` 放进 API body；`BashTool` 不需要改协议。 | 让模型通过结构化 tool schema 认识 `bash`，而不是靠 system prompt 里描述“你可以执行命令”。 |
| `tool_use` content block 是 loop 继续信号。 | 在 `AnthropicMessagesProvider` 里新增 `normalizeResponseContent()`，只把 API 返回的 `text` 和 `tool_use` 转成 `ContentBlock[]`；`mini-cc/src/query.ts` 继续用 `toolUseBlocks(response.content)` 判断是否进入工具执行。 | 第二课只替换模型来源，不改第一课已经跑通的 agent loop；真实模型返回 `tool_use` 后，旧 loop 能直接接住。 |
| `tool_result` 作为 user message 回填。 | 不改 `mini-cc/src/query.ts` 的回填逻辑：`runTools()` 返回的结果仍组装成 `{ role: "user", content: toolResults }`；第二轮真实 API 请求会带着这条 user message 再发给模型。 | Anthropic 协议要求工具结果回连 `tool_use_id`，所以 provider 只负责透传合法 transcript，不重新设计消息结构。 |
| Claude Code 真实路径有 streaming / retry / fallback。 | 第二课没有实现 streaming/retry/fallback，只在 `AnthropicMessagesProvider` 保留清晰 adapter 边界：`buildMessagesUrl()`、env 配置、请求发送、响应标准化；后续可以在同一文件或 `services/api` 下扩展。 | 当前学习目标是“真实模型能驱动 bash 闭环”；先做非 streaming 的最小版本，避免一次性把 chunk 聚合、重试和 fallback 混进课程。 |
| 课程演进应增强既有入口，不另起运行门口。 | 修改 `mini-cc/src/main.ts`：默认使用 `createAnthropicProviderFromEnv()`；把 `MockClaudeProvider` import 和 provider 注入注释掉作为过去式；`package.json` 保持单一 `dev` 脚本。 | 第二课是在第一课入口上演进，而不是新增 `lesson:02` CLI。读者仍从同一个 `main.ts -> QueryEngine -> queryLoop` 路径学习。 |
| Claude Code 是持续交互的 harness，不是一次进程只回答一次。 | `main.ts` 用 `node:readline/promises` 实现 `mini-cc >>` 循环；`QueryEngine` 增加 `messages` 字段保存跨输入 transcript；`query.ts` 支持从外部传入完整 messages。 | 进程只启动一次；每次用户输入都能看到之前的 assistant / tool_use / tool_result 历史，同时每次输入内部仍按 agent loop 跑到没有 `tool_use` 为止。 |

## Files Changed

| 文件 | 变更 |
|---|---|
| `mini-cc/src/services/api/anthropicMessages.ts` | 新增 Anthropic Messages provider，读取 env、发送 `/v1/messages`、标准化 `text/tool_use`。 |
| `mini-cc/src/main.ts` | 在既有入口上增强，默认注入真实 provider、默认工具和 system prompt；mock provider 仅注释保留。 |
| `mini-cc/src/QueryEngine.ts` | 支持传入 `systemPrompt` 和 `maxTurns`，并保存跨用户输入的 transcript。 |
| `mini-cc/src/query.ts` | 支持接收完整 `messages`，让 `QueryEngine` 可以驱动持续交互。 |
| `mini-cc/src/utils/dotenv.ts` | 用 Node 原生 `util.parseEnv()` 解析 `.env`，把模型配置放入 `process.env`。 |
| `mini-cc/.env.example` | 提供本地配置模板。 |
| `mini-cc/.gitignore` | 忽略真实 `.env`，避免密钥进入仓库。 |
| `mini-cc/package.json` | 保持单一 `dev` 脚本，不新增第二个入口。 |
| `docs/wiki-source/cc/analysis/claude-code-anthropic-provider-tool-use.md` | 新增源码机制分析。 |
| `docs/build-along/cc/02-anthropic-provider-bash.md` | 本文档。 |
| `docs/wiki-source/cc/00-learning-map.md` | 更新当前节点和 frontier。 |

## Implementation Steps

1. 保留第一课 `queryLoop`：不把模型调用和工具执行揉在一起。
2. 新增 `AnthropicMessagesProvider`：用 `fetch` 直连 Anthropic-compatible endpoint。
3. 读取环境变量：`ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL`、`ANTHROPIC_MODEL` / `MINI_CC_MODEL`。
4. 标准化工具 schema：只发送 `name / description / input_schema`。
5. 标准化模型响应：只保留 `text` 和 `tool_use` content block。
6. 增强既有 `main.ts` 入口：复用 `QueryEngine` 和 `BashTool`，不另建第二个 CLI 门口。
7. 把入口改成 REPL：一次启动后循环读取输入，`q` / `exit` / 空输入退出。
8. 把历史保存在 `QueryEngine`：每次 `submitMessage()` 都把新 user message 接到旧 transcript 后面。
9. 增加 `.env` 读取：启动时先加载 `mini-cc/.env`；Node 原生 `process.loadEnvFile()` 不覆盖已有变量，所以这里用 `util.parseEnv()` 加一层很薄的 override 语义，贴近本地实验脚本的 `override=True` 行为。

## Annotated Code Walkthrough

这一节对应代码中的 `//L02-Sxx` 注释。

| Step | 文件 | 本课作用 |
|---|---|---|
| L02-S01 | `mini-cc/src/services/api/anthropicMessages.ts` | 从环境变量读取真实模型配置，避免 key 进入代码。 |
| L02-S02 | `mini-cc/src/services/api/anthropicMessages.ts` | 把 `messages + tools + system` 映射为 Anthropic Messages API 请求。 |
| L02-S03 | `mini-cc/src/services/api/anthropicMessages.ts` | 把 API 响应标准化成 `mini-cc` 只认识的 `text/tool_use`。 |
| L02-S04 | `mini-cc/src/main.ts` | 用真实 provider 替换 mock provider，复用同一个 QueryEngine。 |
| L02-S05 | `mini-cc/src/main.ts` | 运行真实模型驱动的 `tool_use -> bash -> tool_result` 闭环。 |
| L02-S06 | `mini-cc/src/QueryEngine.ts` | 保存跨用户输入的 transcript，让交互式 harness 不丢历史。 |
| L02-S07 | `mini-cc/src/main.ts` | 用 `mini-cc >>` 循环反复读取用户输入，一次启动多次执行。 |
| L02-S08 | `mini-cc/src/utils/dotenv.ts` | 启动时加载本地 `.env`，让密钥和模型配置不出现在命令行或源码里。 |

## How To Run

PowerShell 示例：

```powershell
Set-Location C:\dev\workspace\hope-cc\mini-cc
npm run dev
```

先创建 `mini-cc/.env`：

```text
ANTHROPIC_API_KEY=你的 key
ANTHROPIC_BASE_URL=你的 Anthropic-compatible base url
MODEL_ID=可用模型名
```

进入提示符后输入：

```text
mini-cc >> 用 bash 打印当前目录，然后告诉我这里有哪些顶层文件
mini-cc >> 继续查看 package.json
mini-cc >> exit
```

如果 base url 已经包含 `/v1` 或 `/v1/messages`，provider 会自动适配；否则默认拼成 `/v1/messages`。

## Verification

已做的本地验证目标：

- 既有 `dev` 脚本是唯一入口；缺少 `ANTHROPIC_API_KEY` 时会在启动阶段明确报错。
- Provider 可用 fake fetch 验证请求 URL、headers、body 和 `tool_use` 标准化。
- REPL 可用管道输入验证：连续输入后进程会回到提示符，输入 `exit` 后退出。

真实模型验证需要用户提供：

```text
ANTHROPIC_API_KEY
ANTHROPIC_BASE_URL
MODEL_ID、ANTHROPIC_MODEL 或 MINI_CC_MODEL
```

## Architecture Evolution

第一课 mock 阶段：

```text
queryLoop -> MockClaudeProvider -> deterministic tool_use
```

第二课真实模型阶段：

```text
queryLoop -> AnthropicMessagesProvider -> real model tool_use
```

这次演进只替换 provider，不改工具执行层。这个边界很重要：后续加 streaming、retry、模型 fallback 时，应继续集中在 `services/api`；后续加权限、path guard、并发调度时，应继续集中在 `services/tools` 和 `tools`。

## Difference From Claude Code

- Claude Code 使用 Anthropic SDK、streaming、retry、fallback、request id、telemetry；本课只用 `fetch` 做非 streaming。
- Claude Code 会处理 thinking、server tools、MCP、prompt cache、tool result storage；本课只处理 `text` 和 `tool_use`。
- Claude Code 有完整 permission/hook 链路；本课仍沿用 `BashTool` 的最小危险命令拦截。
- Claude Code 会对 malformed transcript 做恢复；本课只保留 maxTurns。

## Next Frontier

- Streaming Provider：实现 `content_block_start`、`input_json_delta`、`content_block_stop` 聚合。
- Permission / Tool Safety：把 BashTool 的危险命令拦截拆成独立权限边界。
- Tool Dispatcher：扩展 read/write/edit 工具，并加入 schema 校验和错误映射。
