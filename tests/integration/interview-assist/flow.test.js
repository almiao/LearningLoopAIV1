import test from "node:test";
import assert from "node:assert/strict";
import { postEventStream, postJson, withInterviewAssistServices } from "../../helpers/interview-assist-services.js";

test("interview assist realtime session keeps voice demo optional and still accepts uploads", async (t) => {
  await withInterviewAssistServices(t, async ({ aiBaseUrl }) => {
    const session = await postJson(`${aiBaseUrl}/api/interview-assist/realtime-session`, {
      selfRole: "interviewer",
      mode: "assist_candidate",
      resumeText: "",
    });

    assert.ok(session.sessionId);
    assert.equal(session.selfRole, "interviewer");
    assert.equal(session.mode, "assist_candidate");
    assert.equal(session.voiceDemoUploaded, false);

    const formData = new FormData();
    formData.append("file", new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/wav" }), "demo.wav");
    const response = await fetch(
      `${aiBaseUrl}/api/interview-assist/voice-demo?sessionId=${encodeURIComponent(session.sessionId)}`,
      { method: "POST", body: formData },
    );
    const uploaded = await response.json();

    assert.equal(response.ok, true);
    assert.equal(uploaded.voiceDemoUploaded, true);
    assert.equal(uploaded.status, "ready");
  }, { aiPort: 18200 });
});

test("interview assist answer stream returns markdown core before detail for candidate assist", async (t) => {
  await withInterviewAssistServices(t, async ({ aiBaseUrl }) => {
    const session = await postJson(`${aiBaseUrl}/api/interview-assist/session`, {
      targetRole: "java-backend",
      sessionMode: "realtime_interview_assist",
    });

    const events = await postEventStream(`${aiBaseUrl}/api/interview-assist/answer-stream`, {
      sessionId: session.sessionId,
      questionText: "你项目里如何做限流？",
      questionEndedAt: Date.now(),
    });

    const coreDoneIndex = events.findIndex((item) => item.event === "core_done");
    const firstDetailIndex = events.findIndex((item) => item.event === "detail_delta");
    const answerReady = events.find((item) => item.event === "answer_ready")?.data;

    assert.ok(coreDoneIndex >= 0);
    assert.ok(firstDetailIndex > coreDoneIndex);
    assert.match(answerReady.coreMarkdown, /\*\*核心点：\*\*/);
    assert.match(answerReady.detailMarkdown, /项目经验/);
    assert.match(answerReady.answerMarkdown, /核心点/);
    assert.equal(answerReady.frameworkPoints, undefined);
    assert.equal(answerReady.detailBlocks, undefined);
  }, { aiPort: 18201 });
});

test("interview assist answer stream carries recent context into pronoun follow-up", async (t) => {
  await withInterviewAssistServices(t, async ({ aiBaseUrl }) => {
    const session = await postJson(`${aiBaseUrl}/api/interview-assist/session`, {
      targetRole: "java-backend",
      sessionMode: "realtime_interview_assist",
    });

    await postEventStream(`${aiBaseUrl}/api/interview-assist/answer-stream`, {
      sessionId: session.sessionId,
      questionText: "AQS 是什么？",
      questionEndedAt: Date.now(),
    });

    const events = await postEventStream(`${aiBaseUrl}/api/interview-assist/answer-stream`, {
      sessionId: session.sessionId,
      questionText: "它怎么解决并发问题？",
      questionEndedAt: Date.now(),
    });
    const answerReady = events.find((item) => item.event === "answer_ready")?.data;

    assert.equal(answerReady.contextTurnsUsed, 1);
    assert.match(answerReady.coreMarkdown, /AQS/);
    assert.doesNotMatch(answerReady.coreMarkdown, /它/);
  }, { aiPort: 18202 });
});

test("interview assist answer stream caps recent context at two turns", async (t) => {
  await withInterviewAssistServices(t, async ({ aiBaseUrl }) => {
    const session = await postJson(`${aiBaseUrl}/api/interview-assist/session`, {
      targetRole: "java-backend",
      sessionMode: "realtime_interview_assist",
    });

    for (const questionText of ["第一轮问题", "第二轮问题", "第三轮问题"]) {
      await postEventStream(`${aiBaseUrl}/api/interview-assist/answer-stream`, {
        sessionId: session.sessionId,
        questionText,
        questionEndedAt: Date.now(),
      });
    }

    const events = await postEventStream(`${aiBaseUrl}/api/interview-assist/answer-stream`, {
      sessionId: session.sessionId,
      questionText: "继续展开一下",
      questionEndedAt: Date.now(),
    });
    const answerReady = events.find((item) => item.event === "answer_ready")?.data;

    assert.equal(answerReady.contextTurnsUsed, 2);
    assert.equal(answerReady.contextTurns.length, 2);
    assert.deepEqual(answerReady.contextTurns.map((item) => item.questionText), ["第二轮问题", "第三轮问题"]);
  }, { aiPort: 18203 });
});

test("interview assist realtime websocket no longer requires voice demo before connecting", async (t) => {
  await withInterviewAssistServices(t, async ({ aiBaseUrl }) => {
    const session = await postJson(`${aiBaseUrl}/api/interview-assist/realtime-session`, {
      selfRole: "interviewer",
      mode: "assist_candidate",
      resumeText: "",
    });

    const ws = new WebSocket(`ws://127.0.0.1:${aiBaseUrl.split(":").at(-1)}/ws/interview-assist/${session.sessionId}`);
    const firstMessage = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for websocket error.")), 10000);
      ws.onmessage = (event) => {
        clearTimeout(timer);
        resolve(JSON.parse(event.data));
      };
      ws.onerror = () => {};
    });

    assert.notEqual(firstMessage.data?.error, "voice demo required before realtime session.");
    assert.ok(["agent_ready", "error"].includes(firstMessage.event));
    ws.close();
  }, { aiPort: 18210 });
});
