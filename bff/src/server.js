import http from "node:http";
import {
  createBaselinePackDecomposition,
  createBaselinePackSource,
  defaultBaselinePackId,
  getBaselinePackById
} from "../../src/baseline/baseline-packs.js";
import {
  listCustomMaterials,
  readCustomMaterialRender,
  listSourceDocuments,
  readCustomMaterialOriginal,
  readSourceAsset,
  readSourceDocument,
  saveCustomMaterial,
} from "../../src/knowledge/source-document-resolver.js";
import {
  convertRemoteMaterialUrl,
  convertUploadedMaterial,
} from "../../src/ingestion/material-converter.js";
import { buildReminderCandidate } from "../../src/superapp/reminder-candidate.js";
import { createMemoryProfileStore } from "../../src/tutor/memory-profile-store.js";
import {
  applyDocumentReadingEvent,
  applyDocumentIgnored,
  applyDocumentUnignored,
  applyDocumentTrainingAnswered,
  applyDocumentTrainingSession,
  applyDocumentTrainingSkipped,
  applyDocumentTrainingStarted,
  applyDocumentTrainingUnavailable,
  applyDocumentRecommendationSnooze,
  readDocumentTrainingSession,
} from "../../src/user/document-progress-state.js";
import { applyReadingProgress } from "../../src/user/reading-progress.js";
import { createUserProfileStore } from "../../src/user/user-profile-store.js";
import { buildUserProfileView } from "../../src/user/profile-aggregator.js";
import {
  ensureResumeVersionLibrary,
  getLatestResumeVersion,
  saveResumeVersion,
} from "../../src/user/resume-version-store.js";
import {
  createUserRulesStore,
  interactionPreferenceRule,
} from "../../src/user/user-rules-store.js";
import { createSessionSummariesStore } from "../../src/user/session-summary-store.js";
import {
  buildLoopAssistOptions,
  previewLoopAssistScope,
  selectLoopAssistSeeds,
} from "../../src/loopassist/corpus.js";

const aiServiceUrl = process.env.AI_SERVICE_URL || "http://127.0.0.1:8000";
const ttsServiceUrl = process.env.TTS_SERVICE_URL || "http://127.0.0.1:4300";
const port = Number(process.env.PORT || 4000);
const memoryProfileStore = createMemoryProfileStore();
const userProfileStore = createUserProfileStore();
const userRulesStore = createUserRulesStore();
const sessionSummariesStore = createSessionSummariesStore();
const superappDemoHandle = process.env.SUPERAPP_DEMO_HANDLE || "learningloop_superapp_demo";
const superappDemoPin = process.env.SUPERAPP_DEMO_PIN || "1234";

function withCorsHeaders(response, statusCode, extraHeaders = {}) {
  response.writeHead(statusCode, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
    "content-type": "application/json; charset=utf-8",
    ...extraHeaders,
  });
}

function sendJson(response, statusCode, payload) {
  withCorsHeaders(response, statusCode);
  response.end(JSON.stringify(payload));
}

function sendErrorJson(response, statusCode, payload) {
  if (response.writableEnded) {
    return;
  }

  if (response.headersSent) {
    response.end();
    return;
  }

  sendJson(response, statusCode, payload);
}

function sendBuffer(response, statusCode, body, extraHeaders = {}) {
  response.writeHead(statusCode, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
    ...extraHeaders,
  });
  response.end(body);
}

