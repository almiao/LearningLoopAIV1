const fillerWords = ["maybe", "kind of", "sort of", "不知道", "不太清楚", "随便", "感觉"];

export function detectNoise(answer) {
  const text = String(answer ?? "").trim().toLowerCase();
  if (!text || text.length < 16) {
    return true;
  }

  return fillerWords.some((word) => text.includes(word));
}

export function evaluateAbstention({
  sourceAligned = true,
  promptContaminated = false,
  informationGain = 1,
  entry
}) {
  const reasons = [];

  if (!sourceAligned) {
    reasons.push("题意未对齐");
  }

  if (promptContaminated) {
    reasons.push("提示污染证据");
  }

  if (!entry || entry.entries.length === 0) {
    reasons.push("没有有效证据");
  }

  const positiveEntries = entry?.entries.filter((item) => item.signal === "positive") ?? [];
  const negativeEntries = entry?.entries.filter((item) => item.signal === "negative") ?? [];
  const noisyEntries = entry?.entries.filter((item) => item.signal === "noise") ?? [];

  if (positiveEntries.length + negativeEntries.length <= 1) {
    reasons.push("证据只覆盖单维度");
  }

  if (noisyEntries.length > 1) {
    reasons.push("表达噪声污染");
  }

  if (positiveEntries.length > 0 && negativeEntries.length > 0) {
    reasons.push("证据互相冲突");
  }

  if (informationGain <= 0) {
    reasons.push("新增追问已无信息增益");
  }

  if (reasons.length === 0) {
    return {
      status: "judge",
      label: null,
      reasons: []
    };
  }

  const severe = reasons.includes("提示污染证据") || reasons.includes("新增追问已无信息增益");
  return {
    status: severe ? "abstain" : "partial",
    label: severe ? "当前不可判" : "仅部分可判",
    reasons
  };
}
