# hope-cc 项目协作规则

## 0. 规则层级

本文件是 `hope-cc` 仓库的项目级规则，优先级高于 `.codex/skills/*/SKILL.md`。Skill 文件只描述执行流程，不能覆盖本文件的产物边界和禁止事项。

规则优先级：

1. `AGENTS.md`：项目原则、产物契约、禁止事项。
2. 用户当前请求：决定本轮主题、范围，以及是否只讨论。
3. `.codex/skills/*/SKILL.md`：某类任务的操作流程。
4. `mini-cc` 代码注释和 `docs/build-along/cc/`：项目内课程实现路径。

如有冲突，优先遵守本文件，并在最终回复中指出需要后续清理的冲突。

## 1. 默认工作方式

- 始终使用简体中文回应。
- 做 Claude Code 机制解释时，必须先读真实源码，再给结论。
- 默认产出高质量 `analysis`；不主动生成 raw。
- 默认不修改 `mini-cc`；只有用户要求落到课程实现、构建 mini-cc、补 lesson 或修改代码时，才进入 `mini-cc` / build-along 流程。
- 除非用户明确要求只讨论，否则应推进到可执行下一步：读源码、补 analysis、写代码、验证或整理规则。

## 2. 产物边界

`docs/wiki-source/cc/` 保持正常项目结构：

```text
docs/wiki-source/cc/
├── 00-learning-map.md
├── analysis/
└── raw/
```

`docs/wiki-source/cc/analysis/` 是默认 active wiki-source 输出目录。新 analysis 必须达到 `claude-code-skills-technical-scheme.md` 这种质量：可直接阅读、可直接指导外部系统实现、可直接作为 ingest source。

`docs/wiki-source/cc/raw/` 保留既有文档，但默认不新增。若用户明确要求 JOB-WIKI raw / ingest 包装，应优先说明当前 analysis 已按可 ingest source 标准写作，再按用户指定目标处理。

`docs/wiki-source/cc/00-learning-map.md` 保留为历史学习索引和轻量定位文件；不要让它覆盖 analysis 的质量标准。

产物归属必须保持清晰：

- `analysis` 产出外部文档：面向不关心本仓库课程的人，解释 Claude Code 机制，并指导外部系统复现。质量标尺是 `C:\dev\workspace\hope-cc\docs\wiki-source\cc\analysis\claude-code-skills-technical-scheme.md`。
- `build-along` 产出内部文档：面向本仓库学习者，记录 `mini-cc` 如何按 lesson 演进、代码怎么改、`Lxx-Sxx` 注释如何阅读、如何运行验证。
- 二者可以互相链接，但不能互相替代：analysis 不写课程 walkthrough；build-along 不重写完整机制技术方案。

## 3. Analysis 输出契约

`analysis` 是本项目默认的高质量外部 source 文档。它不是内部工作日志，不是证据堆叠，不是 raw 草稿，也不是 `mini-cc` 课程文档。

### 3.1 默认读者

Analysis 默认面向外部实现者：IDE agent、企业工作流 agent、数据分析 agent、客服 agent、运维 agent、低代码平台 agent、知识库 agent 等系统的工程团队。

读者应能在不理解本仓库课程结构、不阅读 `mini-cc`、不看聊天记录的情况下，理解 Claude Code 机制，并按文档复现核心功能。

### 3.2 文档类型

创建或大幅更新 analysis 前，先判断文档类型：

- `源码机制分析`：解释 Claude Code 某个机制如何工作，例如 agent loop、tool dispatcher、context compaction、permission hooks。
- `技术方案 / 实现指南`：把已确认的 Claude Code 机制重构成外部系统可复现的方案。
- `追问补充`：把用户对既有 analysis 的局部追问和修正补回原文，而不是另写散乱笔记。

### 3.3 成熟 Analysis 必须具备的结构能力

- 文档入口友好：长文必须有“如何阅读本文”或等价导读，说明快速路径、完整路径和适用读者。
- 前 5 分钟可理解：开头回答本文解决什么问题、不解决什么问题、为什么值得学或值得实现。
- 最小模型前置：用一句话方案、ASCII 图、流程图或最小闭环建立主线。
- 关键术语早定义：不要大量使用 `meta message`、`context patch`、`content block`、`tool result` 等术语后才解释。
- 主体按读者理解顺序组织，而不是按命令执行顺序或源码搜索顺序组织。
- 源码证据支撑正文：路径、符号、类型、函数和调用链可以放在相关小节或附录，但不能替代机制解释。
- 明确区分 `源码确认`、`合理推断`、`待验证`。

