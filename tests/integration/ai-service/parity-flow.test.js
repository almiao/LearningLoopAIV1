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
    assert.equal(taught.latestFeedback.turnResolution.mode, "stay");
    assert.ok(taught.currentProbe.length > 0);
    assert.equal(taught.currentQuestionMeta?.phase, "teach-back");

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

    const summarized = await postJson(`${aiBaseUrl}/api/interview/answer`, {
      sessionId: advanced.sessionId,
      answer: "总结一下",
      burdenSignal: "normal",
      interactionPreference: "balanced"
    });

    assert.equal(summarized.latestFeedback.action, "summarize");
    assert.equal(summarized.latestFeedback.turnResolution.mode, "stop");
    assert.equal(summarized.currentProbe, "");
    assert.match(summarized.latestFeedback.explanation, /标准答案：/);
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
