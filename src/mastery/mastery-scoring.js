import { masteryScoringConfig } from "./scoring-config.js";

const stateRank = masteryScoringConfig.stateRank;
const confidenceLevelScore = masteryScoringConfig.confidenceLevelScore;
const readingScoreConfig = masteryScoringConfig.readingScore;
const trainingScoreConfig = masteryScoringConfig.trainingScore;
const stabilityScoreConfig = masteryScoringConfig.stabilityScore;
const conflictPenaltyConfig = masteryScoringConfig.conflictPenalty;
const targetReadinessConfig = masteryScoringConfig.targetReadiness;
const labelConfig = masteryScoringConfig.labels;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function average(values = []) {
  if (!values.length) {
    return 0;
  }
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

export function rankState(state = "不可判") {
  return stateRank[state] ?? stateRank.weak;
}

export function confidenceLevelToScore(level = "low") {
  return confidenceLevelScore[level] ?? confidenceLevelScore.low;
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

export function buildMasteryLabel(score = 0, { hasEvidence = false, hasReading = false } = {}) {
  if (!hasEvidence && !hasReading) {
    return "未开始";
  }
  for (const entry of labelConfig.mastery) {
    if (score >= entry.min) {
      return entry.label;
    }
  }
  return "未开始";
}

export function buildTargetLabel(score = 0) {
  for (const entry of labelConfig.target) {
    if (score >= entry.min) {
      return entry.label;
    }
  }
  return "尚未建立证据";
}

export function calculateReadingScore(readingProgress = {}) {
  const progressPercentage = Number(readingProgress?.progressPercentage || 0);
  const dwellMs = Number(readingProgress?.dwellMs || 0);
  const completedReadCount = Number(readingProgress?.completedReadCount || 0);

  let score = 0;
  if (progressPercentage > 0) {
    score += readingScoreConfig.opened;
  }
  if (progressPercentage >= 25) {
    score += readingScoreConfig.progress25;
  }
  if (progressPercentage >= 50) {
    score += readingScoreConfig.progress50;
  }
  if (progressPercentage >= 75) {
    score += readingScoreConfig.progress75;
  }
  if (progressPercentage >= 90 && dwellMs >= 45_000) {
    score += readingScoreConfig.progress90Complete;
  }
  if (completedReadCount >= 2) {
    score += readingScoreConfig.secondFullReadBonus;
  }
  if (completedReadCount >= 3) {
    score += readingScoreConfig.thirdPlusFullReadBonus;
  }
  return clamp(score, 0, readingScoreConfig.max);
}

export function calculateTrainingScore(memoryItem = {}) {
  const evidenceCount = Number(memoryItem?.evidenceCount || 0);
  if (evidenceCount <= 0) {
    return 0;
  }

  const state = memoryItem?.state || "weak";
  const config = trainingScoreConfig[state] || trainingScoreConfig.weak;
  const score = config.base + Math.max(0, evidenceCount - 1) * config.repeat;
  return clamp(score, 0, Math.min(config.max, trainingScoreConfig.max));
}

export function calculateStabilityScore(memoryItem = {}) {
  const evidenceCount = Number(memoryItem?.evidenceCount || 0);
  if (evidenceCount <= 0) {
    return 0;
  }

  const state = memoryItem?.state || "不可判";
  const strongEvidenceCount = asArray(memoryItem?.recentStrongEvidence).length;
  if (state === "solid" && strongEvidenceCount >= 2) {
    return stabilityScoreConfig.repeatedSolid;
  }
  if (state === "solid" && strongEvidenceCount >= 1) {
    return stabilityScoreConfig.singleSolid;
  }
  if ((state === "partial" || state === "solid") && evidenceCount >= 2) {
    return stabilityScoreConfig.repeatedPartialOrAbove;
  }
  if (state === "partial" || state === "solid") {
    return stabilityScoreConfig.partialOrAbove;
  }
  return 0;
}

export function calculateConflictPenalty(memoryItem = {}) {
  const conflicts = asArray(memoryItem?.recentConflictingEvidence).length;
  if (!conflicts) {
    return 0;
  }

  let penalty = conflicts * conflictPenaltyConfig.perConflict;
  if ((memoryItem?.state || "不可判") === "weak") {
    penalty += conflictPenaltyConfig.weakStateExtra;
  }
  return clamp(penalty, 0, conflictPenaltyConfig.max);
}

export function calculateMasteryScore({ readingProgress = null, memoryItem = null } = {}) {
  const readingScore = calculateReadingScore(readingProgress || {});
  const trainingScore = calculateTrainingScore(memoryItem || {});
  const stabilityScore = calculateStabilityScore(memoryItem || {});
  const conflictPenalty = calculateConflictPenalty(memoryItem || {});

  return clamp(readingScore + trainingScore + stabilityScore - conflictPenalty, 0, 100);
}

export function calculateTargetReadinessScore(items = []) {
  if (!items.length) {
    return targetReadinessConfig.min;
  }

  const score = average(items.map((item) => Number(item?.masteryScore || 0)));
  return clamp(score, targetReadinessConfig.min, targetReadinessConfig.max);
}
