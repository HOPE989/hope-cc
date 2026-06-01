# Claude Code File QA 技术方案：从 @file 到 Read 的本地文件问答机制

## 如何阅读本文

本文修正一个容易混淆的点：Claude Code CLI 的 File QA 主机制不是“点击 `+` 上传文件”，而是“用户通过 `@文件路径` 或模型通过 `Read` 工具，把本地文件内容变成模型可见上下文”。如果某个远端 UI 有 `+` 上传按钮，它只是把文件先变成 Claude Code 能读取的路径或附件；真正支撑问答的是 CLI 侧的 `@file`、attachment、`Read`、message normalize 这条链路。

推荐阅读路径：

- **快速理解**：读 § Learning Question、§ 0 核心结论、§ 1 最小心智模型、§ 8 它和 RAG 的关系。
- **实现复现**：读 § 2 到 § 7，重点看源码确认的状态流、数据结构、文件类型策略和安全边界。
- **核验源码**：读附录 A 的路径、符号和行号。

最小闭环：

```text
用户输入：请总结 @docs/spec.pdf
        |
        v
processUserInputBase 提取 inputString
        |
        v
getAttachmentMessages -> getAttachments
        |
        v
processAtMentionedFiles 解析 @docs/spec.pdf
        |
        v
权限 / 大小 / PDF 页数 / 是否已读 检查
        |
        v
FileReadTool.validateInput + FileReadTool.call
        |
        v
AttachmentMessage(type="attachment")
        |
        v
normalizeAttachmentForAPI
        |
        v
合成 Read 调用/结果形态的 meta user message / PDF reference meta message / image/document blocks
        |
        v
模型基于文件内容回答；需要更多内容时继续调用 Read(offset/limit/pages)
```

## Learning Question

本文回答：

```text
Claude Code 的 File QA 机制到底是什么？
如果不从知识库 RAG 或 session RAG 出发，而是从 Claude Code 源码出发，
它如何让模型围绕本地文件、PDF、图片、notebook 对话？
```

结论是：

```text
Claude Code 的 File QA 是“文件上下文化 + 工具化精读”，不是默认的向量库检索。

首轮 @file 会尽量把文件读成模型可见的 attachment；
如果文件太大、PDF 页数太多或上下文已有内容，则转成引用、截断、已读标记或后续 Read 指令；
后续问答由模型按需要继续调用 Read(file_path, offset, limit, pages)。
```

## Scope

本文覆盖：

- CLI 用户输入中的 `@file`、`@"path with spaces"` 和 `#Lx-y` 行号范围。
- `processUserInputBase()` 如何触发 attachment 管线。
- `getAttachments()` / `processAtMentionedFiles()` / `generateFileAttachment()` 的状态流。
- `FileReadTool` 如何读取文本、图片、PDF、notebook。
- attachment 如何变成模型可见的 API messages。
- 大文件、大 PDF、重复读取、权限 deny、二进制文件等边界。
- 外部系统如果要复现 Claude Code-like File QA，应该如何分层。

本文不覆盖：

- Web / Desktop 的 `+` 上传 UI 实现。Claude Code CLI 源码中没有这个 UI。
- 向量索引、embedding、知识库召回、OCR 管线。源码确认的主链路不是这些机制。
- 项目内教学实现。

## 0. 核心结论

### 0.1 一句话方案

Claude Code 把“围绕文件问答”拆成两步：先把用户显式引用的文件变成 attachment 注入本轮上下文，再允许模型用 `Read` 工具按路径、行号或 PDF 页码继续读取。它不是预先把文件放进知识库，而是在对话过程中按需读取、按类型转换、按限制裁剪。

### 0.2 关键设计取舍

