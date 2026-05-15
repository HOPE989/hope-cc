# ✅Claude Code Permission / Tool Safety：让真实模型调用工具前先过安全闸门

## TL;DR

我在 `project-cc` 的 Lesson 03 中学习了 Claude Code 的工具权限机制：模型发出 `tool_use` 并不等于工具立刻执行。真实执行前，Claude Code 会先经过工具级 `checkPermissions`、统一 `hasPermissionsToUseTool`、permission mode、hook 和 UI / SDK 确认等边界，最终只有 `allow` 才会进入 `tool.call()`；非 allow 会作为错误 `tool_result` 回填给模型。

基于这个源码事实，我把 `mini-cc` 第二课里裸跑 Bash 的实现改成了最小权限层：入口层提供 permission mode 和用户确认回调，执行层在 `runToolUse()` 放置 permission gate，Bash 工具只声明命令风险，统一 permission pipeline 再合成 `allow / ask / deny`。

## 为什么要做这个机制？

第二课完成后，`mini-cc` 已经可以让真实模型发起 `bash` tool call。这个能力一旦接入真实本地环境，就会立刻产生安全问题：

```text
模型认为需要执行命令
-> assistant 返回 tool_use(name=bash)
-> harness 如果直接调用 BashTool.call()
-> 本地文件、环境变量、仓库状态都会暴露给模型动作
```

这说明工具调用的关键不是“模型能不能发出 tool_use”，而是 harness 能不能在模型意图和本地副作用之间建立可解释、可扩展、可拒绝的边界。

Claude Code 的做法不是把危险命令判断写死在 BashTool 里，而是把权限拆成几层：

1. 具体工具判断自己的输入风险。
2. 统一 permission pipeline 合成最终 `allow / ask / deny`。
3. 工具执行层只在最终 `allow` 后产生副作用。
4. 拒绝也回填为协议内 `tool_result`，让模型理解失败原因。

这节课就是把这个边界缩小成 `mini-cc` 可读、可运行的最小版本。

## 源码里看到的核心结构

Claude Code 的真实链路可以概括为：

```text
tool_use
-> runPreToolUseHooks(...)
-> resolveHookPermissionDecision(...)
-> hasPermissionsToUseTool(...)
-> allow ? tool.call(...) : error tool_result
-> runPostToolUseHooks(...) / runPostToolUseFailureHooks(...)
```

关键源码证据：

| 源码位置 | 关键符号 / 线索 | 说明 |
|---|---|---|
| `src/services/tools/toolExecution.ts:800` | `runPreToolUseHooks(...)` | 工具执行前先跑 PreToolUse hooks。 |
| `src/services/tools/toolExecution.ts:921` | `resolveHookPermissionDecision(...)` | hook 结果和 `canUseTool` 合成最终权限决策。 |
| `src/services/tools/toolExecution.ts:995` | `permissionDecision.behavior !== 'allow'` | 非 allow 决策不会调用工具。 |
| `src/services/tools/toolExecution.ts:1032` | `tool_result` error block | 拒绝会被写回 transcript，而不是直接吞掉。 |
| `src/services/tools/toolHooks.ts:332` | `resolveHookPermissionDecision` | hook allow 后仍可能继续检查规则。 |
| `src/utils/permissions/permissions.ts:473` | `hasPermissionsToUseTool` | 主 `CanUseToolFn` 入口。 |
| `src/utils/permissions/permissions.ts:1158` | `hasPermissionsToUseToolInner` | 工具结果、规则和 mode 的合成逻辑。 |
| `src/types/permissions.ts:177` / `202` / `232` / `251` | permission types | 类型层区分 `allow / ask / deny / passthrough`。 |
| `src/tools/BashTool/bashPermissions.ts:1663` | `bashToolHasPermission` | Bash 工具级权限检查入口。 |
| `src/tools/BashTool/bashSecurity.ts:2426` | `bashCommandIsSafeAsync_DEPRECATED` | Bash 安全检查关注 shell 解析差异和注入风险。 |

## 核心协议 / 数据结构

这节课最重要的协议不是 Bash 命令本身，而是权限结果协议：

