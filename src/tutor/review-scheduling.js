const DAY_MS = 24 * 60 * 60 * 1000;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function parseIso(value = "") {
  const date = new Date(value || "");
  return Number.isFinite(date.getTime()) ? date : null;
}

function addDays(timestamp, days) {
  return new Date(timestamp + days * DAY_MS).toISOString();
}

function intervalDaysForState(state = "unknown") {
  if (state === "weak") {
    return 1;
  }
  if (state === "partial") {
    return 3;
  }
  if (state === "solid") {
    return 10;
  }
  return 2;
}

export function scheduleCheckpointReview(previous = {}, {
  nextState = "unknown",
  signal = "noise",
  timestamp = new Date().toISOString(),
} = {}) {
  const reviewedAt = parseIso(timestamp)?.getTime() || Date.now();
  const previousStability = Number(previous.stability || 0);
  const previousConfidence = Number(previous.recallConfidence || 0);

  let stability = previousStability;
  let recallConfidence = previousConfidence;

  if (nextState === "weak") {
    stability = clamp(previousStability * 0.6 || 0.35, 0.2, 0.8);
    recallConfidence = clamp(previousConfidence * 0.65 || 0.35, 0.2, 0.65);
  } else if (nextState === "partial") {
    stability = clamp(Math.max(previousStability, 0.45) + (signal === "positive" ? 0.08 : 0.03), 0.35, 1.6);
    recallConfidence = clamp(Math.max(previousConfidence, 0.55) + (signal === "positive" ? 0.08 : 0.02), 0.45, 0.82);
  } else if (nextState === "solid") {
    stability = clamp(Math.max(previousStability, 0.9) + 0.2, 0.8, 3.2);
    recallConfidence = clamp(Math.max(previousConfidence, 0.8) + 0.08, 0.75, 0.98);
  } else {
    stability = clamp(previousStability || 0.4, 0.2, 1.2);
    recallConfidence = clamp(previousConfidence || 0.4, 0.2, 0.75);
  }

  let intervalDays = intervalDaysForState(nextState);
  if (signal === "negative") {
    intervalDays = Math.max(1, intervalDays - 1);
  }
  if (Array.isArray(previous.recentConflictingEvidence) && previous.recentConflictingEvidence.length > 0 && nextState !== "solid") {
    intervalDays = 1;
  }

  return {
    lastReviewedAt: new Date(reviewedAt).toISOString(),
    nextReviewAt: addDays(reviewedAt, intervalDays),
    stability,
    recallConfidence,
  };
}

