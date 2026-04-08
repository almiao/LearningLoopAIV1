import { createSource } from "../material/material-model.js";

export const defaultBaselinePackId = "bigtech-java-backend";
export const siblingBaselinePackId = "java-backend-generalist";

const javaGuideSourceRegistry = {
  "docs/java/concurrent/aqs.md": { title: "AQS 详解" },
  "docs/java/concurrent/jmm.md": { title: "JMM（Java 内存模型）详解" },
  "docs/java/concurrent/java-thread-pool-summary.md": { title: "Java 线程池详解" },
  "docs/java/concurrent/java-concurrent-questions-03.md": { title: "Java 并发常见面试题（下）" },
  "docs/java/concurrent/completablefuture-intro.md": { title: "CompletableFuture 详解" },
  "docs/database/mysql/mysql-questions-01.md": { title: "MySQL 常见面试题总结" },
  "docs/database/mysql/innodb-implementation-of-mvcc.md": { title: "InnoDB 对 MVCC 的实现" },
  "docs/database/mysql/transaction-isolation-level.md": { title: "MySQL 事务隔离级别详解" },
  "docs/database/mysql/mysql-index.md": { title: "MySQL 索引详解" },
  "docs/database/mysql/mysql-logs.md": { title: "MySQL 三大日志详解" },
  "docs/database/redis/redis-questions-01.md": { title: "Redis 常见面试题总结（上）" },
  "docs/database/redis/redis-questions-02.md": { title: "Redis 常见面试题总结（下）" },
  "docs/database/redis/redis-persistence.md": { title: "Redis 持久化机制详解" },
  "docs/database/redis/redis-common-blocking-problems-summary.md": { title: "Redis 常见阻塞原因总结" },
  "docs/system-design/framework/spring/spring-transaction.md": { title: "Spring 事务详解" },
  "docs/system-design/framework/spring/ioc-and-aop.md": { title: "IoC 与 AOP 详解" },
  "docs/system-design/framework/spring/spring-boot-auto-assembly-principles.md": { title: "Spring Boot 自动装配原理详解" },
  "docs/high-availability/timeout-and-retry.md": { title: "超时与重试详解" },
  "docs/high-availability/idempotency.md": { title: "接口幂等方案总结" },
  "docs/high-availability/fallback-and-circuit-breaker.md": { title: "降级与熔断详解" },
  "docs/high-performance/message-queue/kafka-questions-01.md": { title: "Kafka 常见问题总结" },
  "docs/high-performance/message-queue/message-queue.md": { title: "消息队列基础知识总结" },
  "docs/java/jvm/memory-area.md": { title: "Java 内存区域详解" },
  "docs/java/jvm/jvm-garbage-collection.md": { title: "JVM 垃圾回收详解" },
  "docs/java/jvm/class-loading-process.md": { title: "类加载过程详解" },
  "docs/java/jvm/classloader.md": { title: "类加载器详解" },
  "docs/cs-basics/network/tcp-connection-and-disconnection.md": { title: "TCP 三次握手和四次挥手" },
  "docs/cs-basics/network/http-status-codes.md": { title: "HTTP 常见状态码" },
  "docs/cs-basics/network/http1.0-vs-http1.1.md": { title: "HTTP 1.0 vs HTTP 1.1" }
};

function toJavaGuideUrl(sourcePath) {
  return `https://javaguide.cn/${sourcePath.replace(/^docs\//, "").replace(/\.md$/, ".html")}`;
}

function normalizeJavaGuideSource(source) {
  const sourcePath = typeof source === "string" ? source : source.path;
  const meta = typeof source === "string" ? javaGuideSourceRegistry[sourcePath] : source;
  return {
    path: sourcePath,
    title: meta?.title || sourcePath.split("/").at(-1)?.replace(/\.md$/, "") || "JavaGuide 资料",
    url: meta?.url || toJavaGuideUrl(sourcePath)
  };
}

function collectPackGuideSources(pack) {
  const unique = new Map();
  for (const domain of pack.domains) {
    for (const item of domain.items) {
      for (const source of item.javaGuideSources || []) {
        const normalized = normalizeJavaGuideSource(source);
        unique.set(normalized.path, normalized);
      }
    }
  }
  return [...unique.values()];
}

