import test from "node:test";
import assert from "node:assert/strict";
import { postEventStream, postJson, withLoopAssistAiService } from "../../helpers/loopassist-ai-service.js";

const seeds = [
  {
    seedId: "seed-1",
    rolePath: "软件开发 / Java",
    stage: "一面",
    company: "淘天",
    topics: ["并发", "项目"],
    baseQuestion: "AQS 的底层实现原理是什么？",
    followupAngles: ["如果线上出现线程阻塞，你会怎么定位？"],
    strongAnswerSignals: ["能讲队列和状态", "能结合项目"],
    qualityScore: 0.9,
  },
];

const planSeeds = [
  {
    seedId: "seed-project-cache",
    rolePath: "软件开发 / Java",
    stage: "一面",
    company: "通用",
    topics: ["项目", "分布式", "Redis"],
    baseQuestion: "你在项目里怎么处理 Redis 缓存一致性问题？",
    followupAngles: ["如果出现缓存击穿，你会怎么定位和兜底？"],
    strongAnswerSignals: ["能结合项目职责", "能讲一致性取舍", "能说明监控指标"],
    qualityScore: 0.9,
  },
  {
    seedId: "seed-java-basic",
    rolePath: "软件开发 / Java",
    stage: "一面",
    company: "通用",
    topics: ["Java", "基础"],
    baseQuestion: "HashMap 的底层结构是什么？",
    followupAngles: ["扩容时为什么可能影响性能？"],
    strongAnswerSignals: ["能讲数组链表红黑树"],
    qualityScore: 0.7,
  },
];

test("LoopAssist AI service starts, follows up, streams interviewer text, and reviews transcript", async (t) => {
  await withLoopAssistAiService(t, async ({ aiBaseUrl }) => {
    const session = await postJson(`${aiBaseUrl}/api/loopassist/start`, {
      scope: {
        role: "Java",
        round: "一面",
        topics: ["并发"],
        companyStyle: "淘天",
        interviewStyle: "probing",
        questionBudget: 6,
      },
      seeds,
    });

    assert.ok(session.sessionId);
    assert.equal(session.transcript.length, 1);
    assert.equal(session.transcript[0].role, "interviewer");
    assert.match(session.interviewerMessage.text, /AQS|项目|真实面经/);

    const events = await postEventStream(`${aiBaseUrl}/api/loopassist/answer-stream`, {
      sessionId: session.sessionId,
      answer: "AQS 通过 state 和 FIFO 队列管理同步状态，项目里我用它理解线程池阻塞问题。",
    });
    const streamSession = events.find((item) => item.event === "session")?.data;

    assert.ok(events.some((item) => item.event === "reply_delta"));
    assert.equal(streamSession.transcript.at(-1).role, "interviewer");
    assert.doesNotMatch(streamSession.interviewerMessage.text, /评分|诊断|readiness/i);

    const review = await postJson(`${aiBaseUrl}/api/loopassist/review`, {
      sessionId: session.sessionId,
    });
    assert.ok(review.review.readinessScore > 0);
    assert.ok(Array.isArray(review.review.capabilityDistribution));
    assert.ok(review.review.capabilityDistribution.length >= 1);
    assert.ok(Array.isArray(review.review.questionReviews));
    assert.ok(review.review.questionReviews.length >= 1);
    assert.match(review.review.questionReviews[0].questionText, /AQS|项目|介绍/);
    assert.ok(review.transcript.length >= 3);

    const questionReview = await postJson(`${aiBaseUrl}/api/loopassist/review-question`, {
      sessionId: session.sessionId,
      questionNumber: 1,
    });
    assert.equal(questionReview.questionReview.questionNumber, 1);
    assert.ok(["miss", "warn", "good"].includes(questionReview.questionReview.status));

    const reviewSummary = await postJson(`${aiBaseUrl}/api/loopassist/review-summary`, {
      sessionId: session.sessionId,
      questionReviews: [questionReview.questionReview],
    });
    assert.ok(reviewSummary.review.readinessScore > 0);
    assert.ok(Array.isArray(reviewSummary.review.capabilityDistribution));
  }, { aiPort: 18221 });
});

