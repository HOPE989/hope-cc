# Claude Code Permission / Tool Safety 源码分析

## Learning Question

第二课已经让真实模型能发起 `bash` tool call。接下来必须回答的问题是：

```text
模型请求执行工具
-> 系统如何决定 allow / ask / deny
-> 被拒绝时如何把结果回填给模型
```

这个机制的关键不是“写几个危险命令正则”。Claude Code 把权限拆成三层：

1. 工具自己判断输入风险，例如 Bash 识别子命令、路径、shell 注入和规则匹配。
2. 统一 permission pipeline 把工具结果、配置规则和 permission mode 合成最终决策。
3. 工具执行层只在最终 `allow` 后调用 `tool.call()`；拒绝或询问失败也会回填为 `tool_result`。

## Scope

本文覆盖：

- `hasPermissionsToUseTool` 如何把工具级 `PermissionResult` 转成最终 `PermissionDecision`。
- Bash 权限检查为什么不是简单正则，而是规则、路径、安全解析和子命令合并。
- PreToolUse / PostToolUse hooks 插在工具执行前后的什么位置。
- `mini-cc` Lesson 03 如何保留最小安全边界。

本文不覆盖：

- 完整 settings 权限规则持久化。
- auto mode classifier、Bash prompt classifier 和 speculative classifier。
- sandbox 运行细节。
- MCP / swarm / bridge 的远程权限同步。

## Mental Model

把权限链路看成一个闸门，而不是工具内部的一句 `if`：

```text
tool_use
-> find tool
-> PreToolUse hooks
-> tool.checkPermissions(input)
-> hasPermissionsToUseTool(...)
-> allow ? tool.call() : tool_result(error)
-> PostToolUse / PostToolUseFailure hooks
```

`allow / ask / deny / passthrough` 的含义：

- `allow`：可以执行，可能带 `updatedInput`。
- `deny`：明确拒绝，直接形成错误 tool_result。
- `ask`：需要用户或外部控制面批准。
- `passthrough`：工具本身没有强意见，交给统一 permission pipeline 转成 ask、mode allow 或规则 allow。

## Execution Flow

### 1. 工具执行层先跑 hook，再做权限决策

源码确认：

- `src/services/tools/toolExecution.ts:800`：执行工具前先迭代 `runPreToolUseHooks(...)`。
- `src/services/tools/toolExecution.ts:921`：随后调用 `resolveHookPermissionDecision(...)`。
- `src/services/tools/toolExecution.ts:995`：如果最终决策不是 `allow`，不会调用工具。
- `src/services/tools/toolExecution.ts:1032`：拒绝会构造成 `tool_result`，并设置错误内容。
- `src/services/tools/toolExecution.ts:1483`：工具成功后进入 `runPostToolUseHooks(...)`。
- `src/services/tools/toolExecution.ts:1720`：工具失败后也会构造错误 `tool_result`。

设计结论：

权限不是 BashTool 自己返回一段字符串那么简单。执行层必须先拿到结构化 decision，再决定是否真正调用工具；如果拒绝，也要用原始 `tool_use_id` 回填，让模型知道这次工具请求失败。

### 2. PreToolUse hook 可以给权限建议，但不能无条件绕过规则

源码确认：

- `src/services/tools/toolHooks.ts:332`：`resolveHookPermissionDecision(...)` 把 hook 权限结果和 `canUseTool` 合并。
- `src/services/tools/toolHooks.ts:358`：即使 hook allow，某些场景仍然强制调用 `canUseTool`。
- `src/services/tools/toolHooks.ts:381`：hook allow 后还会跑 `checkRuleBasedPermissions(...)`。
- `src/services/tools/toolHooks.ts:397`：如果规则要求 ask，仍然回到 `canUseTool(...)`。
- `src/services/tools/toolHooks.ts:423`：没有 hook 决策或 hook ask 时，走正常 permission flow。

设计结论：

hook 是权限链路的一部分，不是超级后门。`mini-cc` Lesson 03 暂不实现 hook，但实现时必须保留“hook 不能覆盖 hard deny / safety ask”的压力点。

### 3. `hasPermissionsToUseTool` 是最终权限合成器

源码确认：

- `src/utils/permissions/permissions.ts:473`：`hasPermissionsToUseTool` 是 `CanUseToolFn` 的实现。
- `src/utils/permissions/permissions.ts:1071`：`checkRuleBasedPermissions(...)` 只跑规则子集，供 hook allow 后二次检查。
- `src/utils/permissions/permissions.ts:1158`：`hasPermissionsToUseToolInner(...)` 是主权限合成逻辑。
- `src/utils/permissions/permissions.ts:1268`：`bypassPermissions` / plan+bypass 可把非硬拦截转成 allow。
- `src/utils/permissions/permissions.ts:503`：`dontAsk` 会把 ask 转成 deny。
- `src/types/permissions.ts:177`、`src/types/permissions.ts:202`、`src/types/permissions.ts:232`、`src/types/permissions.ts:251`：类型层面区分 allow / ask / deny / passthrough。