| 问题 | Claude Code 的选择 | 设计含义 |
|---|---|---|
| 用户如何指定文件 | 在 prompt 中写 `@path`，支持 quoted path 和行号范围。 | 文件选择是显式上下文引用，不是隐式全局检索。 |
| 首轮是否直接读文件 | 是。`@file` 会触发 attachment 预处理。 | 模型第一轮就能看到小文件 / 图片 / 小 PDF。 |
| 文件内容如何进模型 | 预读后包装成 `Read` 调用/结果形态的 meta user message，或作为 PDF reference 等 meta user message。 | 模型看到的是“工具已经读过文件”的上下文，而不是纯文本拼接；但这不是 agent loop 中真实执行出来的结构化 `tool_use/tool_result`。 |
| 后续如何追问 | 模型继续调用 `Read`。 | File QA 是 agentic read，而不是一次性塞全文。 |
| 大文件如何处理 | 非 PDF 大文件可能截断前 2000 行；超限时引导 offset / limit。 | 默认保护上下文和 token。 |
| 大 PDF 如何处理 | `@file` 阶段超过 10 页转成 `pdf_reference`，要求模型用 `Read(pages)`，单次最多 20 页。 | PDF QA 是分页精读，不是整本入上下文。 |
| 重复读取如何处理 | `readFileState` 记录已读文件和 mtime，未变化时可返回已读 / unchanged。 | 避免重复消耗上下文。 |
| 是否等于 RAG | 否。源码主线没有 embedding / vector search。 | RAG 可叠加，但不是 Claude Code File QA 的基本形态。 |

### 0.3 `+ 上传文件` 和 `@file` 的关系

如果一个产品有 `+ 上传文件`，它可以被设计成 `@file` 的 UI 包装：

```text
用户点击 + 选择文件
        |
        v
系统把文件放到一个当前会话可读的位置
        |
        v
自动把用户问题改写为：@"会话文件路径" + 原问题
        |
        v
进入 Claude Code-like @file / Read 管线
```

也就是说，`+` 不是 File QA 的核心算法；它只是“帮助用户产生一个文件引用”的交互入口。Claude Code CLI 源码确认的核心是路径引用、读取工具和上下文注入。

## 1. 全局心智模型 / 关键术语

### 1.1 关键术语

- **@file mention**：用户在输入中写的 `@path`。支持 `@"path with spaces"`，也支持 `@file#L10-20` 这样的行范围。
- **Attachment**：Claude Code 内部上下文补充对象。`@file`、目录列表、IDE selection、memory、MCP resource 等都可变成 attachment。
- **AttachmentMessage**：内部消息，`type: "attachment"`，包装一个 attachment，等待 API normalize。
- **FileReadTool / Read**：统一读取本地文件的工具，输入是绝对路径，可选 `offset`、`limit`、`pages`。
- **readFileState**：会话内文件读取状态缓存，记录文件内容、mtime、offset、limit，用于去重和后续恢复。
- **pdf_reference**：大 PDF 的轻量引用。它不直接把 PDF 内容塞入上下文，而是告诉模型必须用 `Read(pages)` 分页读取。
- **synthetic Read context**：`@file` 预处理读到文件后，API normalize 会构造看起来像 `Read` 已经被调用、并返回结果的 meta user 上下文片段；当前源码不是结构化的 assistant `tool_use` + user `tool_result` 块。

### 1.2 两条互补路径

Claude Code File QA 有两条路径，它们共享同一个 `Read` 工具边界：

```text
路径 A：用户显式 @file

User prompt -> @file parser -> generateFileAttachment -> Read.call
            -> attachment -> synthetic Read meta context -> model answers
```

```text
路径 B：模型主动 Read

User asks -> model decides it needs a file -> assistant tool_use Read
          -> Read.call -> user tool_result -> model answers
```

路径 A 是“首轮上下文化”：用户已经指明文件，所以 Claude Code 在模型回答前先读一次。路径 B 是“后续精读”：模型发现需要更多局部内容，再主动调用工具。

### 1.3 为什么这不是知识库 RAG

源码确认的主链路里没有这些动作：

- 上传后抽取文本并建立 embedding。
- 在每轮问题前做向量召回。
- 把文件切片写入 session-level vector store。
- 用 top-k chunk 替代文件读取工具。

它做的是：

- 显式路径引用。
- 类型感知读取。
- 上下文限制下的截断或引用。
- 模型主动继续读。

因此它更接近“文件作为会话可读资源 + agent 工具读取”，而不是“知识库检索问答”。

