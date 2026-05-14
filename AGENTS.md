# hope-cc 项目协作规则

## 1. 语言与交互

- 始终使用简体中文回应。
- 默认把本仓库视为 Claude Code 源码学习、架构仿写和 JOB-WIKI raw source 生产的长期项目。
- 除非用户明确要求只讨论，否则应推进到可执行的下一步：读源码、整理规则、规划实现、写代码、验证、产出文档。

## 2. 项目目标

本仓库的目标不是简单阅读 Claude Code 源码，而是形成一套可持续学习体系：

```text
读 Claude Code 源码
→ 理解功能、协议、架构边界和生产级约束
→ 仿照其架构逐步实现一个简化版 coding agent
→ 将学习和实践沉淀为 JOB-WIKI 可 ingest 的 raw project source
```

最终产物包括：

- Claude Code 源码机制学习地图。
- 关键机制的源码解析和调用链。
- 一个逐步演进的简化版 Claude Code-like 实现。
- 面向 `raw/Projects/cc` 的 JOB-WIKI 源文档。

## 3. 工作流总览

每个学习主题按以下顺序推进：

1. **定位源码**：找到真实 Claude Code 入口、核心文件、关键类型和调用链。
2. **理解架构**：说明该机制属于哪个模块边界，为什么这样拆。
3. **提炼机制**：区分源码确认、合理推断和待验证事项。
4. **仿写实践**：在简化实现中复现核心机制，目录和模块边界尽量贴近 Claude Code。
5. **验证行为**：通过测试、脚本或小实验验证理解。
6. **沉淀文档**：产出可读学习材料，成熟后整理成 JOB-WIKI raw source。

## 4. 源码学习规则

- 先读源码，再下结论。
- 解释一个机制时，必须给出源码路径、关键符号或调用链证据。
- 不只解释“功能是什么”，还要解释：
  - 模块边界
  - 状态流
  - 数据结构
  - 错误路径
  - 权限 / 安全边界
  - 上下文和消息协议
  - 为什么这种架构值得学习
- 必须区分：
  - `源码确认`：代码中明确能证明。
  - `合理推断`：基于命名、结构、调用关系推断。
  - `待验证`：需要运行、测试或进一步读源码确认。

## 5. 简化实现规则

简化实现不是随手写 demo，而是边学边长出来的 Claude Code-like 架构。

核心原则：

- 不要求完全复刻 Claude Code。
- 但模块边界尽量贴近 Claude Code。
- 每新增一个功能，先判断它在原版 Claude Code 中属于哪个边界，再决定放到简化实现的哪个模块。
- 避免把所有逻辑堆进一个教学文件。
- 先实现最小可理解版本，再逐步补生产级约束。

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

目录可以随着学习演进，但演进必须服务于理解 Claude Code 架构，而不是追求形式相似。

## 6. 文档产出规则

文档分三类：

```text
learning notes      # 学习过程材料，服务于理解
build-along notes   # 边学边写记录，服务于实践复盘
wiki-source docs    # JOB-WIKI raw source 候选文档，服务于 ingest
```

JOB-WIKI raw source 候选文档必须比普通学习笔记更结构化，建议包含：

```markdown
## TL;DR
## Study Scope
## Source Evidence
## Mechanism Walkthrough
## Architecture Notes
## Key Data Structures
## Design Decisions & Trade-offs
## What I Practiced
## Difference From Claude Code
## Candidate JOB-WIKI Mapping
## Weak Spots / TODO
## Suggested Ingest Plan
```

## 7. JOB-WIKI 对接规则

- 目标 raw 路径是 `C:\dev\workspace\h0pe\JOB-WIKI\raw\Projects\cc\`。
- 只有用户明确要求归档或复制到 JOB-WIKI 时，才写入该路径。
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

## 8. Skill 分工

- `cc-onboarding`：建立源码学习地图、选择学习主题和优先级。
- `cc-code-explorer`：精读并追踪单个 Claude Code 机制。
- `cc-build-along`：每学一个机制，就带着实现一个简化版能力。
- `cc-practice-lab`：通过实验、测试、临时 instrumentation 验证行为。
- `cc-job-wiki-source`：把成熟学习成果整理成 JOB-WIKI 可摄入的 raw project 源文档。

Skill 只负责具体任务流程，不应重复或覆盖本文件中的全局规则。

## 9. 禁止事项

- 禁止编造 Claude Code 源码中不存在的技术细节。
- 禁止把合理推断写成源码事实。
- 禁止把未验证实验结果写成已确认结论。
- 禁止默认写入 `JOB-WIKI/raw`。
- 禁止把普通学习笔记伪装成可 ingest 的 source 文档。
- 禁止为了形式相似而过度设计简化实现。
