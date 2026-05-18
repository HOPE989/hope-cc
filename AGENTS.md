# hope-cc 项目协作规则

## 0. 规则层级

本文件是 `hope-cc` 仓库的项目级规则。它定义学习目标、产物边界和禁止事项；`.codex/skills/*/SKILL.md` 只描述具体工作流，不能覆盖本文件。

规则优先级：

1. `AGENTS.md`：项目级原则、产物契约、禁止事项。
2. 用户当前请求：决定本轮主题、范围和是否只讨论。
3. `.codex/skills/*/SKILL.md`：执行某类任务的操作流程。
4. `docs/wiki-source/cc/00-learning-map.md`：学习 frontier、优先级和已完成节点。
5. 具体 lesson 文档和 `mini-cc` 注释：单节课的实现路径和复盘事实。

如有冲突，优先遵守本文件，并在最终回复中指出需要后续清理的规则冲突。

## 1. 默认工作方式

- 始终使用简体中文回应。
- 本仓库是 Claude Code 源码学习、机制复盘和 `mini-cc` 架构仿写项目。
- 默认推进 `analysis` 和必要的 `build-along`；不主动生成 `raw`。
- 做源码机制解释时，必须先读真实源码，再给结论。
- 做 `mini-cc` 变更时，必须同步维护课程分步注释和对应 build-along 文档。
- 除非用户明确要求只讨论，否则应推进到可执行下一步：读源码、补 analysis、写代码、验证或更新 learning map。

## 2. 项目目标

本项目不是泛读源码，也不是写随手 demo。目标是形成一套可持续学习路径：

```text
读 Claude Code 源码
-> 理解机制、协议、状态流和生产级边界
-> 把机制缩小成 mini-cc 的可运行实现
-> 用 Lxx-Sxx 注释和 build-along 记录开发路径
-> 在用户明确要求时，再打包成 JOB-WIKI raw source
```

长期产物：

- `docs/wiki-source/cc/analysis/`：源码机制分析和追问沉淀。
- `mini-cc/`：逐步演进的 Claude Code-like 简化实现。
- `docs/build-along/cc/`：实现过程、文件变更、验证和注释 walkthrough。
- `docs/wiki-source/cc/00-learning-map.md`：学习队列和 frontier。
- `docs/wiki-source/cc/raw/`：仅在用户明确要求时生成的 JOB-WIKI raw 候选。

## 3. 产物边界

### analysis

`analysis` 是源码机制理解的主文档，也是面向读者的教案。它不是内部工作日志、证据堆叠或 raw 草稿。位置：

```text
docs/wiki-source/cc/analysis/
```

用于记录：

- 学习问题和范围。
- 面向读者的解释路径：先说明为什么要学这个机制，再用最小心智模型讲清楚它如何工作。
- 实际 Reading Path。
- Discovery Log：读源码时一步步发现了什么。
- 源码证据：路径、符号、类型、函数、调用链。
- 机制解释：入口、状态流、数据结构、错误路径、安全边界、消息 / 工具协议。
- `源码确认` / `合理推断` / `待验证`。
- 用户追问带来的修正，例如 `message / content block / chunk` 这类边界澄清。
- 对 `mini-cc` 的设计推导。

`analysis` 的可读性要求：

- 面向一个未来读者，而不是只给当前执行者看。
- 先给问题、直觉和最小模型，再展开源码路径和证据。
- 可以使用短小代码片段、ASCII 图、流程图和对话式解释降低理解成本。
- 源码证据要支撑叙事，不要把证据表放在最前面压住读者。
- 读者看完应能复述机制如何工作、为什么这样设计、`mini-cc` 应保留哪些边界。
- 仍然必须标注源码确认、合理推断、待验证；可读不等于可以省略证据。

禁止把 `analysis` 写成只有最终调用链、散乱摘录、内部工作日志，或没有源码证据的教程。

### build-along

`build-along` 是开发记录，位置：

```text
docs/build-along/cc/
```

