import { createBaselinePackDecomposition, createBaselinePackSource, defaultBaselinePackId, getBaselinePackById } from "../../../src/baseline/baseline-packs.js";
import { readSourceDocument } from "../../../src/knowledge/source-document-resolver.js";
import { extractLastDrillRound } from "../../../src/ledger/extract-drill-round.js";
import { applyDocumentTrainingAnswered, applyDocumentTrainingSession, applyDocumentTrainingStarted, applyDocumentTrainingUnavailable, readDocumentTrainingSession } from "../../../src/user/document-progress-state.js";
import { parseSseEvent, serializeSseEvent, withStreamHeaders } from "./http-utils.js";
import { getDocumentLearningText, hasSufficientKnowledgeContent } from "./knowledge-domain.js";
import { getMemoryProfile, getUserProfile, persistInteractionPreferenceRule } from "./profile-domain.js";
import { aiServiceUrl, proxyJson } from "./service-proxy.js";
import { drillPassthrough, memoryProfileStore, sessionSummariesStore, userProfileStore } from "./stores.js";

export function stripSessionPayload(session = {}) {
  const nextSession = {
    ...session,
  };
  delete nextSession.memoryProfileSnapshot;
  delete nextSession.sessionSnapshot;
  return nextSession;
}

export function buildDecompositionSnapshot(session = {}) {
  return {
    summary: session.summary || {},
    trainingPoints: session.trainingPoints || [],
    concepts: session.concepts || [],
  };
}

export function summarizeCompletedSession(result = {}) {
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

export async function persistSessionSummaryIfCompleted(result = {}) {
  if (!result?.userId || !isCompletedDocumentSession(result)) {
    return;
  }
  const summary = summarizeCompletedSession(result);
  if (!summary.sessionId || !summary.docPath) {
    return;
  }
  await sessionSummariesStore.upsert(result.userId, summary);
}

export function isCompletedDocumentSession(session = {}) {
  const hasOpenProbe = Boolean(String(session?.currentProbe || "").trim());
  const hasCompletionTurn = Array.isArray(session?.turns)
    && session.turns.some((turn) => turn?.role === "tutor" && turn?.kind === "feedback" && turn?.action === "complete");
  return Boolean(session?.sessionId && !hasOpenProbe && hasCompletionTurn);
}

export function isResumableDocumentSession(session = {}, { userId = "", docPath = "" } = {}) {
  return Boolean(
    session?.sessionId
    && session.userId === userId
    && session.source?.metadata?.docPath === docPath
    && !isCompletedDocumentSession(session)
  );
}

export async function tryReadLiveSession(sessionId = "") {
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

export async function tryRestoreSessionSnapshot(sessionSnapshot = null) {
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

export function touchUserTarget(user, baselinePack, timestamp, { incrementSessionsStarted = false } = {}) {
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

export function persistDocumentSessionState(user, session, timestamp) {
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

export function isRecoverableTrainingPreparationFailure(message = "") {
  return [
    "Tutor intelligence returned too few teaching units.",
    "Tutor intelligence returned invalid training points.",
    "AI tutor did not generate an initial question for this concept.",
    "AI tutor did not generate a runtime question for this concept.",
    "AI tutor did not generate a follow-up question for this concept.",
  ].some((fragment) => String(message || "").includes(fragment));
}

export function normalizeTrainingUnavailableMessage(message = "") {
  if (String(message || "").includes("too few teaching units") || String(message || "").includes("invalid training points")) {
    return "当前文档缺少足够可训练内容，已保留为阅读材料。";
  }
  return "当前文档暂时无法生成训练点，已保留为阅读材料。";
}

export async function handleStartTarget(body) {
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

export async function handleAnswer(body) {
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
  // 失败账本（阶段 3）：把刚答完的这一轮 drill 喂给一次性锚点判分，答崩就写复习项。
  // passthrough 自带旁路兜底——判分/写盘任何报错都吞掉，绝不影响这次 answer 的返回。
  const drillRound = extractLastDrillRound(result.turns);
  if (drillRound) {
    await drillPassthrough({
      handle: drillRound.handle,
      question: drillRound.question,
      answer: drillRound.answer,
      sourceRef: result.source?.metadata?.docPath || "",
    });
  }
  return stripSessionPayload({
    ...result,
    traceId,
  });
}

export async function persistAnswerSideEffects(result) {
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

export async function handleFocusDomain(body) {
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

export async function handleFocusConcept(body) {
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

export async function handleAnswerStream(body, response) {
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