设计结论：

Claude Code 的权限不是单点判断，而是把工具判断、规则、模式和交互能力合成最终结果。`mini-cc` 保留这个形状：工具返回 `PermissionResult`，统一 `hasPermissionToUseTool()` 产出 `PermissionDecision`。

### 4. Bash 权限检查是工具级复杂策略

源码确认：

- `src/tools/BashTool/bashPermissions.ts:991`：先检查 exact command deny / ask / allow。
- `src/tools/BashTool/bashPermissions.ts:1050`：`bashToolCheckPermission(...)` 处理 prefix 规则、路径约束、mode、只读命令。
- `src/tools/BashTool/bashPermissions.ts:1112`：`checkPathConstraints(...)` 负责路径边界。
- `src/tools/BashTool/bashPermissions.ts:1183`：`checkCommandAndSuggestRules(...)` 会结合安全检查和规则建议。
- `src/tools/BashTool/bashPermissions.ts:1663`：`bashToolHasPermission(...)` 是 Bash 主权限入口。
- `src/tools/BashTool/bashPermissions.ts:2164`：复杂 compound command 超过上限会退回 ask。
- `src/tools/BashTool/bashPermissions.ts:2233`：deny / ask 规则要先于路径约束，避免被路径 ask 掩盖。
- `src/tools/BashTool/bashPermissions.ts:2276`：原始命令上的 redirection 也要做路径约束。

设计结论：

Bash 是高风险工具，所以它自己的 `checkPermissions` 必须比普通工具更保守。`mini-cc` 不复刻 AST / classifier，但至少拆出独立 `bashSafety.ts`，让 BashTool 的执行体不再拥有安全策略。

### 5. Bash 安全解析关注 shell 注入和解析差异

源码确认：

- `src/tools/BashTool/bashSecurity.ts:16`：存在命令替换、process substitution、Zsh expansion 等危险模式集合。
- `src/tools/BashTool/bashSecurity.ts:2109`：`validateQuotedNewline(...)` 专门处理带引号换行隐藏参数的攻击。
- `src/tools/BashTool/bashSecurity.ts:2186`：`validateZshDangerousCommands(...)` 识别 Zsh 特有危险能力。
- `src/tools/BashTool/bashSecurity.ts:2251`：控制字符会触发安全检查。
- `src/tools/BashTool/bashSecurity.ts:2426`：`bashCommandIsSafeAsync_DEPRECATED(...)` 会优先尝试 tree-sitter 分析，失败后才走 legacy 检查。

设计结论：

真实 Claude Code 的 Bash 安全边界主要是在防“解析器看到的命令”和“shell 实际执行的命令”不一致。`mini-cc` 的简单字符串检查只能作为教学最小模型，不能被写成生产级安全结论。

## Source Evidence

| 源码位置 | 关键事实 |
|---|---|
| `src/services/tools/toolExecution.ts:800` | 工具执行前先跑 PreToolUse hooks。 |
| `src/services/tools/toolExecution.ts:921` | hook 结果与 `canUseTool` 合并成最终权限决策。 |
| `src/services/tools/toolExecution.ts:995` | 非 allow 决策不会执行工具。 |
| `src/services/tools/toolExecution.ts:1032` | 拒绝会作为错误 `tool_result` 回填。 |
| `src/services/tools/toolHooks.ts:332` | `resolveHookPermissionDecision` 是 hook 与权限系统的合流点。 |
| `src/utils/permissions/permissions.ts:473` | `hasPermissionsToUseTool` 是主 `CanUseToolFn`。 |
| `src/utils/permissions/permissions.ts:1158` | 主权限合成逻辑在 `hasPermissionsToUseToolInner`。 |
| `src/tools/BashTool/bashPermissions.ts:1663` | Bash 主权限入口是 `bashToolHasPermission`。 |
| `src/tools/BashTool/bashSecurity.ts:2426` | Bash 安全检查包含 tree-sitter / legacy 双路径。 |

## Build-Along Derivation

Lesson 03 在 `mini-cc` 中保留这些边界：

