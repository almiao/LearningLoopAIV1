import test from "node:test";
import assert from "node:assert/strict";
import { postEventStream, postJson, withInterviewAssistServices } from "../../helpers/interview-assist-services.js";

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

test("LoopAssist AI service starts, follows up, streams interviewer text, and reviews transcript", async (t) => {
  await withInterviewAssistServices(t, async ({ aiBaseUrl }) => {
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
    assert.ok(review.transcript.length >= 3);
  }, { aiPort: 18220 });
});
