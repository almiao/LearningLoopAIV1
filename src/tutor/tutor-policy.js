export function normalizeInteractionPreference(value) {
  const allowed = new Set(["probe-heavy", "balanced", "explain-first"]);
  return allowed.has(value) ? value : "balanced";
}

function estimateFatigue({ burdenSignal, attempts }) {
  if (burdenSignal === "high") {
    return "high";
  }

  if (attempts >= 2) {
    return "medium";
  }

  return "low";
}

function estimateQuestionHeadroom({ concept, attempts, review }) {
  if (concept.coverage === "low") {
    return "low";
  }

  if (attempts >= 2) {
    return "low";
  }

  if (review.judge.state === "solid" || review.judge.confidence >= 0.8) {
    return "low";
  }

  if (concept.coverage === "high" && attempts === 0) {
    return "high";
  }

  return "medium";
}

export function chooseNextAction({
  concept,
  conceptState,
  review,
  burdenSignal = "normal",
  interactionPreference = "balanced"
}) {
  const preference = normalizeInteractionPreference(interactionPreference);
  const attempts = conceptState.attempts;
  const fatigue = estimateFatigue({ burdenSignal, attempts });
  const headroom = estimateQuestionHeadroom({ concept, attempts, review });
  const importance = concept.importance || "secondary";
  const teachCount = conceptState.teachCount || 0;

  if (review.judge.state === "不可判") {
    return { action: "abstain", fatigue, headroom };
  }

  if (review.signal === "positive") {
    if (
      fatigue === "high" ||
      headroom === "low" ||
      (importance !== "core" && review.judge.confidence >= 0.6)
    ) {
      return { action: "advance", fatigue, headroom };
    }

    return {
      action: preference === "explain-first" ? "affirm" : "deepen",
      fatigue,
      headroom
    };
  }

  if (
    attempts >= 2 ||
    fatigue === "high" ||
    headroom === "low" ||
    preference === "explain-first"
  ) {
    if (teachCount >= 1 && (importance !== "core" || headroom === "low" || fatigue !== "low")) {
      return { action: "advance", fatigue, headroom };
    }
    return { action: "teach", fatigue, headroom };
  }

  return { action: "repair", fatigue, headroom };
}

export function buildPromptForAction({ action, concept, review, burdenSignal = "normal" }) {
  switch (action) {
    case "affirm":
    case "deepen":
      return review.nextQuestion || concept.stretchQuestion || concept.checkQuestion;
    case "repair":
      return review.nextQuestion || concept.retryQuestion || concept.checkQuestion;
    case "teach":
      return concept.checkQuestion || review.nextQuestion || concept.retryQuestion;
    case "summarize":
      return "";
    case "advance":
    case "abstain":
      return "";
    default:
      return burdenSignal === "high" ? concept.checkQuestion : review.nextQuestion || concept.retryQuestion;
  }
}
