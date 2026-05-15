# Lesson 03: Permission / Tool Safety Build-Along

## What We Built

本课给 `mini-cc` 增加最小权限层，让真实模型发起 `bash` tool call 时不再直接进入 `BashTool.call()`。

新路径是：

```text
tool_use
-> runToolUse()
-> hasPermissionToUseTool()
-> BashTool.checkPermissions()
-> evaluateBashPermission()
-> allow: call tool
-> deny/ask rejected: return error tool_result
```

机制分析见 `docs/wiki-source/cc/analysis/claude-code-permission-tool-safety.md`。

## Source-To-Design Derivation

| 源码事实 | mini-cc 具体改动 | 为什么这样改 |
|---|---|---|
| Claude Code 在工具执行前通过 `canUseTool` 合成最终权限决策。 | 新增 `mini-cc/src/utils/permissions/permissions.ts`，提供 `hasPermissionToUseTool()`。 | `queryLoop` 和具体工具都不应该直接拥有最终权限策略。 |
| 权限结果有 allow / ask / deny / passthrough。 | 新增 `mini-cc/src/utils/permissions/PermissionResult.ts`。 | 保留 Claude Code 的决策形状，后续可以接规则、hooks、session。 |
| Bash 工具有自己的复杂安全检查。 | 新增 `mini-cc/src/tools/BashTool/bashSafety.ts`，从 `BashTool.call()` 中移出危险命令判断。 | 安全策略应先于执行，并和工具协议分层。 |
| 非 allow 决策不会执行工具，而是回填错误 `tool_result`。 | 修改 `mini-cc/src/services/tools/toolExecution.ts`。 | 模型需要看到权限失败，而不是工具静默不执行或进程崩溃。 |
| 交互式 permission ask 属于入口能力。 | 修改 `mini-cc/src/main.ts` 和 `mini-cc/src/QueryEngine.ts`，把 `requestApproval` 放入 `ToolUseContext`。 | 执行层消费统一上下文，不直接持有 readline。 |

## Files Changed

| 文件 | 变更 |
|---|---|
| `mini-cc/src/Tool.ts` | 增加 `ToolPermissionContext`、`ToolPermissionRequest`、`Tool.checkPermissions()`。 |
| `mini-cc/src/utils/permissions/PermissionResult.ts` | 新增权限结果类型。 |
| `mini-cc/src/utils/permissions/permissions.ts` | 新增统一权限决策函数。 |
| `mini-cc/src/tools/BashTool/bashSafety.ts` | 新增 Bash 最小风险分类，包括 hard deny、工作区外路径、敏感路径、shell operator、破坏性命令和只读命令。 |
| `mini-cc/src/tools/BashTool.ts` | 暴露 `checkPermissions()`，移除执行体内的危险命令判断。 |
| `mini-cc/src/services/tools/toolExecution.ts` | 执行工具前先检查权限，拒绝时回填错误结果。 |
| `mini-cc/src/QueryEngine.ts` | 把权限上下文传入 `query()`。 |
| `mini-cc/src/main.ts` | 默认交互式 ask；支持 `MINI_CC_PERMISSION_MODE=deny/bypass`。 |
| `docs/wiki-source/cc/analysis/claude-code-permission-tool-safety.md` | 新增源码机制分析。 |
| `docs/build-along/cc/03-permission-tool-safety.md` | 本文档。 |

## Implementation Steps

1. 定义权限类型：`allow / ask / deny / passthrough`。
2. 扩展 `Tool` 协议：工具可以实现 `checkPermissions()`。
3. 新增 Bash 风险分类：hard deny、工作区外路径 ask、敏感路径 ask、shell operator ask、破坏性命令 ask、只读命令 allow。
4. 新增统一权限合成：hard deny / allow 先返回；`passthrough` 转 ask；`deny` 模式拒绝；`bypass` 模式允许；默认模式询问用户。
5. 修改执行层：只有 `allow` 才调用 `tool.call()`。
6. 修改入口：REPL 提供 `requestApproval()`，让 ask 可以在入口层交互。

## Annotated Code Walkthrough

这一节对应代码中的 `//L03-Sxx` 注释。

