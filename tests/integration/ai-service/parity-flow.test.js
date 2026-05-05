import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "../../helpers/local-env.js";
import {
  createBaselinePackDecomposition,
  createBaselinePackSource,
  getBaselinePackById
} from "../../../src/baseline/baseline-packs.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function createMemoryProfile(id = `ai_profile_${Date.now()}`) {
  return {
    id,
    sessionsStarted: 0,
    abilityItems: {}
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForJson(url, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return response.json();
      }
    } catch {}
    await sleep(400);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function startProcess(command, args, options = {}) {
  return spawn(command, args, {
    stdio: "ignore",
    ...options
  });
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.detail || data.error || "Request failed");
  }
  return data;
}

function parseSseEvent(rawEvent) {
  const lines = String(rawEvent || "").split(/\r?\n/);
  let event = "message";
  const dataLines = [];
  for (const line of lines) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }
  return {
    event,
    data: dataLines.length ? JSON.parse(dataLines.join("\n")) : {},
  };
}

async function postEventStream(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  assert.equal(response.ok, true);
  assert.ok(response.body);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      events.push(parseSseEvent(rawEvent));
      boundary = buffer.indexOf("\n\n");
    }
  }

  if (buffer.trim()) {
    events.push(parseSseEvent(buffer));
  }
  return events;
}

async function withAiService(t, port, run) {
  const localEnv = loadLocalEnv(root);
  const aiBaseUrl = `http://127.0.0.1:${port}`;
  const ai = startProcess(
    "python3",
    ["-m", "uvicorn", "app.main:app", "--port", String(port), "--app-dir", "ai-service"],
    {
      cwd: root,
      env: {
        ...process.env,
        ...localEnv,
        APP_ENV: "test",
        LLAI_LLM_ENABLED: "false",
        LLAI_ENABLE_AI_SERVICE_HEURISTIC_TEST_DOUBLE: "1",
      }
    }
  );

  t.after(() => {
    ai.kill("SIGTERM");
  });

  await waitForJson(`${aiBaseUrl}/api/health`);
  return run(aiBaseUrl);
}

function baselinePayload({ memoryProfileId, interactionPreference = "balanced" } = {}) {
  const baselinePack = getBaselinePackById("bigtech-java-backend");
  return {
    userId: "ai-service-user",
    source: createBaselinePackSource(baselinePack),
    decomposition: createBaselinePackDecomposition(baselinePack),
    targetBaseline: {
      id: baselinePack.id,
      title: baselinePack.title,
      targetRole: baselinePack.targetRole,
      flagship: baselinePack.flagship
    },
    memoryProfile: createMemoryProfile(memoryProfileId),
    interactionPreference
  };
}

test("python ai-service supports teach, advance, and domain-scoped continuation", async (t) => {
  await withAiService(t, 18100, async (aiBaseUrl) => {
    const session = await postJson(`${aiBaseUrl}/api/interview/start-target`, baselinePayload());

    assert.ok(session.sessionId);
    assert.equal(session.currentQuestionMeta?.type, "provenance-backed");
    assert.ok(session.currentProbe.length > 0);

    const taught = await postJson(`${aiBaseUrl}/api/interview/answer`, {
      sessionId: session.sessionId,
      answer: "讲一下",
      burdenSignal: "normal",
      interactionPreference: "balanced"
    });

    assert.equal(taught.latestFeedback.action, "teach");
    assert.equal(taught.latestFeedback.turnResolution.mode, "switch");
    assert.ok(taught.currentProbe.length > 0);
    assert.equal(taught.currentQuestionMeta?.phase, "diagnostic");

    const focused = await postJson(`${aiBaseUrl}/api/interview/focus-domain`, {
      sessionId: taught.sessionId,
      domainId: "network-http-tcp"
    });

    const advanced = await postJson(`${aiBaseUrl}/api/interview/answer`, {
      sessionId: focused.sessionId,
      answer: "下一题",
      burdenSignal: "normal",
      interactionPreference: "balanced"
    });

    assert.equal(advanced.latestFeedback.action, "advance");
    assert.equal(advanced.latestFeedback.turnResolution.mode, "switch");
    const nextConcept = (advanced.concepts || []).find((item) => item.id === advanced.currentConceptId);
    assert.equal(nextConcept?.abilityDomainId || nextConcept?.domainId, "network-http-tcp");
  });
});

