---
name: cc-job-wiki-source
description: Generate JOB-WIKI raw source documents from mature hope-cc analysis and build-along materials. Use only when the user explicitly asks to generate raw, package JOB-WIKI source, prepare ingest material, archive a completed study, or copy material into JOB-WIKI/raw.
---

# CC JOB-WIKI Source Writer

Use this skill only on explicit user request.

Default project work is to improve `analysis` and `build-along`. Do not run this workflow just because a lesson is complete or an analysis is mature.

## Inputs

Gather existing material first:

```text
docs/wiki-source/cc/analysis/<topic>.md
docs/build-along/cc/<lesson>.md
mini-cc source files
docs/wiki-source/cc/experiments/<topic>.md
```

If analysis is weak or missing, improve analysis before writing raw.

Also read the target JOB-WIKI conventions before writing:

```text
C:\dev\workspace\h0pe\JOB-WIKI\AGENTS.md
C:\dev\workspace\h0pe\JOB-WIKI\raw\Projects\*
```

For `project-cc` materials, inspect 2-3 nearby `raw/Projects/*` examples and follow their style: a readable project mechanism document. Only inspect `raw/Clippings/*` when the requested raw is an external article or clipping.

## Output Locations

Draft raw candidate locally:

```text
docs/wiki-source/cc/raw/YYYY-MM-DD-claude-code-<topic-slug>.md
```

Only copy to JOB-WIKI when the user explicitly asks:

```text
C:\dev\workspace\h0pe\JOB-WIKI\raw\Projects\cc\
```

Once copied into `JOB-WIKI/raw`, treat it as immutable unless the user explicitly asks to edit it.

## Raw Document Shape

For `project-cc`, raw should be a project-source document, not an ingest task list.

Use a natural structure similar to `JOB-WIKI/raw/Projects/*`:

```markdown
# ✅Claude Code <机制>：<一句话主题>

开篇说明这个机制在 `project-cc` 中解决什么问题，以及这一课做到了什么。

## 为什么要做这个机制？
## Claude Code 源码里看到的核心结构
## 核心协议 / 数据结构
## mini-cc 实现结构
## 关键模块说明
## 注释驱动阅读路径
## 运行效果
## 工程取舍
## 和真实 Claude Code 的差距
## 这份资料可以抽取哪些 wiki 词条？
## 后续 TODO
## Raw Reference
```

The exact headings may vary by mechanism. Prefer readable source value over template completeness.

## Writing Rules

- Write in simplified Chinese.
- Make the document self-contained; JOB-WIKI should not need conversation history.
- Ground mechanism claims in source paths.
- Preserve learning narrative and design derivation.
- Explain how Claude Code facts became `mini-cc` choices.
- Do not assume access to existing JOB-WIKI wiki pages.
- Candidate mapping is a short end section, not the document body.
- Avoid `Entry Candidate`, `Suggested Page`, `Ingest Priorities`, and other operation-list language in the main body.
- Do not paste the analysis/build-along chronology wholesale. Raw should read like a source document that can stand on its own.
- Use `JOB-WIKI/raw/Projects/*` style for project mechanisms. Use `JOB-WIKI/raw/Clippings/*` style only for external article clippings with real source frontmatter.

## Completion Checklist

- Concrete source evidence exists.
- The document reads as a project mechanism source, not a source packet or checklist.
- Design trade-offs are explicit.
- Practice actions are written in first person where useful.
- Weak spots are marked.
- Candidate wiki objects are listed briefly near the end.
- The target raw path is noted, but the file is not copied to JOB-WIKI unless explicitly requested.
