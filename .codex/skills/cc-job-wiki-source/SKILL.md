---
name: cc-job-wiki-source
description: Convert Claude Code source study results in hope-cc into stable Markdown source documents for JOB-WIKI ingestion under raw/Projects/cc. Use when the user asks to produce wiki source files, package a cc learning result, write a document such as context compaction flow, prepare ingest-ready material, or connect cc study to project-cc, entries, questions, scenarios, and interview assets.
---

# CC JOB-WIKI Source Writer

Use this skill to turn `cc` exploration into source documents that JOB-WIKI can ingest effectively.

## Target

Draft source documents locally in `hope-cc` first:

```text
docs/wiki-source/cc/
```

When the user approves or explicitly asks, place the final file at:

```text
C:\dev\workspace\h0pe\JOB-WIKI\raw\Projects\cc\
```

Once a file is in `JOB-WIKI/raw`, treat it as immutable raw source. Future corrections should become a new versioned source file unless the user explicitly asks to edit raw.

## JOB-WIKI Contract

Documents under `raw/Projects/cc` are project practice evidence for the user's `cc` practice project.

This `hope-cc` session may not have visibility into `JOB-WIKI/wiki`. Therefore, do not require exact existing page names. Provide a candidate ingest mapping that JOB-WIKI can later reconcile with existing pages.

Candidate mapping should include:

- source page suggestion, e.g. `src-2026-05-14-cc-context-compaction-flow`
- project suggestion, e.g. `project-cc`
- entry directions, e.g. Agent Harness, 上下文工程, 多轮对话上下文压缩, Agent工具调用与协议, Agent Skills
- question directions, e.g. multiturn context compression, tool permission model
- scenario directions for engineering trade-offs or failure handling
- overview directions for larger topics

## File Naming

Use stable, dated names:

```text
YYYY-MM-DD-claude-code-<topic-slug>.md
```

Examples:

```text
2026-05-14-claude-code-context-compaction-flow.md
2026-05-14-claude-code-tool-permission-model.md
2026-05-14-claude-code-skills-loading.md
2026-05-14-claude-code-agent-loop.md
```

## Source Document Template

```markdown
# Claude Code：<主题>

## TL;DR
2-4 句话说明这个机制、我通过源码实践掌握了什么、它能支撑哪些面试能力。

## Why This Matters
说明它和 Agent Harness / AI Coding / 上下文工程 / 工具调用等能力的关系。

## Study Scope
- 覆盖范围：
- 不覆盖范围：

## Source Evidence
| 源码位置 | 关键符号 / 线索 | 证明了什么 |
|---|---|---|

## Mechanism Walkthrough
按真实流程解释机制。必要时包含 Mermaid 图。

## Key Data Structures
说明状态、配置、消息、工具结果、权限结果、压缩摘要等关键数据。

## Design Decisions & Trade-offs
提炼工程取舍：为什么这样组织、解决了什么问题、代价是什么。

## Failure Modes
说明可能失败的路径、边界情况、降级策略或待验证风险。

## What I Practiced
用第一人称写清楚我的实践动作：
- 我阅读了哪些源码入口
- 我追踪了哪条调用链
- 我验证或复盘了什么行为
- 我沉淀了什么可迁移设计

## Transfer to My Agent Projects
说明可迁移到 DodoAgent / HopeAgent / 其他个人 Agent 项目的模式。

## Interview Assets
这份材料可支撑的面试表达：
- 候选能力方向：
- 候选项目页：project-cc
- 候选问题页：
- 候选场景页：

## Weak Spots / TODO
- 仍未验证：
- 缺少运行证据：
- 后续可继续精读：

## Suggested Ingest Plan
- 新建 source 页：
- 更新 project 页：
- 候选 entry 方向：
- 候选 question 方向：
- 候选 scenario 方向：
- 需要 JOB-WIKI ingest 阶段确认 / 合并的页面：
```

## Writing Rules

- Always write in simplified Chinese.
- Use `Claude Code` as the studied system and `cc` / `project-cc` as the personal practice project candidate.
- Ground mechanism claims in source paths.
- Do not claim production metrics unless the user provides them.
- Keep raw source documents self-contained; JOB-WIKI should not need conversation history to ingest them.
- Include explicit `Suggested Ingest Plan` as a candidate mapping; downstream JOB-WIKI ingestion owns final page matching, merging, and link updates.

## Completion Checklist

Before handing off a source document, verify:

- It has concrete source evidence.
- It explains the mechanism, not just a reading diary.
- It contains project-practice language in `What I Practiced`.
- It lists candidate wiki mapping and interview assets without assuming access to existing JOB-WIKI pages.
- It marks uncertainty in `Weak Spots / TODO`.
- It is suitable to copy into `raw/Projects/cc` unchanged.