test("python ai-service honors explicit structured intent for control actions", async (t) => {
  await withAiService(t, 18101, async (aiBaseUrl) => {
    const session = await postJson(`${aiBaseUrl}/api/interview/start-target`, baselinePayload({
      memoryProfileId: `ai_profile_${Date.now()}_intent`
    }));

    const taught = await postJson(`${aiBaseUrl}/api/interview/answer`, {
      sessionId: session.sessionId,
      answer: "保留用户原话，不再靠按钮文案精确匹配。",
      intent: "teach",
      burdenSignal: "normal",
      interactionPreference: "balanced"
    });

    assert.equal(taught.latestFeedback.action, "teach");
    assert.equal(taught.engagement.controlCount, 1);
    assert.equal(taught.engagement.teachRequestCount, 1);
  });
});

test("python ai-service answer stream emits backend-owned append-only turns before final snapshot", async (t) => {
  await withAiService(t, 18103, async (aiBaseUrl) => {
    const session = await postJson(`${aiBaseUrl}/api/interview/start-target`, baselinePayload({
      memoryProfileId: `ai_profile_${Date.now()}_stream_turns`
    }));

    const events = await postEventStream(`${aiBaseUrl}/api/interview/answer-stream`, {
      sessionId: session.sessionId,
      answer: "查看解析",
      intent: "teach",
      burdenSignal: "normal",
      interactionPreference: "balanced"
    });

    const turnAppends = events.filter((event) => event.event === "turn_append");
    const turnPatches = events.filter((event) => event.event === "turn_patch");
    assert.ok(turnAppends.length >= 4);
    assert.ok(turnPatches.length >= 1);
    assert.equal(turnAppends[0].data.turn.role, "learner");
    assert.equal(turnAppends[0].data.turn.kind, "control");
    assert.equal(turnAppends.at(-1).data.turn.kind, "question");
    const streamedFeedbackTurnId = turnAppends.find((event) => event.data.turn.kind === "feedback")?.data.turn.turnId;
    assert.equal(turnPatches[0].data.turnId, streamedFeedbackTurnId);

    const turnResultIndex = events.findIndex((event) => event.event === "turn_result");
    const lastMessageEventIndex = events.reduce((last, event, index) => (
      event.event === "turn_append" || event.event === "turn_patch" ? index : last
    ), -1);
    assert.ok(turnResultIndex > lastMessageEventIndex);
    const finalFeedback = events[turnResultIndex].data.turns.find((turn) => turn.kind === "feedback" && turn.action === "teach");
    assert.equal(finalFeedback?.turnId, streamedFeedbackTurnId);
    const streamedTurnIds = turnAppends.map((event) => event.data.turn.turnId).filter(Boolean);
    const finalTurnIds = events[turnResultIndex].data.turns.map((turn) => turn.turnId).filter(Boolean);
    const streamedIdsInFinalOrder = finalTurnIds.filter((turnId) => streamedTurnIds.includes(turnId));
    assert.deepEqual(streamedIdsInFinalOrder, streamedTurnIds);
    const processDetails = turnAppends
      .filter((event) => event.data.turn.kind === "process")
      .map((event) => event.data.turn.content);
    assert.ok(processDetails.some((content) => String(content).includes("正在同步到对话并准备下一步")));
    assert.ok(processDetails.some((content) => String(content).includes("讲解已追加")));
  });
});

test("python ai-service does not auto-revisit skipped concepts after a scoped domain is exhausted", async (t) => {
  await withAiService(t, 18102, async (aiBaseUrl) => {
    let session = await postJson(`${aiBaseUrl}/api/interview/start-target`, baselinePayload({
      memoryProfileId: `ai_profile_${Date.now()}_scope_stop`
    }));

    session = await postJson(`${aiBaseUrl}/api/interview/focus-domain`, {
      sessionId: session.sessionId,
      domainId: "service-reliability"
    });

    session = await postJson(`${aiBaseUrl}/api/interview/answer`, {
      sessionId: session.sessionId,
      answer: "下一题",
      intent: "advance",
      burdenSignal: "normal",
      interactionPreference: "balanced"
    });

    session = await postJson(`${aiBaseUrl}/api/interview/answer`, {
      sessionId: session.sessionId,
      answer: "下一题",
      intent: "advance",
      burdenSignal: "normal",
      interactionPreference: "balanced"
    });

    assert.equal(session.currentProbe, "");
    assert.equal(session.latestFeedback.turnResolution.mode, "stop");
    assert.equal(
      session.turns.some(
        (turn) =>
          turn.role === "tutor" &&
          turn.kind === "question" &&
          /我们回到刚才先放下的这个点/.test(turn.content || "")
      ),
      false
    );
  });
});