## 2. 源码确认的执行流

### 2.1 用户输入进入 attachment 管线

入口在 `src/utils/processUserInput/processUserInput.ts` 的 `processUserInputBase()`。

源码确认：

- 字符串输入直接成为 `inputString`。
- content block 输入会处理图片 block，并从最后一个 text block 提取 `inputString`。
- 对普通 prompt，如果不是 slash command，且没有 `skipAttachments`，会调用 `getAttachmentMessages(inputString, ...)`。

这说明 `@file` 不是模型看到 prompt 后才解析的语法，而是在发送 API 请求前由 CLI 预处理。

### 2.2 getAttachments 聚合多类上下文

`getAttachmentMessages()` 调 `getAttachments()`，再把每个 attachment 包成 `AttachmentMessage`。

`getAttachments()` 不只处理文件，它还会聚合：

- `at_mentioned_files`
- MCP resources
- agent mentions
- IDE selection / opened file
- memory / todo / task 等上下文

File QA 的主分支是 `processAtMentionedFiles(input, context)`。

### 2.3 `@file` 解析

`extractAtMentionedFiles()` 使用两类模式：

```text
@"path with spaces"
@regular/path
```

它会跳过 `@"xxx (agent)"` 这类 agent mention，合并 quoted 和 regular matches，并去重。

`processAtMentionedFiles()` 对每个文件引用执行：

1. 解析可能存在的行号范围。
2. `expandPath()` 转成绝对路径。
3. 用 `isFileReadDenied()` 做 deny 检查。
4. 如果是目录，读取最多 1000 个条目，生成 `directory` attachment。
5. 如果是文件，调用 `generateFileAttachment()`。

### 2.4 generateFileAttachment 是 File QA 的核心预读器

`generateFileAttachment()` 负责把一个路径变成 file / pdf_reference / already_read_file / compact_file_reference。

关键状态流：

```text
filename
  |
  v
deny rule check
  |
  v
非 PDF 超过 maxSizeBytes ? -> at-mention 模式返回 null
  |
  v
大 PDF ? -> pdf_reference
  |
  v
readFileState 中已有且 mtime 未变 ? -> already_read_file
  |
  v
FileReadTool.validateInput()
  |
  v
FileReadTool.call()
  |
  v
FileAttachment(type="file", content=Read output)
```

如果 `Read` 因 token 或文件大小超限失败，`at-mention` 模式会尝试读取前 `MAX_LINES_TO_READ = 2000` 行，并标记 `truncated: true`。`compact` 模式则会退成 `compact_file_reference`，提醒模型需要时再读。

### 2.5 API normalize 把 attachment 变成模型上下文

`normalizeMessagesForAPI()` 遇到 `type: "attachment"` 时调用 `normalizeAttachmentForAPI()`。

对 File QA 最重要的转换是：

- `file` attachment -> 合成描述 `Read` 工具调用和 `Read` 工具结果的 meta user message。
- `directory` attachment -> 合成描述 `ls` 调用和结果的 meta user message。
- `pdf_reference` -> meta user message，要求模型必须用 `Read(pages)`。
- `already_read_file` -> 空消息，因为文件内容已经在当前上下文中过。

这一步解释了 Claude Code 的一个关键技巧：`@file` 读到的内容不是简单拼接到用户 prompt，而是被包装成“工具读取结果语义”。模型后续更容易延续同一个交互范式：需要更多内容就继续用 `Read`。但这一步仍然属于进入 agent loop 前的上下文预注入，不会经过 `runTools()`，也不会产生真实工具执行事件。

## 3. 关键数据结构与协议

### 3.1 输入语法

```text
@README.md
@"docs/product spec.md"
@src/index.ts#L10
@src/index.ts#L10-50
```

源码确认支持 quoted path 和 regular path；行号解析由 `parseAtMentionedFileLines()` 承接，最终传给 `generateFileAttachment()` 的 `offset` 和 `limit`。

### 3.2 Attachment 类型

File QA 相关 attachment：

