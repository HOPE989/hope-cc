---
name: cc-build-along
description: Guide the user through building a small Claude Code-like coding agent while studying hope-cc. Use when the user wants to learn by implementing mini-cc, start with an agent loop, add tools, todos, subagents, context compaction, skills, permissions, plugins, or gradually evolve a simplified cc alongside source reading.
---

# CC Build Along

Use this skill to teach Claude Code by building a small, runnable Claude Code-like project step by step.

## Goal

Every lesson should have three outputs:

1. **Source reading**: what the real Claude Code source appears to do.
2. **Mini implementation**: a smaller version we write ourselves.
3. **JOB-WIKI source notes**: what this teaches as `cc` practice material.

Do not try to fully clone Claude Code. The point is to learn harness mechanisms by rebuilding their core shape.

## Default Implementation Strategy

- Prefer TypeScript / Node for the simplified implementation because `hope-cc` source is TypeScript-heavy.
- Keep each lesson small and runnable.
- Let architecture follow Claude Code as much as practical. Do not use arbitrary tutorial structure when a real cc module boundary is visible.
- Prefer these evolving boundaries:
  - `src/query.ts` for the core loop.
  - `src/QueryEngine.ts` for SDK/headless-style entry wrapping.
  - `src/Tool.ts` and `src/tools/` for tool abstraction and concrete tools.
  - `src/services/api/` for model provider adapters.
  - `src/services/tools/` for tool execution and orchestration.
  - later: `src/utils/permissions/`, `src/services/compact/`, `src/skills/`, `src/commands/`.
- Put implementation under the agreed directory, likely:

```text
mini-cc/
```

- After the layout is approved, put lesson notes under:

```text
docs/build-along/cc/
```

- After the layout is approved, put JOB-WIKI-ready source drafts under:

```text
docs/wiki-source/cc/raw/
```

## Lesson Loop

For each topic:

0. Check or update `docs/wiki-source/cc/00-learning-map.md` with `cc-onboarding`.
1. Pick one Claude Code mechanism and state its priority and adjacent topics.
2. Use `cc-code-explorer` to inspect the real source.
3. Define a minimal learning version.
4. Implement or update the simplified project only after the architecture/location is already established or the user has approved a new one.
5. Run a small verification command.
6. Write a lesson note that explains how the source facts became implementation decisions.
7. If useful, hand off to `cc-job-wiki-source` for an ingest-ready raw project document.

## Curriculum

| Lesson | Mechanism | Mini-cc deliverable |
|---|---|---|
| 01 | Agent loop | `query.ts` / `QueryEngine.ts` / `Tool.ts` skeleton with `messages`, `tools`, and `tool_result` feedback |
| 02 | Tool dispatcher | `services/tools/toolExecution.ts`, `toolOrchestration.ts`, `read_file`, `write_file`, `edit_file`, `bash` |
| 03 | Path and command safety | workspace path guard, dangerous command classifier, output limits |
| 04 | Todo/task state | persistent todo list and task lifecycle |
| 05 | Context building | system prompt, project facts, recent history, tool output shaping |
| 06 | Context compaction | transcript save, summary message, old tool-result shrinking |
| 07 | Skill loading | skill index, description routing, on-demand skill file loading |
| 08 | Slash commands | command registry and command handlers |
| 09 | Subagent | child loop with isolated messages and summary return |
| 10 | Hooks / telemetry | event log, cost placeholders, trace spans |
| 11 | Plugin / MCP shape | simplified external tool provider interface |
| 12 | Session persistence | saved conversations, resume, compact handoff |

## Teaching Rules

- Teach one mechanism at a time.
- Keep the main loop understandable, but preserve the same architectural pressure points as Claude Code.
- When adding a feature, first decide which real Claude Code boundary it belongs to; avoid placing everything in `query.ts`.
- When real Claude Code is more complex, explain what is intentionally omitted.
- Prefer code that can run locally without hidden services. If an LLM API is needed, isolate it behind a provider interface.
- Record open questions instead of pretending the mini implementation equals production behavior.

## Lesson Note Template

````markdown
# Lesson <NN>: <机制名>

## What We Read
- Learning question:
- Real source paths:
- Reading path:
- Key discoveries:

## Source-To-Design Derivation
说明如何从 Claude Code 源码事实推导出 mini-cc 的设计：
- Claude Code 的模块边界：
- mini-cc 保留的边界：
- mini-cc 暂时省略的复杂度：
- 这样取舍的原因：

## What We Built
- Files changed:
- Behavior:

## Implementation Steps
按实际实现顺序记录：
1. 先创建 / 修改 ...
2. 再连接 ...
3. 最后验证 ...

## How To Run
```powershell
...
```

## What This Teaches
- Harness pattern:
- Trade-off:

## Architecture Evolution
- 本课之前：
- 本课之后：
- 下一课应该补：

## Difference From Claude Code
- Simplified:
- Missing:

## Candidate JOB-WIKI Mapping
- project: cc
- entry candidates:
- question candidates:
- scenario candidates:
````

## Done Criteria

A lesson is complete only when:

- The relevant source path has been inspected.
- The lesson note explains how source facts became mini-cc design decisions.
- The mini implementation is runnable or clearly marked as design-only.
- The lesson note explains the gap between the simplified project and real Claude Code.
- The candidate JOB-WIKI mapping is included without assuming access to existing wiki pages.
