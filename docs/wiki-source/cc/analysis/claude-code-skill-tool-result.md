# Claude Code Skill 工具返回结果源码分析

## Learning Question

本次追问的问题是：

```text
agent 判断需要加载一个 skill
-> 调用 Skill 工具
-> 这个工具到底返回什么给 agent
```

容易误解的一点是：`Skill` 工具的模型可见 `tool_result` 不是完整 `SKILL.md`。完整 skill 内容通过 `ToolResult.newMessages` 作为额外的 meta user message 注入后续上下文；`tool_result` 本身通常只是一个很短的确认文本。

## Scope

本文覆盖：

- `Skill` 工具的输入 / 输出 schema。
- inline skill 成功后 `data`、`newMessages`、`contextModifier` 的结构。
- forked skill 和 remote canonical skill 的返回差异。
- 工具执行层如何把 `data` 映射成 Anthropic `tool_result`，并追加 `newMessages`。

本文不覆盖：

- skill search / discovery 如何筛选候选 skill。
- plugin skill、MCP skill 的完整加载流程。
- compaction 后 invoked skill 如何恢复。
- `mini-cc` 实现；本轮没有改代码，所以不更新 build-along。

## Mental Model

把 `Skill` 工具返回拆成两条通道：

```text
SkillTool.call()
  -> data
     -> mapToolResultToToolResultBlockParam()
     -> user message content[0] = tool_result(...)

  -> newMessages
     -> 额外追加到消息列表
     -> 其中 inline skill 的主消息是 isMeta: true 的 skill 内容
```

所以 agent 下一轮看到的不是“tool_result 里塞满 skill 文档”，而是：

```text
assistant:
  tool_use: Skill({ skill: "xxx", args?: "..." })

user:
  tool_result: "Launching skill: xxx"

user(meta):
  "Base directory for this skill: ...\n\n<SKILL.md 展开后的内容>"
```

## Source Evidence

### 1. `Skill` 工具输入是 skill 名和可选 args

源码确认：

- `src/tools/SkillTool/SkillTool.ts:291`：`inputSchema` 是 `{ skill: string, args?: string }`。
- `src/tools/SkillTool/constants.ts:1`：工具名是 `Skill`。
- `src/tools/SkillTool/prompt.ts:173`：prompt 说明这是在主会话中执行 skill。
- `src/tools/SkillTool/prompt.ts:180`：调用方式是传 skill name 和 optional arguments。
- `src/tools/SkillTool/prompt.ts:194`：如果当前 turn 已经有 command tag，说明 skill 已加载，不要重复调用。

### 2. inline skill 的 `call()` 返回结构

源码确认：

- `src/tools/SkillTool/SkillTool.ts:634`：inline 路径调用 `processPromptSlashCommand(...)`。
- `src/tools/SkillTool/SkillTool.ts:728`：从父 assistant message 中取出本次 `Skill` 的 `tool_use_id`。
- `src/tools/SkillTool/SkillTool.ts:735`：把 `processedCommand.messages` 过滤后通过 `tagMessagesWithToolUseID(...)` 标记为 `newMessages`。
- `src/tools/SkillTool/SkillTool.ts:767`：最终返回 `ToolResult`，其中 `data.success = true`、`data.commandName = ...`、可选 `allowedTools` 和 `model`，并带上 `newMessages` 和 `contextModifier`。
- `src/tools/SkillTool/SkillTool.ts:778`：`contextModifier` 会把 skill 允许的额外工具写入 `alwaysAllowRules.command`。
- `src/tools/SkillTool/SkillTool.ts:810`：如果 skill 指定 model，会覆盖主循环模型。
- `src/tools/SkillTool/SkillTool.ts:823`：如果 skill 指定 effort，会覆盖 effort。

近似结构：

```ts
{
  data: {
    success: true,
    commandName: "skill-name",
    allowedTools?: ["..."],
    model?: "..."
  },
  newMessages: [...],
  contextModifier(ctx) { ... }
}
```