| Claude Code 边界 | mini-cc 对应 | 本课取舍 |
|---|---|---|
| `tool.checkPermissions(...)` | `Tool.checkPermissions?` | 工具可声明自己的风险判断。 |
| `PermissionResult` / `PermissionDecision` | `utils/permissions/PermissionResult.ts` | 保留 allow / ask / deny / passthrough 四态。 |
| `hasPermissionsToUseTool` | `utils/permissions/permissions.ts` | 统一把工具结果和 permission mode 合成最终决策。 |
| Bash 安全策略 | `tools/BashTool/bashSafety.ts` | 只做 hard deny、工作区路径 guard、敏感路径 ask、shell operator ask、只读 allow。 |
| execution gate | `services/tools/toolExecution.ts` | 非 allow 不调用 `tool.call()`，而是回填错误 tool_result。 |
| interactive ask | `main.ts` / `QueryEngine.ts` | 默认模式把 ask 交回 REPL 询问用户。 |

## 源码确认 / 合理推断 / 待验证

源码确认：

- Claude Code 的权限检查发生在 `tool.call()` 之前。
- 拒绝工具调用不会破坏 transcript，而是生成错误 `tool_result`。
- hook 可以影响权限，但 hook allow 后仍会受规则检查约束。
- Bash 权限检查包含规则匹配、路径约束、子命令拆分和 shell 安全解析。
- `passthrough` 最终会被统一权限层转成 ask、mode allow 或规则 allow。

合理推断：

- `mini-cc` 不应继续把危险命令判断写在 `BashTool.call()` 里；那会让后续文件工具、MCP 工具各自重复安全逻辑。
- Lesson 03 的最小实现应优先保留决策形状，而不是试图复刻 Claude Code 的完整 Bash AST 安全系统。
- `bypass` 模式可以作为教学里的“非硬拦截自动允许”，但 hard deny 仍应先于 bypass。

待验证：

- 真实 Claude Code 在不同 permission mode 下，对 Bash safety ask 与用户 ask rule 的优先级还有更多细节。
- `checkPathConstraints` 对 Windows path、redirection 和 compound command 的精确处理需要后续单独实验。
- classifier 与 interactive prompt 并发竞争的行为需要 `cc-practice-lab` 做运行观察。

## mini-cc Lesson 03 Design

本课实现后的最小路径：

```text
model tool_use(name=bash)
-> runToolUse()
-> hasPermissionToUseTool()
-> BashTool.checkPermissions()
-> evaluateBashPermission()
-> allow ? BashTool.call() : error tool_result
```

默认 `MINI_CC_PERMISSION_MODE`：

- 未设置或 `default`：`ask` 会在 REPL 中询问用户。
- `deny`：`ask` 自动转成 deny，适合非交互测试。
- `bypass`：`ask` 自动转成 allow，但 hard deny 仍然拒绝。

这是教学实现，不是生产级 sandbox。它的价值是把权限边界从具体工具执行体里拆出来，为后续文件工具、hooks、session 和 MCP 留出共同接口。

## 用户补充注释

代码中允许出现 `//L03` 这种没有 `-Sxx` 分段号的注释。它们不参与主阅读路径编号，而是用户对当前机制的补充理解。本课已有补充如下：

| 文件 | 补充说明 | 机制含义 |
|---|---|---|
| `mini-cc/src/Tool.ts` | `requestApproval` 是请求权限审批的回调，返回用户是否批准工具使用。 | 权限确认能力来自入口层，不属于具体工具执行逻辑。 |
| `mini-cc/src/services/tools/toolExecution.ts` | permission gate 是 Lesson 03 的核心逻辑入口。 | `runToolUse()` 是 `tool_use` 变成副作用前的最后统一拦截点。 |
| `mini-cc/src/utils/permissions/permissions.ts` | 没有 `requestApproval` 回调也按 deny 处理，避免工具直接放行的安全风险。 | 无交互能力时必须 fail closed，不能默认 allow。 |
| `mini-cc/src/utils/permissions/permissions.ts` | `main.ts` 中的 `requestApproval` 回调实际询问用户，相当于 human in the loop。 | `ask` 决策不是工具自己处理，而是回到人类确认环节。 |
| `mini-cc/src/tools/BashTool/bashSafety.ts` | 涉及外部目录时进入 ask。 | 工作区边界外的路径访问不能静默执行。 |
| `mini-cc/src/tools/BashTool/bashSafety.ts` | 涉及敏感文件时进入 ask。 | `.env`、`.git`、`.claude`、`.ssh` 等路径即使在工作区内也需要确认。 |
| `mini-cc/src/tools/BashTool/bashSafety.ts` | 其他命令默认 ask。 | 未明确证明安全的命令走确认路径，保持 fail-closed。 |

## Verification

本课用直接模块实验验证：

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

并补充验证了执行层行为：

```text
runToolUse(dir, deny mode) -> allow 后真实执行
runToolUse(del temp.txt, deny mode) -> 错误 tool_result，不执行工具
runToolUse(rm -rf /, bypass mode) -> hard deny 仍然拒绝
```

真实模型端到端验证仍需要可用的 `ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL` 和模型配置。
