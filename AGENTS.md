# hope-cc 项目协作规则

## 0. 规则层级

本文件是 `hope-cc` 仓库内的长期协作规则。它负责定义项目目标、学习方法、产物契约和禁止事项；各个 skill 只负责执行具体工作流，不应重复或覆盖这里的全局规则。

项目内部规则按下面顺序理解：

1. `AGENTS.md`：项目级原则、边界和产物契约。
2. 用户当前请求：决定本轮具体主题、范围和是否只讨论。
3. `.codex/skills/*/SKILL.md`：执行某类任务时的操作流程。
4. `docs/wiki-source/cc/00-learning-map.md`：学习 frontier、优先级和已完成节点。
5. 具体 lesson 文档和 `mini-cc` 注释：单节课的实现路径和复盘事实。

如果这些文件之间出现冲突，优先收敛到本文件的原则，并在最终回复中指出需要后续清理的冲突点。

## 1. 语言与默认工作方式

- 始终使用简体中文回应。
- 默认把本仓库视为 Claude Code 源码学习、架构仿写和 JOB-WIKI raw source 生产的长期项目。
- 除非用户明确要求只讨论，否则应推进到可执行的下一步：读源码、整理规则、规划实现、写代码、验证、产出文档。
- 做源码机制解释时，必须先读真实源码，再给结论。
- 做 `mini-cc` 变更时，必须同步维护课程分步注释和对应课程文档。

## 2. 项目目标

本项目不是单纯阅读 Claude Code 源码，而是形成一套可持续学习体系：

```text
读 Claude Code 源码
→ 理解功能、协议、架构边界和生产级约束
→ 仿照其架构逐步实现一个简化版 coding agent
→ 用注释驱动的课程代码沉淀学习路径
→ 将成熟成果整理为 JOB-WIKI 可 ingest 的 raw project source
```

长期产物包括：

- Claude Code 源码机制学习地图。
- 关键机制的源码解析、调用链和设计推导。
- 一个逐步演进的 Claude Code-like 简化实现：`mini-cc`。
- 注释驱动的 build-along 课程文档。
- 面向 `raw/Projects/cc` 的 JOB-WIKI source 候选文档。

## 3. 核心学习模型：机制锚定 + 注释驱动

每个学习主题都必须围绕一个明确机制展开，例如 `agent loop`、`tool dispatcher`、`context compaction`、`permission hooks`。不要先脱离当前主题做空泛全量地图。

本项目采用两条主线同步推进：

- **机制锚定**：从用户指定或 learning map 推荐的机制开始，读取真实 Claude Code 源码，追踪入口、状态流、数据结构和模块边界。
- **注释驱动**：把源码理解转化为 `mini-cc` 中可运行、可阅读、带分步注释的简化实现，让学习者能沿着 `Lxx-Sxx` 注释顺序复盘机制。

机制学习的标准流程：

1. **锚定当前机制**：确认本轮主题、学习问题和所在阶段。
2. **局部展开地图**：说明上游依赖、下游牵引主题和本轮优先级。
3. **更新 frontier**：维护 `docs/wiki-source/cc/00-learning-map.md`，记录新发现的要学习、要拓展、要优化主题。
4. **定义本轮产物**：明确是否产出 `analysis`、`build-along`、`raw`，以及是否修改 `mini-cc`。
5. **定位源码**：找到真实 Claude Code 入口、核心文件、关键符号和调用链。
6. **理解架构**：解释模块边界、状态流、错误路径、权限 / 安全边界、上下文和消息协议。
7. **提炼机制**：区分源码确认、合理推断和待验证事项。
8. **仿写实践**：在 `mini-cc` 中复现最小核心机制，并写好课程分步注释。
9. **验证行为**：通过测试、脚本或小实验验证理解。
10. **沉淀文档**：产出可复盘学习材料，成熟后整理成 JOB-WIKI raw source 候选。
11. **回写 frontier**：把本主题牵出的后续学习点补回 learning map。

## 4. 源码学习规则

解释一个 Claude Code 机制时，必须给出源码证据：

- 源码路径。
- 关键符号、类型或函数。
- 调用链或状态流。
- 该源码事实如何推导出设计结论。

不要只解释“功能是什么”，还要解释：

- 模块边界。
- 状态如何流动。
- 关键数据结构。
- 错误路径和恢复路径。
- 权限、安全和副作用边界。
- 上下文、消息和工具协议。
- 为什么这种架构值得学习，哪些部分适合 `mini-cc` 保留。

结论必须分类标注：

