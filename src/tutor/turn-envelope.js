const allowedInfoGainLevels = new Set(["high", "medium", "low", "negligible"]);
const allowedConfidenceLevels = new Set(["high", "medium", "low"]);
const allowedStates = new Set(["solid", "partial", "weak", "不可判"]);
const allowedSignals = new Set(["positive", "negative", "noise"]);
const allowedUiModes = new Set(["probe", "teach", "verify", "advance", "revisit", "stop"]);
const confidenceScoreMap = {
  high: 0.84,
  medium: 0.58,
  low: 0.28
};

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function ensureNonEmptyString(value, label) {
  assert(typeof value === "string" && value.trim().length > 0, `Turn envelope ${label} is required.`);
}

export function confidenceLevelToScore(level = "low") {
  return confidenceScoreMap[level] ?? confidenceScoreMap.low;
}

export function scoreToConfidenceLevel(score = 0) {
  if (score >= 0.75) {
    return "high";
  }

  if (score >= 0.45) {
    return "medium";
  }

  return "low";
}

export function createEmptyRuntimeMap(anchorId) {
  return {
    anchor_id: anchorId,
    turn_signal: "noise",
    anchor_assessment: {
      state: "不可判",
      confidence_level: "low",
      reasons: ["当前还没有足够证据，先保持保守判断"]
    },
    hypotheses: [],
    misunderstandings: [],
    open_questions: [],
    verification_targets: [],
    info_gain_level: "medium"
  };
}

export function normalizeConfidenceLevel(level, fallback = "low") {
  return allowedConfidenceLevels.has(level) ? level : fallback;
}

export function normalizeInfoGainLevel(level, fallback = "medium") {
  return allowedInfoGainLevels.has(level) ? level : fallback;
}

function normalizeHypothesis(entry, index) {
  return {
    id: typeof entry?.id === "string" && entry.id.trim() ? entry.id : `hypothesis-${index + 1}`,
    status: ["supported", "unsupported", "contradicted", "unknown"].includes(entry?.status)
      ? entry.status
      : "unknown",
    confidence_level: normalizeConfidenceLevel(entry?.confidence_level, "low"),
    evidence_refs: Array.isArray(entry?.evidence_refs) ? entry.evidence_refs.filter(Boolean).slice(0, 4) : [],
    note: typeof entry?.note === "string" ? entry.note : ""
  };
}

function normalizeMisunderstanding(entry, index) {
  return {
    label:
      typeof entry?.label === "string" && entry.label.trim()
        ? entry.label
        : `misunderstanding-${index + 1}`,
    confidence_level: normalizeConfidenceLevel(entry?.confidence_level, "low"),
    evidence_refs: Array.isArray(entry?.evidence_refs) ? entry.evidence_refs.filter(Boolean).slice(0, 4) : []
  };
}

export function mergeRuntimeMaps(previousMap = null, nextMap = null, expectedAnchorId = "") {
  if (!previousMap) {
    return nextMap;
  }
  if (!nextMap) {
    return previousMap;
  }

  const anchorId = nextMap.anchor_id || previousMap.anchor_id || expectedAnchorId;
  const hypothesisMap = new Map();
  for (const [index, entry] of (previousMap.hypotheses || []).entries()) {
    const normalized = normalizeHypothesis(entry, index);
    hypothesisMap.set(normalized.id, normalized);
  }
  for (const [index, entry] of (nextMap.hypotheses || []).entries()) {
    const normalized = normalizeHypothesis(entry, index);
    hypothesisMap.set(normalized.id, normalized);
  }

  const misunderstandingMap = new Map();
  for (const [index, entry] of [...(previousMap.misunderstandings || []), ...(nextMap.misunderstandings || [])].entries()) {
    const normalized = normalizeMisunderstanding(entry, index);
    misunderstandingMap.set(normalized.label, normalized);
  }

  const verificationTargets = [];
  const verificationKeys = new Set();
  for (const entry of [...(previousMap.verification_targets || []), ...(nextMap.verification_targets || [])]) {
    const key = `${entry?.id || ""}:${entry?.question || ""}`;
    if (!key.trim() || verificationKeys.has(key)) {
      continue;
    }
    verificationKeys.add(key);
    verificationTargets.push(entry);
  }

  return {
    anchor_id: anchorId,
    turn_signal: nextMap.turn_signal || previousMap.turn_signal || "noise",
    anchor_assessment: nextMap.anchor_assessment || previousMap.anchor_assessment,
    hypotheses: [...hypothesisMap.values()].slice(0, 6),
    misunderstandings: [...misunderstandingMap.values()].slice(0, 4),
    open_questions: [...new Set([...(previousMap.open_questions || []), ...(nextMap.open_questions || [])])].slice(0, 4),
    verification_targets: verificationTargets.slice(0, 4),
    info_gain_level: normalizeInfoGainLevel(nextMap.info_gain_level || previousMap.info_gain_level, "medium")
  };
}

