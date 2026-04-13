function createEntryId(turn, index) {
  return [
    turn.role || "unknown",
    turn.kind || "message",
    turn.conceptId || "general",
    turn.timestamp || index
  ].join(":");
}

function buildWorkspaceLabel(turn) {
  if (turn.action === "focus-domain") {
    return `已切换到该主题：${turn.conceptTitle || "新主题"}`;
  }

  if (turn.action === "focus-concept") {
    return `已定位到这一题：${turn.conceptTitle || "当前题目"}`;
  }

  return turn.conceptTitle ? `已切换到：${turn.conceptTitle}` : "已更新当前面试上下文";
}

function buildUserIntentLabel(turn) {
  if (turn.kind !== "control") {
    return "";
  }

  if (turn.action === "teach") {
    return "请求讲解";
  }

  if (turn.action === "advance") {
    return "切到下一题";
  }

  return "";
}

function buildAssistantBodyParts(turn) {
  return [String(turn?.content || "").trim()].filter(Boolean);
}

function buildAssistantEntry(turn, index) {
  const bodyParts = buildAssistantBodyParts(turn);
  return {
    id: createEntryId(turn, index),
    type: "message",
    role: "assistant",
    conceptTitle: turn.conceptTitle || "",
    body: bodyParts[0] || "",
    bodyParts,
    teachingParagraphs: [],
    takeaway: "",
    followUpQuestion: "",
    candidateFollowUpQuestion: turn.candidateCoachingStep || "",
    coachingStep: turn.coachingStep || "",
    topicShiftLabel: "",
    timestamp: turn.timestamp || index
  };
}

export function buildChatTimeline(turns = [], { limit = 24 } = {}) {
  const timeline = [];

  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    if (!turn) {
      continue;
    }

    if (turn.role === "system" && turn.kind === "workspace") {
      timeline.push({
        id: createEntryId(turn, index),
        type: "event",
        label: buildWorkspaceLabel(turn),
        conceptTitle: turn.conceptTitle || "",
        timestamp: turn.timestamp || index
      });
      continue;
    }

    if (turn.role === "learner") {
      timeline.push({
        id: createEntryId(turn, index),
        type: "message",
        role: "user",
        conceptTitle: turn.conceptTitle || "",
        body: turn.content || "",
        intentLabel: buildUserIntentLabel(turn),
        timestamp: turn.timestamp || index
      });
      continue;
    }

    if (turn.role !== "tutor") {
      continue;
    }

    if (turn.kind === "feedback") {
      const nextTurn = turns[index + 1];
      const sameConceptFollowUp =
        nextTurn?.role === "tutor" &&
        nextTurn.kind === "question" &&
        nextTurn.conceptId &&
        nextTurn.conceptId === turn.conceptId;

      if (sameConceptFollowUp) {
        timeline.push({
          ...buildAssistantEntry(turn, index),
          candidateFollowUpQuestion: "",
          coachingStep: ""
        });
        continue;
      }
    }

    timeline.push(buildAssistantEntry(turn, index));
  }

  return timeline.slice(-limit);
}