### 3. `newMessages` 里包含真正的 skill 内容

源码确认：

- `src/utils/processUserInput/processSlashCommand.tsx:869`：调用 `command.getPromptForCommand(args, context)` 取得展开后的 skill 内容。
- `src/utils/processUserInput/processSlashCommand.tsx:883`：为 compaction preservation 记录 `skillPath`。
- `src/utils/processUserInput/processSlashCommand.tsx:884`：把 text block 拼成 `skillContent`。
- `src/utils/processUserInput/processSlashCommand.tsx:885`：调用 `addInvokedSkill(...)`。
- `src/utils/processUserInput/processSlashCommand.tsx:902`：第一条消息是 command loading metadata。
- `src/utils/processUserInput/processSlashCommand.tsx:905`：第二条消息是 `createUserMessage({ content: mainMessageContent, isMeta: true })`。
- `src/utils/processUserInput/processSlashCommand.tsx:908`：随后还可能追加 attachment messages 和 `command_permissions` attachment。

`SkillTool.call()` 又会过滤掉包含 `<command-message>` 的 loading metadata，所以真正被追加的核心消息是 `isMeta: true` 的 skill 内容。

### 4. 本地 `/skills/<name>/SKILL.md` 展开形态

源码确认：

- `src/skills/loadSkillsDir.ts:344`：本地 skill 的 `getPromptForCommand(...)` 构造最终 prompt。
- `src/skills/loadSkillsDir.ts:345`：如果存在 baseDir，会在内容前加 `Base directory for this skill: ...`。
- `src/skills/loadSkillsDir.ts:349`：会替换 `$ARGUMENTS` / 命名参数。
- `src/skills/loadSkillsDir.ts:356`：会替换 `${CLAUDE_SKILL_DIR}`。
- `src/skills/loadSkillsDir.ts:365`：会替换 `${CLAUDE_SESSION_ID}`。
- `src/skills/loadSkillsDir.ts:374`：非 MCP skill 会执行 markdown 里的 inline shell command 注入。
- `src/skills/loadSkillsDir.ts:398`：最终返回 `[{ type: 'text', text: finalContent }]`。

所以 local inline skill 的 meta message 内容大致是：

```text
Base directory for this skill: <skill-dir>

<frontmatter 去除后、变量替换后、inline shell 注入后的 SKILL.md 文本>
```

### 5. `data` 如何映射成模型可见的 `tool_result`

源码确认：

- `src/services/tools/toolExecution.ts:1292`：工具执行成功后调用 `tool.mapToolResultToToolResultBlockParam(result.data, toolUseID)`。
- `src/tools/SkillTool/SkillTool.ts:843`：`SkillTool` 自己定义这个映射。
- `src/tools/SkillTool/SkillTool.ts:856`：inline skill 的 tool result 是 `Launching skill: ${result.commandName}`。
- `src/services/tools/toolExecution.ts:1456`：映射后的 `tool_result` 会被包装成 user message。
- `src/services/tools/toolExecution.ts:1565`：随后工具返回的 `newMessages` 被追加到 resulting messages。

inline skill 的模型可见 tool result：

```ts
{
  type: "tool_result",
  tool_use_id: "<Skill tool_use id>",
  content: "Launching skill: skill-name"
}
```

## Forked Skill

如果 `command.context === 'fork'`，返回形态不同。

源码确认：

- `src/tools/SkillTool/SkillTool.ts:621`：检测到 `context === 'fork'` 时走 `executeForkedSkill(...)`。
- `src/tools/SkillTool/SkillTool.ts:223`：forked skill 通过 `runAgent(...)` 在子 agent 中执行。
- `src/tools/SkillTool/SkillTool.ts:264`：从子 agent 消息中提取 `resultText`。
- `src/tools/SkillTool/SkillTool.ts:276`：返回 `data.success = true`、`status = 'forked'`、`agentId`、`result`。
- `src/tools/SkillTool/SkillTool.ts:848`：forked skill 的 tool result 包含完整的 fork 结果摘要。

