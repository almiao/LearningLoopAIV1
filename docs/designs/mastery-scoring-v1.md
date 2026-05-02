# Mastery Scoring V1

Status: Proposed
Date: 2026-05-01
Owner: Codex + product discussion

## Goal

给用户一个稳定、友好、可解释的掌握度分数，让用户随时知道：

1. 自己已经走到哪了
2. 距离目标还差多少
3. 哪些阅读和训练行为正在带来提升

V1 的第一目标不是“最科学”，而是“进度感强、方向清楚、不会误导”。
产品排序优先级如下：

1. 让用户有明确进度感
2. 让用户知道自己差在哪里
3. 激励用户多看、多练、多回来继续
4. 再追求更细的准确性

## Core Principles

1. 读过，不等于掌握。
2. 只练过一次，不等于稳定掌握。
3. 掌握度必须能上涨，用户要看得到。
4. 阅读在前期可以占更高权重，帮助用户建立进度感。
5. 一旦训练证据变多，训练结果要逐步成为主导。
6. 所有分数都必须能解释来源，不能给“黑箱分”。

## Score Layers

V1 使用四层分数，不混用。

### 1. Checkpoint Mastery Score

单个 checkpoint 的掌握度，范围 0-100。

这是最小评分单元，也是训练流程里最适合做即时反馈的分数。

### 2. Point Mastery Score

单个 point 的掌握度，范围 0-100。

由 point 下多个 checkpoints 聚合而来，用于训练地图、章节列表、薄弱点排序。

### 3. Document Mastery Score

单篇文档的掌握度，范围 0-100。

用于目录、文档卡片、学习首页的文档列表。

### 4. Target Readiness Score

单个目标的准备度，范围 0-100。

这是给用户看的主指标。它回答的问题不是“你看了多少”，而是“你离目标还有多远”。

## V1 Scoring Model

V1 不做复杂模型，直接使用友好型综合评分。

### Checkpoint Score Formula

`checkpointScore = readingScore + trainingScore + stabilityScore - conflictPenalty`

分数范围控制在 0-100。

#### A. Reading Score

阅读分范围 0-60。

目的：

1. 让用户在训练前也能获得明显进度感
2. 鼓励阅读和重复阅读
3. 让“认真看过”与“没看过”在产品上有明显差异

建议规则：

- 首次打开文档: `+8`
- 阅读进度达到 25%: `+8`
- 阅读进度达到 50%: `+14`
- 阅读进度达到 75%: `+12`
- 阅读进度达到 90% 且停留达标: `+12`
- 第二次完整阅读: `+4`
- 第三次完整阅读: `+2`

上限 `60`。

说明：

- 用户完整阅读 50% 左右时，应该已经能感到“我不是 0 分了”。
- 阅读分故意做得更友好，优先给用户进度感。
- 但阅读分单独不能冲到高掌握，因为高掌握仍然要求训练证据。

#### B. Training Score

训练分范围 0-25。

目的：

1. 反映用户是否真的下场训练
2. 区分“看过”和“讲出来了”
3. 随多次训练累计，但递减，防止刷分

建议规则：

- 第一次训练结果为 `weak / partial / solid`: `+4 / +9 / +13`
- 第二次训练结果为 `weak / partial / solid`: `+2 / +5 / +7`
- 第三次及以后每次额外训练最多 `+2`

上限 `25`。

说明：

- 训练分不是主分盘子里最大的，因为 V1 明确优先考虑用户进度感。
- 但它依然是后期冲高掌握度的关键条件。

#### C. Stability Score

稳定性分范围 0-15。

目的：

1. 奖励“连续讲清”
2. 区分“一次答对”和“真的稳定了”

建议规则：

- 最近 7 天内出现一次 `partial+`: `+4`
- 连续两次 `partial+`: `+8`
- 最近出现一次 `solid`: `+10`
- 连续两次 `solid` 且不在同一轮硬刷: `+15`

上限 `15`。

#### D. Conflict Penalty

冲突扣分范围 0-15。

目的：

1. 避免用户因为一次好成绩长期虚高
2. 让“之前会，现在不稳了”体现在分数里

建议规则：

- 最近一次从 `solid/partial` 掉到 `weak`: `-8`
- 最近两次出现明显矛盾证据: `-4`
- 长时间未练后重新作答显著退步: `-3`

上限 `-15`。

## Score Meaning

为了避免分数看起来像假精确，V1 约定区间含义。

- `0-19`: 未开始
- `20-39`: 已接触
- `40-59`: 已阅读，待训练
- `60-74`: 训练中
- `75-89`: 已掌握主线
- `90-100`: 稳定掌握

## Aggregation Rules

### Point Score

point 下多个 checkpoints 的聚合方式：

- 默认取平均
- 核心 checkpoint 权重 1.5
- 次要 checkpoint 权重 1.0
- 如果 point 下任一核心 checkpoint 低于 40，point 总分最高不超过 79

目的：

