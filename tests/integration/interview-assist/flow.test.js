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
  });
});

test("interview assist answer stream still returns framework before detail for candidate assist", async (t) => {
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

    const frameworkDoneIndex = events.findIndex((item) => item.event === "framework_done");
    const firstDetailIndex = events.findIndex((item) => item.event === "detail_delta");
    const answerReady = events.find((item) => item.event === "answer_ready")?.data;

    assert.ok(frameworkDoneIndex >= 0);
    assert.ok(firstDetailIndex > frameworkDoneIndex);
    assert.equal(answerReady.frameworkPoints.length, 3);
    assert.equal(answerReady.detailBlocks.length, 3);
  });
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
