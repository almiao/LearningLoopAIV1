import { buildChatTimeline } from "./chat-transcript.js";

export function buildVisibleSessionView(session, { timelineLimit = null } = {}) {
  const turns = session?.turns || [];
  const limit = timelineLimit ?? Math.max(turns.length, 24);

  return {
    chatTimeline: buildChatTimeline(turns, { limit }),
    currentProbe: session?.currentProbe || "",
    latestFeedback: session?.latestFeedback || null,
    targetMatch: session?.targetMatch || null,
    latestMemoryEvents: session?.latestMemoryEvents || [],
    interactionLog: session?.interactionLog || []
  };
}