export function buildControlVerdict({
  envelope,
  contextPacket,
  scopeType = "pack"
}) {
  const nextMove = envelope.next_move || {};
  const reply = envelope.reply || {};
  const runtimeMap = envelope.runtime_map || {};
  const stopConditions = contextPacket.stop_conditions || {};
  const budget = contextPacket.budget || {};

  let shouldStop = false;
  let reason = "continue";
  if (["advance", "stop", "revisit"].includes(nextMove.ui_mode) || reply.requires_response === false) {
    shouldStop = true;
    reason = "next_move_requests_stop";
  } else if (runtimeMap.info_gain_level === "negligible") {
    reason = "low_information_gain";
  } else if (stopConditions.probe_budget_reached) {
    reason = "probe_budget_reached";
  } else if (stopConditions.friction_high) {
    reason = "high_friction";
  }

  if (scopeType === "concept" && nextMove.ui_mode === "advance") {
    reason = "concept_scope_guard";
  }

  return {
    should_stop: shouldStop,
    reason,
    confidence_level: runtimeMap.anchor_assessment?.confidence_level || "low",
    scope_type: scopeType,
    budget_snapshot: {
      remaining_probe_turns: budget.remaining_probe_turns ?? null,
      remaining_teach_turns: budget.remaining_teach_turns ?? null
    }
  };
}

function validateRuntimeMap(runtimeMap, expectedAnchorId) {
  assert(runtimeMap && typeof runtimeMap === "object", "Turn envelope runtime_map is required.");
  assert(runtimeMap.anchor_id === expectedAnchorId, "Turn envelope runtime_map anchor_id mismatch.");
  assert(allowedSignals.has(runtimeMap.turn_signal), "Turn envelope runtime_map turn_signal is invalid.");
  assert(runtimeMap.anchor_assessment, "Turn envelope runtime_map anchor_assessment is required.");
  assert(
    allowedStates.has(runtimeMap.anchor_assessment.state),
    "Turn envelope runtime_map anchor_assessment state is invalid."
  );
  assert(
    allowedConfidenceLevels.has(runtimeMap.anchor_assessment.confidence_level),
    "Turn envelope runtime_map anchor_assessment confidence_level is invalid."
  );
  assert(Array.isArray(runtimeMap.anchor_assessment.reasons), "Turn envelope runtime_map reasons are invalid.");
  assert(
    allowedInfoGainLevels.has(runtimeMap.info_gain_level),
    "Turn envelope runtime_map info_gain_level is invalid."
  );
}

function validateNextMove(nextMove) {
  assert(nextMove && typeof nextMove === "object", "Turn envelope next_move is required.");
  ensureNonEmptyString(nextMove.intent, "next_move.intent");
  ensureNonEmptyString(nextMove.reason, "next_move.reason");
  assert(allowedUiModes.has(nextMove.ui_mode), "Turn envelope next_move ui_mode is invalid.");
  assert(
    allowedInfoGainLevels.has(nextMove.expected_gain),
    "Turn envelope next_move expected_gain is invalid."
  );
}

function validateReply(reply) {
  assert(reply && typeof reply === "object", "Turn envelope reply is required.");
  ensureNonEmptyString(reply.visible_reply, "reply.visible_reply");
  ensureNonEmptyString(reply.evidence_reference, "reply.evidence_reference");
  ensureNonEmptyString(reply.takeaway, "reply.takeaway");
  assert(typeof reply.requires_response === "boolean", "Turn envelope reply.requires_response is invalid.");
  assert(typeof reply.complete_current_unit === "boolean", "Turn envelope reply.complete_current_unit is invalid.");
  if (reply.requires_response) {
    ensureNonEmptyString(reply.next_prompt, "reply.next_prompt");
  }
  if (reply.teaching_paragraphs) {
    assert(Array.isArray(reply.teaching_paragraphs), "Turn envelope reply.teaching_paragraphs is invalid.");
  }
}

