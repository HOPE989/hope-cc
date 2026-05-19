---
name: cc-onboarding
description: Orient Claude Code mechanism exploration in hope-cc without maintaining a learning map. Use when the user wants to choose the next mechanism, understand project direction, or place a topic before source analysis or mini-cc implementation.
---

# CC Onboarding

Use this skill to orient the next Claude Code mechanism.

## Boundary

`AGENTS.md` owns product rules. This skill only helps choose or frame the next mechanism.

Do not create raw documents.

## Workflow

1. **Anchor the current mechanism**
   - Use the mechanism named by the user.
   - Do not create a detached full-codebase curriculum before the current mechanism is placed.

2. **Inspect active context**
   - Check active analysis files under `docs/wiki-source/cc/analysis/`.
   - If useful, read `docs/wiki-source/cc/00-learning-map.md` as lightweight historical context and re-check source before relying on it.

3. **Recommend next step**
   - Identify the mechanism to study next.
   - State whether the next output should be external-facing analysis, internal `mini-cc` build-along, or an experiment.
   - Keep the recommendation scoped; do not rebuild a full curriculum.

4. **Define expected outputs**
   - Default output is `analysis`: an external-facing source document for understanding and reproducing a Claude Code mechanism.
   - Use `build-along` only for internal `mini-cc` learning/build work: lesson decisions, `Lxx-Sxx` walkthroughs, commands, verification, and next frontier.
   - Include `raw` only when the user explicitly asks for raw / JOB-WIKI source / ingest packaging.

5. **Hand off**
   - Use `cc-code-explorer` for source mechanism analysis.
   - Use `cc-build-along` for implementation.
   - Use `cc-practice-lab` for behavior verification.
   - Use `cc-job-wiki-source` only on explicit raw request.

## Quality Rules

- Prefer source paths and concrete mechanisms over broad topic names.
- Mark uncertainty as `待验证`.
