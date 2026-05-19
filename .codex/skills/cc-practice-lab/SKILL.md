---
name: cc-practice-lab
description: Run focused experiments against hope-cc or mini-cc to verify uncertain Claude Code mechanism behavior. Use when source reading leaves a hypothesis unresolved, tests need to be run, temporary instrumentation is needed, or analysis needs empirical evidence.
---

# CC Practice Lab

Use this skill when reading source is not enough and behavior needs evidence.

## Boundary

Experiments support `analysis`. Analysis remains the external-facing place for Claude Code behavior evidence, verification notes, and unresolved questions. Build-along should only receive experiment results when they validate a `mini-cc` lesson implementation or command path. Experiments are not raw generation and not production changes unless the user explicitly asks.

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
   - Update the relevant active analysis document when the evidence clarifies Claude Code behavior, protocol, state flow, or implementation guidance.
   - Update build-along only when the experiment verifies an internal `mini-cc` lesson, script, or implementation boundary.
   - If the evidence is temporary or too detailed for the main narrative, summarize it in the analysis `Verification` or `待验证` section rather than creating a new `docs/wiki-source/cc/` subdirectory.

## Safety Rules

- Do not run destructive commands.
- Do not modify `JOB-WIKI/raw`.
- Do not create `docs/wiki-source/cc/raw/`.
- If temporary edits are made, report them and clean them up unless kept intentionally.