test("LoopAssist builds a visible LLM interview plan from resume, JD, and selected interview seeds", async (t) => {
  await withLoopAssistAiService(t, async ({ aiBaseUrl }) => {
    const session = await postJson(`${aiBaseUrl}/api/loopassist/start`, {
      scope: {
        role: "Java 后端",
        round: "一面",
        topics: ["项目", "分布式"],
        companyStyle: "通用",
        interviewStyle: "realistic",
        questionBudget: 3,
        resumeText: "候选人简历：负责订单系统 Redis 缓存、接口隔离和人审流程。",
        jobDescription: "岗位 JD：要求有分布式系统、缓存一致性、Java 服务治理经验。",
      },
      seeds: planSeeds,
    });

    assert.ok(session.interviewPlan);
    assert.match(session.interviewPlan.rationale, /真实面经|岗位|简历|题源/);
    assert.match(session.interviewPlan.sourceExplanation, /真实面经|简历|JD|岗位/);
    assert.equal(session.interviewPlan.stages[0].step, 1);
    assert.ok(session.interviewPlan.stages[0].sourcePreview);
    assert.equal(session.interviewPlan.stages[0].sourcePreview.seedId, "seed-project-cache");
    assert.match(session.interviewPlan.stages[0].sourcePreview.resumeText, /订单系统 Redis 缓存/);
    assert.ok(session.interviewPlan.stages[0].sourceContexts.some((context) => context.type === "user_resume"));
    assert.ok(session.interviewPlan.stages[0].sourceContexts.some((context) => context.type === "historical_interview"));
    assert.match(session.interviewerMessage.text, /Redis|缓存一致性|项目/);
    assert.equal(session.transcript[0].planStep, 1);

    const events = await postEventStream(`${aiBaseUrl}/api/loopassist/answer-stream`, {
      sessionId: session.sessionId,
      answer: "我主要负责订单系统的缓存改造，用 Redis 缓存热点数据，通过延迟双删和消息补偿降低数据库压力，并用监控观察命中率和不一致告警。",
    });
    const streamSession = events.find((item) => item.event === "session")?.data;

    assert.ok(streamSession);
    assert.ok(streamSession.interviewPlan);
    assert.equal(streamSession.interviewPlan.stages.length, 3);
    assert.match(streamSession.interviewerMessage.text, /HashMap|扩容|Java|基础|继续追一下/);
    assert.equal(streamSession.transcript.at(-1).planStep, 2);
  }, { aiPort: 18222 });
});

test("LoopAssist stops asking new questions after reaching the question budget", async (t) => {
  await withLoopAssistAiService(t, async ({ aiBaseUrl }) => {
    const session = await postJson(`${aiBaseUrl}/api/loopassist/start`, {
      scope: {
        role: "Java",
        round: "一面",
        topics: ["并发"],
        companyStyle: "淘天",
        interviewStyle: "probing",
        questionBudget: 1,
      },
      seeds,
    });

    assert.equal(session.remainingBudget, 0);
    assert.equal(session.completed, true);

    const events = await postEventStream(`${aiBaseUrl}/api/loopassist/answer-stream`, {
      sessionId: session.sessionId,
      answer: "我先说一下 HashMap 的数组、链表和红黑树结构。",
    });
    const streamSession = events.find((item) => item.event === "session")?.data;

    assert.ok(streamSession);
    assert.equal(streamSession.completed, true);
    assert.equal(streamSession.remainingBudget, 0);
    assert.equal(streamSession.interviewerMessage, null);
    assert.equal(streamSession.transcript.at(-1).role, "candidate");
    assert.equal(events.some((item) => item.event === "interviewer_message"), false);
  }, { aiPort: 18220 });
});