- `源码确认`：代码中明确能证明。
- `合理推断`：基于命名、结构、调用关系推断。
- `待验证`：需要运行、测试或进一步读源码确认。

禁止把合理推断写成源码事实，禁止把未验证实验结果写成已确认结论。

## 5. `mini-cc` 实现契约

`mini-cc` 是课程式仿写项目，不是随手写 demo。它的目标是让学习者通过代码结构和分步注释理解 Claude Code-like agent 的核心机制。

实现原则：

- 不要求完全复刻 Claude Code。
- 模块边界尽量贴近 Claude Code 已确认的边界。
- 新增功能前，先判断它在原版 Claude Code 中属于哪个边界，再决定放入 `mini-cc` 的哪个模块。
- 避免把所有逻辑堆进单个教学文件。
- 先实现最小可理解版本，再逐步补生产级约束。
- 保留后续能长出权限、上下文压缩、session、skills、plugins、MCP 的压力点。

候选架构方向：

```text
mini-cc/
├── src/
│   ├── query.ts
│   ├── QueryEngine.ts
│   ├── Tool.ts
│   ├── tools/
│   ├── services/
│   │   ├── api/
│   │   ├── tools/
│   │   ├── compact/
│   │   └── plugins/
│   ├── utils/
│   │   ├── permissions/
│   │   └── messages/
│   ├── commands/
│   ├── skills/
│   └── main.ts
```

目录可以随着学习演进，但演进必须服务于理解 Claude Code 架构，不追求形式相似。

## 6. 分步注释契约

分步注释是 `mini-cc` 的核心学习载体。凡是课程代码里的关键步骤、模块边界、状态转换、工具协议转换、上下文转换、安全边界，都应通过统一格式写入代码。

统一格式：

```ts
//L<两位课程序号>-S<两位步骤号> 步骤标题：具体注释内容
```

示例：

```ts
//L01-S04 准备上下文：QueryEngine 是简化版入口包装，对应 Claude Code 中 REPL/headless 在进入 query() 前准备上下文。
```

注释规则：

- 注释必须解释“这一步为什么存在”以及“它对应 Claude Code 的哪个机制”。
- 不要只复述代码字面动作。
- 普通实现细节不需要过度注释。
- 每个课程序号独立维护步骤编号，例如 `L01-S01`、`L02-S01`。
- 同一课内步骤顺序应能串成一条从入口到行为闭环的阅读路径。
- 修改既有课程代码时，必须同步维护对应课程序号的注释。
- 如果删除或合并步骤，优先保持已发布 lesson 的编号稳定，并在课程文档中说明调整。

代码和文档的关系：

- 代码注释是第一阅读路径。
- `docs/build-along/cc/<lesson>.md` 的 `Annotated Code Walkthrough` 必须按这些注释组织。
- 如果本课修改了 `mini-cc`，但没有新增或维护 `Annotated Code Walkthrough`，则课程未完成。

## 7. 文档产出契约

文档不是结论摘要，而是学习和设计过程的可复盘记录。读者看完后应该知道：

- 最初面对的设计问题是什么。
- 为什么从这些源码入口开始读。
- 读源码时一步步发现了哪些事实。
- 这些事实如何推导出 Claude Code 的功能和架构。
- 如何把理解转化成 `mini-cc` 的简化设计。
- 简化实现和 Claude Code 的差距在哪里，后续为什么要补这些能力。

文档分三类：

```text
docs/wiki-source/cc/analysis/   # 源码分析过程稿，服务于理解
docs/build-along/cc/            # 边学边写记录，服务于实践复盘
docs/wiki-source/cc/raw/        # JOB-WIKI raw source 候选文档，服务于 ingest
```

三类文档职责：

- `analysis`：记录源码探索路线。必须包含问题定义、搜索路径、入口选择理由、调用链发现过程、源码事实、推断和待验证事项。
- `build-along`：记录架构仿写路线。必须包含源码事实到 `mini-cc` 模块设计的推导、文件放置理由、实现步骤、验证结果、后续演进点和注释驱动 walkthrough。
- `raw`：记录可被 JOB-WIKI ingest 的完整实践材料。必须在结构化摘要之外保留学习叙事、设计推导、工程取舍、实践动作和候选映射。

机制文档的最低结构：

```markdown
## Learning Question
## Reading Path
## Discovery Log
## Design Reconstruction
## Build-Along Derivation
## Annotated Code Walkthrough
## Verification
```