### 3.4 成熟 Analysis 必须具备的实现能力

- 涉及协议或模块时，给出数据结构、字段含义、状态流和调用时序。
- 涉及外部系统复现时，给出模块职责表，并说明每个模块“不应该做什么”。
- 涉及可执行机制时，给出最小可用闭环、端到端装配示例、测试计划、失败模式和安全边界。
- 示例代码服务于理解和复现，字段命名在全文内一致。
- 如果使用外部系统抽象，必须保证逻辑与 Claude Code 源码事实一致。
- 默认不写 `mini-cc`、lesson、课程注释、build-along walkthrough 或项目内脚手架细节；这些内容属于 build-along。

### 3.5 提交 Analysis 前的自检清单

- 前 5 分钟内，读者能否知道本文讲什么、为什么重要、自己该读哪些章节？
- 读者看完能否复述机制如何工作、为什么这样设计、关键边界在哪里？
- 工程读者能否根据文档写出最小实现或验证脚本？
- 重要结论是否都有源码路径、符号、类型、函数或调用链支撑？
- 源码确认、合理推断、待验证是否分清楚？
- 术语、字段名、示例代码和章节之间是否前后一致？
- 是否避免夹带 `mini-cc`、lesson、课程注释和 build-along 内容？
- 是否避免内部工作日志、证据堆叠、散乱摘录和 raw 操作清单？

## 4. Build-Along 输出契约

`docs/build-along/cc/` 是内部学习和构建记录，专门服务于 `mini-cc` 课程化实现。

Build-along 用于记录：

- 本课如何把 analysis 中的 Claude Code 源码事实转译成 `mini-cc` 实现。
- 本课从源码事实推导出哪些 `mini-cc` 实现决策。
- 修改了哪些文件、实现顺序、如何运行和验证。
- `Annotated Code Walkthrough`：按代码里的 `Lxx-Sxx` 注释组织。
- 和 Claude Code 的差异，以及下一课要补什么。

Build-along 可以链接或概括 analysis 中的机制结论，但不重写大段源码机制解释。它是 `mini-cc`、lesson、课程注释和 walkthrough 的主要承载位置；不要把这些项目内构建路径塞回 analysis。

如果本轮没有修改 `mini-cc` 代码、课程注释、运行脚本或实现边界，只是在解释机制、回答追问或补运行观察，则不要更新 build-along，应更新对应 analysis。

## 5. Claude Code 源码学习规则

解释 Claude Code 机制时必须给出：

- 源码路径。
- 关键符号、类型或函数。
- 调用链、状态流或数据流。
- 该源码事实如何推导出设计结论。

必须区分：

- `源码确认`：代码中明确能证明。
- `合理推断`：基于命名、结构、调用关系推断。
- `待验证`：需要运行、测试或继续读源码确认。

禁止：

- 把合理推断写成源码事实。
- 把未验证实验结果写成已确认。
- 编造 Claude Code 源码中不存在的技术细节。

## 6. mini-cc 实现契约

`mini-cc` 是课程式仿写项目。目标是通过代码结构和分步注释理解 Claude Code-like agent 的核心机制。

实现原则：

- 不追求完全复刻 Claude Code。
- 模块边界尽量贴近已确认的 Claude Code 边界。
- 新增功能前，先判断它在 Claude Code 中属于哪个边界，再决定放入 `mini-cc` 的哪个模块。
- 课程演进优先增强既有入口、脚本和模块边界；不要因为进入下一课就自立新的 CLI 入口、npm script 或平行 `main` 文件。
- 如果旧实现被新机制取代，优先在原位置用注释保留“过去式”代码或迁移说明，除非用户明确要求删除。
- 避免把逻辑堆进单个教学文件。
- 先实现最小可理解版本，再逐步补生产级约束。

候选结构：

```text
mini-cc/
├── src/
│   ├── main.ts
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
│   └── skills/
```

目录可以演进，但演进必须服务于理解，不追求形式相似。