| 类型 | 什么时候出现 | 模型最终看到什么 |
|---|---|---|
| `file` | 文本、图片、小 PDF、notebook 等成功读取。 | 描述 `Read` 调用和结果的 meta user message / 图片或文档内容块。 |
| `directory` | `@path` 指向目录。 | 描述 `ls` 调用和结果的 meta user message。 |
| `pdf_reference` | `@PDF` 且页数超过 inline 阈值。 | meta message：要求用 `Read(pages)`。 |
| `already_read_file` | 文件已读且 mtime 未变。 | normalize 后为空，避免重复注入。 |
| `compact_file_reference` | 压缩恢复时文件过大。 | meta message：提示需要时再用 `Read`。 |

### 3.3 Read 工具输入

`Read` 的输入 schema：

```ts
{
  file_path: string, // 绝对路径
  offset?: number,  // 起始行，适用于文本
  limit?: number,   // 行数，适用于文本
  pages?: string    // PDF 页范围，例如 "1-5"，单次最多 20 页
}
```

`Read` 工具说明要求 `file_path` 使用绝对路径；这也是外部系统复现时应保持的边界：UI 可以接受相对路径，但进入工具层前必须 resolve 成明确路径。

### 3.4 Read 工具输出

`Read` 输出是 discriminated union：

| 输出类型 | 含义 |
|---|---|
| `text` | 带文件路径、内容、返回行数、起始行、总行数。 |
| `image` | base64 图片、媒体类型、原始尺寸和展示尺寸。 |
| `notebook` | notebook cells。 |
| `pdf` | PDF base64 document 数据。 |
| `parts` | PDF pages 提取后的 page image 结果。 |
| `file_unchanged` | 文件未变化，沿用之前的读取结果。 |

## 4. 按文件类型的 QA 策略

### 4.1 文本文件

文本读取由 `readFileInRange()` 完成。

关键策略：

- 默认读取从第 1 行开始，最多 `MAX_LINES_TO_READ = 2000` 行。
- 默认 `maxSizeBytes` 来自 `MAX_OUTPUT_SIZE = 0.25MB`。
- 默认 `maxTokens = 25000`。
- `offset` / `limit` 支持模型或用户进行局部读取。
- 输出会以带行号的格式进入模型可见的 Read 结果文本，便于模型引用和后续定位；真实 agentic Read 时才是结构化 `tool_result`。
- 成功读取后写入 `readFileState`，记录 content、mtime、offset、limit。

这意味着文本 File QA 的基本策略是“先读可控范围，后续按行精读”。

### 4.2 图片文件

`Read` 支持 `png/jpg/jpeg/gif/webp`。

策略：

- 图片不按文本大小限制处理。
- 读取图片 bytes 后按 token budget resize / compress。
- Read 结果上下文中放 image block，而不是 OCR 后的纯文本；真实 agentic Read 时这些内容会经 `tool_result` 返回。
- 同时生成尺寸 metadata，帮助模型理解坐标和展示尺寸。

因此图片 QA 是多模态输入，不是文本检索。

### 4.3 PDF 文件

PDF 是最特殊的分支：

- `@file` 阶段，如果 PDF 页数超过 `PDF_AT_MENTION_INLINE_THRESHOLD = 10`，不会直接 inline，而是生成 `pdf_reference`。
- `pdf_reference` 会告诉模型：必须调用 `Read` 并带 `pages` 参数。
- `Read(pages)` 单次最多 `PDF_MAX_PAGES_PER_READ = 20` 页。
- 小 PDF 或支持 document block 的场景，可以以 base64 document block 进入模型。
- 不支持 full PDF 或 PDF 太大时，会走 page extraction，把页渲染成图片 blocks。

这说明 Claude Code 对 PDF QA 的默认策略是“页级导航 + 分批视觉读取”，不是把整本 PDF 全量文本化后检索。

### 4.4 Notebook

`.ipynb` 会被读取为 notebook cells，并检查大小和 token。它不是按普通文本行直接读，而是保留 notebook 结构。

### 4.5 目录

`@directory` 不会调用 `Read`，而是列目录，最多 1000 个条目。模型如果需要读具体文件，应再调用 `Read`。

