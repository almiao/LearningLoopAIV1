const allowedJudgeStates = new Set(["solid", "partial", "weak", "不可判"]);
const allowedSignals = new Set(["positive", "negative", "noise"]);
const allowedConfidenceLevels = new Set(["high", "medium", "low"]);
const allowedInfoGainLevels = new Set(["high", "medium", "low", "negligible"]);
const allowedHypothesisStatuses = new Set(["supported", "unsupported", "contradicted", "unknown"]);

function ensureString(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

export function confidenceToLevel(confidence) {
  if (typeof confidence !== "number") {
    return "low";
  }
  if (confidence >= 0.75) {
    return "high";
  }
  if (confidence >= 0.45) {
    return "medium";
  }
  return "low";
}

function normalizeConfidenceLevel(value, fallback = "low") {
  return allowedConfidenceLevels.has(value) ? value : fallback;
}

function normalizeInfoGainLevel(value, fallback = "medium") {
  return allowedInfoGainLevels.has(value) ? value : fallback;
}

function normalizeHypothesis(entry, index) {
  return {
    id: ensureString(entry?.id, `hypothesis-${index + 1}`),
    status: allowedHypothesisStatuses.has(entry?.status) ? entry.status : "unknown",
    confidenceLevel: normalizeConfidenceLevel(entry?.confidenceLevel),
    evidenceRefs: ensureArray(entry?.evidenceRefs).map((item) => ensureString(item)).filter(Boolean).slice(0, 4),
    note: ensureString(entry?.note)
  };
}

function normalizeMisunderstanding(entry, index) {
  return {
    label: ensureString(entry?.label, `misunderstanding-${index + 1}`),
    confidenceLevel: normalizeConfidenceLevel(entry?.confidenceLevel),
    evidenceRefs: ensureArray(entry?.evidenceRefs).map((item) => ensureString(item)).filter(Boolean).slice(0, 4)
  };
}

export function mergeRuntimeMaps(previousMap = null, nextMap = null, concept) {
  const previousHypotheses = new Map(
    ensureArray(previousMap?.hypotheses).map((entry) => [entry.id, normalizeHypothesis(entry, 0)])
  );

  for (const entry of ensureArray(nextMap?.hypotheses).map((item, index) => normalizeHypothesis(item, index))) {
    previousHypotheses.set(entry.id, entry);
  }

  const mergedMisunderstandings = [];
  const seenMisunderstandings = new Set();
  for (const entry of [
    ...ensureArray(previousMap?.misunderstandings),
    ...ensureArray(nextMap?.misunderstandings)
  ]) {
    const normalized = normalizeMisunderstanding(entry, mergedMisunderstandings.length);
    const key = `${normalized.label}:${normalized.confidenceLevel}`;
    if (!seenMisunderstandings.has(key)) {
      seenMisunderstandings.add(key);
      mergedMisunderstandings.push(normalized);
    }
  }

  const openQuestions = [
    ...new Set(
      [...ensureArray(previousMap?.openQuestions), ...ensureArray(nextMap?.openQuestions)]
        .map((item) => ensureString(item))
        .filter(Boolean)
    )
  ].slice(0, 4);

  return {
    anchorId: ensureString(nextMap?.anchorId || previousMap?.anchorId, concept.id),
    hypotheses: [...previousHypotheses.values()].slice(0, 6),
    misunderstandings: mergedMisunderstandings.slice(0, 4),
    openQuestions,
    infoGainLevel: normalizeInfoGainLevel(nextMap?.infoGainLevel || previousMap?.infoGainLevel, "medium")
  };
}

function normalizeReply(payload, concept) {
  const judge = payload?.judge ?? {};
  const confidence =
    typeof judge.confidence === "number" && judge.confidence >= 0 && judge.confidence <= 1
      ? judge.confidence
      : 0.3;
  const teachingParagraphs = ensureArray(payload?.teachingParagraphs)
    .map((item) => ensureString(item))
    .filter(Boolean)
    .slice(0, 4);
  const teachingChunk = ensureString(payload?.teachingChunk, teachingParagraphs.join("\n\n"));

  return {
    moveType: ensureString(payload?.moveType, "repair"),
    signal: allowedSignals.has(payload?.signal) ? payload.signal : "noise",
    judge: {
      state: allowedJudgeStates.has(judge?.state) ? judge.state : "weak",
      confidence,
      reasons: ensureArray(judge?.reasons).map((item) => ensureString(item)).filter(Boolean).slice(0, 4)
    },
    visibleReply: ensureString(payload?.visibleReply, concept.summary),
    evidenceReference: ensureString(payload?.evidenceReference, concept.excerpt || concept.summary),
    teachingChunk: ensureString(teachingChunk, concept.summary),
    teachingParagraphs,
    nextQuestion: ensureString(payload?.nextQuestion),
    takeaway: ensureString(payload?.takeaway, concept.summary),
    confirmedUnderstanding: ensureString(payload?.confirmedUnderstanding),
    remainingGap: ensureString(payload?.remainingGap),
    revisitReason: ensureString(payload?.revisitReason),
    completeCurrentUnit: Boolean(payload?.completeCurrentUnit),
    requiresResponse: payload?.requiresResponse !== false
  };
}

function normalizeNextMove(payload, reply) {
  const uiMode = ensureString(payload?.uiMode, reply.moveType || "repair");
  return {
    intent: ensureString(payload?.intent, reply.visibleReply),
    reason: ensureString(payload?.reason, reply.remainingGap || reply.takeaway),
    expectedGain: normalizeInfoGainLevel(payload?.expectedGain, "medium"),
    uiMode,
    shouldStop: Boolean(payload?.shouldStop),
    requiresResponse: payload?.requiresResponse ?? reply.requiresResponse
  };
}

function normalizeWritebackSuggestion(payload, reply, concept, session) {
  const confidenceLevel = normalizeConfidenceLevel(
    payload?.anchorPatch?.confidenceLevel,
    confidenceToLevel(reply.judge.confidence)
  );

  return {
    shouldWrite: payload?.shouldWrite !== false,
    mode: ensureString(payload?.mode, "immediate"),
    reason: ensureString(payload?.reason, "当前轮产生了可归档的能力证据。"),
    admission: ensureString(payload?.admission, "review"),
    anchorPatch: {
      state: allowedJudgeStates.has(payload?.anchorPatch?.state) ? payload.anchorPatch.state : reply.judge.state,
      confidenceLevel,
      derivedPrinciple: ensureString(payload?.anchorPatch?.derivedPrinciple, reply.takeaway || concept.summary),
      projectedTargets: ensureArray(payload?.anchorPatch?.projectedTargets)
        .map((item) => ensureString(item))
        .filter(Boolean)
        .slice(0, 4)
        .concat(session.targetBaseline?.id ? [session.targetBaseline.id] : [])
        .filter((value, index, array) => array.indexOf(value) === index)
    }
  };
}

export function normalizeTutorTurnEnvelope(payload, { concept, session, previousRuntimeMap = null }) {
  const reply = normalizeReply(payload?.reply || payload, concept);
  const runtimeMap = mergeRuntimeMaps(previousRuntimeMap, payload?.runtimeMap, concept);
  const nextMove = normalizeNextMove(payload?.nextMove, reply);
  const writebackSuggestion = normalizeWritebackSuggestion(
    payload?.writebackSuggestion,
    reply,
    concept,
    session
  );

  return {
    runtimeMap,
    nextMove,
    reply,
    writebackSuggestion
  };
}

export function assertTutorTurnEnvelope(envelope, { scopeType = "pack" } = {}) {
  if (!envelope?.runtimeMap?.anchorId) {
    throw new Error("Tutor intelligence returned an invalid tutor turn (missing runtime map).");
  }

  if (!envelope.reply?.visibleReply) {
    throw new Error("Tutor intelligence returned an invalid tutor turn (missing reply).");
  }

  if (envelope.runtimeMap.infoGainLevel === "negligible" && ["probe", "repair", "deepen", "check"].includes(envelope.nextMove.uiMode)) {
    throw new Error(
      `Tutor intelligence returned an inconsistent tutor turn (low-gain probe). nextMove=${envelope.nextMove.uiMode}`
    );
  }

  if (envelope.nextMove.shouldStop && envelope.reply.requiresResponse) {
    throw new Error("Tutor intelligence returned an inconsistent tutor turn (stop with required response).");
  }

  if (scopeType === "concept" && envelope.reply.completeCurrentUnit && envelope.nextMove.uiMode === "advance") {
    throw new Error("Tutor intelligence returned an inconsistent tutor turn (concept scope attempted to advance away).");
  }
}

export function resolveWritebackDecision({
  suggestion,
  judge,
  previousMemory,
  signal = "noise"
}) {
  const previousState = previousMemory?.state || "不可判";
  const stateChanged = previousState !== judge.state;
  const confidenceRaised = confidenceToLevel(previousMemory?.confidence ?? 0) !== suggestion.anchorPatch.confidenceLevel;
  const strongSignal = signal === "positive" || signal === "negative";

  const shouldApply =
    suggestion.shouldWrite &&
    (suggestion.admission === "strong" || stateChanged || confidenceRaised || strongSignal);

  return {
    shouldApply,
    mode: shouldApply ? "immediate" : "defer",
    reason: shouldApply
      ? suggestion.reason
      : "当前轮证据还不够强，先留在 session 证据层，不立即升级到长期记忆。"
  };
}