## 7. 分步注释契约

关键课程代码必须使用统一注释：

```ts
//L<两位课程序号>-S<两位步骤号> 步骤标题：解释这一步为什么存在，以及对应 Claude Code 的哪个机制。
```

用户也可以在代码中补充无分段号的课程注释：

```ts
//L<两位课程序号> 补充说明
```

无分段号 `//Lxx` 注释表示用户对当前课程机制的补充解释、提醒或口语化理解，不参与主阅读路径编号。后续维护时必须保留其含义，并默认沉淀到对应 build-along；如果其中包含可脱离 `mini-cc` 的 Claude Code 机制澄清，再用去课程化表述补入对应 analysis。

规则：

- 注释解释机制和边界，不复述代码字面动作。
- 每个课程序号独立维护步骤编号。
- 同一课内步骤顺序应能串成阅读路径。
- 修改既有课程代码时，同步维护对应注释。
- 如果删除或合并步骤，优先保持已发布 lesson 编号稳定，并在 build-along 说明调整。

## 8. 方法注释契约

`mini-cc` 中的稳定方法入口必须有 JSDoc 方法注释。范围包括命名函数、类方法、对象方法、构造函数，以及类型 / interface 中暴露的函数签名；不要求给局部匿名回调逐个补注释，除非该回调承载独立机制边界。

统一格式：

```ts
/**
 * 说明这个方法为什么存在，以及它在当前机制中的边界。
 * @param input 参数含义。
 * @returns 返回值含义。
 */
```

规则：

- 第一行直接写方法说明，不使用“用途：”这类固定标签。
- 有参数就写 `@param`；无参数时不写空 `@param`。
- 有返回值或异步完成语义就写 `@returns`；返回 `void` 时说明完成的副作用或完成语义。
- 方法注释说明职责、边界和协议含义，不复述代码字面动作。

## 9. Skill 分工

- `cc-code-explorer`：读源码、追机制，产出或补充面向外部实现者的 analysis。
- `cc-build-along`：把 analysis 中的机制结论转译为项目内 `mini-cc` 课程实现和 build-along。
- `cc-practice-lab`：用实验验证不确定行为，并把证据回填 analysis。
- `cc-job-wiki-source`：仅当用户明确要求 raw / JOB-WIKI 包装时使用；默认不创建 `docs/wiki-source/cc/raw/`。

## 10. 完成标准

一个机制主题完成时，至少满足：

- 已定位真实 Claude Code 源码入口和关键调用链。
- 已区分源码确认、合理推断和待验证事项。
- 已说明模块边界、状态流、数据结构和错误 / 安全边界。
- 已更新或创建对应 analysis，且默认面向外部实现者，不夹带 `mini-cc` / lesson / build-along 内容。
- 已运行测试、脚本或小实验；如果无法验证，明确写出原因。
- 如果修改了 `mini-cc`，代码中有对应 `Lxx-Sxx` 注释。
- 如果修改了 `mini-cc` 方法，代码中有对应 JSDoc 方法注释。
- 如果修改了 `mini-cc`，build-along 有 `Annotated Code Walkthrough`。

## 11. 禁止事项

- 禁止编造源码事实。
- 禁止把推断写成确认。
- 禁止把未验证结果写成已验证。
- 禁止主动生成 `docs/wiki-source/cc/raw/`。
- 禁止默认写入 `JOB-WIKI/raw`。
- 禁止把 analysis 写成没有源码证据的教程。
- 禁止把 analysis 写成只给执行者看的工作日志或证据堆叠。
- 禁止默认把 `mini-cc`、lesson、课程注释或 build-along walkthrough 写进 analysis。
- 禁止把 build-along 写成大段机制分析。
- 禁止在没有代码、注释、脚本或实现边界变更时更新 build-along。
- 禁止修改 `mini-cc` 却不维护分步注释和 build-along。
- 禁止新增或修改 `mini-cc` 方法却不维护方法注释。
- 禁止为了形式相似而过度设计 `mini-cc`。
- 禁止在未获用户明确要求时，为新课程或新机制另起独立 CLI 入口、重复 npm script、平行 `main` 文件。
- 禁止把被替代的教学实现直接抹掉导致学习路径断裂；需要保留时用注释或文档说明其已成为过去式。
