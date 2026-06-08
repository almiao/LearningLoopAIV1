import { createAnchorJudge } from "./anchor-judge.js";
import { createReviewItemStore } from "./review-item-store.js";

// 穿透适配器 (PRODUCT.md 阶段 3)。
//
// 挂在现有 drill 回路上：每完成一轮 drill，额外判一次一次性锚点，把「漏掉的」写成
// 复习项进失败账本。纪律：
//   - 只写不读：不读老 store、不改 UI、不做数据迁移。
//   - 失败驱动：只有判 fail 且有漏点才写（§4「练过不留痕」）。
//   - 绝不拖垮主流程：判分/写盘任何报错都吞掉，drill 照常进行（旁路、尽力而为）。

function deriveHandle(question = "") {
  const text = String(question || "").trim().replace(/\s+/g, " ");
  if (!text) {
    return "";
  }
  // 去掉句末问号/句号，截断成一句话 handle（fallback；调用方最好直接传 topic 作 handle）。
  const trimmed = text.replace(/[?？。.!！]+$/u, "");
  return trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed;
}

export function createDrillPassthrough({ store, judge, logger = console } = {}) {
  const reviewStore = store || createReviewItemStore();
  const anchorJudge = judge || createAnchorJudge();

  // 返回新建的复习项；没写则返回 null。永不抛出。
  return async function recordDrillRound({
    handle = "",
    question = "",
    answer = "",
    sourceRef = "",
    sourceExcerpt = "",
  } = {}) {
    try {
      if (!String(question).trim() || !String(answer).trim()) {
        return null;
      }
      const judgment = await anchorJudge({ question, answer, sourceExcerpt });
      const misses = Array.isArray(judgment?.misses) ? judgment.misses : [];
      // 过线、或没有漏点 → 不留痕。
      if (judgment?.verdict === "pass" || misses.length === 0) {
        return null;
      }
      const itemHandle = String(handle).trim() || deriveHandle(question);
      if (!itemHandle) {
        return null;
      }
      return await reviewStore.recordMiss({
        handle: itemHandle,
        source_ref: sourceRef,
        evidence: { question, missedAnchors: misses },
        state: "shaky",
      });
    } catch (error) {
      // 旁路、尽力而为：写账本失败绝不能影响用户正在进行的 drill。
      const message = error && error.message ? error.message : String(error);
      if (logger && typeof logger.warn === "function") {
        logger.warn(`[ledger] drill passthrough skipped: ${message}`);
      }
      return null;
    }
  };
}
