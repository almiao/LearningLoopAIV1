export const sessionReviewScenarios = [
  {
    id: "mvcc-rr-boundary",
    title: "MVCC 与 Repeatable Read 边界",
    interactionPreference: "balanced",
    reviewFocus: [
      "快照读 vs 当前读边界是否讲清楚",
      "会不会把 next-key lock 讲成多余补丁",
      "追问是否具体，不要泛化成模板问题"
    ],
    source: {
      title: "MySQL Repeatable Read 与 MVCC",
      content: `
MySQL InnoDB 在 Repeatable Read 下依靠 MVCC 为普通 SELECT 提供一致性快照。事务读取数据时，不一定直接读取最新版本，而是根据 Read View 和 undo log 版本链判断哪个历史版本可见。

MVCC 解决的是快照读的一致性问题，重点是让事务在同一事务内多次普通查询时看到稳定结果，从而避免不可重复读。

但当前读并不走同一条路径。像 SELECT ... FOR UPDATE、UPDATE、DELETE 这类操作，需要读取并保护当前版本，还要处理范围查询里的插入并发。

因此在 Repeatable Read 下，当前读仍然需要借助记录锁、间隙锁和 next-key lock 来约束并发插入，否则范围判断和后续更新就可能遭遇幻读。
`
    },
    learnerTurns: [
      "MVCC 解决的是事务并发读写时基于历史快照读取，不是每次都读最新值。",
      "因为当前读不是快照读，范围判断时如果没有间隙锁或者 next-key lock，别的事务插入新行就会出现幻读。"
    ],
    expectedSignals: [
      "至少一次明确承认 learner 已经抓到快照读这个核心",
      "后续追问继续压当前读边界，而不是跳回泛泛而谈的事务概念"
    ]
  },
  {
    id: "threadlocal-storage-closure",
    title: "ThreadLocal 存储位置与线程隔离",
    interactionPreference: "balanced",
    reviewFocus: [
      "用户说不知道后能否快速收敛成标准答案",
      "是否把 Thread -> ThreadLocalMap -> value 讲完整",
      "讲解后是否还能留下可复述 takeaway"
    ],
    source: {
      title: "ThreadLocal 存储机制",
      content: `
ThreadLocal 的核心不是把值存在线程外部的全局位置，而是把值挂在当前线程对象内部维护的 ThreadLocalMap 上。

调用 ThreadLocal.set(value) 时，当前线程会把当前这个 ThreadLocal 实例作为 key，把 value 作为 value，写入自己的 ThreadLocalMap。

因此同一个 ThreadLocal 对象被不同线程访问时，本质上是在不同线程各自的 ThreadLocalMap 里查值，所以互不干扰。

面试回答时，最好把对象关系说成：Thread 持有 ThreadLocalMap，ThreadLocal 只是访问这个 map 的 key。
`
    },
    learnerTurns: [
      "应该是放到线程本地内存吧？",
      "不知道",
      "讲一下"
    ],
    expectedSignals: [
      "第一轮先确认方向接近，再纠正到 ThreadLocalMap",
      "用户明确不会后，系统应该偏向 teach 而不是连续逼问"
    ]
  },
  {
    id: "volatile-dcl-closure",
    title: "双重校验锁为什么需要 volatile",
    interactionPreference: "explain-first",
    reviewFocus: [
      "teach 模式能否一次讲清半初始化对象问题",
      "是否出现 teach -> ask -> teach 的低效循环",
      "有没有一句稳定结论可带走"
    ],
    source: {
      title: "DCL 与 volatile",
      content: `
双重校验锁单例模式里，new 一个对象在底层可以拆成三步：分配内存、调用构造初始化对象、把引用赋给变量。

如果没有 volatile，编译器和 CPU 可能发生重排序，导致“先把引用写出去，再完成对象初始化”。这样其他线程第一次判空时，会看到一个非 null 但尚未初始化完成的对象。

volatile 在这里至少有两个作用：一是禁止这类关键重排序，二是保证对象初始化结果对其他线程可见。

面试里最稳的表达通常不是“会读到旧值”，而是“会读到引用已发布但对象还没初始化完的半成品对象”。
`
    },
    learnerTurns: [
      "不这么用的话，指令重排序可能导致别的线程拿到半初始化对象。",
      "不知道",
      "讲一下"
    ],
    expectedSignals: [
      "先确认 learner 已经抓到重排序",
      "后续 teach 需要给出 1-2-3 链路，而不是重复换个说法"
    ]
  },
  {
    id: "concurrenthashmap-skip-closure",
    title: "ConcurrentHashMap 版本演进与收口",
    interactionPreference: "balanced",
    reviewFocus: [
      "部分正确后确认是否自然",
      "用户说下一题时能否顺滑收口并记录 revisit",
      "输出是否过于模板化"
    ],
    source: {
      title: "ConcurrentHashMap 演进",
      content: `
JDK 1.7 的 ConcurrentHashMap 依赖 Segment 分段锁，把桶数组拆成多个段来降低并发冲突。

JDK 1.8 取消了 Segment，改成数组 + 链表/红黑树 + CAS + synchronized 的组合。真正发生 bin 冲突或结构修改时，synchronized 只会锁住对应桶位的头节点，而不是整张表。

因此 1.8 的关键收益不是“完全无锁”，而是锁粒度更细、无冲突路径更多，读写协作方式也更灵活。
`
    },
    learnerTurns: [
      "1.7 是分段锁，1.8 变成了 CAS 加 synchronized，锁粒度更细。",
      "下一题"
    ],
    expectedSignals: [
      "第一轮应该确认 learner 已经抓到主要方向",
      "skip 后最好留下一个一句话总结，并出现 revisit 线索"
    ]
  }
];
