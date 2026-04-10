# ThreadLocal 存储位置与线程隔离

## Scope

- Scenario id: threadlocal-storage-closure
- Interaction preference: balanced
- Total score: 8/12

## Review focus

- 用户说不知道后能否快速收敛成标准答案
- 是否把 Thread -> ThreadLocalMap -> value 讲完整
- 讲解后是否还能留下可复述 takeaway

## Expected signals

- 第一轮先确认方向接近，再纠正到 ThreadLocalMap
- 用户明确不会后，系统应该偏向 teach 而不是连续逼问

## Scorecard

- Knowledge closure: 2
- Teach quality: 2
- Conversation efficiency: 1
- Confirmation quality: 2
- Naturalness: 0
- Revisit readiness: 1

## Automatic flags

- MEDIUM: 模板化表达偏多，读起来更像策略输出，不像 tutor 自然回复。
- HIGH: learner 明确不会后没有尽快切到 teach，当前单元收敛速度偏慢。

## Metrics

- Total steps: 3
- Template phrase hits: 4
- Repeated teach loops: 0
- Control turns: 2
- Teach intents handled: 1
- Skip intents handled: 0

## Step 1

- Prompt: 围绕“集合结构与选型”回答一个具体点：材料里它是怎么工作的？
- Learner: 应该是放到线程本地内存吧？
- Action: teach
- Reply: 你前面的方向有一点接近，但还差最关键的一层。 我先把这一层讲清楚：ThreadLocal 的核心不是把值存在线程外部的全局位置，而是把值挂在当前线程对象内部维护的 ThreadLocalMap 上。
- Takeaway: ThreadLocal 的核心不是把值存在线程外部的全局位置，而是把值挂在当前线程对象内部维护的 ThreadLocalMap 上。
- Next prompt: 现在用你自己的话复述一下：“集合结构与选型”在材料里的关键机制是什么？

## Step 2

- Prompt: 现在用你自己的话复述一下：“集合结构与选型”在材料里的关键机制是什么？
- Learner: 不知道
- Action: advance
- Reply: 这一点你已经抓到主要方向了，我们先往下走，别在这里卡太久。
- Takeaway: ThreadLocal 的核心不是把值存在线程外部的全局位置，而是把值挂在当前线程对象内部维护的 ThreadLocalMap 上。
- Next prompt: 围绕“集合结构与选型”回答一个具体点：材料里它是怎么工作的？

## Step 3

- Prompt: 围绕“集合结构与选型”回答一个具体点：材料里它是怎么工作的？
- Learner: 讲一下
- Action: teach
- Reply: 好，我先不让你继续猜了。 调用 ThreadLocal.set(value) 时，当前线程会把当前这个 ThreadLocal 实例作为 key，把 value 作为 value，写入自己的 ThreadLocalMap。 优先抓住：先抓住材料里的关键点：调用 ThreadLocal.set(value) 时，当前线程会把当前这个 ThreadLocal 实例作为 key，把 value 作为 value，写入自己的 ThreadLocalMap。 常见卡点是：容易只复述“集合结构与选型”的表面结论，但没有讲清材料中的具体机制。
- Takeaway: 调用 ThreadLocal.set(value) 时，当前线程会把当前这个 ThreadLocal 实例作为 key，把 value 作为 value，写入自己的 ThreadLocalMap。
- Next prompt: 现在用你自己的话复述一下：“集合结构与选型”在材料里的关键机制是什么？

