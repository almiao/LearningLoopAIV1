import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createAppService } from "../../../src/server.js";
import { createHeuristicTutorIntelligence } from "../../../src/tutor/tutor-intelligence.js";
import {
  createBaselinePackDecomposition,
  createBaselinePackSource,
  getBaselinePackById
} from "../../../src/baseline/baseline-packs.js";
import { createMemoryProfile } from "../../../src/tutor/capability-memory.js";

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
  const child = spawn(command, args, {
    stdio: "ignore",
    ...options
  });
  return child;
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

test("python ai-service preserves core session semantics for teach, advance, and domain-scoped continuation", async (t) => {
  const aiPort = 18100;
  const aiBaseUrl = `http://127.0.0.1:${aiPort}`;
  const ai = startProcess(
    "python3",
    ["-m", "uvicorn", "app.main:app", "--port", String(aiPort), "--app-dir", "ai-service"],
    { cwd: "/Users/lee/IdeaProjects/LearningLoopAIV1" }
  );

  t.after(() => {
    ai.kill("SIGTERM");
  });

  await waitForJson(`${aiBaseUrl}/api/health`);

  const legacyService = createAppService({
    intelligence: createHeuristicTutorIntelligence()
  });

  const baselinePack = getBaselinePackById("bigtech-java-backend");
  const decomposition = createBaselinePackDecomposition(baselinePack);
  const source = createBaselinePackSource(baselinePack);
  const memoryProfileId = `parity_profile_${Date.now()}`;
  const memoryProfile = createMemoryProfile(memoryProfileId);

  const legacySession = await legacyService.startTargetSession({
    targetBaselineId: "bigtech-java-backend",
    interactionPreference: "balanced",
    memoryProfileId
  });

  const aiSession = await postJson(`${aiBaseUrl}/api/interview/start-target`, {
    userId: "parity-user",
    source,
    decomposition,
    targetBaseline: {
      id: baselinePack.id,
      title: baselinePack.title,
      targetRole: baselinePack.targetRole,
      flagship: baselinePack.flagship
    },
    memoryProfile,
    interactionPreference: "balanced"
  });

  assert.equal(aiSession.currentQuestionMeta?.type, legacySession.currentQuestionMeta?.type);
  assert.ok(aiSession.currentProbe.length > 0);

  const legacyTeach = await legacyService.answer({
    sessionId: legacySession.sessionId,
    answer: "讲一下",
    burdenSignal: "normal",
    interactionPreference: "balanced"
  });
  const aiTeach = await postJson(`${aiBaseUrl}/api/interview/answer`, {
    sessionId: aiSession.sessionId,
    answer: "讲一下",
    burdenSignal: "normal",
    interactionPreference: "balanced"
  });

  assert.equal(aiTeach.latestFeedback.action, legacyTeach.latestFeedback.action);
  assert.equal(aiTeach.latestFeedback.turnResolution.mode, "stay");
  assert.ok(aiTeach.currentProbe.length > 0);

  const focusedLegacy = await legacyService.focusDomain({
    sessionId: legacyTeach.sessionId,
    domainId: "network-http-tcp"
  });
  const focusedAi = await postJson(`${aiBaseUrl}/api/interview/focus-domain`, {
    sessionId: aiTeach.sessionId,
    domainId: "network-http-tcp"
  });

  const legacyAdvanced = await legacyService.answer({
    sessionId: focusedLegacy.sessionId,
    answer: "下一题",
    burdenSignal: "normal",
    interactionPreference: "balanced"
  });
  const aiAdvanced = await postJson(`${aiBaseUrl}/api/interview/answer`, {
    sessionId: focusedAi.sessionId,
    answer: "下一题",
    burdenSignal: "normal",
    interactionPreference: "balanced"
  });

  assert.equal(aiAdvanced.latestFeedback.action, legacyAdvanced.latestFeedback.action);
  assert.equal(aiAdvanced.latestFeedback.turnResolution.mode, "switch");
  const nextDomainId = (aiAdvanced.concepts || []).find((item) => item.id === aiAdvanced.currentConceptId)?.abilityDomainId
    || (aiAdvanced.concepts || []).find((item) => item.id === aiAdvanced.currentConceptId)?.domainId;
  assert.equal(nextDomainId, "network-http-tcp");
});

