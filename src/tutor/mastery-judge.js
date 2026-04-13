import { evaluateAbstention } from "./abstention-policy.js";

export function judgeConcept({
  entry,
  sourceAligned = true,
  promptContaminated = false,
  informationGain = 1
}) {
  const abstention = evaluateAbstention({
    sourceAligned,
    promptContaminated,
    informationGain,
    entry
  });

  const positives = entry.entries.filter((item) => item.signal === "positive").length;
  const negatives = entry.entries.filter((item) => item.signal === "negative").length;

  if (abstention.status === "stop") {
    return {
      state: "不可判",
      confidence: 0,
      reasons: abstention.reasons
    };
  }

  if (abstention.status === "partial" && positives <= 1) {
    return {
      state: "partial",
      confidence: 0.4,
      reasons: abstention.reasons
    };
  }

  if (positives >= 2 && negatives === 0) {
    return {
      state: "solid",
      confidence: 0.85,
      reasons: ["回答在多轮追问中保持稳定"]
    };
  }

  if (positives >= 1) {
    return {
      state: "partial",
      confidence: 0.6,
      reasons: negatives > 0 ? ["理解部分成立，但仍有冲突"] : ["已有积极证据，但仍需追问"]
    };
  }

  return {
    state: "weak",
    confidence: 0.25,
    reasons: negatives > 0 ? ["关键解释失败或明显遗漏"] : ["有效证据不足"]
  };
}
