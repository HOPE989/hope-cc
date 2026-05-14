# hope-cc 文档体系

本目录服务于 Claude Code 源码学习、`mini-cc` 仿写实践和 JOB-WIKI raw source 候选材料生产。文档不按“越详细越好”组织，而按用途分层：队列、分析、课程、raw source。

## 文档分层

```text
docs/
├── README.md                         # 本文件：文档体系入口
├── build-along/cc/                   # 注释驱动课程复盘
└── wiki-source/cc/
    ├── 00-learning-map.md            # frontier 队列和主题索引
    ├── analysis/                     # 源码阅读过程稿
    └── raw/                          # JOB-WIKI ingest 候选 source
```

## 每类文档的职责

| 类型 | 位置 | 主要读者 | 写什么 | 不写什么 |
|---|---|---|---|---|
| Learning Map | `docs/wiki-source/cc/00-learning-map.md` | 后续学习会话 | 当前节点、frontier、优先级、source index | 不写完整源码分析，不替代课程文档 |
| Analysis | `docs/wiki-source/cc/analysis/` | 读源码的人 | 问题、阅读路径、发现日志、源码证据、推断和待验证事项 | 不写完整 mini-cc 课程过程 |
| Build-Along | `docs/build-along/cc/` | 跟着写 mini-cc 的人 | 从源码事实到 mini-cc 设计的推导，按 `Lxx-Sxx` 注释读代码 | 不伪装成 JOB-WIKI raw source |
| Raw Source | `docs/wiki-source/cc/raw/` | JOB-WIKI ingest | 可独立摄入的完整实践材料、候选映射、弱点和 ingest 建议 | 不假设能看到 JOB-WIKI wiki 已有页面 |

## 注释驱动规则

只要某一课修改了 `mini-cc`，对应 build-along 文档必须包含 `Annotated Code Walkthrough`，并按代码里的注释编号组织：

```ts
//L<两位课程序号>-S<两位步骤号> 步骤标题：具体注释内容
```

文档中的 walkthrough 不是重复源码，而是解释三件事：

- 这一步在 `mini-cc` 中做什么。
- 它对应 Claude Code 的哪个源码机制。
- 为什么本课保留或省略这部分复杂度。

## 写作顺序

每个机制主题按下面顺序推进：

1. 更新 `00-learning-map.md`，锚定当前机制和 frontier。
2. 写 `analysis/`，记录源码阅读路径和发现过程。
3. 修改 `mini-cc`，写好 `Lxx-Sxx` 分步注释。
4. 写 `build-along/`，按注释路径复盘实现。
5. 主题成熟后写 `raw/`，作为 JOB-WIKI ingest 候选。

只有用户明确要求归档或复制时，才写入 `C:\dev\workspace\h0pe\JOB-WIKI\raw\Projects\cc\`。