test("python ai-service matches explain-first and switch-suppression semantics on key turns", async (t) => {
  const aiPort = 18101;
  const aiBaseUrl = `http://127.0.0.1:${aiPort}`;
  const ai = startProcess(
    "python3",
    ["-m", "uvicorn", "app.main:app", "--port", String(aiPort), "--app-dir", "ai-service"],
    { cwd: "/Users/lee/IdeaProjects/LearningLoopAIV1" }
  );

  t.after(() => {
    ai.kill("SIGTERM");
  });

  await waitForJson(`${aiBaseUrl}/api/health`);

  const legacyService = createAppService({
    intelligence: createHeuristicTutorIntelligence()
  });

  const baselinePack = getBaselinePackById("bigtech-java-backend");
  const decomposition = createBaselinePackDecomposition(baselinePack);
  const source = createBaselinePackSource(baselinePack);
  const memoryProfile = createMemoryProfile(`parity_profile_${Date.now()}_explain`);

  const legacySession = await legacyService.startTargetSession({
    targetBaselineId: "bigtech-java-backend",
    interactionPreference: "explain-first",
    memoryProfileId: memoryProfile.id
  });

  const aiSession = await postJson(`${aiBaseUrl}/api/interview/start-target`, {
    userId: "parity-user-2",
    source,
    decomposition,
    targetBaseline: {
      id: baselinePack.id,
      title: baselinePack.title,
      targetRole: baselinePack.targetRole,
      flagship: baselinePack.flagship
    },
    memoryProfile,
    interactionPreference: "explain-first"
  });

  const weakLegacy = await legacyService.answer({
    sessionId: legacySession.sessionId,
    answer: "不太清楚，感觉就是个锁。",
    burdenSignal: "normal",
    interactionPreference: "explain-first"
  });
  const weakAi = await postJson(`${aiBaseUrl}/api/interview/answer`, {
    sessionId: aiSession.sessionId,
    answer: "不太清楚，感觉就是个锁。",
    burdenSignal: "normal",
    interactionPreference: "explain-first"
  });

  assert.equal(weakAi.latestFeedback.action, weakLegacy.latestFeedback.action);
  assert.equal(weakAi.latestFeedback.turnResolution.mode, "stay");
  assert.ok((weakAi.currentProbe || "").length > 0);

  const skipLegacy = await legacyService.answer({
    sessionId: weakLegacy.sessionId,
    answer: "下一题",
    burdenSignal: "normal",
    interactionPreference: "explain-first"
  });
  const skipAi = await postJson(`${aiBaseUrl}/api/interview/answer`, {
    sessionId: weakAi.sessionId,
    answer: "下一题",
    burdenSignal: "normal",
    interactionPreference: "explain-first"
  });

  assert.equal(skipAi.latestFeedback.action, skipLegacy.latestFeedback.action);
  assert.equal(skipAi.latestFeedback.turnResolution.mode, "switch");
  assert.equal(skipAi.latestFeedback.coachingStep, "");
  assert.equal(skipAi.latestFeedback.nextMove, null);
  assert.ok((skipAi.currentProbe || "").length > 0 || skipAi.turns.length > weakAi.turns.length);
});

test("python ai-service honors explicit structured intent for control actions", async (t) => {
  const aiPort = 18102;
  const aiBaseUrl = `http://127.0.0.1:${aiPort}`;
  const ai = startProcess(
    "python3",
    ["-m", "uvicorn", "app.main:app", "--port", String(aiPort), "--app-dir", "ai-service"],
    { cwd: "/Users/lee/IdeaProjects/LearningLoopAIV1" }
  );

  t.after(() => {
    ai.kill("SIGTERM");
  });

  await waitForJson(`${aiBaseUrl}/api/health`);

  const baselinePack = getBaselinePackById("bigtech-java-backend");
  const decomposition = createBaselinePackDecomposition(baselinePack);
  const source = createBaselinePackSource(baselinePack);
  const memoryProfile = createMemoryProfile(`parity_profile_${Date.now()}_intent`);

  const aiSession = await postJson(`${aiBaseUrl}/api/interview/start-target`, {
    userId: "parity-user-3",
    source,
    decomposition,
    targetBaseline: {
      id: baselinePack.id,
      title: baselinePack.title,
      targetRole: baselinePack.targetRole,
      flagship: baselinePack.flagship
    },
    memoryProfile,
    interactionPreference: "balanced"
  });

  const teachIntent = await postJson(`${aiBaseUrl}/api/interview/answer`, {
    sessionId: aiSession.sessionId,
    answer: "保留用户原话，不再靠按钮文案精确匹配。",
    intent: "teach",
    burdenSignal: "normal",
    interactionPreference: "balanced"
  });

  assert.equal(teachIntent.latestFeedback.action, "teach");
  assert.equal(teachIntent.engagement.controlCount, 1);
  assert.equal(teachIntent.engagement.teachRequestCount, 1);
});

test("python ai-service does not auto-revisit skipped concepts after a scoped domain is exhausted", async (t) => {
  const aiPort = 18103;
  const aiBaseUrl = `http://127.0.0.1:${aiPort}`;
  const ai = startProcess(
    "python3",
    ["-m", "uvicorn", "app.main:app", "--port", String(aiPort), "--app-dir", "ai-service"],
    { cwd: "/Users/lee/IdeaProjects/LearningLoopAIV1" }
  );

  t.after(() => {
    ai.kill("SIGTERM");
  });

  await waitForJson(`${aiBaseUrl}/api/health`);

  const baselinePack = getBaselinePackById("bigtech-java-backend");
  const decomposition = createBaselinePackDecomposition(baselinePack);
  const source = createBaselinePackSource(baselinePack);
  const memoryProfile = createMemoryProfile(`parity_profile_${Date.now()}_scope_stop`);

  let aiSession = await postJson(`${aiBaseUrl}/api/interview/start-target`, {
    userId: "parity-user-4",
    source,
    decomposition,
    targetBaseline: {
      id: baselinePack.id,
      title: baselinePack.title,
      targetRole: baselinePack.targetRole,
      flagship: baselinePack.flagship
    },
    memoryProfile,
    interactionPreference: "balanced"
  });

  aiSession = await postJson(`${aiBaseUrl}/api/interview/focus-domain`, {
    sessionId: aiSession.sessionId,
    domainId: "service-reliability"
  });

  aiSession = await postJson(`${aiBaseUrl}/api/interview/answer`, {
    sessionId: aiSession.sessionId,
    answer: "下一题",
    intent: "advance",
    burdenSignal: "normal",
    interactionPreference: "balanced"
  });

  aiSession = await postJson(`${aiBaseUrl}/api/interview/answer`, {
    sessionId: aiSession.sessionId,
    answer: "下一题",
    intent: "advance",
    burdenSignal: "normal",
    interactionPreference: "balanced"
  });

  assert.equal(aiSession.currentProbe, "");
  assert.equal(aiSession.latestFeedback.turnResolution.mode, "stop");
  assert.equal(
    aiSession.turns.some(
      (turn) =>
        turn.role === "tutor" &&
        turn.kind === "question" &&
        /我们回到刚才先放下的这个点/.test(turn.content || "")
    ),
    false
  );
});
