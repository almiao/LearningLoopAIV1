import { createSource } from "../material/material-model.js";

export const defaultBaselinePackId = "bigtech-java-backend";
export const siblingBaselinePackId = "java-backend-generalist";

const baselinePacks = [
  {
    id: defaultBaselinePackId,
    title: "大厂 Java 后端面试包",
    shortTitle: "大厂 Java 后端",
    description:
      "面向大厂 Java 后端面试准备，重点覆盖并发、事务、缓存一致性、Spring 链路和 JVM 可见性。",
    targetRole: "Java 后端工程师",
    targetLabel: "大厂 Java 后端面试",
    flagship: true,
    packSummary:
      "先用高频真实面试问法摸清你当前离大厂 Java 后端面试通过线还有多远，再把弱点接回补强资料。",
    domains: [
      {
        id: "java-concurrency",
        title: "Java 并发",
        items: [
          {
            id: "aqs-acquire-release",
            title: "AQS acquire/release 语义",
            summary: "能解释 AQS 在独占获取与释放时如何驱动排队、阻塞和唤醒。",
            excerpt: "面试官通常会继续追问 AQS、ReentrantLock 与 state / 队列变化的关系。",
            keywords: ["aqs", "acquire", "release", "state", "reentrantlock", "队列", "唤醒"],
            misconception: "容易只背 AQS 是模板方法框架，却讲不清 acquire/release 主链路。",
            importance: "core",
            coverage: "high",
            diagnosticQuestion:
              "这是某位候选人在字节并发面里被追问的版本：如果 ReentrantLock 建在 AQS 之上，独占 acquire/release 这条主链路你会怎么解释？",
            retryQuestion: "先只讲一个点：获取失败后，线程为什么会排队和阻塞？",
            stretchQuestion: "如果再追问共享模式或 condition，你会怎么补充边界差异？",
            checkQuestion: "现在用你自己的话重讲一遍：AQS 为什么是同步器底座，不是一把锁？",
            remediationHint: "回到 state、CLH 队列和唤醒链路，先把 acquire/release 机制串起来。",
            provenance: {
              type: "interview-report",
              company: "字节",
              label: "字节并发面经原题"
            },
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
            summary: "能把缓存可见性、happens-before 和 volatile / 锁语义联系起来。",
            excerpt: "大厂追问里常见的是把硬件缓存和 Java 内存模型联系起来解释。",
            keywords: ["jmm", "volatile", "happens-before", "缓存", "可见性", "锁"],
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
            remediationAssets: [
              {
                id: "jmm-visibility-card",
                title: "JMM 可见性补强卡",
                kind: "note",
                durationMinutes: 15,
                description: "把缓存一致性、volatile 语义和 happens-before 放到同一条解释链里。"
              }
            ]
          }
        ]
      },
      {
        id: "database-transactions",
        title: "数据库事务",
        items: [
          {
            id: "mvcc-repeatable-read",
            title: "MVCC 与 Repeatable Read 边界",
            summary: "能解释 RR 下 MVCC 解决了什么，没解决什么，以及幻读边界。",
            excerpt: "面试常追问 RR 为什么还要 next-key lock，以及 MVCC 版本视图的作用。",
            keywords: ["mvcc", "repeatable read", "幻读", "next-key", "版本", "快照"],
            misconception: "容易把 MVCC、锁和隔离级别混成一团，只背结论不说边界。",
            importance: "core",
            coverage: "high",
            diagnosticQuestion:
              "这是某位候选人在阿里数据库面里被追问的版本：MySQL Repeatable Read 已经有 MVCC 了，为什么还会谈 next-key lock？",
            retryQuestion: "先只回答：MVCC 在 RR 里主要解决了什么问题？",
            stretchQuestion: "如果面试官继续追问幻读和当前读 / 快照读，你会怎么区分？",
            checkQuestion: "现在用自己的话说一遍：MVCC 解决了什么，为什么还不等于所有并发问题都没了？",
            remediationHint: "把快照读、当前读、版本视图和幻读边界拆开讲。",
            provenance: {
              type: "interview-report",
              company: "阿里",
              label: "阿里数据库面经原题"
            },
            remediationAssets: [
              {
                id: "mvcc-card",
                title: "MVCC / RR 边界补强卡",
                kind: "note",
                durationMinutes: 15,
                description: "围绕快照读、当前读、幻读和 next-key lock 重讲一遍。"
              }
            ]
          }
        ]
      },
      {
        id: "cache-consistency",
        title: "缓存一致性",
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
            remediationAssets: [
              {
                id: "redis-consistency-card",
                title: "Redis 一致性窗口补强卡",
                kind: "note",
                durationMinutes: 15,
                description: "按更新顺序和并发读时序重建缓存一致性解释。"
              }
            ]
          }
        ]
      },
      {
        id: "spring-service",
        title: "Spring 服务链路",
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
            remediationAssets: [
              {
                id: "spring-tx-card",
                title: "Spring 事务边界补强卡",
                kind: "note",
                durationMinutes: 15,
                description: "围绕代理、自调用、传播行为补齐事务失效解释链路。"
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
      "用于验证跨 baseline 重投影时的保守性，保留部分重叠能力项并加入通用后端稳定性项。",
    targetRole: "Java 后端工程师",
    targetLabel: "Java 后端通用面试",
    flagship: false,
    packSummary: "这是一个更通用的 Java 后端对照包，用来保守地重投影已有能力记忆。",
    domains: [
      {
        id: "java-concurrency",
        title: "Java 并发",
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
        id: "database-transactions",
        title: "数据库事务",
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
            remediationAssets: [
              {
                id: "mvcc-card",
                title: "MVCC / RR 边界补强卡",
                kind: "note",
                durationMinutes: 15,
                description: "围绕快照读、当前读、幻读和 next-key lock 重讲一遍。"
              }
            ]
          }
        ]
      },
      {
        id: "service-reliability",
        title: "服务稳定性",
        items: [
          {
            id: "idempotency-retry-boundary",
            title: "幂等与重试边界",
            summary: "能解释后端服务里幂等键、重复请求和补偿策略的边界。",
            excerpt: "通用后端面里常把重试、幂等和分布式副作用放在一起追问。",
            keywords: ["幂等", "重试", "重复请求", "补偿", "去重"],
            misconception: "容易把『可重试』和『天然幂等』混为一谈。",
            importance: "core",
            coverage: "medium",
            diagnosticQuestion: "系统生成诊断题：为什么一个接口支持重试，不等于它天然就幂等？",
            retryQuestion: "先只回答：重复请求为什么可能导致副作用重复执行？",
            stretchQuestion: "如果再追问幂等键和补偿逻辑，你会怎么展开？",
            checkQuestion: "现在重新讲一遍：重试与幂等的边界是什么？",
            remediationHint: "把重复请求、副作用和去重机制放在同一个因果链里讲。",
            provenance: {
              type: "system-generated",
              company: "",
              label: "系统生成诊断题"
            },
            remediationAssets: [
              {
                id: "idempotency-card",
                title: "幂等与重试边界补强卡",
                kind: "note",
                durationMinutes: 15,
                description: "围绕重复请求、副作用和去重机制快速重建边界理解。"
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
  return baselinePacks.map((pack) => ({
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
  return {
    summary: {
      sourceTitle: pack.title,
      keyThemes: pack.domains.slice(0, 3).map((domain) => domain.title),
      framing: `${pack.packSummary} 当前先从 ${pack.domains
        .slice(0, 3)
        .map((domain) => domain.title)
        .join("、")} 这些能力域切入。`
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
      remediationMaterials: item.remediationAssets || []
    }))
  };
}
