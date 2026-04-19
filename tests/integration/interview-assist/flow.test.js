import test from "node:test";
import assert from "node:assert/strict";
import {
  postEventStream,
  postJson,
  withInterviewAssistServices,
} from "../../helpers/interview-assist-services.js";

function findEvents(events, eventName) {
  return events.filter((item) => item.event === eventName);
}

test("interview assist streams full framework before any detail expansion", async (t) => {
  await withInterviewAssistServices(t, async ({ agentBaseUrl }) => {
    const session = await postJson(`${agentBaseUrl}/api/interview-assist/session`, {
      targetRole: "java-backend",
      sessionMode: "realtime_interview_assist",
    });

    assert.ok(session.sessionId);
    assert.ok(["mock", "livekit"].includes(session.transportMode));

    const events = await postEventStream(`${agentBaseUrl}/api/interview-assist/answer-stream`, {
      sessionId: session.sessionId,
      questionText: "你项目里如何做限流？",
      questionEndedAt: Date.now(),
    });

    const frameworkDeltas = findEvents(events, "framework_delta");
    const frameworkDone = findEvents(events, "framework_done");
    const detailDeltas = findEvents(events, "detail_delta");
    const answerReady = findEvents(events, "answer_ready");

    assert.equal(frameworkDeltas.length >= 3, true);
    assert.equal(frameworkDone.length, 1);
    assert.equal(detailDeltas.length > 0, true);
    assert.equal(answerReady.length, 1);

    const frameworkDoneIndex = events.findIndex((item) => item.event === "framework_done");
    const firstDetailIndex = events.findIndex((item) => item.event === "detail_delta");
    assert.ok(frameworkDoneIndex >= 0);
    assert.ok(firstDetailIndex > frameworkDoneIndex);

    const payload = answerReady[0].data;
    assert.equal(Array.isArray(payload.frameworkPoints), true);
    assert.equal(payload.frameworkPoints.length, 3);
    assert.equal(Array.isArray(payload.detailBlocks), true);
    assert.equal(payload.detailBlocks.length, 3);
    assert.equal(payload.contextTurnsUsed, 0);

    const rendered = await postJson(`${agentBaseUrl}/api/interview-assist/first-screen-rendered`, {
      sessionId: session.sessionId,
      turnId: payload.turnId,
      renderedAt: Date.now(),
    });
    assert.equal(rendered.ok, true);
  });
});

test("interview assist reuses only the prior 1-2 turns as simple context", async (t) => {
  await withInterviewAssistServices(t, async ({ aiBaseUrl }) => {
    const session = await postJson(`${aiBaseUrl}/api/interview-assist/session`, {
      targetRole: "java-backend",
      sessionMode: "realtime_interview_assist",
    });

    const first = await postEventStream(`${aiBaseUrl}/api/interview-assist/answer-stream`, {
      sessionId: session.sessionId,
      questionText: "AQS 是什么？",
      questionEndedAt: Date.now(),
    });
    const second = await postEventStream(`${aiBaseUrl}/api/interview-assist/answer-stream`, {
      sessionId: session.sessionId,
      questionText: "为什么这样设计？",
      questionEndedAt: Date.now(),
    });

    const firstReady = findEvents(first, "answer_ready")[0]?.data;
    const secondReady = findEvents(second, "answer_ready")[0]?.data;

    assert.equal(firstReady.contextTurnsUsed, 0);
    assert.equal(secondReady.contextTurnsUsed, 1);
    assert.equal(secondReady.frameworkPoints.length, 3);
    assert.equal(secondReady.detailBlocks.length, 3);
  });
});
