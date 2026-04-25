import { normalizeWhitespace } from "../material/material-model.js";

const allowedControlIntents = new Set(["advance", "teach", "summarize"]);

export function normalizeControlIntent(intent) {
  const normalized = normalizeWhitespace(intent).toLowerCase();
  return allowedControlIntents.has(normalized) ? normalized : null;
}

export function detectControlIntent(answer, explicitIntent = "") {
  const normalizedIntent = normalizeControlIntent(explicitIntent);
  if (normalizedIntent) {
    return normalizedIntent;
  }

  const normalized = normalizeWhitespace(answer).toLowerCase();
  if (!normalized) {
    return null;
  }

  if (["下一题", "跳过", "skip", "next"].map((item) => item.toLowerCase()).includes(normalized)) {
    return "advance";
  }

  if (["讲一下", "先讲一下", "直接讲", "给答案", "解释一下"].map((item) => item.toLowerCase()).includes(normalized)) {
    return "teach";
  }

  if (
    ["总结一下", "总结", "收尾一下", "面试总结", "给个总结", "wrap up"].map((item) => item.toLowerCase()).includes(normalized)
  ) {
    return "summarize";
  }

  return null;
}