```text
Tool.checkPermissions()
-> PermissionResult: allow / ask / deny / passthrough
-> hasPermissionToUseTool()
-> PermissionDecision: allow / ask / deny
```

`passthrough` 是一个中间态：工具自己没有足够理由直接放行、拒绝或询问，于是把判断交给统一 permission pipeline。在真实 Claude Code 里，统一层还会考虑 settings rule、permission mode、interactive prompt、headless 策略、hooks、classifier 等因素；在 `mini-cc` 里，`passthrough` 会被归一成 `ask`。

四态的教学含义：

- `allow`：工具已经确认可以执行，可能携带 `updatedInput`。
- `deny`：工具确认必须拒绝，例如 hard deny 命令。
- `ask`：工具确认需要用户或外部控制面批准。
- `passthrough`：工具无法作出最终判断，交给统一权限层。

这个协议的价值在于：具体工具不需要理解整个系统的交互能力，统一 permission 层也不需要理解 Bash 语法。两者通过结构化结果衔接。

## mini-cc 实现结构

Lesson 03 的 `mini-cc` 调用路径按应用入口展开：

```text
main.ts
-> permissionModeFromEnv()
-> requestApproval()
-> QueryEngine.submitMessage()
-> query(...)
-> runToolUse()
-> hasPermissionToUseTool()
-> Tool.checkPermissions()
-> BashTool.checkPermissions()
-> evaluateBashPermission()
-> allow ? BashTool.call() : error tool_result
```

实现后，`BashTool.call()` 不再包含危险命令判断。它只负责执行已经被批准的命令。风险判断被移到 `tools/BashTool/bashSafety.ts`，最终执行闸门在 `services/tools/toolExecution.ts`。

## 关键模块说明

### `mini-cc/src/main.ts`

入口层负责准备运行态权限能力：

- 读取 `MINI_CC_PERMISSION_MODE`。
- 默认进入 `default` 模式。
- 提供 `requestApproval()` 回调，在 ask 时询问用户。

这对应 Claude Code 中 REPL / SDK / bridge 等入口层提供交互能力，而核心 loop 和具体工具只消费统一上下文。

### `mini-cc/src/Tool.ts`

`ToolUseContext` 增加 `permissionContext`：

```text
ToolUseContext
├── cwd
└── permissionContext
    ├── mode
    └── requestApproval?
```

`Tool` 协议增加 `checkPermissions()`，让每个工具可以先报告自己的输入风险。这个设计给后续 `read_file / write_file / edit_file / MCP tool` 留出了同一套权限入口。

### `mini-cc/src/services/tools/toolExecution.ts`

`runToolUse()` 是模型意图变成本地副作用前的最后统一位置。因此 Lesson 03 把 permission gate 放在这里：

```text
find tool
-> hasPermissionToUseTool(...)
-> behavior !== allow ? error tool_result : tool.call(...)
```

拒绝时仍然使用原始 `tool_use_id` 生成 `tool_result`。这样模型下一轮能看到“工具请求被系统拒绝”，而不是误以为工具已经执行。

### `mini-cc/src/utils/permissions/`

这里保存统一权限协议和合成逻辑：

- `PermissionResult.ts`：定义 `allow / ask / deny / passthrough`。
- `permissions.ts`：调用工具级 `checkPermissions()`，再根据 mode 和确认能力合成最终 decision。

当前 mode 语义：

- `default`：`ask` 进入 `requestApproval()`。
- `deny`：`ask` 自动转 deny，适合非交互验证。
- `bypass`：`ask` 自动转 allow，但前面已经返回的 hard deny 不会被绕过。

### `mini-cc/src/tools/BashTool/bashSafety.ts`

Bash 安全模块做最小风险分类：

- 空命令：deny。
- hard deny 模式：deny，例如 `rm -rf /`。
- 工作区外路径：ask。
- 敏感路径：ask，例如 `.env`、`.git`、`.claude`、`.ssh`。
- shell operator / redirection / pipe / command substitution：ask。
- 破坏性文件命令：ask，例如 `del`、`rm`、`mv`、`cp`。
- 明确只读观察命令：allow。
- 其他命令：ask。

