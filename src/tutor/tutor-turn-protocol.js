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

function normalizeNextMove(payload) {
  const uiMode = ensureString(payload?.uiMode, "repair");
  return {
    intent: ensureString(payload?.intent, "先继续围绕当前点推进。"),
    reason: ensureString(payload?.reason, "当前还需要一个更明确的下一步判断。"),
    expectedGain: normalizeInfoGainLevel(payload?.expectedGain, "medium"),
    uiMode,
    shouldStop: payload?.shouldStop ?? ["advance", "stop", "revisit"].includes(uiMode),
    followUpQuestion: ensureString(payload?.followUpQuestion)
  };
}

function normalizeWritebackSuggestion(payload, concept, session) {
  const confidenceLevel = normalizeConfidenceLevel(
    payload?.anchorPatch?.confidenceLevel,
    "medium"
  );

  return {
    shouldWrite: payload?.shouldWrite !== false,
    mode: ensureString(payload?.mode, "immediate"),
    reason: ensureString(payload?.reason, "当前轮产生了可归档的能力证据。"),
    admission: ensureString(payload?.admission, "review"),
    anchorPatch: {
      state: allowedJudgeStates.has(payload?.anchorPatch?.state) ? payload.anchorPatch.state : "partial",
      confidenceLevel,
      derivedPrinciple: ensureString(payload?.anchorPatch?.derivedPrinciple, concept.summary),
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
  const runtimeMap = mergeRuntimeMaps(previousRuntimeMap, payload?.runtimeMap, concept);
  const nextMove = normalizeNextMove(payload?.nextMove);
  const writebackSuggestion = normalizeWritebackSuggestion(
    payload?.writebackSuggestion,
    concept,
    session
  );

  return {
    runtimeMap,
    nextMove,
    writebackSuggestion
  };
}

export function assertTutorTurnEnvelope(envelope, { scopeType = "pack" } = {}) {
  if (!envelope?.runtimeMap?.anchorId) {
    throw new Error("Tutor intelligence returned an invalid tutor turn (missing runtime map).");
  }

  if (envelope.runtimeMap.infoGainLevel === "negligible" && ["probe", "repair", "deepen", "check"].includes(envelope.nextMove.uiMode)) {
    throw new Error(
      `Tutor intelligence returned an inconsistent tutor turn (low-gain probe). nextMove=${envelope.nextMove.uiMode}`
    );
  }

  if (
    ["probe", "teach", "verify"].includes(envelope.nextMove.uiMode) &&
    !envelope.nextMove.followUpQuestion
  ) {
    throw new Error("Tutor intelligence returned an inconsistent tutor turn (interactive move without follow-up).");
  }

  if (scopeType === "concept" && envelope.nextMove.uiMode === "advance") {
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