function validateWritebackSuggestion(suggestion) {
  assert(
    suggestion && typeof suggestion === "object",
    "Turn envelope writeback_suggestion is required."
  );
  assert(typeof suggestion.should_write === "boolean", "Turn envelope writeback_suggestion.should_write is invalid.");
  assert(
    ["update", "append_conflict", "noop"].includes(suggestion.mode),
    "Turn envelope writeback_suggestion.mode is invalid."
  );
  ensureNonEmptyString(suggestion.reason, "writeback_suggestion.reason");
  assert(
    suggestion.anchor_patch && typeof suggestion.anchor_patch === "object",
    "Turn envelope writeback_suggestion.anchor_patch is required."
  );
  assert(
    allowedStates.has(suggestion.anchor_patch.state),
    "Turn envelope writeback_suggestion.anchor_patch.state is invalid."
  );
  assert(
    allowedConfidenceLevels.has(suggestion.anchor_patch.confidence_level),
    "Turn envelope writeback_suggestion.anchor_patch.confidence_level is invalid."
  );
}

export function assertValidTurnEnvelope(envelope, expectedAnchorId) {
  assert(envelope && typeof envelope === "object", "Turn envelope payload is required.");
  validateRuntimeMap(envelope.runtime_map, expectedAnchorId);
  validateNextMove(envelope.next_move);
  validateReply(envelope.reply);
  validateWritebackSuggestion(envelope.writeback_suggestion);
}

export function assertConsistentTurnEnvelope(envelope, contextPacket) {
  const { runtime_map: runtimeMap, next_move: nextMove, reply } = envelope;

  if (runtimeMap.info_gain_level === "negligible" && nextMove.ui_mode === "probe") {
    throw new Error("Turn envelope is inconsistent: negligible info gain cannot continue probing.");
  }

  if (contextPacket.stop_conditions?.should_discourage_more_probe && nextMove.ui_mode === "probe") {
    throw new Error("Turn envelope is inconsistent: stop conditions discourage more probing.");
  }

  if (["advance", "stop", "revisit"].includes(nextMove.ui_mode) && reply.requires_response) {
    throw new Error("Turn envelope is inconsistent: non-interactive moves cannot require a response.");
  }

  if (["probe", "verify"].includes(nextMove.ui_mode) && !reply.requires_response) {
    throw new Error("Turn envelope is inconsistent: probing moves must require a response.");
  }

  if (nextMove.ui_mode === "teach" && (!Array.isArray(reply.teaching_paragraphs) || !reply.teaching_paragraphs.length)) {
    throw new Error("Turn envelope is inconsistent: teach move requires teaching_paragraphs.");
  }
}

export function turnEnvelopeToTutorMove(envelope, concept) {
  const { runtime_map: runtimeMap, next_move: nextMove, reply } = envelope;
  const moveType =
    nextMove.ui_mode === "teach"
      ? "teach"
      : nextMove.ui_mode === "verify"
        ? runtimeMap.turn_signal === "positive"
          ? "deepen"
          : "check"
        : nextMove.ui_mode === "advance" || nextMove.ui_mode === "revisit"
          ? "advance"
          : nextMove.ui_mode === "stop"
            ? "abstain"
            : runtimeMap.turn_signal === "positive"
              ? "deepen"
              : "repair";

  return {
    moveType,
    signal: runtimeMap.turn_signal,
    judge: {
      state: runtimeMap.anchor_assessment.state,
      confidence: confidenceLevelToScore(runtimeMap.anchor_assessment.confidence_level),
      confidenceLevel: runtimeMap.anchor_assessment.confidence_level,
      reasons: runtimeMap.anchor_assessment.reasons
    },
    visibleReply: reply.visible_reply,
    evidenceReference: reply.evidence_reference || concept.excerpt,
    teachingChunk: Array.isArray(reply.teaching_paragraphs) ? reply.teaching_paragraphs.join("\n\n") : "",
    teachingParagraphs: Array.isArray(reply.teaching_paragraphs) ? reply.teaching_paragraphs : [],
    nextQuestion: reply.next_prompt || "",
    takeaway: reply.takeaway || concept.summary,
    confirmedUnderstanding: reply.confirmed_understanding || "",
    remainingGap: reply.remaining_gap || "",
    revisitReason: reply.revisit_reason || "",
    completeCurrentUnit: reply.complete_current_unit,
    requiresResponse: reply.requires_response,
    nextMove: nextMove,
    runtimeMap: runtimeMap,
    writebackSuggestion: envelope.writeback_suggestion
  };
}