forked skill 的模型可见 tool result：

```ts
{
  type: "tool_result",
  tool_use_id: "<Skill tool_use id>",
  content: `Skill "skill-name" completed (forked execution).\n\nResult:\n${resultText}`
}
```

## Remote Canonical Skill

实验性 remote canonical skill 也走 inline 注入，但不经过本地 slash command 展开。

源码确认：

- `src/tools/SkillTool/SkillTool.ts:600`：remote canonical skill 会拦截 `_canonical_<slug>`。
- `src/tools/SkillTool/SkillTool.ts:991`：调用 `loadRemoteSkill(slug, meta.url)`。
- `src/tools/SkillTool/SkillTool.ts:1068`：解析并去掉 YAML frontmatter。
- `src/tools/SkillTool/SkillTool.ts:1076`：加 `Base directory for this skill: ...`。
- `src/tools/SkillTool/SkillTool.ts:1088`：调用 `addInvokedSkill(...)`。
- `src/tools/SkillTool/SkillTool.ts:1101`：返回 `data: { success: true, commandName, status: 'inline' }` 和一个 `isMeta: true` 的 `newMessages`。

remote skill 的 `tool_result` 仍按 inline 分支映射，因此模型可见文本仍是：

```text
Launching skill: <commandName>
```

## Design Reconstruction

源码确认：

- `ToolResult<T>` 支持 `data`、`newMessages`、`contextModifier`、`mcpMeta`；见 `src/Tool.ts:321`。
- 工具执行层先把 `data` 映射成标准 `tool_result`，再追加 `newMessages`。
- `Skill` 工具利用这个双通道协议，把“工具调用已完成”与“把 skill 指令注入上下文”分开。

设计结论：

`Skill` 工具不是一个“读取文件并把文件内容作为 tool_result 返回”的普通读取工具。它更像一个上下文改写工具：

```text
短 tool_result：满足 tool_use / tool_result 配对协议
meta user message：承载真正的 skill 指令
contextModifier：承载 allowedTools / model / effort 这类后续执行环境变化
```

这样做有两个效果：

1. `tool_result` 保持短小、稳定，主要用于协议闭环。
2. `SKILL.md` 被当成后续用户侧 meta instruction，而不是工具输出数据。

## 源码确认 / 合理推断 / 待验证

源码确认：

- inline skill 成功时，`tool_result.content` 是 `Launching skill: <name>`。
- inline skill 的完整内容通过 `newMessages` 注入，其中主内容是 `isMeta: true` 的 user message。
- local skill 内容会带 base directory header，并做参数、`${CLAUDE_SKILL_DIR}`、`${CLAUDE_SESSION_ID}` 替换。
- forked skill 的 `tool_result.content` 会包含子 agent 的结果摘要。
- remote canonical skill 直接注入 remote `SKILL.md` 内容，不做本地 slash command expansion。

合理推断：

- 这个设计让 skill 更接近“加载一段操作指南到当前上下文”，而不是“执行后返回一个业务结果”。
- `tool_result` 短文本主要服务于 Anthropic tool protocol 的配对要求，真实上下文增量靠 `newMessages`。

待验证：

- UI / transcript 中 `sourceToolUseID` 对 skill loading 消息的具体展示细节。
- compaction 后 invoked skill 的恢复顺序和重复去重策略。
- experimental skill search 下 remote skill 的完整生命周期和缓存失效行为。

## Build-Along Derivation

本轮没有修改 `mini-cc`。如果后续在 `mini-cc` 实现 SkillTool，最小版本应保留三个边界：

1. `Skill` 工具返回短 `tool_result`。
2. 完整 skill 内容作为 meta user message 注入 transcript。
3. skill frontmatter 中的 allowed tools / model / effort 不应混进普通文本结果，而应作为执行上下文修改。
