# Lesson 04: Streaming Provider Build-Along

## What We Built

本课把 `mini-cc` 的 Anthropic provider 从“只会非 streaming 请求”演进为“默认使用 streaming 请求，并在 provider 内部聚合 chunk”。

新路径是：

```text
main.ts
-> createAnthropicProviderFromEnv()
-> QueryEngine.submitMessage()
-> query()
-> provider.createMessage()
-> createStreamingMessage()
-> parseSSE()
-> applyStreamEvent()
-> finalizeStreamingContent()
-> queryLoop receives complete ContentBlock[]
```

机制分析见 `docs/wiki-source/cc/analysis/claude-code-streaming-provider.md`。

## Source-To-Design Derivation

| 源码事实 | mini-cc 具体改动 | 为什么这样改 |
|---|---|---|
| Claude Code 主路径调用 Messages API 时设置 `stream: true`。 | `AnthropicMessagesProvider.createMessage()` 默认走 `createStreamingMessage()`。 | 让 Lesson 04 的真实 provider 进入 streaming 协议。 |
| Claude Code 使用 raw stream，并自己累加 `input_json_delta`。 | 新增 `parseSSE()`、`applyStreamEvent()` 和 `StreamingBlock.inputJson`。 | 保持 `partial_json -> string -> object` 的教学路径。 |
| `content_block_start` 只建立 block 槽位。 | `content_block_start` 初始化 text / tool_use block。 | 不提前假设工具输入已经完整。 |
| `content_block_delta` 是内容累加点。 | `text_delta` 追加 text；`input_json_delta` 追加 inputJson。 | 让 chunk 聚合留在 provider adapter。 |
| `normalizeContentFromAPI()` 把 streamed input 字符串解析成对象。 | `finalizeStreamingContent()` 在 stream 完成后解析 JSON。 | 工具层继续只面对对象型 `tool_use.input`。 |
| `query.ts` 只消费 assistant message 和 `tool_use` block。 | `mini-cc/src/query.ts` 只新增 L04 边界注释，不解析 SSE。 | 避免把 provider 协议细节泄漏到主状态机。 |
| Claude Code streaming 失败会 fallback 到非 streaming。 | `createMessage()` 捕获 streaming 错误后回退 `createNonStreamingMessage()`。 | 保留生产级边界的最小版本。 |

## Files Changed

| 文件 | 变更 |
|---|---|
| `mini-cc/src/main.ts` | 增加 L04 入口注释，说明 streaming 从既有应用入口进入，不新增平行 CLI。 |
| `mini-cc/src/QueryEngine.ts` | 增加 L04 包装层注释，说明 QueryEngine 不感知 streaming / non-streaming 差异。 |
| `mini-cc/src/services/api/anthropicMessages.ts` | 增加 streaming option、SSE parser、stream event reducer、tool input JSON finalize、streaming fallback。 |
| `mini-cc/src/query.ts` | 增加 L04 注释，强调主 loop 不处理 chunk。 |
| `docs/wiki-source/cc/analysis/claude-code-streaming-provider.md` | 新增源码机制分析。 |
| `docs/build-along/cc/04-streaming-provider.md` | 本文档。 |
| `docs/wiki-source/cc/00-learning-map.md` | 更新当前节点、完成状态和下一步 frontier。 |

## Implementation Steps

1. 从 `main.ts` 继续创建同一个 `QueryEngine` 和同一个 Anthropic provider，不为 L04 新增入口。
2. 在 `createAnthropicProviderFromEnv()` 读取 `MINI_CC_STREAMING`，默认走 streaming，允许 `MINI_CC_STREAMING=0` 回到 L02 路径。
3. 让 `QueryEngine` 继续只保存 transcript 和传递 provider，不把 streaming 状态传入入口层。
4. 在 `queryLoop` 保持完整 `ModelResponse` 协议，主 loop 不解析 SSE chunk。
5. 在 provider 的 `createMessage()` 内选择 streaming / non-streaming。
6. 新增 `createStreamingMessage()`，请求体加入 `stream: true`。
7. 新增 `parseSSE()`，把 HTTP body 中的 SSE data 行解析成 stream event。
8. 新增 `applyStreamEvent()`，按 `content_block_start` / `content_block_delta` 聚合 text 和 tool input。
9. 新增 `finalizeStreamingContent()`，把 `inputJson` 解析成 `tool_use.input` 对象。

## Annotated Code Walkthrough

这一节对应代码中的 `//L04-Sxx` 注释。