用于记录：

- 本课从源码事实推导出哪些 `mini-cc` 实现决策。
- 改了哪些文件。
- 实现顺序。
- 如何运行和验证。
- `Annotated Code Walkthrough`：按代码里的 `Lxx-Sxx` 注释组织。
- 和 Claude Code 的差异，以及下一课要补什么。

`build-along` 不承载大段机制解释。机制解释先进入 `analysis`，build-along 只链接或概括。

如果本轮没有修改 `mini-cc` 代码、课程注释、运行脚本或实现边界，只是在解释现象、补充运行观察、回答用户追问，则不要修改既有 build-along。此类内容应沉淀到对应 `analysis`，因为它属于机制理解和读者教案，而不是开发记录。

### raw

`raw` 是 JOB-WIKI ingest 候选文档，位置：

```text
docs/wiki-source/cc/raw/
```

默认不生成 raw。只有用户明确要求以下动作时才创建：

- “生成 raw”
- “归档”
- “打包 JOB-WIKI source”
- “准备 ingest”
- “复制到 JOB-WIKI raw”

学习过程中应先补充 `analysis`。用户学习完并明确要求后，再基于成熟的 `analysis` / `build-along` 打包 raw。

`raw` 的写法必须贴近 JOB-WIKI 的真实 raw source，而不是把 analysis / build-along 拼接成一份长报告，也不是写成 “Entry Candidate / Suggested Page / Ingest Priorities” 这种操作清单。

对于本项目的 Claude Code / `mini-cc` 学习成果，默认目标形态是未来放入：

```text
JOB-WIKI/raw/Projects/cc/
```

因此 raw 主体应参考 `JOB-WIKI/raw/Projects/*` 的项目机制文档风格：

- 像一篇可独立阅读的项目机制讲稿。
- 先讲为什么做这个机制、它解决什么工程问题。
- 再讲源码观察、设计推导、`mini-cc` 实现、关键模块、运行效果、工程取舍和后续演进。
- 自然保留第一人称实践痕迹，但不要变成命令执行流水账。
- 末尾可以用简短小节说明“这份资料可以抽取哪些 wiki 词条 / 问题 / 场景”，但这只是辅助，不是正文主结构。

如果 raw 是外部文章、官方博客、访谈或 clipping，才参考 `JOB-WIKI/raw/Clippings/*` 的外部资料归档风格：保留来源 frontmatter、原文结构和摘录语气。`project-cc` 的 raw 不是 clipping，不能伪装成外部文章。

禁止因为“主题成熟”“lesson 完成”“文档可 ingest”而主动生成 raw。

## 4. 机制学习流程

每个主题必须围绕一个明确机制展开，例如 `agent loop`、`tool dispatcher`、`context compaction`、`permission hooks`。

默认流程：

1. 锚定机制：确认本轮问题和范围。
2. 查 learning map：确认当前位置和 frontier。
3. 读源码：定位入口、核心文件、关键符号。
4. 追调用链：跟到状态变化、模型交互、工具执行或副作用边界。
5. 写 / 补 `analysis`：保留阅读路径、发现过程和源码证据。
6. 如涉及 `mini-cc`：实现最小可理解版本，维护 `Lxx-Sxx` 注释。
7. 如修改 `mini-cc`：维护 `build-along`。
8. 验证：运行测试、脚本或小实验；无法验证就写明原因。
9. 回写 learning map：只更新当前机制相关 frontier，不重写整张地图。
10. 仅当用户明确要求时，生成 raw。

## 5. 源码学习规则

解释 Claude Code 机制时必须给出：

- 源码路径。
- 关键符号、类型或函数。
- 调用链或状态流。
- 该源码事实如何推导出设计结论。

必须区分：

- `源码确认`：代码中明确能证明。
- `合理推断`：基于命名、结构、调用关系推断。
- `待验证`：需要运行、测试或继续读源码确认。

禁止：

