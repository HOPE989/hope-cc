---
name: cc-onboarding
description: Build and maintain the learning map for the Claude Code source project in hope-cc. Use when the user wants to start exploring cc, choose learning topics, understand the codebase shape, plan a study path, or decide which source mechanisms should become JOB-WIKI raw project documents under raw/Projects/cc.
---

# CC Onboarding

Use this skill to turn the `hope-cc` source tree into a navigable learning system.

## Goal

Create a practical map for studying Claude Code (`cc`) as a personal engineering practice project. The output should guide later deep dives and produce source material that can be copied into:

```text
C:\dev\workspace\h0pe\JOB-WIKI\raw\Projects\cc\
```

Do not write directly into `JOB-WIKI/raw` unless the user explicitly asks. Treat `JOB-WIKI/raw` as immutable after a file is placed there.

## First Steps

1. Inspect the source tree with `rg --files`, directory listings, and package/config files.
2. Identify major subsystems by responsibility, not only by folder name.
3. Connect each subsystem to candidate JOB-WIKI semantic directions. Do not assume this session can see or verify existing `JOB-WIKI/wiki` pages. Use names as ingest suggestions only.
4. Produce a learning map or update an existing one under the local workspace, not under JOB-WIKI raw by default.

## Mechanism-Anchored Frontier Learning

Use this skill as a prerequisite whenever the user asks to start learning from a concrete Claude Code mechanism, such as `agent loop`, `tool dispatcher`, `context compaction`, `permissions`, `skills`, `plugins`, `MCP`, `slash commands`, or `subagent`.

The onboarding must be anchored to the mechanism the user named. Use the mechanism as the current node, then update the learning map with the next frontier nodes it reveals. Do not pause the learning flow to create a detached full-codebase plan first.

Do not jump directly into `cc-code-explorer` or `cc-build-along` until the requested mechanism has been placed in the learning route and priority queue.

For an existing learning map, a lightweight update is enough:

- Treat the requested mechanism as the anchor.
- Confirm where the requested mechanism sits in the overall learning route.
- Confirm its priority, such as P0/P1/P2.
- List adjacent frontier topics that should be learned, expanded, or optimized next.
- Preserve why each frontier topic was discovered from the current mechanism.
- State the expected outputs for this learning turn: `analysis`, `build-along`, `raw`, and/or `mini-cc` implementation.

For a missing learning map, create `docs/wiki-source/cc/00-learning-map.md` from the requested mechanism outward, not as an exhaustive upfront survey.

## Recommended Output

Create or update the learning map in the approved documentation location:

```text
docs/wiki-source/cc/00-learning-map.md
```

Use this structure:

```markdown
# Claude Code 源码学习地图

## TL;DR
一句话说明本项目作为个人实践能沉淀什么能力。

## Codebase Map
按子系统说明源码目录、职责和阅读入口。

## Learning Tracks
- Agent Loop / Query
- Context / Compaction
- Tool Calling / Permission
- Skills / Plugins / MCP
- CLI / Commands
- UI / Ink
- Bridge / Remote Session
- Observability / Cost / Telemetry

## Priority Queue
按 P0/P1/P2 列出下一批值得精读的机制。

## Frontier Queue
按“当前机制 -> 牵出的下一层主题”维护学习队列：
- 已完成节点：
- 当前节点：
- 新发现 frontier：
- 对 mini-cc 的学习 / 拓展 / 优化影响：

## Learning Narrative Plan
说明每个高优先级主题应该怎样学：
- 要回答的设计问题
- 推荐阅读入口
- 预期产出的 analysis / build-along / raw 文档
- mini-cc 可能演进的模块

## Candidate JOB-WIKI Mapping
列出后续 ingest 时可能更新的 project / entry / question / scenario 方向。只作为候选映射，不要求与现有 wiki 页面完全一致。

## Source Candidates
列出适合沉淀到 `raw/Projects/cc` 的源文档候选主题。

## Open Questions
记录尚未验证的源码问题。
```

## Quality Rules

- Keep statements grounded in source files.
- Prefer exact file paths and symbol names over vague module labels.
- Do not present Claude Code vendor behavior as personal implementation unless the document explicitly frames it as source-study practice.
- When unsure, mark it as `待验证` instead of inventing intent.

## Handoff

After mapping, use:

- `cc-code-explorer` for one mechanism or call chain.
- `cc-build-along` when the mechanism should evolve `mini-cc`.
- `cc-practice-lab` when behavior needs runtime or experiment verification.
- `cc-job-wiki-source` to package the result as a JOB-WIKI raw project document.
