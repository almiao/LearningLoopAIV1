# MVCC 与 Repeatable Read 边界

## Scope

- Scenario id: mvcc-rr-boundary
- Interaction preference: balanced
- Total score: 8/12

## Review focus

- 快照读 vs 当前读边界是否讲清楚
- 会不会把 next-key lock 讲成多余补丁
- 追问是否具体，不要泛化成模板问题

## Expected signals

- 至少一次明确承认 learner 已经抓到快照读这个核心
- 后续追问继续压当前读边界，而不是跳回泛泛而谈的事务概念

## Scorecard

- Knowledge closure: 1
- Teach quality: 2
- Conversation efficiency: 2
- Confirmation quality: 1
- Naturalness: 1
- Revisit readiness: 1

## Automatic flags

- MEDIUM: 模板化表达偏多，读起来更像策略输出，不像 tutor 自然回复。
- MEDIUM: 当前会话结尾缺少稳定 takeaway，用户拿走的结论感偏弱。

## Metrics

- Total steps: 2
- Template phrase hits: 3
- Repeated teach loops: 0
- Control turns: 0
- Teach intents handled: 0
- Skip intents handled: 0

## Step 1

- Prompt: 围绕“事务与索引推理”回答一个具体点：材料里它是怎么工作的？
- Learner: MVCC 解决的是事务并发读写时基于历史快照读取，不是每次都读最新值。
- Action: teach
- Reply: 你前面的方向有一点接近，但还差最关键的一层。 我先把这一层讲清楚：MySQL InnoDB 在 Repeatable Read 下依靠 MVCC 为普通 SELECT 提供一致性快照。事务读取数据时，不一定直接读取最新版本，而是根据 Read View 和 undo log 版本链判断哪个历史版本可见。
- Takeaway: MySQL InnoDB 在 Repeatable Read 下依靠 MVCC 为普通 SELECT 提供一致性快照。事务读取数据时，不一定直接读取最新版本，而是根据 Read View 和 undo log 版本链判断哪个历史版本可见。
- Next prompt: 现在用你自己的话复述一下：“事务与索引推理”在材料里的关键机制是什么？

## Step 2

- Prompt: 现在用你自己的话复述一下：“事务与索引推理”在材料里的关键机制是什么？
- Learner: 因为当前读不是快照读，范围判断时如果没有间隙锁或者 next-key lock，别的事务插入新行就会出现幻读。
- Action: advance
- Reply: 这一点你已经抓到主要方向了，我们先往下走，别在这里卡太久。
- Takeaway: MySQL InnoDB 在 Repeatable Read 下依靠 MVCC 为普通 SELECT 提供一致性快照。事务读取数据时，不一定直接读取最新版本，而是根据 Read View 和 undo log 版本链判断哪个历史版本可见。
- Next prompt: 围绕“事务与索引推理”回答一个具体点：材料里它是怎么工作的？

