// 从一段 session turns 里抽出「最近一轮已完成的 drill」：
// 最后一条真正的学习者回答 + 它前面最近的那道 tutor 提问。
//
// turn 形状见 src/view/chat-transcript.js：
//   - tutor 提问：role="tutor", kind="question", content=问题文本, conceptTitle=话题
//   - 学习者回答：role="learner", content=回答文本（kind="control" 的是「请求讲解/切题」，不是回答）

export function extractLastDrillRound(turns = []) {
  if (!Array.isArray(turns) || turns.length === 0) {
    return null;
  }

  let answerIndex = -1;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (turn && turn.role === "learner" && turn.kind !== "control" && String(turn.content || "").trim()) {
      answerIndex = i;
      break;
    }
  }
  if (answerIndex === -1) {
    return null;
  }

  let questionTurn = null;
  for (let i = answerIndex - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (turn && turn.role === "tutor" && turn.kind === "question" && String(turn.content || "").trim()) {
      questionTurn = turn;
      break;
    }
  }
  if (!questionTurn) {
    return null;
  }

  return {
    question: String(questionTurn.content).trim(),
    answer: String(turns[answerIndex].content).trim(),
    handle: String(questionTurn.conceptTitle || "").trim(),
    conceptId: questionTurn.conceptId || "",
  };
}
