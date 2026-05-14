---
name: cc-code-explorer
description: Trace and explain one Claude Code source mechanism in hope-cc, then create or update an analysis document. Use when the user asks how a cc feature works, wants a call chain, source-level analysis, or wants to deepen an existing analysis note.
---

# CC Code Explorer

Use this skill to read real Claude Code source and maintain `docs/wiki-source/cc/analysis/`.

## Boundary

`AGENTS.md` owns product rules. This skill only executes source exploration.

Default output is `analysis`. Do not generate raw or invoke `cc-job-wiki-source` unless the user explicitly asks for raw / JOB-WIKI source / ingest packaging.

## Workflow

1. **Anchor the mechanism**
   - Name the mechanism precisely.
   - State what is in scope and out of scope.
   - Check `docs/wiki-source/cc/00-learning-map.md`; if needed, update only the current frontier.

2. **Find source entry points**
   - Use `rg` for function names, event names, type names, command names, config keys, and protocol fields.
   - Prefer concrete files and symbols over folder-level guesses.
   - Read enough surrounding code to understand why an entry point is credible.

3. **Trace the mechanism**
   - Follow control flow until it reaches state mutation, model interaction, tool execution, persistence, UI rendering, permission check, or other side-effect boundary.
   - Capture data structures, state transitions, error paths, and safety boundaries.
   - Preserve the actual reading path, including why certain paths were chosen or excluded.

4. **Separate certainty**
   - Mark `源码确认` for code-backed facts.
   - Mark `合理推断` for conclusions inferred from structure.
   - Mark `待验证` for runtime behavior or incomplete source paths.

5. **Write or update analysis**
   - Location:

```text
docs/wiki-source/cc/analysis/<topic-slug>.md
```

   - Write it as a reader-facing lesson plan, not an internal work log:
     - problem first
     - minimal mental model
     - working mechanism
     - source path and evidence
     - design reconstruction
     - what this means for mini-cc
     - open questions
   - Do not turn analysis into a raw source package.

6. **Update frontier**
   - Add only frontier topics discovered from the current mechanism.
   - Do not prefill future raw paths.

## Analysis Shape

A useful analysis usually contains:

```markdown
# Claude Code <机制> 源码分析

## Learning Question
## Scope
## 解决方案 / Mental Model
## 工作原理 / Execution Flow
## Reading Path
## Discovery Log
## Source Evidence
## Design Reconstruction
## Key Data Structures
## Error / Edge Paths
## Build-Along Derivation
## Verification
## 待验证
```

If `mini-cc` was not changed, say so instead of inventing an annotated walkthrough.

## Quality Rules

- Treat analysis as a teaching document for a future reader.
- Start with why the mechanism matters and a simple mental model before source tables.
- Make the reading path easy to follow; do not dump findings in the order commands happened if that hurts understanding.
- Every important claim needs a source path.
- Keep long code dumps out; quote only small shapes or protocols.
- Prefer diagrams and short snippets when flow is complex.
- Put user follow-up clarifications back into analysis when they improve the mechanism, for example `message / content block / chunk` boundaries.
- Avoid two bad extremes: source-free tutorials and unreadable evidence piles.
- If behavior cannot be confirmed from code, use `cc-practice-lab`.