## 5. 权限、安全与失败边界

### 5.1 deny rule 优先

`processAtMentionedFiles()` 和 `generateFileAttachment()` 都会检查文件读取 deny rule。`FileReadTool.validateInput()` 也会通过 permission context 做 deny 检查。

设计含义：即使文件路径来自用户显式输入，也不能绕过工具权限。

### 5.2 二进制文件限制

`Read` 会拒绝普通二进制扩展，但排除 PDF、图片、SVG 等原生支持类型。外部系统不要把任意二进制误当文本塞给模型。

### 5.3 设备文件与 UNC 路径

`Read` 会阻止可能阻塞或无限输出的特殊设备路径。UNC path 分支避免在权限确认前做可能泄露凭据的 I/O。

### 5.4 大文件失败不是终局

大文件可能触发：

- at-mention 阶段返回 null。
- 读取前大小限制错误。
- 读取后 token 超限错误。
- 截断前 2000 行并提示模型需要时继续 `Read`。

这不是简单失败，而是把“全量读取”降级为“局部读取”。

### 5.5 prompt 注入风险

文件内容最终会进入模型上下文，所以它本质上是不可信输入。Claude Code 使用 system-reminder 包装、工具结果结构和权限边界降低风险，但外部系统仍应把文件内容视为用户提供数据，不应让文件文本覆盖系统策略。

## 6. 会话状态、重复读取与压缩恢复

### 6.1 readFileState

`Read` 成功读取文本或 notebook 后，会把内容、mtime、offset、limit 写入 `readFileState`。

用途：

- 同一会话重复读同一范围时，可返回 `file_unchanged`。
- 再次 `@file` 时，如果文件未变化，可生成 `already_read_file`。
- 压缩或恢复时可以知道哪些文件曾经进入过上下文。

### 6.2 already_read_file 为什么 normalize 为空

`already_read_file` 表示文件内容已经在上下文里，并且没有变化。`normalizeAttachmentForAPI()` 对它返回空数组，避免重复注入相同内容。

这不是“忘了处理”，而是上下文去重策略。

### 6.3 压缩后的文件引用

如果文件内容太大，压缩恢复时可以保留 `compact_file_reference`，告诉模型“这个文件之前读过，但内容太大未重新放入上下文，需要时用 `Read`”。这使得长会话不必在每次压缩后重复塞大文件。

## 7. 外部系统复现方案

### 7.1 模块拆分

| 模块 | 负责什么 | 不应该负责什么 |
|---|---|---|
| FilePicker / Upload UI | 让用户选择文件，或把文件放到会话可读目录。 | 不直接拼接文件全文进 prompt。 |
| MentionResolver | 把 `@path`、上传文件卡片、IDE selection 统一解析成文件引用。 | 不绕过权限读取文件。 |
| AttachmentBuilder | 做权限、类型、大小、PDF 页数、重复读取检查。 | 不调用模型。 |
| ReadTool | 统一读取文本、图片、PDF、notebook，支持 offset/limit/pages。 | 不关心文件是上传来的还是本地已有。 |
| AttachmentNormalizer | 把 attachment 转成模型 API messages。 | 不做文件系统 I/O。 |
| FileReadState | 记录已读文件、mtime、范围、内容摘要。 | 不作为长期知识库。 |
| Agent Loop | 让模型根据问题继续调用 `Read` 精读。 | 不在工具外私自读取文件。 |

### 7.2 最小可用实现

最小闭环：

1. 支持用户输入 `@path question`。
2. 解析 `@path`，resolve 成绝对路径。
3. 检查 deny / allow。
4. 文本文件读取前 N 行，带行号。
5. 构造一条 synthetic tool result：`Read(path) -> file content`。
6. 把用户原问题和 synthetic tool result 一起发给模型。
7. 暴露 `Read(file_path, offset, limit)` 给模型后续调用。

有了这 7 步，就已经是 Claude Code-like File QA 的核心，而不是 RAG。

### 7.3 PDF / 图片增强

第二阶段再加：

