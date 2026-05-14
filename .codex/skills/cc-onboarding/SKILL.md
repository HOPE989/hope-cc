---
name: cc-onboarding
description: Build and maintain the Claude Code learning map for hope-cc. Use when the user wants to start exploring cc, choose a mechanism, update frontier, understand project learning order, or place a topic before source analysis or mini-cc implementation.
---

# CC Onboarding

Use this skill to keep the learning map small, current, and mechanism-driven.

## Boundary

`AGENTS.md` owns product rules. This skill only updates the learning route.

Do not create raw documents. Raw is generated only when the user explicitly asks for raw / JOB-WIKI source / ingest packaging.

## Workflow

1. **Anchor the current mechanism**
   - Use the mechanism named by the user.
   - Do not create a detached full-codebase curriculum before the current mechanism is placed.

2. **Inspect current map**
   - Read `docs/wiki-source/cc/00-learning-map.md` if it exists.
   - Update the smallest relevant section.

3. **Maintain frontier**
   - Record current node.
   - Record confirmed source facts if known.
   - Record `mini-cc` completed scope if relevant.
   - Add next topics as:
     - `要学习`
     - `要拓展`
     - `要优化`

4. **Define expected outputs**
   - Default outputs: `analysis`, optional `build-along`, optional `mini-cc`.
   - Include `raw` only when the user explicitly asks for raw / JOB-WIKI source / ingest packaging.

5. **Hand off**
   - Use `cc-code-explorer` for source mechanism analysis.
   - Use `cc-build-along` for implementation.
   - Use `cc-practice-lab` for behavior verification.
   - Use `cc-job-wiki-source` only on explicit raw request.

## Learning Map Shape

Keep the map practical, not exhaustive:

```markdown
# Claude Code 源码学习地图

## Current State
## How To Use This Map
## Completed Nodes
## Current Node
## Frontier Queue
## Source Index
## Next Lesson
## Open Questions
```

## Quality Rules

- Update only the relevant area.
- Do not prefill future raw file paths.
- Prefer source paths and concrete mechanisms over broad topic names.
- Mark uncertainty as `待验证`.