只有本轮涉及 `mini-cc` 代码时，`Annotated Code Walkthrough` 才是必需章节；如果本轮是纯源码阅读，需要明确写出“本轮未修改 mini-cc，因此无代码注释 walkthrough”。

JOB-WIKI raw source 候选文档必须包含：

```markdown
## TL;DR
## Learning Question
## Reading Path
## Discovery Log
## Study Scope
## Source Evidence
## Design Reconstruction
## Mechanism Walkthrough
## Architecture Notes
## Key Data Structures
## Design Decisions & Trade-offs
## Build-Along Derivation
## Annotated Code Walkthrough
## What I Practiced
## Difference From Claude Code
## Candidate JOB-WIKI Mapping
## Weak Spots / TODO
## Suggested Ingest Plan
```

## 8. Learning Map 与 Frontier

`docs/wiki-source/cc/00-learning-map.md` 是学习队列和状态索引，不是一次性全量大纲。

每次机制学习都应维护：

- 当前节点。
- 已确认源码事实。
- `mini-cc` 已完成范围。
- 新牵出的 frontier。
- 下一步优先级。
- 新增的 analysis / build-along / raw 文档索引。

frontier 分类：

- `要学习`：需要继续精读 Claude Code 源码的机制。
- `要拓展`：需要在 `mini-cc` 中新增的能力。
- `要优化`：已有 `mini-cc` 能力后续要接近 Claude Code 的地方。

不要为了“完整”重写整张 learning map。只更新当前机制相关区域，并保持队列可继续推进。

## 9. JOB-WIKI 对接规则

- 本仓库内的 JOB-WIKI ingest 候选文档统一放在 `docs/wiki-source/cc/raw/`。
- `docs/wiki-source/cc/analysis/` 只放源码分析过程稿，不作为 ingest 候选。
- 目标 raw 路径是 `C:\dev\workspace\h0pe\JOB-WIKI\raw\Projects\cc\`。
- 只有用户明确要求归档或复制到 JOB-WIKI 时，才写入目标 raw 路径。
- 写入 `JOB-WIKI/raw` 后，该文件视为不可变 raw source。
- 本项目会话不假设能看到 `JOB-WIKI/wiki` 中已有页面。
- 本项目只产出候选映射，真正的页面合并、去重、链接更新由 JOB-WIKI ingest 阶段完成。

候选映射使用这种形式：

```markdown
## Candidate JOB-WIKI Mapping
- project candidate: project-cc
- entry candidates:
- question candidates:
- scenario candidates:
```

## 10. Skill 分工

- `cc-onboarding`：建立和维护源码学习地图，选择学习主题和优先级。
- `cc-code-explorer`：精读并追踪单个 Claude Code 机制。
- `cc-build-along`：把机制理解转化为 `mini-cc` 课程实现和 build-along 文档。
- `cc-practice-lab`：通过实验、测试、临时 instrumentation 验证行为。
- `cc-job-wiki-source`：把成熟学习成果整理成 JOB-WIKI 可 ingest 的 raw project source 候选。

Skill 只负责具体任务流程。全局规则、产物边界、注释契约和 JOB-WIKI 写入边界以本文件为准。

## 11. 机制学习完成标准

一个机制主题完成时，至少满足：

- 已定位真实 Claude Code 源码入口和关键调用链。
- 已区分源码确认、合理推断和待验证事项。
- 已说明该机制的模块边界、状态流、数据结构和错误 / 安全边界。
- 如果修改了 `mini-cc`，代码中有对应 `Lxx-Sxx` 分步注释。
- 如果修改了 `mini-cc`，build-along 文档有 `Annotated Code Walkthrough`，并能链接回真实文件。
- 已运行测试、脚本或小实验；如果无法验证，明确写出原因。
- 已更新 learning map 的当前节点、frontier 和 source index。
- 如产出 raw 候选文档，包含 `Candidate JOB-WIKI Mapping`，但不默认复制到 JOB-WIKI 目录。

## 12. 禁止事项

- 禁止编造 Claude Code 源码中不存在的技术细节。
- 禁止把合理推断写成源码事实。
- 禁止把未验证实验结果写成已确认结论。
- 禁止默认写入 `JOB-WIKI/raw`。
- 禁止把普通学习笔记伪装成可 ingest 的 source 文档。
- 禁止为了形式相似而过度设计 `mini-cc`。
- 禁止修改 `mini-cc` 课程代码却不维护分步注释。
- 禁止只写最终调用链而不记录阅读路径和发现过程。
- 禁止让 skill 文档覆盖项目级规则；skill 只能补充执行流程。
