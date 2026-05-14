---
name: cc-practice-lab
description: Run focused experiments against hope-cc or mini-cc to verify uncertain Claude Code mechanism behavior. Use when source reading leaves a hypothesis unresolved, tests need to be run, temporary instrumentation is needed, or analysis needs empirical evidence.
---

# CC Practice Lab

Use this skill when reading source is not enough and behavior needs evidence.

## Boundary

Experiments support `analysis`. They are not raw generation and not production changes unless the user explicitly asks.

## Workflow

1. **State the hypothesis**
   - Write what should happen before running commands.
   - Tie it to a source question.

2. **Pick the smallest test surface**
   - Prefer existing tests, small scripts, CLI flags, or isolated functions.
   - Avoid full app startup unless necessary.

3. **Check worktree**
   - Run `git status --short`.
   - Do not revert unrelated changes.

4. **Instrument only if needed**
   - Keep temporary logs minimal.
   - Record cleanup requirements.
   - Remove instrumentation unless the user wants to keep it.

5. **Run and interpret**
   - Record command, output summary, and what it confirms or disproves.
   - Do not over-interpret setup failures.

6. **Feed evidence back**
   - Update the relevant analysis document or create an experiment note under:

```text
docs/wiki-source/cc/experiments/
```

## Experiment Note Shape

```markdown
# Experiment: <主题>

## Hypothesis
## Source Context
## Setup
## Steps
## Observations
## Result
## Impact on Analysis
## Cleanup
```

## Safety Rules

- Do not run destructive commands.
- Do not modify `JOB-WIKI/raw`.
- Do not create `docs/wiki-source/cc/raw/` unless the user explicitly asks for raw / JOB-WIKI source / ingest packaging.
- If temporary edits are made, report them and clean them up unless kept intentionally.
