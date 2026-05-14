---
name: cc-practice-lab
description: Run safe experiments against the Claude Code source project in hope-cc to validate learning. Use when the user wants to verify how a cc mechanism behaves, run tests, add temporary instrumentation, compare hypotheses, debug a flow, or produce experiment evidence for JOB-WIKI raw/Projects/cc source documents.
---

# CC Practice Lab

Use this skill when source reading is not enough and a behavior needs empirical verification.

## Principle

Experiments must be small, reversible, and documented. The output is evidence for the user's `cc` practice project, not a production change unless the user explicitly asks.

## Workflow

1. **State the hypothesis**
   - Example: `compact` should preserve recent user/tool context but summarize older messages.
   - Mark expected observations before running commands.

2. **Find the narrowest test surface**
   - Prefer existing tests, small scripts, CLI flags, or isolated functions.
   - Avoid broad app startup unless needed.

3. **Check worktree state**
   - Run `git status --short`.
   - Do not revert unrelated user changes.

4. **Add temporary instrumentation only when needed**
   - Use minimal logs or focused assertions.
   - Keep a cleanup note.
   - Do not leave noisy instrumentation unless it becomes part of an intentional patch.

5. **Run and record**
   - Capture command, observed output, and interpretation.
   - Distinguish confirmed behavior from failed setup.

6. **Package findings**
   - Write local experiment notes under the approved documentation location:

```text
docs/wiki-source/cc/experiments/<topic-slug>.md
```

## Experiment Template

```markdown
# Experiment: <主题>

## Hypothesis
我预计...

## Source Context
- 相关源码：
- 相关配置：

## Setup
- 环境：
- 命令：

## Steps
1. ...

## Observations
| 步骤 | 观察 | 证据 |
|---|---|---|

## Result
- confirmed / disproved / inconclusive

## Impact on Understanding
这个实验如何修正源码理解。

## JOB-WIKI Value
可支撑的候选 project / entry / question / scenario 方向：
- project: cc
- entry candidates:
- question candidates:
- scenario candidates:

## Cleanup
- 已清理：
- 仍需处理：
```

## Safety Rules

- Do not run destructive commands such as `git reset --hard` or broad deletion.
- Do not modify `JOB-WIKI/raw` from an experiment.
- If temporary edits are made, clearly report them and clean them up unless the user wants to keep them.
- If tests fail because of environment setup, say so directly and do not over-interpret.

## Handoff

Use `cc-code-explorer` when experiment results reveal a new call chain to inspect.
Use `cc-job-wiki-source` when the experiment should become part of a raw project document.