const baselinePacks = [
  {
    id: defaultBaselinePackId,
    title: "大厂 Java 后端面试包",
    shortTitle: "大厂 Java 后端",
    description:
      "基于 JavaGuide 面试优先级裁剪的一版 Java 后端能力包，聚焦并发、MySQL、Redis、Spring、高可用、MQ、JVM 与 HTTP/TCP 高频追问。",
    targetRole: "Java 后端工程师",
    targetLabel: "大厂 Java 后端面试",
    flagship: true,
    exposed: true,
    packSummary:
      "先围绕最容易影响大厂 Java 后端通过率的能力点做目标诊断，再把薄弱点接回 JavaGuide 的补强资料。",
    domains: [
      {
        id: "java-concurrency",
        title: "Java 并发与可见性",
        tier: "core",
        items: [
          {
            id: "aqs-acquire-release",
            title: "AQS acquire/release 语义",
            summary: "能解释 AQS 在独占获取与释放时如何驱动排队、阻塞和唤醒。",
            excerpt: "高频追问集中在 AQS、ReentrantLock、state、队列变化与唤醒语义的关系。",
            keywords: ["aqs", "acquire", "release", "state", "reentrantlock", "队列", "唤醒"],
            misconception: "容易只背 AQS 是同步器框架，却讲不清 acquire/release 主链路。",
            importance: "core",
            coverage: "high",
            diagnosticQuestion:
              "这是某位候选人在字节并发面里被追问的版本：如果 ReentrantLock 建在 AQS 之上，独占 acquire/release 这条主链路你会怎么解释？",
            retryQuestion: "先只讲一个点：获取失败后，线程为什么会排队和阻塞？",
            stretchQuestion: "如果再追问共享模式或 condition，你会怎么补充边界差异？",
            checkQuestion: "现在用你自己的话重讲一遍：AQS 为什么是同步器底座，不是一把锁？",
            remediationHint: "回到 state、CLH 变体队列和唤醒链路，先把 acquire/release 机制串起来。",
            provenance: {
              type: "interview-report",
              company: "字节",
              label: "字节并发面经原题"
            },
            javaGuideSources: [
              "docs/java/concurrent/aqs.md"
            ],
            remediationAssets: [
              {
                id: "aqs-fix-card",
                title: "AQS acquire/release 15 分钟补强卡",
                kind: "note",
                durationMinutes: 15,
                description: "按 state、入队、park/unpark 重新搭一遍解释链路。"
              }
            ]
          },
          {
            id: "jmm-visibility",
            title: "JMM 可见性与 happens-before",
            summary: "能把缓存可见性、指令重排、happens-before 与 volatile/锁语义联系起来。",
            excerpt: "高频追问是：为什么线程写了共享变量，另一个线程不一定立刻看到，volatile 到底改变了什么。",
            keywords: ["jmm", "volatile", "happens-before", "缓存", "可见性", "锁", "重排序"],
            misconception: "容易只背结论，不会把可见性问题和具体同步原语联系起来。",
            importance: "core",
            coverage: "high",
            diagnosticQuestion:
              "这是某位候选人在美团并发面里被追问的版本：为什么一个线程写了共享变量，另一个线程不一定立刻看到？volatile 到底改变了什么？",
            retryQuestion: "先别展开全部，只回答 volatile 为什么能让读线程看到最新值。",
            stretchQuestion: "如果把 volatile 换成 lock/unlock，你会怎么比较 happens-before 保证？",
            checkQuestion: "现在重新讲一遍：JMM 里的可见性问题到底是怎么被同步原语修复的？",
            remediationHint: "先把 CPU 缓存可见性和 Java happens-before 的桥接关系讲清楚。",
            provenance: {
              type: "interview-report",
              company: "美团",
              label: "美团并发面经原题"
            },
            javaGuideSources: [
              "docs/java/concurrent/jmm.md"
            ],
            remediationAssets: [
              {
                id: "jmm-visibility-card",
                title: "JMM 可见性补强卡",
                kind: "note",
                durationMinutes: 15,
                description: "把缓存一致性、volatile 语义和 happens-before 放到同一条解释链里。"
              }
            ]
          },
          {
            id: "thread-pool-sizing-rejection",
            title: "线程池参数、拒绝策略与隔离设计",
            summary: "能把核心线程数、队列、拒绝策略和隔离目标讲成具体取舍，而不是只背参数名。",
            excerpt: "真实面试会追问线程池为什么这么配、满了会怎样、为什么不能共享一个线程池。",
            keywords: ["线程池", "核心线程数", "拒绝策略", "队列", "隔离", "completablefuture"],
            misconception: "容易只背线程池 7 个参数，却说不清不同业务为什么不能共用同一个线程池。",
            importance: "secondary",
            coverage: "medium",
            diagnosticQuestion: "系统生成诊断题：为什么线上不同业务不能随便共用一个线程池？线程池参数到底是在控制什么？",
            retryQuestion: "先只回答一个点：线程池的队列和拒绝策略为什么会直接影响故障扩散？",
            stretchQuestion: "如果再追问 CompletableFuture 默认线程池，你会怎么解释风险？",
            checkQuestion: "现在重新讲一遍：线程池的核心参数本质上是在控制哪三件事？",
            remediationHint: "先抓住容量、排队、拒绝和隔离这四个词，再回到具体参数。",
            provenance: {
              type: "system-generated",
              company: "",
              label: "系统生成诊断题"
            },
            javaGuideSources: [
              "docs/java/concurrent/java-thread-pool-summary.md",
              "docs/java/concurrent/java-concurrent-questions-03.md",
              "docs/java/concurrent/completablefuture-intro.md"
            ],
            remediationAssets: [
              {
                id: "thread-pool-card",
                title: "线程池参数与隔离补强卡",
                kind: "note",
                durationMinutes: 15,
                description: "围绕容量、排队、拒绝和业务隔离重建一轮线程池解释。"
              }
            ]
          }
        ]
      },
      {
        id: "database-core",
        title: "MySQL 事务、索引与日志",
        tier: "core",
        items: [
          {
            id: "mvcc-repeatable-read",
            title: "MVCC 与 Repeatable Read 边界",
            summary: "能解释 RR 下 MVCC 解决了什么、没解决什么，以及幻读边界。",
            excerpt: "面试常追问 RR 为什么还要 next-key lock，以及快照读 / 当前读边界。",
            keywords: ["mvcc", "repeatable read", "幻读", "next-key", "版本", "快照", "当前读"],
            misconception: "容易把 MVCC、锁和隔离级别混成一团，只背结论不说边界。",
            importance: "core",
            coverage: "high",
            diagnosticQuestion:
              "这是某位候选人在阿里数据库面里被追问的版本：MySQL Repeatable Read 已经有 MVCC 了，为什么还会谈 next-key lock？",
            retryQuestion: "先只回答：MVCC 在 RR 里主要解决了什么问题？",
            stretchQuestion: "如果面试官继续追问幻读和当前读 / 快照读，你会怎么区分？",
            checkQuestion: "现在用自己的话说一遍：MVCC 解决了什么，为什么还不等于所有并发问题都没了？",
            remediationHint: "把快照读、当前读、Read View 和幻读边界拆开讲。",
            provenance: {
              type: "interview-report",
              company: "阿里",
              label: "阿里数据库面经原题"
            },
            javaGuideSources: [
              "docs/database/mysql/mysql-questions-01.md",
              "docs/database/mysql/innodb-implementation-of-mvcc.md",
              "docs/database/mysql/transaction-isolation-level.md"
            ],
            remediationAssets: [
              {
                id: "mvcc-card",
                title: "MVCC / RR 边界补强卡",
                kind: "note",
                durationMinutes: 15,
                description: "围绕快照读、当前读、Read View 和 next-key lock 重讲一遍。"
              }
            ]
          },
          {
            id: "mysql-index-query-plan",
            title: "MySQL 索引设计与查询计划",
            summary: "能讲清索引为什么生效或失效、为什么回表、什么时候优化器会放弃索引。",
            excerpt: "索引相关追问常落在 B+ 树、最左前缀、覆盖索引、索引失效和执行计划理解上。",
            keywords: ["索引", "b+树", "覆盖索引", "回表", "最左前缀", "执行计划", "失效"],
            misconception: "容易只背『索引能加速查询』，不会解释为什么优化器有时仍然不走索引。",
            importance: "core",
            coverage: "high",
            diagnosticQuestion: "这是某位候选人在腾讯数据库面里被问到的：一个查询为什么明明建了索引，执行计划里还是没用上？",
            retryQuestion: "先只回答一个点：联合索引为什么会受最左前缀限制？",
            stretchQuestion: "如果继续追问覆盖索引和回表，你会怎么解释它们的成本差异？",
            checkQuestion: "现在重新组织一遍：索引生效、失效和回表之间是什么关系？",
            remediationHint: "先用『索引结构 -> 命中条件 -> 是否回表』三层去解释。",
            provenance: {
              type: "interview-report",
              company: "腾讯",
              label: "腾讯数据库面经原题"
            },
            javaGuideSources: [
              "docs/database/mysql/mysql-index.md",
              "docs/database/mysql/mysql-questions-01.md"
            ],
            remediationAssets: [
              {
                id: "mysql-index-card",
                title: "MySQL 索引与执行计划补强卡",
                kind: "note",
                durationMinutes: 15,
                description: "围绕最左前缀、覆盖索引、回表和索引失效做一页推理卡。"
              }
            ]
          },
          {
            id: "mysql-redo-undo-binlog-chain",
            title: "MySQL 三大日志职责与恢复链路",
            summary: "能把 redo log、undo log、binlog 的职责、顺序和恢复意义讲成一条链。",
            excerpt: "高频问题不是背名字，而是讲清楚谁负责崩溃恢复、谁负责回滚、谁负责主从复制。",
            keywords: ["redo log", "undo log", "binlog", "崩溃恢复", "回滚", "复制", "两阶段提交"],
            misconception: "容易只记得三大日志名字，却说不清为什么它们不能相互替代。",
            importance: "core",
            coverage: "high",
            diagnosticQuestion: "系统生成诊断题：MySQL 里的 redo log、undo log、binlog 分别在管什么？为什么不能只有一种日志？",
            retryQuestion: "先只回答：如果数据库崩了，redo log 为什么重要？",
            stretchQuestion: "如果继续追问两阶段提交和主从一致性，你会怎么补充？",
            checkQuestion: "现在重新讲一遍：三大日志分别解决了哪类问题？",
            remediationHint: "先按『恢复 / 回滚 / 复制』三件事分类，再解释日志链路。",
            provenance: {
              type: "system-generated",
              company: "",
              label: "系统生成诊断题"
            },
            javaGuideSources: [
              "docs/database/mysql/mysql-logs.md",
              "docs/database/mysql/mysql-questions-01.md"
            ],
            remediationAssets: [
              {
                id: "mysql-logs-card",
                title: "MySQL 三大日志补强卡",
                kind: "note",
                durationMinutes: 15,
                description: "按恢复、回滚、复制三个职责重建 redo/undo/binlog 的解释链路。"
              }
            ]
          }
        ]
      },
      {
        id: "redis-cache",
        title: "Redis 与缓存治理",
        tier: "core",
        items: [
          {
            id: "redis-cache-consistency",
            title: "Redis 缓存一致性取舍",
            summary: "能说明缓存旁路、双删、失效顺序和一致性风险的权衡。",
            excerpt: "后端面经里常把缓存策略和数据库更新顺序放在一起追问。",
            keywords: ["redis", "cache", "双删", "失效", "一致性", "旁路", "延迟双删"],
            misconception: "容易只背套路，不会说为什么这个顺序仍有脏读窗口。",
            importance: "core",
            coverage: "medium",
            diagnosticQuestion:
              "这是某位候选人在滴滴后端面里被追问的版本：更新数据库和删除 Redis 缓存时，为什么顺序不对会出一致性问题？",
            retryQuestion: "先只回答：为什么『先删缓存再写库』和『先写库再删缓存』都会有窗口期？",
            stretchQuestion: "如果再追问延迟双删和 binlog 方案，你会怎么解释它们缓解了什么、又没解决什么？",
            checkQuestion: "现在再讲一遍：缓存一致性问题本质上是在防哪类并发窗口？",
            remediationHint: "抓住『数据库更新』『缓存失效』『并发读』三者顺序关系。",
            provenance: {
              type: "interview-report",
              company: "滴滴",
              label: "滴滴缓存面经原题"
            },
            javaGuideSources: [
              "docs/database/redis/redis-questions-01.md",
              "docs/high-availability/timeout-and-retry.md"
            ],
            remediationAssets: [
              {
                id: "redis-consistency-card",
                title: "Redis 一致性窗口补强卡",
                kind: "note",
                durationMinutes: 15,
                description: "按更新顺序和并发读时序重建缓存一致性解释。"
              }
            ]
          },
          {
            id: "redis-persistence-blocking-tradeoff",
            title: "Redis 持久化、阻塞与治理取舍",
            summary: "能解释 Redis 持久化方式、阻塞风险和线上治理取舍。",
            excerpt: "高频追问会把 RDB/AOF、阻塞、大 key/hot key 和线上恢复放在一起考。",
            keywords: ["redis", "rdb", "aof", "持久化", "阻塞", "bigkey", "hotkey"],
            misconception: "容易只背 Redis 快，却讲不清持久化和阻塞为什么会影响线上表现。",
            importance: "core",
            coverage: "medium",
            diagnosticQuestion: "系统生成诊断题：Redis 的 RDB 和 AOF 分别怎么取舍？为什么线上还会担心阻塞和数据丢失？",
            retryQuestion: "先只回答：RDB 和 AOF 的核心取舍是什么？",
            stretchQuestion: "如果继续追问大 key、阻塞和恢复窗口，你会怎么展开？",
            checkQuestion: "现在重新讲一遍：Redis 的快和持久化代价为什么经常一起出现？",
            remediationHint: "先把『速度 / 持久化 / 阻塞』放到同一个取舍框架里。",
            provenance: {
              type: "system-generated",
              company: "",
              label: "系统生成诊断题"
            },
            javaGuideSources: [
              "docs/database/redis/redis-persistence.md",
              "docs/database/redis/redis-questions-02.md",
              "docs/database/redis/redis-common-blocking-problems-summary.md"
            ],
            remediationAssets: [
              {
                id: "redis-persistence-card",
                title: "Redis 持久化与阻塞治理补强卡",
                kind: "note",
                durationMinutes: 15,
                description: "把 RDB/AOF、阻塞来源和恢复窗口整理成一张取舍卡。"
              }
            ]
          }
        ]
      },
      {
        id: "spring-runtime",
        title: "Spring 运行时与事务边界",
        tier: "core",
        items: [
          {
            id: "spring-transaction-boundary",
            title: "Spring 事务边界与失效场景",
            summary: "能解释事务代理生效边界、自调用失效和传播行为的含义。",
            excerpt: "服务链路面经常追问 @Transactional 为什么有时候不生效。",
            keywords: ["spring", "transactional", "代理", "传播", "自调用", "事务"],
            misconception: "容易只记住自调用会失效，但讲不清本质是代理边界。",
            importance: "core",
            coverage: "medium",
            diagnosticQuestion:
              "系统生成诊断题：为什么同一个类里自调用一个标了 @Transactional 的方法，事务可能不生效？",
            retryQuestion: "先只回答：这个问题的根本原因为什么和代理边界有关？",
            stretchQuestion: "如果继续追问传播行为和异常回滚，你会怎么扩展？",
            checkQuestion: "现在重新讲一遍：事务失效到底是在哪一层失效的？",
            remediationHint: "把代理对象、生效入口和传播行为放在同一个视角讲。",
            provenance: {
              type: "system-generated",
              company: "",
              label: "系统生成诊断题"
            },
            javaGuideSources: [
              "docs/system-design/framework/spring/spring-transaction.md"
            ],
            remediationAssets: [
              {
                id: "spring-tx-card",
                title: "Spring 事务边界补强卡",
                kind: "note",
                durationMinutes: 15,
                description: "围绕代理、自调用、传播行为补齐事务失效解释链路。"
              }
            ]
          },
          {
            id: "spring-ioc-aop-proxy-chain",
            title: "IoC / AOP / 代理链路理解",
            summary: "能把 IoC、AOP、代理对象和运行时增强链路讲清楚。",
            excerpt: "这类题核心不是记概念，而是能不能把运行时代理链和业务方法联系起来。",
            keywords: ["spring", "ioc", "aop", "proxy", "bean", "增强", "代理链"],
            misconception: "容易背 IoC 和 AOP 的定义，但不会解释它们在运行时到底怎么接到业务方法上。",
            importance: "core",
            coverage: "medium",
            diagnosticQuestion: "系统生成诊断题：Spring 里的 IoC 和 AOP 最后是怎样落到运行时代理链路上的？",
            retryQuestion: "先只回答一个点：为什么说很多 Spring 能力最后都要落到代理对象上？",
            stretchQuestion: "如果继续追问 Bean 生命周期和增强链顺序，你会怎么补充？",
            checkQuestion: "现在重新讲一遍：IoC、AOP 和代理链为什么不能拆开理解？",
            remediationHint: "先从 Bean 管理，再到代理，再到增强切面，按顺序讲。",
            provenance: {
              type: "system-generated",
              company: "",
              label: "系统生成诊断题"
            },
            javaGuideSources: [
              "docs/system-design/framework/spring/ioc-and-aop.md"
            ],
            remediationAssets: [
              {
                id: "spring-ioc-aop-card",
                title: "IoC / AOP / 代理链补强卡",
                kind: "note",
                durationMinutes: 15,
                description: "围绕 Bean、代理、增强链重建一轮运行时解释。"
              }
            ]
          },
          {
            id: "spring-boot-auto-configuration-boundary",
            title: "Spring Boot 自动装配边界",
            summary: "能解释自动装配为什么生效、在哪里接入、边界在哪里。",
            excerpt: "高频追问会从 @SpringBootApplication、条件装配和 starter 机制切入。",
            keywords: ["spring boot", "auto configuration", "starter", "条件装配", "enableautoconfiguration"],
            misconception: "容易把自动装配讲成“帮你自动扫包”，但说不清真正的接入边界。",
            importance: "secondary",
            coverage: "medium",
            diagnosticQuestion: "系统生成诊断题：Spring Boot 自动装配为什么会生效？它到底是在哪一层把配置接进来的？",
            retryQuestion: "先只回答：自动装配和普通组件扫描的区别是什么？",
            stretchQuestion: "如果让你手写一个 starter，你会怎么解释自动装配链路？",
            checkQuestion: "现在重新讲一遍：自动装配不是“魔法”，而是哪些机制串起来的？",
            remediationHint: "先分清组件扫描、条件装配和 starter，再讲接入点。",
            provenance: {
              type: "system-generated",
              company: "",
              label: "系统生成诊断题"
            },
            javaGuideSources: [
              "docs/system-design/framework/spring/spring-boot-auto-assembly-principles.md"
            ],
            remediationAssets: [
              {
                id: "spring-auto-config-card",
                title: "Spring Boot 自动装配补强卡",
                kind: "note",
                durationMinutes: 15,
                description: "围绕条件装配、starter 和接入链路重建自动装配理解。"
              }
            ]
          }
        ]
      },
      {
        id: "service-reliability",
        title: "服务可靠性与高可用",
        tier: "core",
        items: [
          {
            id: "timeout-retry-idempotency-boundary",
            title: "超时 / 重试 / 幂等边界",
            summary: "能解释超时、重试、幂等和副作用控制之间的边界。",
            excerpt: "高频场景题会把超时、重试风暴、幂等约束和补偿一起问。",
            keywords: ["timeout", "retry", "幂等", "副作用", "风暴", "补偿"],
            misconception: "容易把‘支持重试’和‘天然幂等’混为一谈，也容易只背策略不讲副作用。",
            importance: "core",
            coverage: "high",
            diagnosticQuestion: "系统生成诊断题：为什么一个接口支持超时重试，不等于它天然就安全？幂等到底在哪一层解决问题？",
            retryQuestion: "先只回答一个点：为什么没有幂等保护时，重试会放大风险？",
            stretchQuestion: "如果继续追问指数退避和重试风暴，你会怎么解释？",
            checkQuestion: "现在重新讲一遍：超时、重试、幂等这三件事的先后边界是什么？",
            remediationHint: "先讲副作用，再讲重试，再讲幂等保护点。",
            provenance: {
              type: "system-generated",
              company: "",
              label: "系统生成诊断题"
            },
            javaGuideSources: [
              "docs/high-availability/timeout-and-retry.md",
              "docs/high-availability/idempotency.md"
            ],
            remediationAssets: [
              {
                id: "retry-idempotency-card",
                title: "超时 / 重试 / 幂等补强卡",
                kind: "note",
                durationMinutes: 15,
                description: "围绕副作用、重试和幂等保护点重建一轮解释。"
              }
            ]
          },
          {
            id: "fallback-circuit-breaker-degradation",
            title: "降级 / 熔断 / 隔离策略取舍",
            summary: "能把降级、熔断、隔离、雪崩和恢复策略讲成一套取舍。",
            excerpt: "场景题通常不是问定义，而是问在高压链路里你会怎么保核心路径。",
            keywords: ["降级", "熔断", "隔离", "雪崩", "线程池", "fallback", "bulkhead"],
            misconception: "容易把降级、熔断和限流混成一个词，不会说各自作用边界。",
            importance: "core",
            coverage: "medium",
            diagnosticQuestion: "系统生成诊断题：如果下游服务开始超时、线程池积压，你会怎么在降级、熔断和隔离之间做取舍？",
            retryQuestion: "先只回答：熔断和降级解决的是同一类问题吗？",
            stretchQuestion: "如果继续追问半开状态和恢复探测，你会怎么解释避免二次雪崩？",
            checkQuestion: "现在重讲一遍：降级、熔断、隔离分别是在哪一层保系统？",
            remediationHint: "先按『保功能 / 断链路 / 隔资源』三层来讲。",
            provenance: {
              type: "system-generated",
              company: "",
              label: "系统生成诊断题"
            },
            javaGuideSources: [
              "docs/high-availability/fallback-and-circuit-breaker.md"
            ],
            remediationAssets: [
              {
                id: "fallback-circuit-card",
                title: "降级 / 熔断 / 隔离补强卡",
                kind: "note",
                durationMinutes: 15,
                description: "围绕核心路径保护、熔断状态机和资源隔离做一轮系统化复述。"
              }
            ]
          }
        ]
      },
      {
        id: "messaging-async",
        title: "消息队列与异步链路",
        tier: "core",
        items: [
          {
            id: "kafka-partition-group-rebalance",
            title: "Kafka 分区、消费者组与 Rebalance",
            summary: "能解释 Kafka 的分区、消费者组、Rebalance 和吞吐/顺序性边界。",
            excerpt: "真实面试常从 Partition、Consumer Group、ISR、Rebalance 切入。",
            keywords: ["kafka", "partition", "consumer group", "rebalance", "offset", "isr"],
            misconception: "容易只背术语，不会说清分区提升了什么，又牺牲了什么。",
            importance: "core",
            coverage: "medium",
            diagnosticQuestion: "系统生成诊断题：Kafka 为什么要用 Partition 和 Consumer Group？Rebalance 到底会带来什么代价？",
            retryQuestion: "先只回答一个点：分区为什么能提升吞吐，但又会影响顺序性？",
            stretchQuestion: "如果继续追问 ISR、offset 提交和 rebalance 抖动，你会怎么展开？",
            checkQuestion: "现在重新讲一遍：Kafka 的 Partition / Group / Rebalance 是一套什么交换？",
            remediationHint: "先把吞吐、顺序、扩展、抖动四个词拉到一张图上。",
            provenance: {
              type: "system-generated",
              company: "",
              label: "系统生成诊断题"
            },
            javaGuideSources: [
              "docs/high-performance/message-queue/kafka-questions-01.md"
            ],
            remediationAssets: [
              {
                id: "kafka-rebalance-card",
                title: "Kafka Partition / Group / Rebalance 补强卡",
                kind: "note",
                durationMinutes: 15,
                description: "围绕吞吐、顺序、消费者组和 rebalance 代价整理一轮解释。"
              }
            ]
          },
          {
            id: "mq-reliability-ordering-idempotent-consume",
            title: "MQ 可靠性 / 顺序性 / 消费幂等",
            summary: "能从业务链路角度解释 MQ 的可靠性、顺序性和重复消费处理边界。",
            excerpt: "实际场景题更关心消息丢失、乱序、重复消费和业务补偿如何平衡。",
            keywords: ["mq", "可靠性", "顺序", "重复消费", "幂等", "补偿", "at least once"],
            misconception: "容易把消息队列讲成‘解耦神器’，但说不清一旦失败谁来兜底。",
            importance: "core",
            coverage: "medium",
            diagnosticQuestion: "系统生成诊断题：消息队列引入后，为什么你还必须考虑消息丢失、乱序和重复消费？",
            retryQuestion: "先只回答一个点：为什么‘至少一次投递’会把幂等消费问题暴露出来？",
            stretchQuestion: "如果继续追问顺序性与吞吐量冲突，你会怎么解释？",
            checkQuestion: "现在重讲一遍：MQ 的可靠性、顺序性和幂等消费为什么经常要一起权衡？",
            remediationHint: "先讲投递语义，再讲消费侧副作用，最后讲补偿。",
            provenance: {
              type: "system-generated",
              company: "",
              label: "系统生成诊断题"
            },
            javaGuideSources: [
              "docs/high-performance/message-queue/message-queue.md",
              "docs/high-performance/message-queue/kafka-questions-01.md"
            ],
            remediationAssets: [
              {
                id: "mq-reliability-card",
                title: "MQ 可靠性 / 顺序性 / 幂等消费补强卡",
                kind: "note",
                durationMinutes: 15,
                description: "围绕投递语义、顺序保证和消费幂等做一轮权衡式回答。"
              }
            ]
          }
        ]
      },
      {
        id: "jvm-basics",
        title: "JVM 高频基础",
        tier: "secondary",
        items: [
          {
            id: "jvm-memory-gc-basics",
            title: "JVM 内存区域与 GC 基本过程",
            summary: "能解释常见内存区域、对象分配与 GC 回收的大致过程。",
            excerpt: "高频问题集中在堆、栈、方法区、年轻代/老年代和常见回收路径。",
            keywords: ["jvm", "heap", "stack", "gc", "young", "old", "memory area"],
            misconception: "容易背出堆栈方法区，但说不清对象分配和 GC 过程是怎么串起来的。",
            importance: "secondary",
            coverage: "medium",
            diagnosticQuestion: "系统生成诊断题：JVM 里对象一般是怎么分配的？GC 为什么要分代？",
            retryQuestion: "先只回答：为什么年轻代和老年代要分开处理？",
            stretchQuestion: "如果继续追问一次 Minor GC 对对象生命周期意味着什么，你会怎么说？",
            checkQuestion: "现在重新讲一遍：内存区域和 GC 过程为什么不能拆开理解？",
            remediationHint: "先画出对象分配和回收路径，再讲分代原因。",
            provenance: {
              type: "system-generated",
              company: "",
              label: "系统生成诊断题"
            },
            javaGuideSources: [
              "docs/java/jvm/memory-area.md",
              "docs/java/jvm/jvm-garbage-collection.md"
            ],
            remediationAssets: [
              {
                id: "jvm-gc-card",
                title: "JVM 内存 / GC 高频补强卡",
                kind: "note",
                durationMinutes: 15,
                description: "围绕对象分配、分代和回收链路重建一轮 JVM 基础回答。"
              }
            ]
          },
          {
            id: "jvm-classloading-parent-delegation",
            title: "类加载与双亲委派边界",
            summary: "能解释类加载过程、双亲委派和它们解决的边界问题。",
            excerpt: "面试里常问：类是怎么被加载的，双亲委派为什么重要，又在哪些场景会打破。",
            keywords: ["classloader", "双亲委派", "加载", "初始化", "linking", "bootstrap"],
            misconception: "容易只背双亲委派流程，不会说它为什么有价值。",
            importance: "secondary",
            coverage: "medium",
            diagnosticQuestion: "系统生成诊断题：Java 的双亲委派到底在保护什么？类加载过程里又是在哪一步生效的？",
            retryQuestion: "先只回答：为什么不直接让应用类加载器自己优先加载所有类？",
            stretchQuestion: "如果继续追问 SPI 或容器打破双亲委派的场景，你会怎么补充？",
            checkQuestion: "现在重新讲一遍：类加载过程和双亲委派为什么经常一起问？",
            remediationHint: "先按加载、连接、初始化，再落到双亲委派的保护目标。",
            provenance: {
              type: "system-generated",
              company: "",
              label: "系统生成诊断题"
            },
            javaGuideSources: [
              "docs/java/jvm/class-loading-process.md",
              "docs/java/jvm/classloader.md"
            ],
            remediationAssets: [
              {
                id: "classloading-card",
                title: "类加载与双亲委派补强卡",
                kind: "note",
                durationMinutes: 15,
                description: "围绕类加载步骤、委派链和保护目标重建一轮 JVM 回答。"
              }
            ]
          }
        ]
      },
      {
        id: "network-http-tcp",
        title: "HTTP / TCP 高频基础",
        tier: "secondary",
        items: [
          {
            id: "tcp-handshake-backlog-timewait",
            title: "TCP 三次握手 / 四次挥手 / backlog / TIME_WAIT",
            summary: "能解释 TCP 建连与断连关键状态，以及 backlog/TIME_WAIT 的服务端含义。",
            excerpt: "高频问题不只问三次握手，还会追问半连接队列、全连接队列、TIME_WAIT 和 overflow。",
            keywords: ["tcp", "握手", "挥手", "time_wait", "backlog", "syn queue", "accept queue"],
            misconception: "容易背流程图，却说不清为什么需要三次握手、TIME_WAIT 有什么代价、backlog 为什么会爆。",
            importance: "secondary",
            coverage: "medium",
            diagnosticQuestion: "系统生成诊断题：TCP 为什么要三次握手？如果服务端 backlog 满了、TIME_WAIT 很多，又分别意味着什么？",
            retryQuestion: "先只回答：为什么建立连接不能只握两次手？",
            stretchQuestion: "如果继续追问半连接队列、全连接队列和 TIME_WAIT，你会怎么补充？",
            checkQuestion: "现在重讲一遍：握手、backlog 和 TIME_WAIT 为什么都和服务端稳定性相关？",
            remediationHint: "先讲建连闭环，再讲队列，再讲 TIME_WAIT 代价。",
            provenance: {
              type: "system-generated",
              company: "",
              label: "系统生成诊断题"
            },
            javaGuideSources: [
              "docs/cs-basics/network/tcp-connection-and-disconnection.md"
            ],
            remediationAssets: [
              {
                id: "tcp-handshake-card",
                title: "TCP 握手 / backlog / TIME_WAIT 补强卡",
                kind: "note",
                durationMinutes: 15,
                description: "围绕握手闭环、队列和 TIME_WAIT 的服务端含义做一轮解释重建。"
              }
            ]
          },
          {
            id: "http-keepalive-status-idempotent-semantics",
            title: "HTTP 状态语义 / Keep-Alive / 幂等边界",
            summary: "能把 HTTP 状态语义、长连接和接口幂等边界联系起来解释。",
            excerpt: "高频追问往往不是死背状态码，而是问哪些状态说明了重试、缓存或接口语义问题。",
            keywords: ["http", "status code", "keep-alive", "idempotent", "retry", "语义"],
            misconception: "容易把状态码背成表，但不会把 Keep-Alive、重试和接口语义边界联系起来。",
            importance: "secondary",
            coverage: "medium",
            diagnosticQuestion: "系统生成诊断题：HTTP 里为什么说 GET 天然更接近幂等，而一个 POST 接口要支持重试就必须额外设计？",
            retryQuestion: "先只回答：HTTP 方法语义和业务幂等为什么不是一回事？",
            stretchQuestion: "如果继续追问 Keep-Alive 和状态码对客户端重试策略的影响，你会怎么说？",
            checkQuestion: "现在重新讲一遍：HTTP 语义、状态码和重试边界为什么经常绑在一起问？",
            remediationHint: "先分开讲协议语义和业务副作用，再把它们接起来。",
            provenance: {
              type: "system-generated",
              company: "",
              label: "系统生成诊断题"
            },
            javaGuideSources: [
              "docs/cs-basics/network/http-status-codes.md",
              "docs/cs-basics/network/http1.0-vs-http1.1.md",
              "docs/high-availability/idempotency.md"
            ],
            remediationAssets: [
              {
                id: "http-idempotency-card",
                title: "HTTP 语义 / Keep-Alive / 幂等补强卡",
                kind: "note",
                durationMinutes: 15,
                description: "围绕协议语义、重试边界和业务副作用做一轮解释重建。"
              }
            ]
          }
        ]
      }
    ]
  },
  {
    id: siblingBaselinePackId,
    title: "Java 后端通用面试包",
    shortTitle: "Java 后端通用",
    description:
      "用于验证跨 baseline 重投影时的保守性，保留部分重叠能力项，并加入更偏通用后端的服务与网络能力。",
    targetRole: "Java 后端工程师",
    targetLabel: "Java 后端通用面试",
    flagship: false,
    exposed: false,
    packSummary: "这是一个更通用的 Java 后端对照包，用来保守地重投影已有能力记忆。",
    domains: [
      {
        id: "java-concurrency",
        title: "Java 并发与可见性",
        tier: "core",
        items: [
          {
            id: "aqs-acquire-release",
            title: "AQS acquire/release 语义",
            summary: "能解释 AQS 独占获取与释放中的排队、阻塞和唤醒。",
            excerpt: "通用 Java 并发面里依然常见。",
            keywords: ["aqs", "acquire", "release", "state", "队列"],
            misconception: "容易只背框架名词，不会讲主链路。",
            importance: "core",
            coverage: "high",
            diagnosticQuestion: "系统生成诊断题：AQS 的 acquire/release 主链路你会怎么解释？",
            retryQuestion: "先只讲获取失败后的排队与阻塞。",
            stretchQuestion: "如果继续追问共享模式，你会怎么区分？",
            checkQuestion: "现在用自己的话重讲一遍：为什么它是同步器底座？",
            remediationHint: "把 state、入队和唤醒三步连起来。",
            provenance: {
              type: "system-generated",
              company: "",
              label: "系统生成诊断题"
            },
            javaGuideSources: [
              "docs/java/concurrent/aqs.md"
            ],
            remediationAssets: [
              {
                id: "aqs-fix-card",
                title: "AQS acquire/release 15 分钟补强卡",
                kind: "note",
                durationMinutes: 15,
                description: "按 state、入队、park/unpark 重新搭一遍解释链路。"
              }
            ]
          }
        ]
      },
      {
        id: "database-core",
        title: "MySQL 事务、索引与日志",
        tier: "core",
        items: [
          {
            id: "mvcc-repeatable-read",
            title: "MVCC 与 Repeatable Read 边界",
            summary: "能解释 RR 下 MVCC 的作用和边界。",
            excerpt: "通用后端面里也高频出现。",
            keywords: ["mvcc", "repeatable read", "幻读", "快照"],
            misconception: "容易混淆快照读、当前读与幻读边界。",
            importance: "core",
            coverage: "high",
            diagnosticQuestion: "系统生成诊断题：MVCC 已经有了，为什么 RR 还要谈锁边界？",
            retryQuestion: "先只回答 MVCC 在 RR 里主要解决了什么。",
            stretchQuestion: "如果再追问幻读和 gap lock，你会怎么回答？",
            checkQuestion: "重新讲一遍：MVCC 解决了什么，没解决什么？",
            remediationHint: "把快照读和当前读分开再解释。",
            provenance: {
              type: "system-generated",
              company: "",
              label: "系统生成诊断题"
            },
            javaGuideSources: [
              "docs/database/mysql/mysql-questions-01.md",
              "docs/database/mysql/innodb-implementation-of-mvcc.md"
            ],
            remediationAssets: [
              {
                id: "mvcc-card",
                title: "MVCC / RR 边界补强卡",
                kind: "note",
                durationMinutes: 15,
                description: "围绕快照读、当前读、幻读和 next-key lock 重讲一遍。"
              }
            ]
          },
          {
            id: "mysql-redo-undo-binlog-chain",
            title: "MySQL 三大日志职责与恢复链路",
            summary: "能讲清 redo、undo、binlog 分别负责什么。",
            excerpt: "这是通用后端数据库面也经常出现的链路问题。",
            keywords: ["redo log", "undo log", "binlog", "恢复", "回滚", "复制"],
            misconception: "容易只记名字，不会讲链路。",
            importance: "secondary",
            coverage: "medium",
            diagnosticQuestion: "系统生成诊断题：MySQL 为什么需要 redo、undo、binlog 三类日志？",
            retryQuestion: "先只回答：redo log 主要解决什么问题？",
            stretchQuestion: "如果继续追问两阶段提交和复制一致性，你会怎么补充？",
            checkQuestion: "现在重新讲一遍：三大日志分别负责哪一类问题？",
            remediationHint: "先按恢复、回滚、复制三类职责来解释。",
            provenance: {
              type: "system-generated",
              company: "",
              label: "系统生成诊断题"
            },
            javaGuideSources: [
              "docs/database/mysql/mysql-logs.md"
            ],
            remediationAssets: [
              {
                id: "mysql-logs-card",
                title: "MySQL 三大日志补强卡",
                kind: "note",
                durationMinutes: 15,
                description: "按恢复、回滚、复制三个职责重建一轮 MySQL 日志解释。"
              }
            ]
          }
        ]
      },
      {
        id: "spring-runtime",
        title: "Spring 运行时与事务边界",
        tier: "core",
        items: [
          {
            id: "spring-transaction-boundary",
            title: "Spring 事务边界与失效场景",
            summary: "能解释事务代理边界和失效场景。",
            excerpt: "通用后端面经里经常追问事务为什么不生效。",
            keywords: ["spring", "transactional", "代理", "自调用", "事务"],
            misconception: "容易只背现象，不会说本质。",
            importance: "core",
            coverage: "medium",
            diagnosticQuestion: "系统生成诊断题：为什么 @Transactional 在某些调用链里会失效？",
            retryQuestion: "先只回答：这个问题本质上为什么和代理有关？",
            stretchQuestion: "如果继续追问传播行为和异常回滚，你会怎么展开？",
            checkQuestion: "现在重新讲一遍：事务边界到底是在哪一层生效的？",
            remediationHint: "先抓代理边界，再扩展传播行为。",
            provenance: {
              type: "system-generated",
              company: "",
              label: "系统生成诊断题"
            },
            javaGuideSources: [
              "docs/system-design/framework/spring/spring-transaction.md"
            ],
            remediationAssets: [
              {
                id: "spring-tx-card",
                title: "Spring 事务边界补强卡",
                kind: "note",
                durationMinutes: 15,
                description: "围绕代理边界与事务失效重建一轮解释。"
              }
            ]
          }
        ]
      },
      {
        id: "service-reliability",
        title: "服务可靠性与高可用",
        tier: "core",
        items: [
          {
            id: "timeout-retry-idempotency-boundary",
            title: "超时 / 重试 / 幂等边界",
            summary: "能解释重试、副作用和幂等保护之间的边界。",
            excerpt: "通用后端场景题里很高频。",
            keywords: ["timeout", "retry", "幂等", "副作用", "补偿"],
            misconception: "容易把支持重试理解成天然安全。",
            importance: "core",
            coverage: "medium",
            diagnosticQuestion: "系统生成诊断题：为什么一个接口支持重试，不等于它天然就安全？",
            retryQuestion: "先只回答：为什么没有幂等保护时，重试会放大风险？",
            stretchQuestion: "如果继续追问补偿和退避，你会怎么补充？",
            checkQuestion: "现在重新讲一遍：重试和幂等的边界是什么？",
            remediationHint: "先讲副作用，再讲重试，再讲幂等。",
            provenance: {
              type: "system-generated",
              company: "",
              label: "系统生成诊断题"
            },
            javaGuideSources: [
              "docs/high-availability/timeout-and-retry.md",
              "docs/high-availability/idempotency.md"
            ],
            remediationAssets: [
              {
                id: "retry-idempotency-card",
                title: "超时 / 重试 / 幂等补强卡",
                kind: "note",
                durationMinutes: 15,
                description: "围绕副作用、重试和幂等保护点快速重建解释。"
              }
            ]
          }
        ]
      },
      {
        id: "network-http-tcp",
        title: "HTTP / TCP 高频基础",
        tier: "secondary",
        items: [
          {
            id: "tcp-handshake-backlog-timewait",
            title: "TCP 三次握手 / 四次挥手 / backlog / TIME_WAIT",
            summary: "能解释 TCP 建连与断连关键状态，以及 backlog/TIME_WAIT 的服务端含义。",
            excerpt: "这是通用后端面里最常见的网络高频追问之一。",
            keywords: ["tcp", "握手", "挥手", "time_wait", "backlog", "syn"],
            misconception: "容易只背流程，不会联系服务端容量与稳定性。",
            importance: "secondary",
            coverage: "medium",
            diagnosticQuestion: "系统生成诊断题：TCP 为什么要三次握手？如果 backlog 满了或者 TIME_WAIT 很多，分别意味着什么？",
            retryQuestion: "先只回答：为什么建立连接不能只握两次手？",
            stretchQuestion: "如果继续追问半连接队列和全连接队列，你会怎么说？",
            checkQuestion: "现在重新讲一遍：握手、队列和 TIME_WAIT 为什么都和服务端稳定性相关？",
            remediationHint: "先讲握手闭环，再讲 backlog，再讲 TIME_WAIT。",
            provenance: {
              type: "system-generated",
              company: "",
              label: "系统生成诊断题"
            },
            javaGuideSources: [
              "docs/cs-basics/network/tcp-connection-and-disconnection.md"
            ],
            remediationAssets: [
              {
                id: "tcp-handshake-card",
                title: "TCP 握手 / backlog / TIME_WAIT 补强卡",
                kind: "note",
                durationMinutes: 15,
                description: "围绕握手、连接队列和 TIME_WAIT 做一轮网络基础解释重建。"
              }
            ]
          }
        ]
      }
    ]
  }
];