- 把合理推断写成源码事实。
- 把未验证实验结果写成已确认结论。
- 编造 Claude Code 源码中不存在的技术细节。

## 6. mini-cc 实现契约

`mini-cc` 是课程式仿写项目。目标是通过代码结构和分步注释理解 Claude Code-like agent 的核心机制。

实现原则：

- 不追求完全复刻 Claude Code。
- 模块边界尽量贴近已确认的 Claude Code 边界。
- 新增功能前，先判断它在 Claude Code 中属于哪个边界，再决定放入 `mini-cc` 的哪个模块。
- 课程演进优先增强既有入口、脚本和模块边界；不要因为进入下一课就自立新的 CLI 入口、npm script 或平行 main 文件。
- 如果旧实现被新机制取代，优先在原位置用注释保留“过去式”代码或迁移说明，除非用户明确要求删除。
- 避免把逻辑堆进单个教学文件。
- 先实现最小可理解版本，再逐步补生产级约束。
- 保留后续能长出权限、上下文压缩、session、skills、plugins、MCP 的压力点。

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

这类注释表示用户对当前课程机制的补充解释、提醒或口语化理解，不参与主阅读路径编号。后续维护时必须保留其含义，并默认沉淀到对应 `analysis`；除非用户明确要求，不要自动改写成 `Lxx-Sxx`、删除或重排。

规则：

- 注释解释机制和边界，不复述代码字面动作。
- 每个课程序号独立维护步骤编号。
- 同一课内步骤顺序应能串成阅读路径。
- 无分段号的 `//Lxx` 注释是用户补充说明，应记录到对应 `analysis` 的补充说明中，不改变 `Lxx-Sxx` 主路径顺序。
- 修改既有课程代码时，同步维护对应注释。
- 如果删除或合并步骤，优先保持已发布 lesson 编号稳定，并在 build-along 说明调整。

代码和文档关系：

- 代码注释是第一阅读路径。
- `docs/build-along/cc/<lesson>.md` 的 `Annotated Code Walkthrough` 必须按这些注释组织。
- 修改 `mini-cc` 但不维护注释和 build-along，视为课程未完成。

### 方法注释契约

`mini-cc` 中的稳定方法入口必须有 JSDoc 方法注释。范围包括命名函数、类方法、对象方法、构造函数，以及类型 / interface 中暴露的函数签名；不要求给 `map`、`filter`、`some` 等局部匿名回调逐个补注释，除非该回调承载了独立机制边界。

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
- 新增或修改 `mini-cc` 方法时，必须同步新增或维护对应方法注释。

## 8. Learning Map 与 Frontier

`docs/wiki-source/cc/00-learning-map.md` 是学习队列和状态索引，不是一次性全量大纲。

每次机制学习只更新当前相关区域：

- 当前节点。
- 已确认源码事实。
- `mini-cc` 已完成范围。
- 新牵出的 frontier。
- 下一步优先级。
- 新增或更新的 analysis / build-along 文档索引。
- raw 只记录已经按用户明确要求生成的文件，不预填未来 raw。

frontier 分类：

- `要学习`：继续精读 Claude Code 源码的机制。
- `要拓展`：需要在 `mini-cc` 新增的能力。
- `要优化`：已有能力后续要接近 Claude Code 的地方。

## 9. JOB-WIKI 与 raw 规则

