// 一次性锚点判分的 Node 薄适配器 (PRODUCT.md §0.1)。
// 只负责把 题+答 发给 ai-service 的 /api/anchor-judge，判分逻辑全在 Python engine 那边
// （复用现有 LLM 管线，不是新引擎）。返回 {verdict, hits, misses, anchors, confidence, lowConfidence}。

const defaultAiServiceUrl = process.env.AI_SERVICE_URL || "http://127.0.0.1:8000";

export function createAnchorJudge({ aiServiceUrl = defaultAiServiceUrl, fetchImpl } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== "function") {
    throw new Error("createAnchorJudge: no fetch implementation available.");
  }
  const base = String(aiServiceUrl || "").replace(/\/+$/, "");

  return async function judge({ question, answer, sourceExcerpt = "" } = {}) {
    const response = await doFetch(`${base}/api/anchor-judge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question: String(question || ""),
        answer: String(answer || ""),
        sourceExcerpt: String(sourceExcerpt || ""),
      }),
    });
    if (!response.ok) {
      throw new Error(`anchor-judge request failed: ${response.status}`);
    }
    return response.json();
  };
}
