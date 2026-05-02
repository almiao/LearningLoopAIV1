# 文档进展统一设计

目标：JavaGuide 当前只有一套文档数据源，用户可见状态也只保留一套文档中心模型，不再让首页状态依赖“目标包 / baseline / 固定训练点映射”。

## 一份真状态

每篇文档只维护一份统一状态，字段按文档存储：

- `reading`
  - `progressPercentage`
  - `status`
  - `openedAt`
  - `lastReadAt`
  - `completedAt`
  - `completedReadCount`
- `training`
  - `trainingStartedAt`
  - `trainingSessionCount`
  - `trainingAnswerCount`
  - `lastTrainingStartedAt`
  - `lastTrainingAt`
- `mastery`
  - `assessedConceptCount`
  - `evidenceCount`
  - `masteryPercentage`
  - `masteryLabel`

## 展示规则

首页每篇文档只展示两类 badge，但它们都来自同一份文档状态：

- 阅读 badge
  - `未读`
  - `已打开`
  - `xx%`
  - `已读`
- 学习 badge
  - `未训练`
  - `已开启训练`
  - `训练中 xx%`
  - `已掌握 xx%`

补充规则：

- `当前阅读` 只表示当前聚焦文档，不再暗示训练进度。
- `当前 · 已读` 表示“当前正在看的就是这篇，且阅读完成度已达已读条件”。
- 只要点击“开始训练”并成功进入训练会话，就立即记录 `已开启训练`。
- 后续答题产生有效记忆证据后，再进入 `训练中 / 已掌握`。

## 为什么不再让首页依赖 baseline

`baseline / target pack` 仍可作为训练引擎的内部上下文组织方式存在，但它不是首页文档状态的真实来源。

原因：

- JavaGuide 面向用户看到的是文档集合，不是面试包集合。
- 文档可以被阅读、打开训练、回答问题，即便它不在某个固定包映射中。
- 用户可见状态必须由“这篇文档本身发生了什么”决定，而不是由某个离线映射是否覆盖到它决定。

## 当前兼容策略

- 训练引擎暂时保留现有 `baseline` 内部默认值，避免一次性重写训练链路。
- 前端和公开 BFF 入口不再要求选择或传入 `baseline`。
- 用户可见状态统一从 `user.documents` 和 `memoryProfile` 聚合。
- 旧的 `targets[*].readingProgress` 继续保留，作为兼容输入；首页和档案页不再直接依赖它。
