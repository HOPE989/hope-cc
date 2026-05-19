---
name: cc-code-explorer
description: Trace and explain one Claude Code source mechanism in hope-cc, then create or update an analysis document. Use when the user asks how a cc feature works, wants a call chain, source-level analysis, or wants to deepen an existing analysis note.
---

# CC Code Explorer

Use this skill to read real Claude Code source and maintain `docs/wiki-source/cc/analysis/`.

## Boundary

`AGENTS.md` owns product rules. This skill only executes source exploration.

Default output is `analysis`. Analysis is an external-facing source document: it must explain Claude Code behavior and implementation implications for readers who do not care about this repository's `mini-cc` lessons. Do not generate raw or invoke `cc-job-wiki-source` unless the user explicitly asks for raw / JOB-WIKI source / ingest packaging.

Active analysis files live in `docs/wiki-source/cc/analysis/`.

Quality benchmark: mature analysis should be comparable to `C:\dev\workspace\hope-cc\docs\wiki-source\cc\analysis\claude-code-skills-technical-scheme.md` in practical usefulness: readable as an article, actionable as an external implementation guide, and structured enough to serve as ingest source without a separate raw rewrite.

## Workflow

1. **Anchor the mechanism**
   - Name the mechanism precisely.
   - State what is in scope and out of scope.
   - If related older notes exist, use them only as historical context; re-check real Claude Code source before carrying any claim forward.

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

   - Classify the document before writing:
     - `source-mechanism`: explain how one Claude Code mechanism works.
     - `technical-scheme`: turn confirmed Claude Code behavior into an implementation plan for another system.
     - `follow-up-patch`: integrate a user clarification into an existing analysis.
   - Write it as a reader-facing source document, not an internal work log:
     - reader path first
     - problem and scope
     - minimal mental model
     - working mechanism
     - source path and evidence
     - design reconstruction
     - external implementation implications
     - verification and open questions
   - For mature documents, the target is direct usability:
     - the user can read it without extra narration
     - an engineer can reproduce the mechanism or subsystem from it
     - it can serve as ingest source without generating raw
     - it does not depend on `mini-cc`, lesson numbering, build-along context, or conversation history
   - Do not turn analysis into a raw source package.

6. **Keep active docs clean**
   - Keep new mechanism source in `docs/wiki-source/cc/analysis/`.
   - Do not create `docs/wiki-source/cc/raw/`.

## Analysis Shapes

Use the shape that matches the document type. Do not mechanically include every heading in small follow-up patches, but mature source-mechanism and technical-scheme documents should cover the relevant responsibilities explicitly.

### Source Mechanism

```markdown
# Claude Code <机制> 源码分析

## 如何阅读本文
## Learning Question
## Scope
## 0. 核心结论
## 1. Mental Model / 关键术语
## 2. Execution Flow / 状态流
## Reading Path
## Discovery Log
## Source Evidence / 源码确认
## Key Data Structures / Protocols
## Error / Edge / Security Paths
## Design Reconstruction
## External Implementation Implications
## Verification
## 合理推断
## 待验证
```

Do not add `mini-cc`, lesson, build-along, or course-comment sections to analysis unless the user explicitly asks for a project-internal implementation path. Put those details in build-along instead.

### Technical Scheme

Use this shape when the user asks for a design that can guide another system, or when the analysis is expected to be implemented directly:

```markdown
# Claude Code <机制> 技术方案：<目标系统或复现范围>

## 如何阅读本文
## Learning Question
## Scope
## 0. 设计摘要
## 1. 全局心智模型 / 关键术语
## 2. 系统上下文架构
## 3. 包格式 / 输入输出协议
## 4. 数据模型与状态流
## 5. 加载、注册、发现或调度机制
## 6. 调用协议与 transcript 写入
## 7. 权限、安全与信任边界
## 8. 持久化、压缩或恢复
## 9. 端到端装配示例
## 10. 测试计划
## 11. 落地分层 / 迁移策略
## 12. 常见失败模式
## 附录 A：源码依据 / 设计来源校验
```

For technical schemes, include module responsibility tables where useful. A good module table says both what the module owns and what it must not own.

## Quality Rules

- Treat analysis as the project's primary external source document, not a staging note for raw and not an internal build log.
- Start with why the mechanism matters, the reading path, and a simple mental model before source tables.
- Provide terminology, diagrams, concrete examples, and end-to-end assembly where they help a reader implement the mechanism.
- Make the reading path easy to follow; do not dump findings in the order commands happened if that hurts understanding.
- Every important claim needs a source path.
- Keep long code dumps out; quote only small shapes or protocols.
- Prefer diagrams and short snippets when flow is complex.
- When the topic is a technical scheme, include enough module boundaries, data structures, protocols, failure modes, testing guidance, and rollout notes for an external system to implement it.
- Keep code examples internally consistent: field names, types, and transcript shapes must agree across sections.
- Keep analysis nearly independent from `mini-cc` and course material by default; analysis should read like an external mechanism source or implementation guide.
- Use `claude-code-skills-technical-scheme.md` as the quality bar for mature analysis: strong opening model, clear terminology, consistent protocols, module boundaries, examples, failure modes, verification, and source-backed appendix or evidence sections.
- Put common failure modes early enough that readers learn the pitfall before copying the design.
- Put user follow-up clarifications back into analysis when they improve the mechanism, for example `message / content block / chunk` boundaries.
- Avoid two bad extremes: source-free tutorials and unreadable evidence piles.
- If behavior cannot be confirmed from code, use `cc-practice-lab`.

## Final Self-Review

Before finishing a mature analysis update, check:

- Can a reader understand the problem, scope, and minimal model in the first five minutes?
- Are important terms defined before they are used heavily?
- Can an engineer reproduce the core mechanism from the module boundaries, data models, protocols, and examples?
- Do source facts, reasonable inferences, and open questions remain separate?
- Are implementation examples aligned with the documented types and transcript protocol?
- Would this document still work for an external engineering team that never opens `mini-cc` or build-along?
- Is the quality close to `claude-code-skills-technical-scheme.md`, rather than a thin note or command log?
- Does the document avoid project-internal `mini-cc`, lesson, and build-along clutter unless explicitly requested?
- Is raw still untouched unless the user explicitly asked for raw packaging?