这是教学实现，不是生产级 Bash sandbox。它保留的是机制形状：安全分类先于执行，硬拒绝先于 bypass，未知命令 fail closed。

## 注释驱动阅读路径

Lesson 03 的注释路径已经按“应用入口 -> 执行层 -> 权限合成 -> 工具级检查 -> Bash 风险分类 -> 回到执行层”的顺序重排：

| Step | 文件 | 阅读点 |
|---|---|---|
| `L03-S01` | `mini-cc/src/main.ts` | 应用入口读取 permission mode。 |
| `L03-S02` | `mini-cc/src/main.ts` | 入口层提供 `requestApproval()`。 |
| `L03-S03` | `mini-cc/src/Tool.ts` | `ToolUseContext` 承载权限能力。 |
| `L03-S04` | `mini-cc/src/QueryEngine.ts` | `QueryEngine` 传入权限上下文。 |
| `L03-S05` | `mini-cc/src/services/tools/toolExecution.ts` | 执行层进入 permission gate。 |
| `L03-S06` | `mini-cc/src/utils/permissions/PermissionResult.ts` | 定义权限结果四态。 |
| `L03-S07` | `mini-cc/src/utils/permissions/permissions.ts` | 调用工具级 `checkPermissions()`。 |
| `L03-S08` | `mini-cc/src/utils/permissions/permissions.ts` | 尊重 hard deny / allow。 |
| `L03-S09` | `mini-cc/src/utils/permissions/permissions.ts` | `passthrough` 归一成 ask。 |
| `L03-S10` | `mini-cc/src/utils/permissions/permissions.ts` | 应用 bypass 模式。 |
| `L03-S11` | `mini-cc/src/utils/permissions/permissions.ts` | 无交互能力时 fail closed。 |
| `L03-S12` | `mini-cc/src/Tool.ts` | 工具协议增加 `checkPermissions()`。 |
| `L03-S13` | `mini-cc/src/tools/BashTool.ts` | BashTool 暴露工具级权限检查。 |
| `L03-S14` | `mini-cc/src/tools/BashTool/bashSafety.ts` | 工作区路径 guard。 |
| `L03-S15` | `mini-cc/src/tools/BashTool/bashSafety.ts` | 敏感路径 ask。 |
| `L03-S16` | `mini-cc/src/tools/BashTool/bashSafety.ts` | 只读白名单和默认 ask。 |
| `L03-S17` | `mini-cc/src/tools/BashTool/bashSafety.ts` | 进入 Bash 风险分类。 |
| `L03-S18` | `mini-cc/src/tools/BashTool/bashSafety.ts` | hard deny 优先级。 |
| `L03-S19` | `mini-cc/src/tools/BashTool/bashSafety.ts` | shell operator ask。 |
| `L03-S20` | `mini-cc/src/tools/BashTool/bashSafety.ts` | 破坏性文件命令 ask。 |
| `L03-S21` | `mini-cc/src/tools/BashTool/bashSafety.ts` | 只读命令 allow。 |
| `L03-S22` | `mini-cc/src/services/tools/toolExecution.ts` | 非 allow 回填错误 `tool_result`。 |
| `L03-S23` | `mini-cc/src/services/tools/toolExecution.ts` | 只有 allow 后才调用工具。 |

代码中还保留了用户补充的 `//L03` 无分段号注释。这类注释不是主路径编号，而是用户对机制的补充理解，例如“permission gate 是 Lesson 03 核心逻辑入口”、“没有 requestApproval 也按 deny 处理”、“human in the loop”等。这类补充会沉淀到 analysis，而不默认改动 build-along。

## 运行效果 / 验证

直接模块实验验证了 Bash 风险分类：

```text
dir -> allow
git status -> allow
rm -rf / -> deny
del temp.txt -> ask
type ../secret.txt -> ask
echo hi > out.txt -> ask
type .env -> ask
deny mode + del temp.txt -> deny
bypass mode + del temp.txt -> allow
```

执行层实验验证了 permission gate 位置正确：

```text
runToolUse(dir, deny mode) -> allow 后真实执行
runToolUse(del temp.txt, deny mode) -> 错误 tool_result，不执行工具
runToolUse(rm -rf /, bypass mode) -> hard deny 仍然拒绝
```

