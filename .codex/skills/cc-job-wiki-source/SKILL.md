---
name: cc-job-wiki-source
description: Package mature hope-cc analysis/build-along material for JOB-WIKI only when the user explicitly asks for raw, JOB-WIKI source, ingest material, or copying material into JOB-WIKI/raw. Do not create local docs/wiki-source/cc/raw files.
---

# CC JOB-WIKI Source Writer

Use this skill only on explicit user request.

Default project work is to improve `analysis` and `build-along`. Do not run this workflow just because a lesson is complete or an analysis is mature. Active `analysis` documents are external-facing and expected to be ingest-ready source; build-along documents are internal `mini-cc` lesson records. Raw packaging is exceptional and explicit.

## Inputs

Gather existing material first:

```text
docs/wiki-source/cc/analysis/<topic>.md
docs/build-along/cc/<lesson>.md
mini-cc source files
```

If analysis is weak or missing, improve analysis before writing any JOB-WIKI package. Do not substitute build-along for analysis when the requested output needs an external implementation guide.

Also read the target JOB-WIKI conventions before writing:

```text
C:\dev\workspace\h0pe\JOB-WIKI\AGENTS.md
C:\dev\workspace\h0pe\JOB-WIKI\raw\Projects\*
```

For `project-cc` materials, inspect 2-3 nearby `raw/Projects/*` examples and follow their style: a readable project mechanism document. Only inspect `raw/Clippings/*` when the requested raw is an external article or clipping.

## Output Locations

Do not create `docs/wiki-source/cc/raw/`. If the user explicitly asks to create JOB-WIKI raw, write to the requested JOB-WIKI target, normally:

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
- Preserve learning narrative and design derivation when the user asks for project-internal source.
- For external technical schemes, keep the analysis-style external implementation framing instead of forcing `mini-cc` course structure.
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
- The target JOB-WIKI path is explicit, and no local `docs/wiki-source/cc/raw/` file is created.
