import { normalizeWhitespace } from "../material/material-model.js";

export function detectControlIntent(answer) {
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

  return null;
}