function buildMissingAssetPlaceholder(assetPath = "") {
  const label = String(assetPath || "knowledge asset")
    .split("/")
    .filter(Boolean)
    .slice(-2)
    .join(" / ")
    .replace(/[<>&"]/g, "");
  return Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" width="960" height="420" viewBox="0 0 960 420" role="img" aria-label="Image unavailable">
  <rect width="960" height="420" fill="#f8fafc"/>
  <rect x="28" y="28" width="904" height="364" rx="18" fill="#ffffff" stroke="#d8dee8" stroke-width="2" stroke-dasharray="10 10"/>
  <text x="480" y="190" text-anchor="middle" font-family="sans-serif" font-size="30" font-weight="700" fill="#475569">Image unavailable</text>
  <text x="480" y="238" text-anchor="middle" font-family="sans-serif" font-size="20" fill="#64748b">${label || "missing source asset"}</text>
</svg>`.trim());
}

function withStreamHeaders(response, statusCode) {
  response.writeHead(statusCode, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const rawBody = Buffer.concat(chunks).toString("utf8");
  return rawBody ? JSON.parse(rawBody) : {};
}

async function getUserProfile(userId) {
  return userProfileStore.getById(userId);
}

async function getMemoryProfile(memoryProfileId) {
  return memoryProfileStore.getOrCreate(memoryProfileId);
}

async function buildProfilePayload(user) {
  const memoryProfile = await getMemoryProfile(user.memoryProfileId);
  const [userRules, sessionSummaries] = await Promise.all([
    userRulesStore.list(user.id),
    sessionSummariesStore.list(user.id),
  ]);
  return buildUserProfileView({
    user,
    memoryProfile,
    userRules,
    sessionSummaries,
  });
}

function buildResumeLibraryPayload(user = {}) {
  const library = ensureResumeVersionLibrary(user.resumeLibrary);
  return {
    latestVersionId: library.latestVersionId,
    versions: library.versions.map((item) => ({
      id: item.id,
      fileName: item.fileName,
      createdAt: item.createdAt,
      charCount: item.charCount,
      text: item.text,
    })),
  };
}

async function proxyJson(method, pathname, payload) {
  const response = await fetch(`${aiServiceUrl}${pathname}`, {
    method,
    headers: {
      "content-type": "application/json",
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });

  const rawText = await response.text();
  let data;
  try {
    data = rawText ? JSON.parse(rawText) : {};
  } catch {
    data = { error: rawText || "Downstream AI service returned invalid JSON." };
  }
  if (!response.ok) {
    throw new Error(data.detail || data.error || "Downstream AI service request failed.");
  }
  return {
    data,
    traceId: response.headers.get("x-trace-id") || ""
  };
}

async function proxyBinary(baseUrl, method, pathname, payload) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      "content-type": "application/json",
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });

  if (!response.ok) {
    const rawText = await response.text();
    let data;
    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch {
      data = { error: rawText || "Downstream AI service request failed." };
    }
    throw new Error(data.detail || data.error || "Downstream AI service request failed.");
  }

  return {
    body: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get("content-type") || "application/octet-stream",
    traceId: response.headers.get("x-trace-id") || "",
    provider: response.headers.get("x-loopassist-tts-provider") || "",
    speaker: response.headers.get("x-loopassist-tts-speaker") || "",
  };
}

function stripSessionPayload(session = {}) {
  const nextSession = {
    ...session,
  };
  delete nextSession.memoryProfileSnapshot;
  delete nextSession.sessionSnapshot;
  return nextSession;
}

function buildDecompositionSnapshot(session = {}) {
  return {
    summary: session.summary || {},
    trainingPoints: session.trainingPoints || [],
    concepts: session.concepts || [],
  };
}

function summarizeCompletedSession(result = {}) {
  const latestFeedback = result.latestFeedback || {};
  const masteryMap = Array.isArray(result.masteryMap) ? result.masteryMap : [];
  const practicedCheckpointIds = masteryMap.map((item) => item.conceptId || item.checkpointId).filter(Boolean);
  const solidifiedCheckpointIds = masteryMap
    .filter((item) => item.state === "solid")
    .map((item) => item.conceptId || item.checkpointId)
    .filter(Boolean);
  const weakCheckpointIds = masteryMap
    .filter((item) => item.state === "weak" || item.state === "partial" || item.state === "不可判")
    .map((item) => item.conceptId || item.checkpointId)
    .filter(Boolean);

  let recommendedNextAction = "quick_review";
  if (result.source?.metadata?.docPath && result.trainingAvailability === "unavailable") {
    recommendedNextAction = "reference_lookup";
  } else if (!weakCheckpointIds.length && solidifiedCheckpointIds.length) {
    recommendedNextAction = "reference_lookup";
  }

  return {
    sessionId: result.sessionId || "",
    docPath: result.source?.metadata?.docPath || "",
    endedAt: new Date().toISOString(),
    practicedCheckpointIds,
    solidifiedCheckpointIds,
    weakCheckpointIds,
    oneParagraphSummary: String(latestFeedback.explanation || latestFeedback.takeaway || "").trim(),
    recommendedNextCheckpointId: weakCheckpointIds[0] || "",
    recommendedNextAction,
  };
}

async function persistSessionSummaryIfCompleted(result = {}) {
  if (!result?.userId || !isCompletedDocumentSession(result)) {
    return;
  }
  const summary = summarizeCompletedSession(result);
  if (!summary.sessionId || !summary.docPath) {
    return;
  }
  await sessionSummariesStore.upsert(result.userId, summary);
}

async function persistInteractionPreferenceRule(userId = "", interactionPreference = "") {
  if (!userId) {
    return;
  }
  const normalized = String(interactionPreference || "").trim();
  if (!normalized) {
    return;
  }
  await userRulesStore.upsert(userId, interactionPreferenceRule(normalized));
}

function isCompletedDocumentSession(session = {}) {
  const hasOpenProbe = Boolean(String(session?.currentProbe || "").trim());
  const hasCompletionTurn = Array.isArray(session?.turns)
    && session.turns.some((turn) => turn?.role === "tutor" && turn?.kind === "feedback" && turn?.action === "complete");
  return Boolean(session?.sessionId && !hasOpenProbe && hasCompletionTurn);
}

function isResumableDocumentSession(session = {}, { userId = "", docPath = "" } = {}) {
  return Boolean(
    session?.sessionId
    && session.userId === userId
    && session.source?.metadata?.docPath === docPath
    && !isCompletedDocumentSession(session)
  );
}

async function tryReadLiveSession(sessionId = "") {
  if (!sessionId) {
    return null;
  }
  try {
    const { data, traceId } = await proxyJson("GET", `/api/interview/${sessionId}`);
    return {
      ...data,
      traceId,
    };
  } catch {
    return null;
  }
}

async function tryRestoreSessionSnapshot(sessionSnapshot = null) {
  if (!sessionSnapshot || typeof sessionSnapshot !== "object") {
    return null;
  }
  try {
    const { data, traceId } = await proxyJson("POST", "/api/interview/restore-session", {
      sessionSnapshot,
    });
    return {
      ...data,
      traceId,
    };
  } catch {
    return null;
  }
}

function touchUserTarget(user, baselinePack, timestamp, { incrementSessionsStarted = false } = {}) {
  const previous = user.targets[baselinePack.id] || {};
  user.targets[baselinePack.id] = {
    targetBaselineId: baselinePack.id,
    title: baselinePack.title,
    targetRole: baselinePack.targetRole,
    createdAt: previous.createdAt || timestamp,
    lastActivityAt: timestamp,
    sessionsStarted: (previous.sessionsStarted || 0) + (incrementSessionsStarted ? 1 : 0),
    readingProgress: previous.readingProgress || {},
  };
}

function persistDocumentSessionState(user, session, timestamp) {
  const docPath = session?.source?.metadata?.docPath || "";
  if (!docPath) {
    return;
  }
  user.documents = applyDocumentTrainingSession(user.documents || {}, {
    docPath,
    docTitle: session.source?.title || session.source?.metadata?.docTitle || "",
    sessionId: session.sessionId || "",
    sessionSnapshot: session.sessionSnapshot || null,
    decompositionSnapshot: buildDecompositionSnapshot(session),
    currentTrainingPointId: session.currentTrainingPointId || "",
    currentCheckpointId: session.currentCheckpointId || "",
    timestamp,
  });
}

function isRecoverableTrainingPreparationFailure(message = "") {
  return [
    "Tutor intelligence returned too few teaching units.",
    "Tutor intelligence returned invalid training points.",
    "AI tutor did not generate an initial question for this concept.",
    "AI tutor did not generate a runtime question for this concept.",
    "AI tutor did not generate a follow-up question for this concept.",
  ].some((fragment) => String(message || "").includes(fragment));
}

function normalizeTrainingUnavailableMessage(message = "") {
  if (String(message || "").includes("too few teaching units") || String(message || "").includes("invalid training points")) {
    return "当前文档缺少足够可训练内容，已保留为阅读材料。";
  }
  return "当前文档暂时无法生成训练点，已保留为阅读材料。";
}

function getDocumentLearningText(document = {}) {
  const learningText = String(document.learning?.text || "").trim();
  if (learningText) {
    return learningText;
  }
  const learningMarkdown = String(document.learning?.markdown || "").trim();
  if (learningMarkdown) {
    return learningMarkdown;
  }
  return String(document.markdown || "").trim();
}

function extractReadableKnowledgeLines(content = "") {
  return String(content || "")
    .replace(/\r/g, "")
    .replace(/<!--[\s\S]*?-->/g, "\n")
    .replace(/```[\s\S]*?```/g, "\n")
    .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .split("\n")
    .map((line) => line.trim().replace(/^#+\s*/, "").replace(/^[-*]\s*/, ""))
    .filter(Boolean);
}

function hasSufficientKnowledgeContent(document = {}) {
  const lines = extractReadableKnowledgeLines(getDocumentLearningText(document));
  const longLines = lines.filter((line) => line.length >= 18);
  const totalTextLength = lines.join(" ").length;
  return longLines.length >= 3 && totalTextLength >= 220;
}

async function handleStartTarget(body) {
  if (!body.userId) {
    throw new Error("userId is required.");
  }
  const user = await getUserProfile(body.userId);
  await persistInteractionPreferenceRule(user.id, body.interactionPreference || "balanced");
  const memoryProfile = await getMemoryProfile(user.memoryProfileId);
  const activeDocument = body.docPath
    ? await readSourceDocument(body.docPath, { userId: user.id })
    : null;

  const targetBaselineId = body.targetBaselineId || defaultBaselinePackId;
  const baselinePack = getBaselinePackById(targetBaselineId);
  const now = new Date().toISOString();
  const previousTarget = user.targets[baselinePack.id] || {};
  const storedSession = activeDocument
    ? readDocumentTrainingSession(user.documents || {}, activeDocument.path)
    : null;
  const restartTraining = Boolean(body.restartTraining || body.forceNewSession);
  const liveSession = restartTraining ? null : await tryReadLiveSession(storedSession?.activeSessionId || "");
  const resumableLiveSession = isResumableDocumentSession(liveSession, {
    userId: user.id,
    docPath: activeDocument?.path || "",
  }) ? liveSession : null;
  const restoredSession = resumableLiveSession
    ? null
    : (restartTraining ? null : await tryRestoreSessionSnapshot(storedSession?.activeSessionSnapshot || null));
  const resumableRestoredSession = isResumableDocumentSession(restoredSession, {
    userId: user.id,
    docPath: activeDocument?.path || "",
  }) ? restoredSession : null;

  if (resumableLiveSession || resumableRestoredSession) {
    const resumedSession = resumableLiveSession || resumableRestoredSession;
    touchUserTarget(user, baselinePack, now);
    persistDocumentSessionState(user, resumedSession, now);
    user.lastActiveAt = now;
    await userProfileStore.save(user);
    return stripSessionPayload(resumedSession);
  }

  const source = activeDocument
    ? {
        kind: "knowledge-document",
        title: activeDocument.title,
        content: getDocumentLearningText(activeDocument),
        metadata: {
          baselinePackId: baselinePack.id,
          targetRole: baselinePack.targetRole,
          docPath: activeDocument.path,
          sourceRefs: activeDocument.sourceRefs || [],
        },
      }
    : createBaselinePackSource(baselinePack);

  if (activeDocument && !hasSufficientKnowledgeContent(activeDocument)) {
    const reasonMessage = "当前文档公开内容不足，暂时无法生成训练点，已保留为阅读材料。";
    touchUserTarget(user, baselinePack, now);
    user.documents = applyDocumentTrainingUnavailable(user.documents || {}, {
      docPath: activeDocument.path,
      docTitle: activeDocument.title || "",
      reason: reasonMessage,
      timestamp: now,
    });
    user.lastActiveAt = now;
    await userProfileStore.save(user);
    return {
      trainingAvailability: "unavailable",
      reasonCode: "insufficient_material",
      reasonMessage,
      source: {
        title: activeDocument.title,
        metadata: {
          docPath: activeDocument.path,
        },
      },
    };
  }

  const aiPayload = {
    userId: user.id,
    source,
    decomposition: activeDocument
      ? (storedSession?.decompositionSnapshot || undefined)
      : createBaselinePackDecomposition(baselinePack),
    targetBaseline: {
      id: baselinePack.id,
      title: baselinePack.title,
      targetRole: baselinePack.targetRole,
      flagship: baselinePack.flagship,
    },
    targetProgress: previousTarget,
    memoryProfile,
    interactionPreference: body.interactionPreference || "balanced",
  };

  let result;
  let traceId = "";
  try {
    const upstream = await proxyJson("POST", "/api/interview/start-target", aiPayload);
    result = upstream.data;
    traceId = upstream.traceId;
  } catch (error) {
    if (activeDocument && isRecoverableTrainingPreparationFailure(error.message)) {
      touchUserTarget(user, baselinePack, now);
      user.documents = applyDocumentTrainingUnavailable(user.documents || {}, {
        docPath: activeDocument.path,
        docTitle: activeDocument.title || "",
        reason: normalizeTrainingUnavailableMessage(error.message),
        timestamp: now,
      });
      user.lastActiveAt = now;
      await userProfileStore.save(user);
      return {
        trainingAvailability: "unavailable",
        reasonCode: "decomposition_failed",
        reasonMessage: normalizeTrainingUnavailableMessage(error.message),
        source: {
          title: activeDocument.title,
          metadata: {
            docPath: activeDocument.path,
          },
        },
      };
    }
    throw error;
  }

  memoryProfile.sessionsStarted += 1;
  await memoryProfileStore.save(memoryProfile);
  touchUserTarget(user, baselinePack, now, { incrementSessionsStarted: true });
  user.documents = applyDocumentTrainingStarted(user.documents || {}, {
    docPath: activeDocument?.path || body.docPath || "",
    docTitle: activeDocument?.title || "",
    timestamp: now,
  });
  user.lastActiveAt = now;
  await userProfileStore.save(user);
  const nextResult = {
    ...result,
    traceId,
  };
  persistDocumentSessionState(user, nextResult, now);
  await userProfileStore.save(user);
  return stripSessionPayload(nextResult);
}

async function handleAnswer(body) {
  const { data: result, traceId } = await proxyJson("POST", "/api/interview/answer", body);
  await persistInteractionPreferenceRule(result.userId || body.userId || "", body.interactionPreference || "");
  const memoryProfileSnapshot = result.memoryProfileSnapshot;
  if (memoryProfileSnapshot?.id) {
    const currentMemoryProfile = await getMemoryProfile(memoryProfileSnapshot.id);
    await memoryProfileStore.save({
      ...memoryProfileSnapshot,
      sessionsStarted: Math.max(
        Number(currentMemoryProfile.sessionsStarted || 0),
        Number(memoryProfileSnapshot.sessionsStarted || 0)
      ),
    });
  }
  if (result.userId && result.targetBaseline?.id) {
    const user = await getUserProfile(result.userId);
    const previous = user.targets[result.targetBaseline.id] || {};
    const timestamp = new Date().toISOString();
    user.targets[result.targetBaseline.id] = {
      targetBaselineId: result.targetBaseline.id,
      title: result.targetBaseline.title,
      targetRole: result.targetBaseline.targetRole || "",
      createdAt: previous.createdAt || timestamp,
      lastActivityAt: timestamp,
      sessionsStarted: previous.sessionsStarted || 0,
      readingProgress: previous.readingProgress || {},
    };
    user.documents = applyDocumentTrainingAnswered(user.documents || {}, {
      docPath: result.source?.metadata?.docPath || "",
      docTitle: result.source?.title || result.source?.metadata?.docTitle || "",
      timestamp,
    });
    persistDocumentSessionState(user, result, timestamp);
    user.lastActiveAt = user.targets[result.targetBaseline.id].lastActivityAt;
    await userProfileStore.save(user);
  }
  await persistSessionSummaryIfCompleted(result);
  return stripSessionPayload({
    ...result,
    traceId,
  });
}

async function handleReminderCandidate(userId) {
  if (!userId) {
    throw new Error("userId is required.");
  }
  const user = await getUserProfile(userId);
  const memoryProfile = await getMemoryProfile(user.memoryProfileId);
  const candidate = buildReminderCandidate({ user, memoryProfile });
  if (!candidate) {
    throw new Error("No reminder candidate available.");
  }
  return candidate;
}

async function handleReadingProgress(body) {
  if (!body.userId) {
    throw new Error("userId is required.");
  }
  const user = await getUserProfile(body.userId);
  const targetBaselineId = body.targetBaselineId || defaultBaselinePackId;
  const baselinePack = getBaselinePackById(targetBaselineId);
  const previous = user.targets[targetBaselineId] || {
    targetBaselineId: baselinePack.id,
    title: baselinePack.title,
    targetRole: baselinePack.targetRole,
    createdAt: new Date().toISOString(),
    lastActivityAt: "",
    sessionsStarted: 0,
    readingProgress: {},
  };

  const timestamp = new Date().toISOString();
  user.targets[targetBaselineId] = applyReadingProgress(previous, {
    targetBaselineId,
    domainId: body.domainId,
    conceptId: body.conceptId,
    docPath: body.docPath,
    docTitle: body.docTitle,
    scrollRatio: body.scrollRatio,
    dwellMs: body.dwellMs,
    readingPreview: body.readingPreview,
    readingChapter: body.readingChapter,
    timestamp,
  });
  user.documents = applyDocumentReadingEvent(user.documents || {}, {
    docPath: body.docPath,
    docTitle: body.docTitle || user.targets[targetBaselineId]?.readingProgress?.currentDocTitle || "",
    scrollRatio: body.scrollRatio,
    dwellMs: body.dwellMs,
    readingPreview: body.readingPreview,
    readingChapter: body.readingChapter,
    timestamp,
  });
  user.targets[targetBaselineId].lastActivityAt = timestamp;
  user.lastActiveAt = user.targets[targetBaselineId].lastActivityAt;
  await userProfileStore.save(user);
  return buildProfilePayload(user);
}

async function handleIgnoredDocument(body) {
  if (!body.userId) {
    throw new Error("userId is required.");
  }
  if (!body.docPath) {
    throw new Error("docPath is required.");
  }
  const user = await getUserProfile(body.userId);
  const timestamp = new Date().toISOString();
  user.documents = body.ignored === false
    ? applyDocumentUnignored(user.documents || {}, {
        docPath: body.docPath,
        timestamp,
      })
    : applyDocumentIgnored(user.documents || {}, {
        docPath: body.docPath,
        docTitle: body.docTitle || "",
        timestamp,
      });
  user.lastActiveAt = timestamp;
  await userProfileStore.save(user);
  return buildProfilePayload(user);
}

async function handleSkippedTraining(body) {
  if (!body.userId) {
    throw new Error("userId is required.");
  }
  if (!body.docPath) {
    throw new Error("docPath is required.");
  }
  const user = await getUserProfile(body.userId);
  const timestamp = new Date().toISOString();
  user.documents = applyDocumentTrainingSkipped(user.documents || {}, {
    docPath: body.docPath,
    docTitle: body.docTitle || "",
    timestamp,
  });
  user.lastActiveAt = timestamp;
  await userProfileStore.save(user);
  return buildProfilePayload(user);
}

async function handleRecommendationSnooze(body) {
  if (!body.userId) {
    throw new Error("userId is required.");
  }
  if (!body.docPath) {
    throw new Error("docPath is required.");
  }
  const user = await getUserProfile(body.userId);
  const timestamp = new Date().toISOString();
  const hours = Math.max(1, Math.min(24, Number(body.hours || 12)));
  const until = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  user.documents = applyDocumentRecommendationSnooze(user.documents || {}, {
    docPath: body.docPath,
    docTitle: body.docTitle || "",
    until,
    timestamp,
  });
  user.lastActiveAt = timestamp;
  await userProfileStore.save(user);
  return buildProfilePayload(user);
}

function normalizeKnowledgeGoal(goal = "") {
  return String(goal || "").trim() || "interview";
}

function normalizeKnowledgeTaskType(taskType = "") {
  const normalized = String(taskType || "").trim();
  return ["summary", "memory_points", "question_points", "inline_quiz", "selection_explain"].includes(normalized)
    ? normalized
    : "freeform";
}

function buildFallbackKnowledgeAnswer(question = "", document = {}, { taskType = "freeform" } = {}) {
  const lines = extractReadableKnowledgeLines(getDocumentLearningText(document));
  const headings = lines.filter((line) => line.length <= 48).slice(0, 8);
  const paragraphs = lines.filter((line) => line.length > 18).slice(0, 6);
  if (taskType === "summary" || /总结|概括|3\s*句|三句/.test(question)) {
    return (paragraphs.length ? paragraphs : headings).slice(0, 3).map((line, index) => `${index + 1}. ${line}`).join("\n");
  }
  if (taskType === "memory_points") {
    return (headings.length ? headings : paragraphs).map((line, index) => `${index + 1}. ${line}：这是当前目标下值得优先记住的内容。`).join("\n");
  }
  if (taskType === "inline_quiz") {
    const sourceText = String(question || "").includes("原文：")
      ? String(question || "").split("原文：").at(-1)
      : (paragraphs[0] || headings[0] || "这段原文的核心概念");
    const answer = String(sourceText || "").split(/[。！？；\n]/)[0].trim() || "这段原文的核心概念";
    return `自测题：这段话最核心的概念是什么？\n参考答案：${answer.slice(0, 80)}`;
  }
  if (taskType === "question_points" || /面试|追问|问题/.test(question)) {
    return (headings.length ? headings : paragraphs).map((line, index) => `${index + 1}. 问题：${line} 的核心机制、适用场景和边界是什么？\n考察点：是否真正理解这个关键点，而不是只记住标题。`).join("\n");
  }
  const seeds = (paragraphs.length ? paragraphs : headings).slice(0, 2);
  return seeds.length ? `基于《${document.title || "当前文档"}》，${seeds.join("；")}` : "这篇材料里没有足够内容回答这个问题。";
}

async function handleKnowledgeAnswer(body) {
  const question = String(body.question || "").trim();
  const docPath = String(body.docPath || "").trim();
  const goal = normalizeKnowledgeGoal(body.goal);
  const taskType = normalizeKnowledgeTaskType(body.taskType);
  if (!question) {
    throw new Error("question is required.");
  }
  if (!docPath) {
    throw new Error("docPath is required.");
  }

  const document = await readSourceDocument(docPath, { userId: body.userId || "" });
  if (!hasSufficientKnowledgeContent(document)) {
    return {
      mode: "knowledge_qa",
      content: `《${document.title || "当前文档"}》当前公开内容不足，暂时无法支持问答。你可以先继续阅读其他正文更完整的材料。`,
      suggestedFollowUp: "换一篇正文更完整的文档继续训练",
      source: {
        title: document.title,
        path: document.path,
      },
      fallbackReason: "insufficient_public_content",
    };
  }
  try {
    const { data, traceId } = await proxyJson("POST", "/api/superapp/answer-knowledge-question", {
      userId: body.userId || "",
      question,
      goal,
      taskType,
      title: document.title,
      context: getDocumentLearningText(document),
    });
    return {
      ...data,
      traceId,
      source: {
        title: document.title,
        path: document.path,
      },
    };
  } catch (error) {
    return {
      mode: "knowledge_qa",
      content: buildFallbackKnowledgeAnswer(question, document, { taskType }),
      suggestedFollowUp: "把这个点出成一道快答题",
      source: {
        title: document.title,
        path: document.path,
      },
      fallbackReason: error.message,
    };
  }
}

async function ensureSuperappDemoUser() {
  const { user, created } = await userProfileStore.loginOrCreate({
    handle: superappDemoHandle,
    pin: superappDemoPin,
  });
  const profile = await buildProfilePayload(user);
  return {
    userId: user.id,
    handle: user.handle,
    created,
    profile,
  };
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
    dataText: dataLines.join("\n")
  };
}

function serializeSseEvent(event, payload) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function buildServiceBaseUrl(request) {
  const host = request.headers.host || `127.0.0.1:${port}`;
  const protocol = String(request.headers["x-forwarded-proto"] || "http").split(",")[0].trim() || "http";
  return `${protocol}://${host}`;
}

function buildSafeContentDisposition(filename = "original") {
  const raw = String(filename || "original").trim() || "original";
  const asciiFallback = raw
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/["\\]/g, "")
    .replace(/[;]/g, "")
    .trim() || "download";
  const encodedFilename = encodeURIComponent(raw);
  return `inline; filename="${asciiFallback}"; filename*=UTF-8''${encodedFilename}`;
}

async function persistAnswerSideEffects(result) {
  const memoryProfileSnapshot = result.memoryProfileSnapshot;
  if (memoryProfileSnapshot?.id) {
    await memoryProfileStore.save(memoryProfileSnapshot);
  }
  if (result.userId && result.targetBaseline?.id) {
    const user = await getUserProfile(result.userId);
    const previous = user.targets[result.targetBaseline.id] || {};
    const timestamp = new Date().toISOString();
    user.targets[result.targetBaseline.id] = {
      targetBaselineId: result.targetBaseline.id,
      title: result.targetBaseline.title,
      targetRole: result.targetBaseline.targetRole || "",
      createdAt: previous.createdAt || timestamp,
      lastActivityAt: timestamp,
      sessionsStarted: previous.sessionsStarted || 0,
      readingProgress: previous.readingProgress || {},
    };
    user.documents = applyDocumentTrainingAnswered(user.documents || {}, {
      docPath: result.source?.metadata?.docPath || "",
      docTitle: result.source?.title || result.source?.metadata?.docTitle || "",
      timestamp,
    });
    persistDocumentSessionState(user, result, timestamp);
    user.lastActiveAt = user.targets[result.targetBaseline.id].lastActivityAt;
    await userProfileStore.save(user);
  }
  await persistSessionSummaryIfCompleted(result);
}

async function handleFocusDomain(body) {
  const { data, traceId } = await proxyJson("POST", "/api/interview/focus-domain", body);
  if (data.userId && data.targetBaseline?.id) {
    const user = await getUserProfile(data.userId);
    const baselinePack = getBaselinePackById(data.targetBaseline.id);
    const timestamp = new Date().toISOString();
    touchUserTarget(user, baselinePack, timestamp);
    persistDocumentSessionState(user, data, timestamp);
    user.lastActiveAt = timestamp;
    await userProfileStore.save(user);
  }
  return stripSessionPayload({
    ...data,
    traceId,
  });
}

async function handleFocusConcept(body) {
  const { data, traceId } = await proxyJson("POST", "/api/interview/focus-concept", body);
  if (data.userId && data.targetBaseline?.id) {
    const user = await getUserProfile(data.userId);
    const baselinePack = getBaselinePackById(data.targetBaseline.id);
    const timestamp = new Date().toISOString();
    touchUserTarget(user, baselinePack, timestamp);
    persistDocumentSessionState(user, data, timestamp);
    user.lastActiveAt = timestamp;
    await userProfileStore.save(user);
  }
  return stripSessionPayload({
    ...data,
    traceId,
  });
}

async function handleAnswerStream(body, response) {
  const upstream = await fetch(`${aiServiceUrl}/api/interview/answer-stream`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!upstream.ok || !upstream.body) {
    const rawText = await upstream.text();
    let data;
    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch {
      data = { error: rawText || "Downstream AI service stream failed." };
    }
    throw new Error(data.detail || data.error || "Downstream AI service stream failed.");
  }

  withStreamHeaders(response, 200);
  const traceId = upstream.headers.get("x-trace-id") || "";
  if (traceId) {
    response.write(serializeSseEvent("trace", { traceId }));
  }

  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of upstream.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const parsed = parseSseEvent(rawEvent);
      if (parsed.event === "turn_result" || parsed.event === "session") {
        const data = parsed.dataText ? JSON.parse(parsed.dataText) : {};
        await persistAnswerSideEffects(data);
        response.write(serializeSseEvent("turn_result", stripSessionPayload({ ...data, traceId })));
      } else {
        response.write(`${rawEvent}\n\n`);
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
  if (buffer.trim()) {
    response.write(`${buffer}\n\n`);
  }
  response.end();
}

async function handleLoopAssistStart(body) {
  let scope = body.scope || {};
  if (!String(scope.resumeText || "").trim() && body.userId && body.useLatestStoredResume !== false) {
    const user = await getUserProfile(body.userId);
    const latestResumeVersion = getLatestResumeVersion(user.resumeLibrary);
    if (latestResumeVersion?.text) {
      scope = {
        ...scope,
        resumeText: latestResumeVersion.text,
      };
    }
  }
  const seeds = selectLoopAssistSeeds(scope);
  const { data, traceId } = await proxyJson("POST", "/api/loopassist/start", {
    ...body,
    scope,
    seeds,
  });
  return {
    ...data,
    traceId,
  };
}

async function handleLoopAssistStream(body, response) {
  const upstream = await fetch(`${aiServiceUrl}/api/loopassist/answer-stream`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!upstream.ok || !upstream.body) {
    const rawText = await upstream.text();
    let data;
    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch {
      data = { error: rawText || "Downstream LoopAssist stream failed." };
    }
    throw new Error(data.detail || data.error || "Downstream LoopAssist stream failed.");
  }

  withStreamHeaders(response, 200);
  const traceId = upstream.headers.get("x-trace-id") || "";
  if (traceId) {
    response.write(serializeSseEvent("trace", { traceId }));
  }

  for await (const chunk of upstream.body) {
    response.write(chunk);
  }
  response.end();
}

async function handleListResumeVersions(userId = "") {
  if (!userId) {
    throw new Error("userId is required.");
  }
  const user = await getUserProfile(userId);
  return buildResumeLibraryPayload(user);
}

async function handleSaveResumeVersion(body = {}) {
  if (!body.userId) {
    throw new Error("userId is required.");
  }
  const text = String(body.text || "").trim();
  if (!text) {
    throw new Error("resume text is required.");
  }
  const user = await getUserProfile(body.userId);
  const nextLibrary = saveResumeVersion(user.resumeLibrary, {
    text,
    fileName: body.fileName || body.filename || "",
  });
  user.resumeLibrary = {
    latestVersionId: nextLibrary.latestVersionId,
    versions: nextLibrary.versions,
  };
  user.lastActiveAt = new Date().toISOString();
  await userProfileStore.save(user);
  return {
    ...buildResumeLibraryPayload(user),
    savedVersionId: nextLibrary.savedVersion.id,
  };
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");

    if (request.method === "OPTIONS") {
      withCorsHeaders(response, 204, { "content-type": "text/plain; charset=utf-8" });
      response.end();
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, { ok: true, aiServiceUrl });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/loopassist/options") {
      sendJson(response, 200, buildLoopAssistOptions());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/loopassist/preview-scope") {
      const body = await readJsonBody(request);
      sendJson(response, 200, previewLoopAssistScope(body.scope || body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/loopassist/start") {
      sendJson(response, 200, await handleLoopAssistStart(await readJsonBody(request)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/loopassist/answer") {
      const { data, traceId } = await proxyJson("POST", "/api/loopassist/answer", await readJsonBody(request));
      sendJson(response, 200, { ...data, traceId });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/loopassist/answer-stream") {
      await handleLoopAssistStream(await readJsonBody(request), response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/loopassist/review") {
      const { data, traceId } = await proxyJson("POST", "/api/loopassist/review", await readJsonBody(request));
      sendJson(response, 200, { ...data, traceId });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/loopassist/review-question") {
      const { data, traceId } = await proxyJson("POST", "/api/loopassist/review-question", await readJsonBody(request));
      sendJson(response, 200, { ...data, traceId });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/loopassist/review-summary") {
      const { data, traceId } = await proxyJson("POST", "/api/loopassist/review-summary", await readJsonBody(request));
      sendJson(response, 200, { ...data, traceId });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/loopassist/tts") {
      const result = await proxyBinary(ttsServiceUrl, "POST", "/api/tts", await readJsonBody(request));
      sendBuffer(response, 200, result.body, {
        "content-type": result.contentType,
        "x-trace-id": result.traceId,
        "x-loopassist-tts-provider": result.provider,
        "x-loopassist-tts-speaker": result.speaker,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/auth/login") {
      const body = await readJsonBody(request);
      const { user, created } = await userProfileStore.loginOrCreate({
        handle: body.handle,
        pin: body.pin,
      });
      sendJson(response, 200, {
        created,
        profile: await buildProfilePayload(user),
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/profile/resume-versions") {
      const userId = url.searchParams.get("userId") || "";
      sendJson(response, 200, await handleListResumeVersions(userId));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/profile/resume-versions") {
      sendJson(response, 200, await handleSaveResumeVersion(await readJsonBody(request)));
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/profile/")) {
      const userId = url.pathname.split("/").at(-1);
      sendJson(response, 200, await buildProfilePayload(await getUserProfile(userId)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/profile/reading-progress") {
      sendJson(response, 200, await handleReadingProgress(await readJsonBody(request)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/profile/ignored-document") {
      sendJson(response, 200, await handleIgnoredDocument(await readJsonBody(request)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/profile/skipped-training") {
      sendJson(response, 200, await handleSkippedTraining(await readJsonBody(request)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/profile/recommendation-snooze") {
      sendJson(response, 200, await handleRecommendationSnooze(await readJsonBody(request)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/knowledge/answer") {
      sendJson(response, 200, await handleKnowledgeAnswer(await readJsonBody(request)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/materials/ingest-url") {
      const body = await readJsonBody(request);
      if (!body.userId) {
        throw new Error("userId is required.");
      }
      const converted = await convertRemoteMaterialUrl(body.url);
      const material = await saveCustomMaterial({
        userId: body.userId,
        ...converted,
      });
      sendJson(response, 200, { material });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/materials/upload") {
      const body = await readJsonBody(request);
      if (!body.userId) {
        throw new Error("userId is required.");
      }
      const converted = await convertUploadedMaterial({
        filename: body.filename,
        mimeType: body.mimeType,
        contentBase64: body.contentBase64,
      });
      const material = await saveCustomMaterial({
        userId: body.userId,
        ...converted,
      });
      sendJson(response, 200, { material });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/materials") {
      const userId = url.searchParams.get("userId") || "";
      if (!userId) {
        throw new Error("userId is required.");
      }
      sendJson(response, 200, { materials: await listCustomMaterials(userId) });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/materials/original") {
      const userId = url.searchParams.get("userId") || "";
      const materialPath = url.searchParams.get("path") || "";
      const original = await readCustomMaterialOriginal(userId, materialPath);
      if (original.redirectUrl) {
        response.writeHead(302, {
          "access-control-allow-origin": "*",
          location: original.redirectUrl,
        });
        response.end();
      } else {
        sendBuffer(response, 200, original.body, {
          "cache-control": "private, max-age=60",
          "content-disposition": buildSafeContentDisposition(original.filename || "original"),
          "content-type": original.mimeType,
        });
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/materials/render") {
      const userId = url.searchParams.get("userId") || "";
      const materialPath = url.searchParams.get("path") || "";
      const rendered = await readCustomMaterialRender(userId, materialPath);
      sendBuffer(response, 200, rendered.body, {
        "cache-control": "private, max-age=60",
        "content-disposition": buildSafeContentDisposition(rendered.filename || "rendered.html"),
        "content-type": rendered.mimeType,
      });
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/superapp/reminder-candidate/")) {
      const userId = url.pathname.split("/").at(-1);
      sendJson(response, 200, await handleReminderCandidate(userId));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/superapp/demo-user") {
      sendJson(response, 200, await ensureSuperappDemoUser());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/superapp/reminder-outcome") {
      const body = await readJsonBody(request);
      sendJson(response, 200, { ok: true, recordedAt: new Date().toISOString(), ...body });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/knowledge/doc") {
      const docPath = url.searchParams.get("path") || url.searchParams.get("doc") || "";
      const document = await readSourceDocument(docPath, {
        userId: url.searchParams.get("userId") || "",
        serviceBaseUrl: buildServiceBaseUrl(request),
      });
      sendJson(response, 200, document);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/knowledge/docs") {
      sendJson(response, 200, { documents: await listSourceDocuments({ userId: url.searchParams.get("userId") || "" }) });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/knowledge/asset") {
      const assetPath = url.searchParams.get("path");
      const remoteUrl = url.searchParams.get("url");

      if (assetPath) {
        try {
          const asset = await readSourceAsset(assetPath);
          sendBuffer(response, 200, asset.body, {
            "cache-control": "public, max-age=3600",
            "content-type": asset.mimeType,
          });
        } catch (error) {
          if (error.code !== "ENOENT") {
            throw error;
          }
          sendBuffer(response, 200, buildMissingAssetPlaceholder(assetPath), {
            "cache-control": "public, max-age=300",
            "content-type": "image/svg+xml; charset=utf-8",
          });
        }
        return;
      }

      if (remoteUrl) {
        const upstream = await fetch(remoteUrl);
        if (!upstream.ok) {
          throw new Error("Remote asset request failed.");
        }
        sendBuffer(response, 200, Buffer.from(await upstream.arrayBuffer()), {
          "cache-control": "public, max-age=3600",
          "content-type": upstream.headers.get("content-type") || "application/octet-stream",
        });
        return;
      }

      throw new Error("knowledge asset path is required.");
    }

    if (request.method === "GET" && url.pathname === "/api/knowledge/redirect") {
      const remoteUrl = url.searchParams.get("url") || "";
      if (!/^https?:\/\//i.test(remoteUrl)) {
        throw new Error("knowledge redirect url is invalid.");
      }
      response.writeHead(302, {
        "access-control-allow-origin": "*",
        location: remoteUrl,
      });
      response.end();
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/interview/start-target") {
      sendJson(response, 200, await handleStartTarget(await readJsonBody(request)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/interview/answer") {
      sendJson(response, 200, await handleAnswer(await readJsonBody(request)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/interview/answer-stream") {
      await handleAnswerStream(await readJsonBody(request), response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/interview/focus-domain") {
      sendJson(response, 200, await handleFocusDomain(await readJsonBody(request)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/interview/focus-concept") {
      sendJson(response, 200, await handleFocusConcept(await readJsonBody(request)));
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/interview/")) {
      const { data: result, traceId } = await proxyJson("GET", url.pathname);
      sendJson(response, 200, stripSessionPayload({ ...result, traceId }));
      return;
    }

    sendJson(response, 404, { error: "Not found." });
  } catch (error) {
    console.error(error);
    sendErrorJson(response, 400, { error: error instanceof Error ? error.message : "Unknown error" });
  }
});

if (process.env.NODE_ENV !== "test") {
  server.listen(port, () => {
    console.log(`Learning Loop BFF listening on http://localhost:${port}`);
  });
}

export { server, isCompletedDocumentSession, isResumableDocumentSession };
