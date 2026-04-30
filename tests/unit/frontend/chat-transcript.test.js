import test from "node:test";
import assert from "node:assert/strict";
import { buildChatTimeline } from "../../../src/view/chat-transcript.js";

test("chat transcript keeps workspace switches visible instead of rendering them as user messages", () => {
  const timeline = buildChatTimeline([
    {
      role: "tutor",
      kind: "question",
      conceptId: "aqs",
      conceptTitle: "AQS acquire/release 语义",
      content: "如果 ReentrantLock 建在 AQS 之上，独占 acquire/release 这条主链路你会怎么解释？",
      timestamp: 1
    },
    {
      role: "system",
      kind: "workspace",
      action: "focus-domain",
      conceptId: "tcp",
      conceptTitle: "TCP 三次握手 / 四次挥手 / backlog / TIME_WAIT",
      content: "focus-domain:TCP 三次握手 / 四次挥手 / backlog / TIME_WAIT",
      timestamp: 2
    },
    {
      role: "tutor",
      kind: "question",
      conceptId: "tcp",
      conceptTitle: "TCP 三次握手 / 四次挥手 / backlog / TIME_WAIT",
      content: "讲一下",
      timestamp: 3
    }
  ]);

  assert.equal(timeline.length, 3);
  assert.equal(timeline[1].type, "event");
  assert.match(timeline[1].label, /切换到该主题/);
  assert.equal(timeline[2].role, "assistant");
});

test("chat transcript keeps tutor feedback and the next tutor question as separate messages", () => {
  const timeline = buildChatTimeline([
    {
      role: "learner",
      kind: "answer",
      conceptId: "mvcc",
      conceptTitle: "MVCC 与 Repeatable Read 边界",
      content: "因为 mvcc 只是能快照读，无法处理间隙插入引起的幻读",
      timestamp: 10
    },
    {
      role: "tutor",
      kind: "feedback",
      action: "check",
      conceptId: "mvcc",
      conceptTitle: "MVCC 与 Repeatable Read 边界",
      content: "这一点你已经抓到主要方向了，我们先往下走，别在这里卡太久。",
      timestamp: 11
    },
    {
      role: "tutor",
      kind: "question",
      action: "probe",
      conceptId: "mvcc",
      conceptTitle: "MVCC 与 Repeatable Read 边界",
      checkpointId: "mvcc-cp-1",
      checkpointStatement: "为什么当前读还要 next-key lock",
      content: "为什么当前读还要 next-key lock？",
      timestamp: 12
    }
  ]);

  assert.equal(timeline.length, 4);
  assert.equal(timeline[1].role, "assistant");
  assert.match(timeline[1].body, /抓到主要方向/);
  assert.equal(timeline[1].followUpQuestion, "");
  assert.equal(timeline[1].topicShiftLabel, "");
  assert.equal(timeline[2].type, "event");
  assert.match(timeline[2].label, /进入子项/);
  assert.equal(timeline[3].role, "assistant");
  assert.match(timeline[3].body, /next-key lock/);
});

test("chat transcript does not merge feedback with the next question when the concept switches", () => {
  const timeline = buildChatTimeline([
    {
      role: "learner",
      kind: "control",
      action: "advance",
      conceptId: "mvcc",
      conceptTitle: "MVCC 与 Repeatable Read 边界",
      content: "下一题",
      timestamp: 10
    },
    {
      role: "tutor",
      kind: "feedback",
      action: "advance",
      conceptId: "mvcc",
      conceptTitle: "MVCC 与 Repeatable Read 边界",
      content: "好，这个点先不继续卡住你了，我们直接进下一题。",
      timestamp: 11
    },
    {
      role: "tutor",
      kind: "question",
      action: "probe",
      conceptId: "mysql-index",
      conceptTitle: "MySQL 索引设计与查询计划",
      checkpointId: "mysql-index-cp-1",
      checkpointStatement: "索引为什么没命中",
      content: "一个查询为什么明明建了索引，执行计划里还是没用上？",
      timestamp: 12
    }
  ]);

  assert.equal(timeline.length, 4);
  assert.equal(timeline[1].role, "assistant");
  assert.equal(timeline[1].conceptTitle, "MVCC 与 Repeatable Read 边界");
  assert.equal(timeline[1].followUpQuestion, "");
  assert.equal(timeline[2].type, "event");
  assert.equal(timeline[3].role, "assistant");
  assert.equal(timeline[3].conceptTitle, "MySQL 索引设计与查询计划");
});

