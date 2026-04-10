import test from "node:test";
import assert from "node:assert/strict";
import { buildChatTimeline } from "../../../frontend/lib/chat-transcript.js";

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

test("chat transcript groups tutor feedback and the next tutor question into one assistant block", () => {
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
      action: "advance",
      conceptId: "mvcc",
      conceptTitle: "MVCC 与 Repeatable Read 边界",
      content: "这一点你已经抓到主要方向了，我们先往下走，别在这里卡太久。",
      timestamp: 11
    },
    {
      role: "tutor",
      kind: "question",
      action: "probe",
      conceptId: "mysql-index",
      conceptTitle: "MySQL 索引设计与查询计划",
      content: "一个查询为什么明明建了索引，执行计划里还是没用上？",
      timestamp: 12
    }
  ]);

  assert.equal(timeline.length, 2);
  assert.equal(timeline[1].role, "assistant");
  assert.match(timeline[1].body, /抓到主要方向/);
  assert.match(timeline[1].followUpQuestion, /执行计划里还是没用上/);
  assert.match(timeline[1].topicShiftLabel, /MySQL 索引设计与查询计划/);
});
