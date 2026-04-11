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

function collectTeachingParagraphs(turn) {
  return Array.isArray(turn?.teachingParagraphs)
    ? turn.teachingParagraphs.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
}

function buildAssistantBodyParts(turn) {
  return [String(turn?.content || "").trim(), ...collectTeachingParagraphs(turn)].filter(Boolean);
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function buildTakeaway(turn) {
  const takeaway = normalizeText(turn?.takeaway || "");
  if (!takeaway) {
    return "";
  }

  const action = String(turn?.action || "").trim();
  const bodyParts = buildAssistantBodyParts(turn).map((item) => normalizeText(item));
  const shouldShow =
    action === "teach" ||
    action === "advance" ||
    action === "abstain" ||
    (!turn?.coachingStep && !turn?.candidateCoachingStep);

  if (!shouldShow) {
    return "";
  }

  return bodyParts.includes(takeaway) ? "" : takeaway;
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
    teachingParagraphs: collectTeachingParagraphs(turn),
    takeaway: buildTakeaway(turn),
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
        const bodyParts = buildAssistantBodyParts(turn);
        timeline.push({
          id: `${createEntryId(turn, index)}+${createEntryId(nextTurn, index + 1)}`,
          type: "message",
          role: "assistant",
          conceptTitle: nextTurn.conceptTitle || turn.conceptTitle || "",
          body: bodyParts[0] || "",
          bodyParts,
          teachingParagraphs: collectTeachingParagraphs(turn),
          takeaway: buildTakeaway(turn),
          followUpQuestion: nextTurn.content || "",
          candidateFollowUpQuestion:
            turn.candidateCoachingStep && turn.candidateCoachingStep !== nextTurn.content
              ? turn.candidateCoachingStep
              : "",
          coachingStep:
            turn.coachingStep && turn.coachingStep !== nextTurn.content ? turn.coachingStep : "",
          topicShiftLabel:
            nextTurn.conceptId && nextTurn.conceptId !== turn.conceptId && nextTurn.conceptTitle
              ? `接下来进入：${nextTurn.conceptTitle}`
              : "",
          timestamp: nextTurn.timestamp || turn.timestamp || index
        });
        index += 1;
        continue;
      }
    }

    timeline.push(buildAssistantEntry(turn, index));
  }

  return timeline.slice(-limit);
}