test("chat transcript emits checkpoint transition only when checkpoint changes", () => {
  const timeline = buildChatTimeline([
    {
      role: "tutor",
      kind: "question",
      action: "probe",
      conceptId: "cdn-role-1",
      conceptTitle: "CDN核心价值与定位",
      checkpointId: "cdn-role-1-cp-1",
      checkpointStatement: "区分静态资源与动态请求",
      content: "CDN最适合加速以下哪类内容？",
      timestamp: 1
    },
    {
      role: "tutor",
      kind: "feedback",
      action: "deepen",
      conceptId: "cdn-role-1",
      conceptTitle: "CDN核心价值与定位",
      content: "答得对。",
      timestamp: 2
    },
    {
      role: "tutor",
      kind: "question",
      action: "probe",
      conceptId: "cdn-role-1",
      conceptTitle: "CDN核心价值与定位",
      checkpointId: "cdn-role-1-cp-1",
      checkpointStatement: "区分静态资源与动态请求",
      content: "那数据库查询结果适合吗？",
      timestamp: 3
    },
    {
      role: "tutor",
      kind: "question",
      action: "probe",
      conceptId: "cdn-role-1",
      conceptTitle: "CDN核心价值与定位",
      checkpointId: "cdn-role-1-cp-2",
      checkpointStatement: "区分CDN与全站加速",
      content: "一个新闻网站既有图片又有评论，哪种说法正确？",
      timestamp: 4
    }
  ]);

  const eventLabels = timeline.filter((entry) => entry.type === "event").map((entry) => entry.label);
  assert.equal(eventLabels.length, 2);
  assert.match(eventLabels[0], /区分静态资源与动态请求/);
  assert.match(eventLabels[1], /区分CDN与全站加速/);
});

test("chat transcript keeps reply markdown body and candidate follow-up visible", () => {
  const timeline = buildChatTimeline([
    {
      role: "learner",
      kind: "answer",
      conceptId: "fallback",
      conceptTitle: "降级 / 熔断 / 隔离策略取舍",
      content: "能把这套策略系统讲一下吗？",
      timestamp: 20
    },
    {
      role: "tutor",
      kind: "feedback",
      action: "teach",
      conceptId: "fallback",
      conceptTitle: "降级 / 熔断 / 隔离策略取舍",
      content:
        "好，我先把这套策略收成一条主线。\n\n先看隔离，它负责把问题关在局部资源池里，避免一个下游把全站线程和连接都拖死。\n\n如果故障已经持续扩散，再用熔断快速失败，把无效等待切断；最后再通过降级保核心路径，把非关键能力先让出去。",
      candidateCoachingStep: "现在你用自己的话重讲一遍：隔离、熔断、降级各自先保护哪一层？",
      timestamp: 21
    }
  ]);

  assert.equal(timeline.length, 2);
  assert.equal(timeline[1].role, "assistant");
  assert.match(timeline[1].body, /这套策略收成一条主线/);
  assert.equal(timeline[1].teachingParagraphs.length, 0);
  assert.equal(timeline[1].takeaway, "");
  assert.match(timeline[1].candidateFollowUpQuestion, /隔离、熔断、降级/);
});

test("chat transcript hides takeaway for in-progress verify turns", () => {
  const timeline = buildChatTimeline([
    {
      role: "learner",
      kind: "answer",
      conceptId: "retry",
      conceptTitle: "超时 / 重试 / 幂等边界",
      content: "我知道这几个词，但链路还没串起来。",
      timestamp: 30
    },
    {
      role: "tutor",
      kind: "feedback",
      action: "check",
      conceptId: "retry",
      conceptTitle: "超时 / 重试 / 幂等边界",
      content: "你已经抓到几个关键概念了，我们先把支付场景里的重复扣款风险说清楚。",
      takeaway: "支持重试只是机制，安全需要幂等性保障。",
      candidateCoachingStep: "为什么支付场景里重试会放大副作用？",
      timestamp: 31
    }
  ]);

  assert.equal(timeline[1].takeaway, "");
});
