import { buildChatTimeline } from "./chat-transcript.js";

function trimSentenceEnding(value = "") {
  return String(value || "").trim().replace(/[。；;，,]+$/u, "");
}

function buildVisibleMemorySummary(session = {}) {
  const events = session?.latestMemoryEvents || [];
  if (!events.length) {
    return "";
  }

  const feedback = session?.latestFeedback || null;
  const scoreSummary = feedback?.scoreSummary || null;
  const conceptTitle = String(
    feedback?.conceptTitle
    || events.find((event) => event?.title)?.title
    || "这个知识点"
  ).trim();
  const userKeyClaim = String(scoreSummary?.keyClaim || "").trim();

  const hasImprovement = events.some((event) => event?.type === "improvement_detected");
  const hasContradiction = events.some((event) => event?.type === "contradiction_detected");
  const hasWeakness = events.some((event) => event?.type === "weakness_confirmed");
  const hasRevisit = events.some((event) => event?.type === "revisit_queued");
  const hasWriteback = events.some((event) => event?.type === "memory_writeback_applied");

  if (hasContradiction) {
    return `已记住：你在“${conceptTitle}”这个点前后回答不一致；后续会先复核这个知识点。`;
  }

  if (hasWeakness || hasRevisit) {
    return `已记住：你在“${conceptTitle}”这个点还不稳；后续会优先回顾。`;
  }

  if (hasImprovement && userKeyClaim) {
    return `已记住：${trimSentenceEnding(userKeyClaim)}；后续会在这个基础上继续追问。`;
  }

  if (hasImprovement) {
    return `已记住：你在“${conceptTitle}”这个点更稳了；后续会在这个基础上继续追问。`;
  }

  if (hasWriteback) {
    return `已记住：这轮关于“${conceptTitle}”的回答已写入学习记录；后续会据此调整追问。`;
  }

  return "";
}

export function buildVisibleSessionView(session, { timelineLimit = null } = {}) {
  const turns = session?.turns || [];
  const limit = timelineLimit ?? Math.max(turns.length, 24);

  return {
    chatTimeline: buildChatTimeline(turns, { limit }),
    currentProbe: session?.currentProbe || "",
    latestFeedback: session?.latestFeedback || null,
    targetMatch: session?.targetMatch || null,
    latestMemoryEvents: session?.latestMemoryEvents || [],
    latestMemorySummary: buildVisibleMemorySummary(session),
    interactionLog: session?.interactionLog || []
  };
}