| Step | 文件 | 本课作用 |
|---|---|---|
| L03-S01 | `mini-cc/src/main.ts` | 应用入口读取 `MINI_CC_PERMISSION_MODE`，决定本次运行的权限模式。 |
| L03-S02 | `mini-cc/src/main.ts` | 应用入口提供 `requestApproval()`，让默认模式可以向用户确认 ask。 |
| L03-S03 | `mini-cc/src/Tool.ts` | `ToolUseContext` 承载入口层准备好的权限能力。 |
| L03-S04 | `mini-cc/src/QueryEngine.ts` | `QueryEngine` 把权限上下文传入 `query()`，自己不做权限判断。 |
| L03-S05 | `mini-cc/src/services/tools/toolExecution.ts` | `runToolUse()` 在工具产生副作用前进入 permission gate。 |
| L03-S06 | `mini-cc/src/utils/permissions/PermissionResult.ts` | 定义 allow / ask / deny / passthrough 四态权限协议。 |
| L03-S07 | `mini-cc/src/utils/permissions/permissions.ts` | 统一 permission 层调用工具级 `checkPermissions()`。 |
| L03-S08 | `mini-cc/src/utils/permissions/permissions.ts` | 直接尊重工具给出的 hard deny / allow。 |
| L03-S09 | `mini-cc/src/utils/permissions/permissions.ts` | 把 passthrough 归一成 ask。 |
| L03-S10 | `mini-cc/src/utils/permissions/permissions.ts` | 应用 bypass 模式，但只绕过 ask。 |
| L03-S11 | `mini-cc/src/utils/permissions/permissions.ts` | 支持 deny 模式和无交互场景的 fail-closed。 |
| L03-S12 | `mini-cc/src/Tool.ts` | 给工具协议增加 `checkPermissions()`，让工具先声明输入风险。 |
| L03-S13 | `mini-cc/src/tools/BashTool.ts` | BashTool 暴露工具级权限检查，执行体不再拥有安全策略。 |
| L03-S14 | `mini-cc/src/tools/BashTool/bashSafety.ts` | 建立 workspace path guard，拦住工作区外路径。 |
| L03-S15 | `mini-cc/src/tools/BashTool/bashSafety.ts` | 标记 `.env/.git/.claude/.ssh` 等敏感路径为 ask。 |
| L03-S16 | `mini-cc/src/tools/BashTool/bashSafety.ts` | 收敛只读白名单，未知命令默认进入 ask。 |
| L03-S17 | `mini-cc/src/tools/BashTool/bashSafety.ts` | 进入 Bash 风险分类，把原始命令转成结构化权限结果。 |
| L03-S18 | `mini-cc/src/tools/BashTool/bashSafety.ts` | hard deny 先于 permission mode，bypass 也不能绕过。 |
| L03-S19 | `mini-cc/src/tools/BashTool/bashSafety.ts` | shell operator、重定向、管道、命令替换进入 ask。 |
| L03-S20 | `mini-cc/src/tools/BashTool/bashSafety.ts` | 破坏性文件命令进入 ask，不静默执行。 |
| L03-S21 | `mini-cc/src/tools/BashTool/bashSafety.ts` | 只读观察命令在 guard 之后自动 allow。 |
| L03-S22 | `mini-cc/src/services/tools/toolExecution.ts` | 非 allow 回填带原 `tool_use_id` 的错误 tool_result。 |
| L03-S23 | `mini-cc/src/services/tools/toolExecution.ts` | 只有 allow 后才调用 `tool.call()` 产生副作用。 |

同时保留 `L01-S24` 作为迁移说明：第一课的内联危险命令判断已经成为过去式实现，Lesson 03 把它迁移到权限模块。

## How To Run

默认交互模式：

```powershell
Set-Location C:\dev\workspace\hope-cc\mini-cc
npm run dev
```

非交互拒绝模式：

```powershell
$env:MINI_CC_PERMISSION_MODE='deny'
npm run dev
```

教学用 bypass 模式：

```powershell
$env:MINI_CC_PERMISSION_MODE='bypass'
npm run dev
```

`bypass` 只绕过 ask；`rm -rf /` 这类 hard deny 仍会拒绝。

## Verification

已运行两组直接模块实验。

第一组验证 Bash 风险分类和 permission mode：

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

命令：

```powershell
Set-Location C:\dev\workspace\hope-cc\mini-cc
@'
import { evaluateBashPermission } from './src/tools/BashTool/bashSafety.ts';
import { BashTool } from './src/tools/BashTool.ts';
import { hasPermissionToUseTool } from './src/utils/permissions/permissions.ts';

const cwd = process.cwd();
const cases = ['dir', 'git status', 'rm -rf /', 'del temp.txt', 'type ../secret.txt', 'echo hi > out.txt', 'type .env'];
for (const command of cases) {
  console.log(command, '=>', evaluateBashPermission({ command }, { cwd }));
}
console.log('deny mode =>', await hasPermissionToUseTool({ tool: BashTool, input: { command: 'del temp.txt' }, context: { cwd, permissionContext: { mode: 'deny' } } }));
console.log('bypass mode =>', await hasPermissionToUseTool({ tool: BashTool, input: { command: 'del temp.txt' }, context: { cwd, permissionContext: { mode: 'bypass' } } }));
'@ | node --experimental-strip-types
```

第二组验证执行层确实在 `tool.call()` 前消费权限决策：

```text
runToolUse(dir, deny mode) -> 执行并返回真实 tool_result
runToolUse(del temp.txt, deny mode) -> 返回权限拒绝 tool_result
runToolUse(rm -rf /, bypass mode) -> 仍返回 hard deny tool_result
```

真实模型端到端验证需要有效的 Anthropic-compatible 配置。

## Architecture Evolution

Lesson 02 结束时：

```text
runToolUse -> BashTool.call -> inline dangerous command check
```

Lesson 03 后：

```text
runToolUse
-> hasPermissionToUseTool
-> BashTool.checkPermissions
-> bashSafety
-> BashTool.call only after allow
```

这个变化把“是否允许执行”和“如何执行”拆开了。后续新增文件工具时，可以复用同一条 permission pipeline，而不是在每个工具里各写一套拦截。

## Difference From Claude Code

- Claude Code 有 settings 规则、policy 规则、session 规则；本课只有 runtime mode。
- Claude Code 的 Bash safety 有 AST / tree-sitter / classifier / sandbox；本课只做保守字符串分类。
- Claude Code 的 ask 可以进入 UI、SDK、bridge、swarm；本课只支持 REPL prompt。
- Claude Code 有 PreToolUse / PostToolUse / PermissionRequest hooks；本课只保留接口压力点，尚未实现 hooks。

## Next Frontier

- Tool Dispatcher：新增 read/write/edit 工具并复用 permission pipeline。
- Permission Hooks：把 PreToolUse / PostToolUse 的最小 hook 链路接进 `mini-cc`。
- Streaming Provider：让真实模型 streaming 下也能稳定产生完整 `tool_use`。