function flattenPack(pack) {
  return {
    ...pack,
    abilityItems: pack.domains.flatMap((domain) =>
      domain.items.map((item) => ({
        ...item,
        abilityItemId: item.id,
        domainId: domain.id,
        domainTitle: domain.title,
        packId: pack.id,
        packTitle: pack.title
      }))
    )
  };
}

export function listBaselinePacks() {
  return baselinePacks
    .filter((pack) => pack.exposed !== false)
    .map((pack) => ({
      id: pack.id,
      title: pack.title,
      shortTitle: pack.shortTitle,
      description: pack.description,
      targetRole: pack.targetRole,
      targetLabel: pack.targetLabel,
      flagship: pack.flagship
    }));
}

export function getBaselinePackById(packId = defaultBaselinePackId) {
  const pack = baselinePacks.find((item) => item.id === packId);
  if (!pack) {
    throw new Error("Unknown baseline pack.");
  }

  return flattenPack(pack);
}

export function createBaselinePackSource(pack) {
  return createSource({
    kind: "baseline-pack",
    title: pack.title,
    content: `${pack.description}\n\n${pack.packSummary}`,
    metadata: {
      baselinePackId: pack.id,
      targetRole: pack.targetRole
    }
  });
}

export function createBaselinePackDecomposition(pack) {
  const domainLookup = Object.fromEntries(pack.domains.map((domain) => [domain.id, domain.title]));
  const javaGuideSourceClusters = collectPackGuideSources(pack);
  return {
    summary: {
      sourceTitle: pack.title,
      keyThemes: pack.domains.slice(0, 3).map((domain) => domain.title),
      framing: `${pack.packSummary} 当前先从 ${pack.domains
        .slice(0, 3)
        .map((domain) => domain.title)
        .join("、")} 这些能力域切入。`,
      overviewDomains: pack.domains.map((domain) => ({
        id: domain.id,
        title: domain.title,
        tier: domain.tier || "core",
        itemCount: domain.items.length,
        sampleItems: domain.items.slice(0, 3).map((item) => item.title)
      })),
      javaGuideSourceClusters
    },
    concepts: pack.abilityItems.map((item) => ({
      ...item,
      abilityDomainId: item.domainId,
      abilityDomainTitle: item.domainTitle || domainLookup[item.domainId] || "通用能力",
      provenanceLabel: item.provenance?.label || "系统生成诊断题",
      interviewQuestion:
        item.provenance?.type === "interview-report"
          ? {
              company: item.provenance.company,
              stage: item.provenance.stage || "",
              label: item.provenance.label
            }
          : null,
      javaGuideSources: (item.javaGuideSources || []).map(normalizeJavaGuideSource),
      remediationMaterials: item.remediationAssets || []
    }))
  };
}