- 防止某个 point 的一个关键 checkpoint 明显不行，但整体分数看起来很高

### Document Score

文档分来自两个部分：

- 文档关联 points 的加权平均: `80%`
- 文档自身阅读完成度信号: `20%`

说明：

- 这保证用户“读得越深，文档分越明显上涨”
- 也保证文档分不会完全脱离训练结果

### Target Readiness Score

目标分来自目标下所有 points 的加权平均。

建议权重：

- 核心 point: `2`
- 次要 point: `1`

再增加一个覆盖修正：

- 若目标下超过 40% 的核心 points 仍低于 50，总分最高不超过 74

目的：

- 用户不能靠少数高分点制造“快达标”的错觉

## Persisted Data

V1 需要明确保存两类数据。

### 1. Decomposition Snapshot

文档拆解结果必须持久化，不能每次重新拆。

建议新增概念：

- `documentDecompositionId`
- `docPath`
- `docVersion`
- `points[]`
- `checkpoints[]`
- `generatedAt`

用途：

- 文档拆完后，训练地图稳定
- 用户下次回来仍能对上原来的 point/checkpoint

### 2. User Training State

用户训练状态必须与拆解结果分开存。

建议每个用户每篇文档至少保存：

- `currentPointId`
- `currentCheckpointId`
- `completedCheckpointIds`
- `startedCheckpointIds`
- `checkpointScores`
- `pointScores`
- `documentScore`
- `readCount`
- `completedReadCount`
- `lastReadAt`
- `trainingAttemptCount`
- `lastTrainingAt`
- `streakPartialOrAbove`
- `streakSolid`

## Continue Training

V1 必须支持“继续训练”。

规则：

1. 文档拆解完成后保存 snapshot
2. 用户训练到一半离开时保存当前进度
3. 用户下次进入文档时，优先展示：
   - 当前掌握度
   - 上次练到哪里
   - 一个明确的“继续训练”按钮
4. 恢复训练默认从：
   - 上次未完成 checkpoint
   - 如果都完成了，从最低分 checkpoint 开始复习

## Frontend Surfaces

V1 至少覆盖以下位置。

### 1. 目录 / 文档列表

每篇文档展示：

- `掌握度 xx`
- `已读 xx%`
- `未训练 / 训练中 / 已掌握`

示例：

- `掌握度 42 · 已读 68%`
- `掌握度 73 · 训练中`
- `掌握度 88 · 已掌握主线`

### 2. Point / Checkpoint 列表

每个 point 展示：

- 分数
- 状态
- 是否已开始
- 是否可继续

### 3. 训练流程内

每次答完后都要给用户即时反馈。

示例：

- `本题掌握度 +7`
- `从 46 提升到 53`
- `你已经从“已阅读”进入“训练中”`
- `再通过 1 次稳定作答，这个点就能进“已掌握主线”`

### 4. 目标首页

必须突出：

- `目标准备度`
- `当前最高提升的领域`
- `还差最多的 3 个 points`

## UX Rules

V1 的体验重点是“让提升被看见”。

定义以下可见事件：

- 首次达到阅读 50%
- 首次完整阅读
- 首次完成训练
- 首次从 `weak -> partial`
- 首次从 `partial -> solid`
- 单文档掌握度突破 `40 / 60 / 80`
- 目标准备度突破 `50 / 70 / 85`

文案规则：

- 说人话，不说模型话
- 强调“你前进了”
- 明确告诉用户下一步最值的动作

示例：

- `掌握度 +6，你已经能讲出主线了`
- `这篇文档已经不只是看过，你开始真的会用了`
- `离目标线还差 14 分，优先补事务边界和 AQS`

## Implementation Mapping

V1 预计落在这些现有模块附近：

- `src/user/profile-aggregator.js`
- `src/tutor/capability-memory.js`
- `src/tutor/memory-profile-store.js`
- `src/training/training-model.js`
- `frontend/components/home-page.js`
- `frontend/components/learn-workspace.js`
- `bff/src/server.js`

## Delivery Phases

### Phase 1

统一分数字段和口径。

- 建立 shared score mapping
- 引入 checkpoint / point / document / target 四层分数
- 后端返回统一掌握度结构

### Phase 2

持久化文档拆解与继续训练。

- 保存 decomposition snapshot
- 保存 user training state
- 支持“继续训练”

### Phase 3

前端展示和即时反馈。

- 文档目录显示掌握度
- 训练页显示每次提升
- 首页显示目标准备度和薄弱点

## Non-Goals

V1 不做这些：

- 概率模型
- 遗忘曲线学习算法
- 跨目标复杂迁移推断
- 黑箱 AI 自动调权

## Success Criteria

V1 完成后，用户应能稳定回答：

1. 我这篇文档现在大概学到什么程度了？
2. 我这个知识点是“看过了”还是“真的会了”？
3. 我离目标还有多远？
4. 我现在下一步最值的是继续读，还是继续练？
