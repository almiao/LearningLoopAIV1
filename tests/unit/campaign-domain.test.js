import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createCampaignGoalStore } from "../../src/goals/campaign-goal-store.js";
import { createReviewItemStore } from "../../src/ledger/review-item-store.js";
import {
  buildReadiness,
  createCampaignDomain,
  daysUntil,
  parseCampaignPath,
} from "../../bff/src/lib/campaign-domain.js";

async function withDomain(run, { proxy, now, loadLibraryItem } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "campaign-domain-"));
  const store = createCampaignGoalStore({ goalsDir: path.join(dir, "goals") });
  const reviewItemStore = createReviewItemStore({ ledgerDir: path.join(dir, "ledger") });
  const calls = [];
  const domain = createCampaignDomain({
    store,
    reviewItemStore,
    proxy: async (method, pathname, payload) => {
      calls.push({ method, pathname, payload });
      return proxy(method, pathname, payload);
    },
    loadUserProfile: async () => ({ resumeLibrary: null }),
    loadLibraryItem: loadLibraryItem || (() => null),
    now: now || (() => new Date("2026-06-12T00:00:00.000Z")),
  });
  try {
    await run({ store, reviewItemStore, domain, calls });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const decomposeProxy = async (_method, pathname) => {
  if (pathname === "/api/campaign/decompose-jd") {
    return {
      data: {
        topics: [
          { topic: "线程池参数与拒绝策略", importance: "core" },
          { topic: "Redis 缓存一致性", importance: "core" },
          { topic: "K8s 滚动发布", importance: "secondary" },
        ],
      },
      traceId: "trace-decompose",
    };
  }
  throw new Error(`unexpected proxy call: ${pathname}`);
};

test("campaign path helper parses detail, practice, rescue, debrief, archive", () => {
  assert.deepEqual(parseCampaignPath("/api/campaigns/c%201"), { id: "c 1", action: "detail", topicId: "" });
  assert.deepEqual(parseCampaignPath("/api/campaigns/c1/archive"), { id: "c1", action: "archive", topicId: "" });
  assert.deepEqual(parseCampaignPath("/api/campaigns/c1/debrief"), { id: "c1", action: "debrief", topicId: "" });
  assert.deepEqual(parseCampaignPath("/api/campaigns/c1/topics/topic-2/practice"), { id: "c1", action: "practice", topicId: "topic-2" });
  assert.deepEqual(parseCampaignPath("/api/campaigns/c1/topics/topic-2/rescue"), { id: "c1", action: "rescue", topicId: "topic-2" });
  assert.equal(parseCampaignPath("/api/campaigns"), null);
});

test("readiness reading derives coverage, weighted mastery, and ranked gaps", () => {
  const readiness = buildReadiness({
    deadline: "2026-06-15",
    topics: [
      { id: "t1", topic: "core 已扎实", importance: "core", coverage: "solid" },
      { id: "t2", topic: "core 还生疏", importance: "core", coverage: "shaky" },
      { id: "t3", topic: "core 没碰过", importance: "core", coverage: "uncovered" },
      { id: "t4", topic: "secondary 没碰过", importance: "secondary", coverage: "uncovered" },
    ],
  }, { now: new Date("2026-06-12T00:00:00.000Z") });

  assert.equal(readiness.daysLeft, 3);
  assert.equal(readiness.coverageRate, 0.5);
  // 加权达标度：solid core(2) / (2+2+2+1)
  assert.ok(Math.abs(readiness.masteryRate - 2 / 7) < 1e-9);
  // 缺口排序：core 未覆盖 > core 生疏 > secondary 未覆盖；扎实的不进缺口。
  assert.deepEqual(readiness.gaps.map((gap) => gap.topicId), ["t3", "t2", "t4"]);
  assert.equal(readiness.likelyToFail.length, 3);
  assert.ok(readiness.disclaimer.includes("不是录用预测"));
});

test("create decomposes the JD into a per-goal coverage checklist", async () => {
  await withDomain(
    async ({ domain, calls }) => {
      const { campaign } = await domain.create({
        company: "Acme",
        role: "Java 后端",
        deadline: "2026-06-20",
        jdText: "负责高并发服务端开发",
        userId: "u1",
      });

      assert.ok(campaign.topics.length >= 3);
      assert.equal(campaign.topics[0].coverage, "uncovered");
      assert.equal(campaign.readiness.coverageRate, 0);
      assert.equal(calls[0].pathname, "/api/campaign/decompose-jd");
      assert.equal(calls[0].payload.role, "Java 后端");
    },
    { proxy: decomposeProxy },
  );
});

test("create mixes resume claims, JD topics, and interview-report seeds by risk", async () => {
  await withDomain(
    async ({ domain, calls }) => {
      const { campaign } = await domain.create({
        role: "Java 后端",
        deadline: "2026-06-20",
        jdText: "要求 Redis、Kafka 和并发基础。",
        resumeText: "负责订单系统 Redis 缓存一致性。",
      });

      assert.equal(calls[0].pathname, "/api/campaign/decompose-jd");
      assert.equal(calls[1].pathname, "/api/campaign/decompose-resume");
      assert.equal(campaign.resume_text, "负责订单系统 Redis 缓存一致性。");
      assert.equal(campaign.topics[0].source, "resume-claim");
      assert.equal(campaign.topics[0].topic, "Redis 缓存一致性项目兜底");
      assert.ok(campaign.topics.some((topic) => topic.source === "jd-topic"));
      assert.ok(campaign.topics.some((topic) => topic.source === "report-seed"));
      assert.deepEqual(campaign.readiness.gaps.slice(0, 2).map((gap) => gap.source), ["resume-claim", "jd-topic"]);
    },
    {
      proxy: async (_method, pathname) => {
        if (pathname === "/api/campaign/decompose-jd") {
          return {
            data: {
              topics: [
                { topic: "Kafka 消息可靠性", importance: "core" },
                { topic: "Redis 缓存一致性项目兜底", importance: "core" },
              ],
            },
            traceId: "jd",
          };
        }
        if (pathname === "/api/campaign/decompose-resume") {
          return {
            data: {
              topics: [{ topic: "Redis 缓存一致性项目兜底", importance: "core" }],
            },
            traceId: "resume",
          };
        }
        throw new Error(`unexpected proxy call: ${pathname}`);
      },
    },
  );
});

test("create keeps AI themes on JD topics and gives resume/report seeds fallback themes", async () => {
  await withDomain(
    async ({ domain }) => {
      const { campaign } = await domain.create({
        role: "Java 后端",
        jdText: "要求 Redis、Kafka 和并发基础。",
        resumeText: "负责订单系统。",
      });

      const kafka = campaign.topics.find((topic) => topic.topic === "Kafka 消息可靠性");
      const noTheme = campaign.topics.find((topic) => topic.topic === "没标主题的 JD 点");
      const resume = campaign.topics.find((topic) => topic.source === "resume-claim");
      const report = campaign.topics.find((topic) => topic.source === "report-seed");

      assert.equal(kafka.theme, "分布式");
      assert.equal(noTheme.theme, ""); // JD 没标主题 → 留空 → 前端降级扁平
      assert.equal(resume.theme, "简历声称");
      if (report) {
        assert.equal(report.theme, "面经常考");
      }
    },
    {
      proxy: async (_method, pathname) => {
        if (pathname === "/api/campaign/decompose-jd") {
          return {
            data: {
              topics: [
                { topic: "Kafka 消息可靠性", importance: "core", theme: "分布式" },
                { topic: "没标主题的 JD 点", importance: "core" },
              ],
            },
            traceId: "jd",
          };
        }
        if (pathname === "/api/campaign/decompose-resume") {
          return { data: { topics: [{ topic: "订单系统设计", importance: "core" }] }, traceId: "resume" };
        }
        throw new Error(`unexpected proxy call: ${pathname}`);
      },
    },
  );
});

test("create from a library JD resolves the item, decomposes it, and adds report seeds", async () => {
  await withDomain(
    async ({ domain, calls }) => {
      const { campaign } = await domain.create({
        role: "Java 后端",
        spine: { source: "jd-library", libraryId: "jd-7" },
      });
      const paths = calls.map((c) => c.pathname);
      assert.ok(paths.includes("/api/campaign/decompose-jd"));
      // 库内 JD 全文被取出当作拆解输入。
      assert.equal(calls.find((c) => c.pathname === "/api/campaign/decompose-jd").payload.jdText, "库内 JD 全文：要求 Kafka 与并发。");
      assert.ok(campaign.topics.some((topic) => topic.source === "jd-topic"));
      assert.ok(campaign.topics.some((topic) => topic.source === "report-seed")); // JD 主轴自动叠面经种子
      assert.equal(campaign.jd_text, "库内 JD 全文：要求 Kafka 与并发。");
    },
    {
      loadLibraryItem: ({ kind, id }) => {
        assert.equal(kind, "jd");
        assert.equal(id, "jd-7");
        return { id, kind: "jd", text: "库内 JD 全文：要求 Kafka 与并发。" };
      },
      proxy: async (_method, pathname) => {
        if (pathname === "/api/campaign/decompose-jd") {
          return { data: { topics: [{ topic: "Kafka 可靠性", importance: "core", theme: "分布式" }] }, traceId: "jd" };
        }
        throw new Error(`unexpected proxy call: ${pathname}`);
      },
    },
  );
});

test("create from a library interview uses the interview decomposer and skips extra report seeds", async () => {
  await withDomain(
    async ({ domain, calls }) => {
      const { campaign } = await domain.create({
        role: "算法",
        spine: { source: "interview-library", libraryId: "iv-3" },
      });
      const paths = calls.map((c) => c.pathname);
      assert.ok(paths.includes("/api/campaign/decompose-interview"));
      assert.ok(!paths.includes("/api/campaign/decompose-jd")); // 面经主轴不走 JD 拆解
      // 面经话题落 report-seed 来源；面经本身即来源，不再另叠 loopassist 种子。
      assert.ok(campaign.topics.every((topic) => topic.source === "report-seed"));
      assert.equal(campaign.jd_text, "面经全文：1. RAG 怎么做？2. Transformer Decoder？");
    },
    {
      loadLibraryItem: ({ kind, id }) => {
        assert.equal(kind, "interview");
        assert.equal(id, "iv-3");
        return { id, kind: "interview", text: "面经全文：1. RAG 怎么做？2. Transformer Decoder？" };
      },
      proxy: async (_method, pathname) => {
        if (pathname === "/api/campaign/decompose-interview") {
          return { data: { topics: [{ topic: "RAG 检索精度", importance: "core", theme: "大模型" }] }, traceId: "iv" };
        }
        throw new Error(`unexpected proxy call: ${pathname}`);
      },
    },
  );
});

test("create throws when the picked library item is missing", async () => {
  await withDomain(
    async ({ domain }) => {
      await assert.rejects(
        domain.create({ role: "Java", spine: { source: "jd-library", libraryId: "gone" } }),
        /不存在/,
      );
    },
    {
      loadLibraryItem: () => null,
      proxy: async () => { throw new Error("should not proxy when item missing"); },
    },
  );
});

test("create rejects when no spine source is provided", async () => {
  await withDomain(
    async ({ domain }) => {
      await assert.rejects(domain.create({ role: "Java" }), /缺少冲刺来源/);
    },
    { proxy: async () => ({ data: { topics: [] } }) },
  );
});

test("passing a topic practice marks coverage solid without touching the ledger", async () => {
  await withDomain(
    async ({ domain, reviewItemStore }) => {
      const { campaign } = await domain.create({
        role: "后端",
        deadline: "2026-06-20",
        jdText: "JD 内容",
      });

      const result = await domain.answerTopicPractice({
        id: campaign.id,
        topicId: campaign.topics[0].id,
        question: "线程池核心参数怎么定？",
        answer: "按任务类型区分 IO/CPU 密集，结合队列与拒绝策略讲清楚边界与降级。",
      });

      assert.equal(result.passed, true);
      assert.equal(result.topic.coverage, "solid");
      assert.equal(result.reviewItem, null);
      assert.equal(result.rescue, null);
      assert.equal(result.campaign.readiness.coverageRate, 1 / result.campaign.topics.length);
      assert.equal((await reviewItemStore.list()).length, 0);
    },
    {
      proxy: async (_method, pathname) => {
        if (pathname === "/api/campaign/decompose-jd") {
          return { data: { topics: [{ topic: "线程池参数", importance: "core" }, { topic: "B", importance: "core" }, { topic: "C", importance: "core" }] }, traceId: "t" };
        }
        if (pathname === "/api/anchor-judge") {
          return { data: { verdict: "pass", hits: ["机制"], misses: [], confidence: 0.9 }, traceId: "t" };
        }
        throw new Error(`unexpected proxy call: ${pathname}`);
      },
    },
  );
});

test("failed topic practice writes a deadline-capped ledger item and defers rescue generation", async () => {
  await withDomain(
    async ({ domain, reviewItemStore, calls }) => {
      const { campaign } = await domain.create({
        role: "后端",
        deadline: "2026-06-13T00:00:00.000Z",
        jdText: "JD 内容",
      });

      const result = await domain.answerTopicPractice({
        id: campaign.id,
        topicId: campaign.topics[0].id,
        question: "Redis 缓存一致性怎么保证？",
        answer: "加锁就行。",
      });

      assert.equal(result.passed, false);
      assert.equal(result.topic.coverage, "shaky");
      assert.equal(result.rescue.pending, true);
      const items = await reviewItemStore.list();
      assert.equal(items.length, 1);
      assert.equal(items[0].handle, "Redis 缓存一致性");
      assert.ok(!calls.some((call) => call.pathname === "/api/loopassist/rescue-material"));
      // deadline 封顶：shaky 本来 +1 天 = 06-13，正好等于 deadline，不超过它。
      assert.ok(Date.parse(items[0].next_due_at) <= Date.parse("2026-06-13T00:00:00.000Z"));

      // 同话题再崩：更新已有项，不重复建。
      await domain.answerTopicPractice({
        id: campaign.id,
        topicId: campaign.topics[0].id,
        question: "再问一次缓存一致性？",
        answer: "还是加锁。",
      });
      assert.equal((await reviewItemStore.list()).length, 1);
    },
    {
      proxy: async (_method, pathname) => {
        if (pathname === "/api/campaign/decompose-jd") {
          return { data: { topics: [{ topic: "Redis 缓存一致性", importance: "core" }] }, traceId: "t" };
        }
        if (pathname === "/api/anchor-judge") {
          return { data: { verdict: "fail", hits: [], misses: ["旁路缓存模式", "双删与过期兜底"], confidence: 0.8 }, traceId: "t" };
        }
        throw new Error(`unexpected proxy call: ${pathname}`);
      },
    },
  );
});

test("topic rescue generates rescue material on demand and falls back when AI rescue fails", async () => {
  await withDomain(
    async ({ domain }) => {
      const { campaign } = await domain.create({
        role: "后端",
        deadline: "2026-06-20",
        jdText: "JD 内容",
      });

      const success = await domain.rescueTopicPractice({
        id: campaign.id,
        topicId: campaign.topics[0].id,
        question: "Redis 缓存一致性怎么保证？",
        hits: ["知道要控制并发"],
        misses: ["旁路缓存模式", "双删与过期兜底"],
      });
      assert.match(success.rescue.markdown, /先讲旁路缓存/);

      const fallback = await domain.rescueTopicPractice({
        id: campaign.id,
        topicId: campaign.topics[0].id,
        question: "Redis 缓存一致性怎么保证？",
        hits: [],
        misses: ["旁路缓存模式"],
      });
      assert.match(fallback.rescue.markdown, /补讲/);
      assert.equal(fallback.rescue.fallback, true);
    },
    {
      proxy: async (_method, pathname, payload) => {
        if (pathname === "/api/campaign/decompose-jd") {
          return { data: { topics: [{ topic: "Redis 缓存一致性", importance: "core" }] }, traceId: "t" };
        }
        if (pathname === "/api/loopassist/rescue-material") {
          if (Array.isArray(payload?.gap?.keyPoints) && payload.gap.keyPoints.length) {
            return { data: { markdown: "### Redis 缓存一致性 · 补讲\n\n先讲旁路缓存。" }, traceId: "t" };
          }
          throw new Error("rescue service slow");
        }
        throw new Error(`unexpected proxy call: ${pathname}`);
      },
    },
  );
});

test("debrief converts real interview misses into ledger items", async () => {
  await withDomain(
    async ({ domain, reviewItemStore }) => {
      const { campaign } = await domain.create({
        role: "后端",
        deadline: "2026-06-20",
        jdText: "JD 内容",
      });

      const { reviewItems } = await domain.debrief({
        id: campaign.id,
        misses: [
          { handle: "Kafka 重平衡的影响", question: "面试官问 rebalance 期间消息会怎样" },
          { handle: "  " },
        ],
      });

      assert.equal(reviewItems.length, 1);
      assert.equal(reviewItems[0].handle, "Kafka 重平衡的影响");
      assert.equal(reviewItems[0].state, "shaky");
      assert.equal((await reviewItemStore.list()).length, 1);
    },
    { proxy: decomposeProxy },
  );
});

test("archive ends the campaign but leaves ledger items alone", async () => {
  await withDomain(
    async ({ domain, store, reviewItemStore }) => {
      const { campaign } = await domain.create({
        role: "后端",
        deadline: "2026-06-20",
        jdText: "JD 内容",
      });
      await reviewItemStore.recordMiss({ handle: "残留薄弱点" });

      const { campaign: archived } = await domain.archive({ id: campaign.id, outcome: "offer" });
      assert.ok(archived.archived_at);
      assert.equal((await store.list()).length, 0);
      // 复习项是全局的，战役归档后留下、流回日常（留存桥 ⑧）。
      assert.equal((await reviewItemStore.list()).length, 1);
    },
    { proxy: decomposeProxy },
  );
});

test("daysUntil clamps at zero after the deadline", () => {
  assert.equal(daysUntil("2026-06-10", new Date("2026-06-12T00:00:00.000Z")), 0);
  assert.equal(daysUntil("2026-06-13T12:00:00.000Z", new Date("2026-06-12T00:00:00.000Z")), 2);
});

test("readiness without a deadline reports null daysLeft and still ranks gaps", () => {
  const readiness = buildReadiness({
    deadline: "",
    topics: [
      { id: "t1", topic: "core 没碰过", importance: "core", coverage: "uncovered" },
      { id: "t2", topic: "secondary 生疏", importance: "secondary", coverage: "shaky" },
    ],
  }, { now: new Date("2026-06-12T00:00:00.000Z") });

  assert.equal(readiness.daysLeft, null);
  assert.deepEqual(readiness.gaps.map((gap) => gap.topicId), ["t1", "t2"]);
});

test("campaign without a deadline writes uncapped ledger items on failure", async () => {
  await withDomain(
    async ({ domain, reviewItemStore }) => {
      const { campaign } = await domain.create({
        role: "后端",
        deadline: "",
        jdText: "JD 内容",
      });
      assert.equal(campaign.readiness.daysLeft, null);

      const result = await domain.answerTopicPractice({
        id: campaign.id,
        topicId: campaign.topics[0].id,
        question: "缓存一致性怎么保证？",
        answer: "加锁。",
      });
      assert.equal(result.passed, false);
      const items = await reviewItemStore.list();
      assert.equal(items.length, 1);
      // 无 deadline：shaky 正常 +1 天，不被封顶。
      assert.equal(items[0].next_due_at, "2026-06-13T00:00:00.000Z");
    },
    {
      proxy: async (_method, pathname) => {
        if (pathname === "/api/campaign/decompose-jd") {
          return { data: { topics: [{ topic: "Redis 缓存一致性", importance: "core" }] }, traceId: "t" };
        }
        if (pathname === "/api/anchor-judge") {
          return { data: { verdict: "fail", hits: [], misses: ["旁路缓存"], confidence: 0.8 }, traceId: "t" };
        }
        throw new Error(`unexpected proxy call: ${pathname}`);
      },
    },
  );
});
