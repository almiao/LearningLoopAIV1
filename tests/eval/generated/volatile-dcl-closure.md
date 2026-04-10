# 双重校验锁为什么需要 volatile

## Scope

- Scenario id: volatile-dcl-closure
- Interaction preference: explain-first
- Total score: 8/12

## Review focus

- teach 模式能否一次讲清半初始化对象问题
- 是否出现 teach -> ask -> teach 的低效循环
- 有没有一句稳定结论可带走

## Expected signals

- 先确认 learner 已经抓到重排序
- 后续 teach 需要给出 1-2-3 链路，而不是重复换个说法

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

- Prompt: 围绕“材料切入点 1”回答一个具体点：材料里它是怎么工作的？
- Learner: 不这么用的话，指令重排序可能导致别的线程拿到半初始化对象。
- Action: teach
- Reply: 你前面的方向有一点接近，但还差最关键的一层。 我先把这一层讲清楚：双重校验锁单例模式里，new 一个对象在底层可以拆成三步：分配内存、调用构造初始化对象、把引用赋给变量。
- Takeaway: 双重校验锁单例模式里，new 一个对象在底层可以拆成三步：分配内存、调用构造初始化对象、把引用赋给变量。
- Next prompt: 现在用你自己的话复述一下：“材料切入点 1”在材料里的关键机制是什么？

## Step 2

- Prompt: 现在用你自己的话复述一下：“材料切入点 1”在材料里的关键机制是什么？
- Learner: 不知道
- Action: advance
- Reply: 这一点你已经抓到主要方向了，我们先往下走，别在这里卡太久。
- Takeaway: 双重校验锁单例模式里，new 一个对象在底层可以拆成三步：分配内存、调用构造初始化对象、把引用赋给变量。
- Next prompt: 围绕“材料切入点 2”回答一个具体点：材料里它是怎么工作的？

## Step 3

- Prompt: 围绕“材料切入点 2”回答一个具体点：材料里它是怎么工作的？
- Learner: 讲一下
- Action: teach
- Reply: 好，我先不让你继续猜了。 如果没有 volatile，编译器和 CPU 可能发生重排序，导致“先把引用写出去，再完成对象初始化”。这样其他线程第一次判空时，会看到一个非 null 但尚未初始化完成的对象。 优先抓住：先抓住材料里的关键点：如果没有 volatile，编译器和 CPU 可能发生重排序，导致“先把引用写出去，再完成对象初始化”。这样其他线程第一次判空时，会看到一个非 null 但尚未初始化完成的对象。 常见卡点是：容易只复述“材料切入点 2”的表面结论，但没有讲清材料中的具体机制。
- Takeaway: 如果没有 volatile，编译器和 CPU 可能发生重排序，导致“先把引用写出去，再完成对象初始化”。这样其他线程第一次判空时，会看到一个非 null 但尚未初始化完成的对象。
- Next prompt: 现在用你自己的话复述一下：“材料切入点 2”在材料里的关键机制是什么？