| Step | 文件 | 本课作用 |
|---|---|---|
| L04-S01 | `mini-cc/src/main.ts` | 从应用入口进入 streaming 课程：仍然注入同一个 Anthropic provider，不新增 CLI 或平行 main。 |
| L04-S02 | `mini-cc/src/services/api/anthropicMessages.ts` | provider 工厂读取 `MINI_CC_STREAMING`：默认 streaming，`0` 时回到非 streaming，方便对照 L02。 |
| L04-S03 | `mini-cc/src/QueryEngine.ts` | QueryEngine 继续只传递 provider 和 transcript，不知道 provider 内部是 streaming 还是 fallback。 |
| L04-S04 | `mini-cc/src/query.ts` | queryLoop 仍等待完整 `ContentBlock[]`，因此停止条件、`tool_use` 检测和工具调度都不接触 SSE。 |
| L04-S05 | `mini-cc/src/services/api/anthropicMessages.ts` | `createMessage()` 成为 provider 内部分叉点：先尝试 streaming，失败回到 Lesson 02 的非 streaming 路径。 |
| L04-S06 | `mini-cc/src/services/api/anthropicMessages.ts` | `createStreamingMessage()` 发起 Messages 请求，请求仍带 `system/messages/tools`，只额外加入 `stream:true`。 |
| L04-S07 | `mini-cc/src/services/api/anthropicMessages.ts` | 建立本轮聚合状态：用 `blocks[index]` 存放半成品 content block，用 `stopReason` 记录 `message_delta`。 |
| L04-S08 | `mini-cc/src/services/api/anthropicMessages.ts` | 逐个消费 SSE：`parseSSE()` 切 HTTP 字节流，`applyStreamEvent()` 处理 `content_block_start/delta` 和 `message_delta`。 |
| L04-S09 | `mini-cc/src/services/api/anthropicMessages.ts` | stream 结束后统一 finalize：把累加出的 `inputJson` 解析成对象型 `tool_use.input`，再交还 queryLoop。 |

## How To Run

默认 streaming 模式：

```powershell
Set-Location C:\dev\workspace\hope-cc\mini-cc
npm run dev
```

临时关闭 streaming，使用 Lesson 02 的非 streaming fallback 路径：

```powershell
Set-Location C:\dev\workspace\hope-cc\mini-cc
$env:MINI_CC_STREAMING='0'
npm run dev
```

权限模式仍然沿用 Lesson 03：

```powershell
$env:MINI_CC_PERMISSION_MODE='deny'
npm run dev
```

## Verification

已运行四组本地验证。

第一组验证假 SSE stream 聚合。验证内容：

```text
text_delta("准备查看")
input_json_delta('{"command"')
input_json_delta(':"dir"}')
message_delta(stop_reason="tool_use")
```

聚合结果：

```text
content:
  - text("准备查看")
  - tool_use(name="bash", input={ command: "dir" })
stop_reason: tool_use
```

命令：

```powershell
Set-Location C:\dev\workspace\hope-cc\mini-cc
node --experimental-strip-types --input-type=module -
```

输出：

```text
stream aggregation ok
```

第二组验证 streaming 失败后回退非 streaming：

```text
stream fallback ok
[stream:fallback] Anthropic streaming API error 500: bad stream; retrying without streaming.
```

第三组验证关键模块可以导入：

```text
module imports ok
```

第四组验证 streaming provider 能驱动既有 query loop 完成工具闭环：

```text
[turn 1] call model
[tool:bash] {"command":"node --version"} -> v22.16.0

[turn 2] call model
[assistant]
工具结果已收到。
[loop] no tool_use; stop
streaming query loop ok
```

验证过程中还尝试运行：

```powershell
npm --prefix mini-cc run dev -- --help
```

该命令会进入 `npm run` 帮助输出，不是有效的 `mini-cc` 自动化验证。后续如果要验证真实模型，需要以交互方式运行 `npm run dev`，并提供有效 `ANTHROPIC_API_KEY`。

## Architecture Evolution

Lesson 04 没有新增 CLI 入口、npm script 或平行 main 文件。入口仍然是：

```text
main.ts
-> QueryEngine
-> query()
-> provider.createMessage()
```

变化只发生在 provider adapter 内部：

```text
non-streaming JSON response
```

演进为：

```text
streaming SSE response
-> provider 聚合
-> 同样返回 ModelResponse
```

这保留了后续扩展点：

- Tool Dispatcher 可以继续消费完整 `tool_use`。
- Permission pipeline 不需要知道 input 曾经是 partial JSON。
- 以后要实现边流式边执行工具，可以在 `query.ts` 和 `services/tools` 之间引入类似 `StreamingToolExecutor` 的边界，而不是推翻 provider。

## Difference From Claude Code

| 真实 Claude Code | mini-cc Lesson 04 |
|---|---|
| 使用 Anthropic SDK raw stream。 | 直接用 `fetch` 解析 SSE。 |
| 每个 `content_block_stop` 都可以 yield assistant message。 | 等整个 stream 完成后一次性返回 `ContentBlock[]`。 |
| 支持 thinking、signature、connector text、server tools、usage、cost。 | 只支持 text 和 tool_use。 |
| streaming fallback 需要 tombstone partial messages，并 discard pending tools。 | provider 尚未提前 yield partial message，因此只做非 streaming retry。 |
| 可选启用 `StreamingToolExecutor` 边流式边执行工具。 | 工具仍在完整 assistant response 后串行执行。 |
| 有 watchdog、stall telemetry、request id、fallback model。 | 暂不实现生产级观测和恢复。 |

## Next Frontier

Lesson 04 之后，最自然的下一步是 **Tool Dispatcher**：

```text
streaming provider 已能产出完整 tool_use
-> dispatcher 需要支持更多工具
-> 文件工具和 bash 共用 permission pipeline
-> 后续再学习 streaming tool execution / concurrency
```

另一个相邻 frontier 是 **StreamingToolExecutor**，但建议等 Tool Dispatcher 先扩展到多个工具后再读，否则并发策略缺少具体工具压力。
