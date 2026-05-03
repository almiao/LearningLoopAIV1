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

function buildCheckpointTransitionLabel(turn) {
  const trainingProgress = turn.trainingProgress || turn.questionMeta?.trainingProgress || null;
  const checkpointStatement =
    trainingProgress?.checkpoint?.statement ||
    turn.checkpointStatement ||
    turn.checkpointId ||
    "下一个子项";

  if (trainingProgress?.trainingPoint && trainingProgress?.checkpoint) {
    const point = trainingProgress.trainingPoint;
    const checkpoint = trainingProgress.checkpoint;
    const parts = [
      `训练点 ${point.currentIndex}/${point.total}`,
      `子项 ${checkpoint.currentIndex}/${checkpoint.total}`
    ].filter(Boolean);
    return `进展：${parts.join(" · ")}。现在进入：${checkpointStatement}`;
  }

  if (turn.checkpointStatement) {
    return `进展：现在进入：${turn.checkpointStatement}`;
  }
  if (turn.checkpointId) {
    return `进展：现在进入：${turn.checkpointId}`;
  }
  return "进展：进入下一个子项";
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

function buildEvaluationEntry(turn, index) {
  const assessment = turn.scoreSummary || null;
  if (!assessment || turn.action === "teach") {
    return null;
  }

  const bodyParts = [`本轮评价：${assessment.stateLabel || assessment.state || "已评分"}。`];
  if (assessment.keyClaim) {
    bodyParts.push(assessment.keyClaim);
  }
  if (assessment.hasMisconception && assessment.misconceptionDetail) {
    bodyParts.push(`要纠正：${assessment.misconceptionDetail}`);
  }

  return {
    id: `${createEntryId(turn, index)}:evaluation`,
    type: "message",
    role: "assistant",
    conceptId: turn.conceptId || "",
    conceptTitle: turn.conceptTitle || "",
    body: bodyParts[0] || "",
    bodyParts,
    isEvaluationMessage: true,
    timestamp: turn.timestamp || index
  };
}

function buildAssistantEntry(turn, index) {
  const bodyParts = buildAssistantBodyParts(turn);
  const isInProgressVerifyTurn =
    turn.action === "check" && Boolean(turn.candidateCoachingStep || turn.coachingStep);
  return {
    id: createEntryId(turn, index),
    type: "message",
    role: "assistant",
    conceptId: turn.conceptId || "",
    conceptTitle: turn.conceptTitle || "",
    body: bodyParts[0] || "",
    bodyParts,
    teachingParagraphs: [],
    takeaway: isInProgressVerifyTurn ? "" : turn.takeaway || "",
    followUpQuestion: "",
    candidateFollowUpQuestion: turn.candidateCoachingStep || "",
    coachingStep: turn.coachingStep || "",
    topicShiftLabel: "",
    action: turn.action || "",
    timestamp: turn.timestamp || index
  };
}

export function buildChatTimeline(turns = [], { limit = 24 } = {}) {
  const timeline = [];
  let lastCheckpointId = "";

  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    if (!turn) {
      continue;
    }

    if (turn.role === "system" && turn.kind === "workspace") {
      timeline.push({
        id: createEntryId(turn, index),
        type: "event",
        conceptId: turn.conceptId || "",
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
        conceptId: turn.conceptId || "",
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

    if (turn.kind === "question" && turn.checkpointId && turn.checkpointId !== lastCheckpointId) {
      const progressLabel = buildCheckpointTransitionLabel(turn);
      timeline.push({
        id: `${createEntryId(turn, index)}:checkpoint`,
        type: "message",
        role: "assistant",
        conceptId: turn.conceptId || "",
        body: progressLabel,
        bodyParts: [progressLabel],
        conceptTitle: turn.conceptTitle || "",
        isProgressUpdate: true,
        timestamp: turn.timestamp || index
      });
      lastCheckpointId = turn.checkpointId;
    }

    if (turn.kind === "feedback") {
      const evaluationEntry = buildEvaluationEntry(turn, index);
      if (evaluationEntry) {
        timeline.push(evaluationEntry);
      }

      const nextTurn = turns[index + 1];
      const sameConceptFollowUp =
        nextTurn?.role === "tutor" &&
        nextTurn.kind === "question" &&
        nextTurn.conceptId &&
        nextTurn.conceptId === turn.conceptId;

      if (sameConceptFollowUp) {
        timeline.push({
          ...buildAssistantEntry(turn, index),
          takeaway: "",
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
