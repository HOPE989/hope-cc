---
name: cc-build-along
description: Implement or evolve mini-cc from a Claude Code mechanism, maintaining lesson code comments and build-along documentation. Use when the user wants to build mini-cc, add tools, permissions, compaction, skills, plugins, subagents, sessions, or turn analysis into runnable teaching code.
---

# CC Build Along

Use this skill to turn a source-backed mechanism into runnable `mini-cc` code and a course-oriented development record.

## Boundary

`AGENTS.md` owns global product rules. This skill owns implementation workflow only.

Default outputs are `mini-cc` changes and `docs/build-along/cc/`. Build-along is an internal project document: it exists to guide this repository's learning and construction process, not to explain the full Claude Code mechanism to external implementers. It is the project-internal place for lesson structure, `mini-cc` implementation choices, `Lxx-Sxx` walkthroughs, verification commands, and learning frontier. Do not generate raw unless the user explicitly asks for raw / JOB-WIKI source / ingest packaging.

Only update build-along when the turn changes `mini-cc` code, lesson comments, scripts, verification commands, or implementation boundaries. If the user is only clarifying runtime behavior or asking a mechanism question after coding is complete, update the relevant analysis document instead of build-along.

## Workflow

1. **Start from analysis**
   - Read or create the relevant `docs/wiki-source/cc/analysis/<topic>.md`.
   - Treat analysis as the external mechanism source: it should explain Claude Code behavior and reproducible design without depending on `mini-cc`.
   - Identify which source-confirmed boundaries should be simplified into `mini-cc`.
   - Keep broad mechanism explanation in analysis; use build-along to record how the mechanism becomes a lesson and runnable teaching implementation.
   - Do not lower the analysis quality bar by moving project-internal lesson notes into it; put those notes in build-along.

2. **Choose the minimal learning implementation**
   - Keep the feature small and runnable.
   - Preserve architecture pressure points: query loop, provider adapter, tool protocol, tool services, permissions, compact, skills, plugins, session.
   - Evolve existing entrypoints and scripts before adding new ones; a new lesson number is not a reason to create a parallel CLI, npm script, or `main` file.
   - When replacing a teaching implementation, prefer commenting it as the previous path or documenting the migration instead of silently deleting it, unless the user explicitly asks for deletion.
   - Avoid placing everything in `query.ts`.

3. **Edit mini-cc**
   - Use TypeScript / Node patterns already present in the repo.
   - Add or update `Lxx-Sxx` comments on key steps.
   - Comments must explain why the step exists and what Claude Code mechanism it mirrors.

4. **Verify behavior**
   - Run the smallest useful command or test.
   - If verification is impossible, document why.

5. **Write build-along**
   - Location:

```text
docs/build-along/cc/<lesson>.md
```

   - Record what was built, files changed, implementation steps, how to run, verification, differences from Claude Code, and annotated walkthrough.
   - Explain the lesson sequence: why each `Lxx-Sxx` step exists, what source boundary it preserves, and what simplification was made for learning.
   - Link to analysis for external mechanism detail instead of duplicating it.
   - Keep the document useful to future maintainers of this repo: concrete paths, commands, lesson decisions, and next steps matter more here than polished external exposition.

6. **Record next frontier**
   - Record completed scope and next learning frontier in the build-along document.
   - Do not create `docs/wiki-source/cc/raw/`.

## Build-Along Shape

```markdown
# Lesson <NN>: <机制> Build-Along

## Lesson Goal
## What We Built
## Source-To-Design Derivation
## Files Changed
## Implementation Steps
## Annotated Code Walkthrough
## How To Run
## Verification
## Architecture Evolution
## Difference From Claude Code
## Next Frontier
```

## mini-cc Boundaries

Prefer these evolving boundaries unless current code suggests a better local pattern:

```text
mini-cc/src/query.ts
mini-cc/src/QueryEngine.ts
mini-cc/src/Tool.ts
mini-cc/src/services/api/
mini-cc/src/services/tools/
mini-cc/src/tools/
mini-cc/src/utils/permissions/
mini-cc/src/services/compact/
mini-cc/src/skills/
mini-cc/src/commands/
```

## Done Criteria

- Relevant Claude Code source was inspected or linked from analysis.
- Build-along remains an internal learning/build document and does not replace the external analysis.
- `mini-cc` behavior is runnable or explicitly marked design-only.
- Code comments include required `Lxx-Sxx` steps.
- Build-along includes `Annotated Code Walkthrough`.
- Verification result is recorded.
- Gaps from Claude Code are explicit.