这说明当前实现至少满足三条底线：

1. 可观察命令仍能低摩擦执行。
2. 需要确认的命令不会静默产生副作用。
3. hard deny 不会被 bypass 模式绕过。

## 工程取舍

这节课刻意没有复刻 Claude Code 的完整 Bash 安全系统。真实源码里，Bash 权限涉及：

- exact / prefix / wildcard 规则。
- `checkPathConstraints(...)` 路径约束。
- compound command 拆分。
- tree-sitter 与 legacy shell parser。
- command substitution、quoted newline、Zsh dangerous commands 等解析差异。
- sandbox 和 auto classifier。

`mini-cc` 只保留最小机制：

```text
工具级风险判断
-> 统一权限合成
-> 执行层 gate
-> 协议内拒绝回填
```

这样做的理由是：Lesson 03 的教学目标是理解权限边界位置，而不是实现生产级 shell 安全。如果一开始就把 AST、规则持久化、classifier、hook 全部塞进来，读者反而看不清“模型意图到本地副作用之间必须有一道统一闸门”这个核心。

## 和真实 Claude Code 的差距

- Claude Code 有 settings / policy / session / command 等多来源规则；`mini-cc` 当前只有 runtime mode。
- Claude Code 的 Bash 权限会解析子命令、重定向、路径和 shell 注入；`mini-cc` 只做保守字符串分类。
- Claude Code 的 ask 可以接 UI、SDK、bridge、swarm；`mini-cc` 只有 REPL prompt。
- Claude Code 有 PreToolUse、PostToolUse、PermissionRequest 和 PermissionDenied hooks；`mini-cc` 暂时只保留后续扩展压力点。
- Claude Code 的 auto mode classifier 会参与 permission decision；`mini-cc` 没有 classifier。
- Claude Code 能对部分安全检查设置 bypass-immune 或 classifier-approvable；`mini-cc` 只区分 hard deny 与 ask。

## 这份资料可以抽取哪些 wiki 词条？

这份 raw 未来可以抽取：

- project candidate:
  - `project-cc`
- entry candidates:
  - Agent Tool Permission
  - Tool Safety
  - Human in the Loop
  - Bash 工具安全边界
  - Agent Harness
  - AI Coding 工具调用协议
- question candidates:
  - Claude Code 为什么不能让模型直接执行 Bash？
  - `allow / ask / deny / passthrough` 在工具权限里分别代表什么？
  - 为什么拒绝工具调用也要回填 `tool_result`？
  - `passthrough` 为什么不是最终决策？
- scenario candidates:
  - 模型请求删除文件时，Agent Harness 应如何拦截？
  - headless 场景没有用户确认能力时，工具权限应如何 fail closed？
  - bypass 模式为什么仍不应该绕过 hard deny？

## 后续 TODO

- 精读 `src/services/tools/toolHooks.ts`，补 Lesson 04 或后续 Permission Hooks。
- 精读 `checkPathConstraints(...)`，尤其是 Windows 路径、重定向和 compound command。
- 为 `mini-cc` 增加 `read_file / write_file / edit_file`，验证文件工具如何复用同一条 permission pipeline。
- 给 `mini-cc` 增加最小 PermissionRequest hook，验证 hook allow 不能绕过 hard deny。
- 后续如果进入 Streaming Provider，需要确认 streaming 下的 tool_use 聚合不破坏 permission gate 的位置。

## Raw Reference

- `docs/wiki-source/cc/analysis/claude-code-permission-tool-safety.md`
- `docs/build-along/cc/03-permission-tool-safety.md`
- `docs/wiki-source/cc/00-learning-map.md`
- `mini-cc/src/main.ts`
- `mini-cc/src/QueryEngine.ts`
- `mini-cc/src/Tool.ts`
- `mini-cc/src/services/tools/toolExecution.ts`
- `mini-cc/src/utils/permissions/PermissionResult.ts`
- `mini-cc/src/utils/permissions/permissions.ts`
- `mini-cc/src/tools/BashTool.ts`
- `mini-cc/src/tools/BashTool/bashSafety.ts`