- 图片 -> image block，带 resize / token 控制。
- 小 PDF -> document block。
- 大 PDF -> `pdf_reference`，要求模型用 `pages` 精读。
- PDF pages -> page image blocks。

### 7.4 如果产品一定要做 `+ 上传`

把 `+ 上传` 当成 MentionResolver 的前置输入：

```text
上传文件卡片
  -> 保存到会话文件目录
  -> 生成内部 fileRef
  -> 在模型请求前等价转换成 @"/session/uploads/file"
  -> 进入同一套 AttachmentBuilder / ReadTool
```

不要为上传文件另建一套平行 QA 逻辑。否则本地文件、上传文件、IDE 文件、模型主动读文件会出现四套权限和上下文行为。

## 8. 它和 RAG / session RAG 的关系

### 8.1 Claude Code 主线不是 RAG

RAG 的典型链路是：

```text
ingest -> chunk -> embedding -> vector store -> retrieve -> prompt
```

Claude Code File QA 的源码主线是：

```text
explicit file ref -> permission/type/size check -> Read -> synthetic meta context/document/image -> agent continues reading
```

它没有默认的 chunk 索引层，也没有每轮问题的 top-k 召回层。

### 8.2 为什么这个设计适合代码和本地文件

代码和工程文档通常需要：

- 精确路径。
- 精确行号。
- 文件是否被修改。
- 工具权限控制。
- 后续按行补读。
- 与 edit / write / bash 等工具共享状态。

这些要求比“语义相似 chunk”更接近 agent 文件系统能力。Claude Code 选择 `Read` 管线，是为了让模型可以像工程师一样逐步打开文件、定位行、再决定下一步。

### 8.3 RAG 可以叠加在哪里

外部系统可以叠加 RAG，但建议放在辅助层：

- 用 RAG 帮模型发现候选文件。
- 候选文件仍交给 `Read` 精读。
- RAG chunk 不替代最终证据读取。
- 回答引用应尽量回到路径和行号，而不是只引用 chunk ID。

## 9. 测试计划

### 9.1 单元测试

- `extractAtMentionedFiles()` 能解析普通路径、quoted path、重复路径。
- `@file#L10-20` 能转成正确 `offset/limit`。
- deny 路径不会生成 attachment。
- 目录路径生成 `directory` attachment，最多 1000 个条目。
- 大 PDF 生成 `pdf_reference`。
- 已读且未变化文件生成 `already_read_file`。

### 9.2 集成测试

- 输入 `请总结 @README.md`，API messages 中出现 synthetic `Read` 调用/结果形态的 meta user message。
- 输入大文本文件，触发截断提醒，并允许模型后续 `Read(offset, limit)`。
- 输入超过 10 页 PDF，首轮只生成 `pdf_reference`，模型被要求用 `Read(pages)`。
- 输入图片路径，tool_result 中出现 image block。
- 重复 `@file` 未修改文件，不重复注入完整内容。

### 9.3 安全测试

- deny 目录下的文件不能通过 `@file` 进入上下文。
- 普通二进制文件被拒绝。
- 特殊设备文件不会阻塞。
- 上传文件名或路径别名不能绕过最终绝对路径权限检查。

## 10. 常见失败模式

| 失败模式 | 后果 | 修正 |
|---|---|---|
| 把上传文件和本地文件做成两套 QA | 行为不一致，权限绕过。 | 上传只生成 fileRef，统一走 Read。 |
| 直接把全文拼进 prompt | token 暴涨，无法后续按行定位。 | 使用 synthetic Read context 和真实 `Read`。 |
| 只做 RAG 不保留路径读取 | 回答缺少精确证据，无法处理“第 80 行是什么”。 | RAG 只做候选发现，最终用 Read。 |
| 大 PDF 全量塞入上下文 | 请求过大或模型迷失。 | 用 `pdf_reference` + `Read(pages)`。 |
| 重复注入已读文件 | 浪费上下文，破坏长会话。 | 维护 readFileState。 |
| 文件内容当可信指令 | prompt injection。 | 把文件内容视为数据，保持系统指令边界。 |

## 11. 合理推断