- 默认不创建 `docs/wiki-source/cc/raw/` 新文档。
- 默认不写入 `C:\dev\workspace\h0pe\JOB-WIKI\raw\Projects\cc\`。
- 只有用户明确要求生成 raw / 归档 / 打包 JOB-WIKI source / 准备 ingest 时，才使用 `cc-job-wiki-source`。
- 写入 `JOB-WIKI/raw` 后，该文件视为不可变 raw source。
- 本项目会话不假设能看到 `JOB-WIKI/wiki` 已有页面。
- raw 文档主体是可读 source；末尾可以提供候选映射。真正的页面合并、去重、链接更新由 JOB-WIKI ingest 阶段完成。
- 生成 raw 前必须读取 `C:\dev\workspace\h0pe\JOB-WIKI\AGENTS.md`，并至少参考 `JOB-WIKI/raw/Projects/` 下 2-3 篇相近项目文档；如本轮 raw 类似外部资料，再额外参考 `JOB-WIKI/raw/Clippings/`。
- raw 的主体必须是可读 source，不是 ingest 任务列表。不要在正文主体使用 `Entry Candidate`、`Suggested Page`、`Ingest Priorities` 这类强操作语言。
- 对 `raw/Projects/cc/` 候选文档，优先写成项目机制文档：背景、问题、源码依据、架构设计、实现细节、取舍、验证、后续 TODO。
- 候选 JOB-WIKI 映射必须放在末尾，保持简短，使用“这份资料可以抽取...”的自然表达。

当用户明确要求 raw 时，文档必须自包含。项目机制类 raw 通常应覆盖：

```markdown
# ✅<机制标题>
## 为什么要做这个机制
## 源码里看到的核心结构
## 核心协议 / 数据结构
## mini-cc 实现结构
## 关键模块说明
## 注释驱动阅读路径
## 运行效果 / 验证
## 工程取舍
## 和真实 Claude Code 的差距
## 这份资料可以抽取哪些 wiki 词条？
## 后续 TODO
## Raw Reference
```

具体章节可以按主题调整；可读性和 ingest 语义密度优先于模板完整性。

## 10. Skill 分工

- `cc-onboarding`：维护 learning map 和 frontier。
- `cc-code-explorer`：读源码、追机制、产出 / 补充 analysis。
- `cc-build-along`：把 analysis 推导落到 `mini-cc` 实现和 build-along。
- `cc-practice-lab`：用实验验证不确定行为，并把证据回填 analysis。
- `cc-job-wiki-source`：仅在用户明确要求 raw 时打包 source 文档。

Skill 只负责执行流程。全局产物边界以本文件为准。

## 11. 完成标准

一个机制主题完成时，至少满足：

- 已定位真实 Claude Code 源码入口和关键调用链。
- 已区分源码确认、合理推断和待验证事项。
- 已说明模块边界、状态流、数据结构和错误 / 安全边界。
- 已更新或创建对应 `analysis`。
- 如果修改了 `mini-cc`，代码中有对应 `Lxx-Sxx` 注释。
- 如果修改了 `mini-cc` 方法，代码中有对应 JSDoc 方法注释。
- 如果修改了 `mini-cc`，build-along 有 `Annotated Code Walkthrough`。
- 已运行测试、脚本或小实验；如果无法验证，明确写出原因。
- 已更新 learning map 的当前节点和 frontier。
- 不要求产出 raw；只有用户明确要求 raw 时才生成。

## 12. 禁止事项

- 禁止编造源码事实。
- 禁止把推断写成确认。
- 禁止把未验证结果写成已验证。
- 禁止主动生成 `docs/wiki-source/cc/raw/`。
- 禁止默认写入 `JOB-WIKI/raw`。
- 禁止把 build-along 写成大段机制分析。
- 禁止在没有代码、注释、脚本或实现边界变更时更新 build-along；运行观察和机制追问应进入 analysis。
- 禁止把 analysis 写成没有源码证据的教程。
- 禁止把 analysis 写成只给执行者看的工作日志或证据堆叠；它必须是面向读者可顺读的教案。
- 禁止修改 `mini-cc` 却不维护分步注释和 build-along。
- 禁止新增或修改 `mini-cc` 方法却不维护方法注释。
- 禁止为了形式相似而过度设计 `mini-cc`。
- 禁止在未获用户明确要求时，为新课程或新机制另起独立 CLI 入口、重复 npm script、平行 `main` 文件；应优先演进既有入口。
- 禁止把被替代的教学实现直接抹掉导致学习路径断裂；需要保留时用注释或文档说明其已成为过去式。