- 如果把 `+ 上传文件` 做成 Claude Code-like 体验，最自然的映射是：上传后落到会话文件目录，再自动生成一个等价的 `@path` 引用。
- 对代码仓库类 agent，File QA 的核心价值不在“语义召回”，而在“路径、行号、mtime、权限、工具调用”这些工程上下文。
- 对企业文档问答产品，可以把 Claude Code 这套机制作为“精读层”，再叠加 RAG 做“发现层”。

## 12. 待验证

- Claude Code Web / Desktop 的文件选择 UI 是否在产品层有额外的上传体验；CLI 源码不能证明 UI 细节。
- Office 文档如 `.docx/.xlsx` 是否在其它工具链有额外解析器。当前 `Read` 主分支确认文本、图片、notebook、PDF。
- 不同模型和 API provider 对 PDF document block 的支持差异需要运行验证。

## 附录 A：源码依据 / 设计来源校验

### A.1 源码确认

| 结论 | 源码依据 |
|---|---|
| `processUserInputBase()` 从字符串或最后一个 text block 提取 `inputString` | `src/utils/processUserInput/processUserInput.ts:314`, `src/utils/processUserInput/processUserInput.ts:338` |
| 普通 prompt 在发送前调用 `getAttachmentMessages()` | `src/utils/processUserInput/processUserInput.ts:495`, `src/utils/processUserInput/processUserInput.ts:501`, `src/utils/processUserInput/processUserInput.ts:504` |
| `getAttachments()` 聚合 at-mentioned files，并可被环境变量禁用 | `src/utils/attachments.ts:743`, `src/utils/attachments.ts:752`, `src/utils/attachments.ts:775` |
| `processAtMentionedFiles()` 解析 @file、expand path、deny 检查、目录处理、文件处理 | `src/utils/attachments.ts:1894`, `src/utils/attachments.ts:1898`, `src/utils/attachments.ts:1905`, `src/utils/attachments.ts:1909`, `src/utils/attachments.ts:1917`, `src/utils/attachments.ts:1947` |
| `extractAtMentionedFiles()` 支持 quoted path 和 regular path | `src/utils/attachments.ts:2757`, `src/utils/attachments.ts:2764`, `src/utils/attachments.ts:2765`, `src/utils/attachments.ts:2788` |
| File QA 相关 attachment 类型包括 file、pdf_reference、already_read_file、directory | `src/utils/attachments.ts:295`, `src/utils/attachments.ts:314`, `src/utils/attachments.ts:323`, `src/utils/attachments.ts:462` |
| 大 PDF 在 @mention 阶段转成 `pdf_reference` | `src/utils/attachments.ts:2986`, `src/utils/attachments.ts:3000`, `src/utils/attachments.ts:3007`, `src/utils/attachments.ts:3070` |
| `generateFileAttachment()` 检查 deny、大小、已读状态，再调用 `FileReadTool` | `src/utils/attachments.ts:3039`, `src/utils/attachments.ts:3046`, `src/utils/attachments.ts:3077`, `src/utils/attachments.ts:3172`, `src/utils/attachments.ts:3178` |
| 大文件失败可截断读取前 2000 行 | `src/utils/attachments.ts:3128`, `src/utils/attachments.ts:3149`, `src/utils/attachments.ts:3153`, `src/tools/FileReadTool/prompt.ts:10` |
| `AttachmentMessage` 包装 attachment | `src/utils/attachments.ts:2937`, `src/utils/attachments.ts:2967`, `src/utils/attachments.ts:3201` |
| API normalize 遇到 attachment 会调用 `normalizeAttachmentForAPI()` 并与 user message 合并 | `src/utils/messages.ts:2269`, `src/utils/messages.ts:2270`, `src/utils/messages.ts:2279` |
| file attachment 被转成 synthetic `Read` 调用/结果形态的 meta user message，而不是结构化 assistant `tool_use` + user `tool_result` | `src/utils/messages.ts:3545`, `src/utils/messages.ts:3550`, `src/utils/messages.ts:3553`, `src/utils/messages.ts:3556`, `src/utils/messages.ts:3561`, `src/utils/messages.ts:4288`, `src/utils/messages.ts:4313`, `src/utils/messages.ts:4325` |
| `pdf_reference` 被转成要求模型使用 `Read(pages)` 的 meta message | `src/utils/messages.ts:3600`, `src/utils/messages.ts:3604`, `src/utils/messages.ts:3605`, `src/utils/messages.ts:3608` |
| `already_read_file` normalize 后为空 | `src/utils/messages.ts:4252`, `src/utils/messages.ts:4261` |
| `Read` 输入 schema 是 `file_path/offset/limit/pages` | `src/tools/FileReadTool/FileReadTool.ts:227`, `src/tools/FileReadTool/FileReadTool.ts:229`, `src/tools/FileReadTool/FileReadTool.ts:230`, `src/tools/FileReadTool/FileReadTool.ts:233`, `src/tools/FileReadTool/FileReadTool.ts:236` |
| `Read` 输出类型包括 text/image/notebook/pdf/parts/file_unchanged | `src/tools/FileReadTool/FileReadTool.ts:257`, `src/tools/FileReadTool/FileReadTool.ts:270`, `src/tools/FileReadTool/FileReadTool.ts:299`, `src/tools/FileReadTool/FileReadTool.ts:306`, `src/tools/FileReadTool/FileReadTool.ts:314`, `src/tools/FileReadTool/FileReadTool.ts:325` |
| `Read` validate 阶段检查 pages、deny、二进制扩展和设备路径 | `src/tools/FileReadTool/FileReadTool.ts:418`, `src/tools/FileReadTool/FileReadTool.ts:433`, `src/tools/FileReadTool/FileReadTool.ts:442`, `src/tools/FileReadTool/FileReadTool.ts:469`, `src/tools/FileReadTool/FileReadTool.ts:484` |
| `Read` 使用 readFileState 做去重 | `src/tools/FileReadTool/FileReadTool.ts:502`, `src/tools/FileReadTool/FileReadTool.ts:540`, `src/tools/FileReadTool/FileReadTool.ts:562` |
| `Read` 支持 notebook、image、PDF pages、小 PDF document、text | `src/tools/FileReadTool/FileReadTool.ts:821`, `src/tools/FileReadTool/FileReadTool.ts:865`, `src/tools/FileReadTool/FileReadTool.ts:895`, `src/tools/FileReadTool/FileReadTool.ts:999`, `src/tools/FileReadTool/FileReadTool.ts:1019` |
| PDF 阈值：@mention 超过 10 页转引用，Read(pages) 单次最多 20 页 | `src/constants/apiLimits.ts:77`, `src/constants/apiLimits.ts:83`, `src/tools/FileReadTool/FileReadTool.ts:433`, `src/tools/FileReadTool/FileReadTool.ts:949` |
| 文本读取默认大小 / token 限制 | `src/tools/FileReadTool/limits.ts:1`, `src/tools/FileReadTool/limits.ts:18`, `src/tools/FileReadTool/limits.ts:53`, `src/utils/file.ts:48` |
| `Read` 工具 prompt 明确说明绝对路径、默认 2000 行、图片、PDF、notebook | `src/tools/FileReadTool/prompt.ts:32`, `src/tools/FileReadTool/prompt.ts:36`, `src/tools/FileReadTool/prompt.ts:37`, `src/tools/FileReadTool/prompt.ts:40`, `src/tools/FileReadTool/prompt.ts:42`, `src/tools/FileReadTool/prompt.ts:45` |

### A.2 源码确认 / 合理推断 / 待验证边界

- **源码确认**：CLI 如何解析 `@file`，如何生成 attachment，如何调用 `Read`，如何把结果变成模型可见 messages，如何处理文本 / 图片 / PDF / notebook / 大文件 / 已读文件。
- **合理推断**：产品层 `+ 上传` 如果要复刻 Claude Code 体验，应映射成“会话文件引用 -> 统一 Read 管线”，而不是另建 RAG-only 链路。
- **待验证**：Web / Desktop UI 的上传细节、Office 文档额外解析能力、不同模型 provider 的 PDF document block 差异。
