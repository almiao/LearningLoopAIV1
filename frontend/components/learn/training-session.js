"use client";

import { useState } from "react";
import Link from "next/link";
import { TrainingGenerationPanel } from "../training-generation-panel";
import { getTurnTimeLabel } from "./shared";

const rescueSourceLabels = {
  reuse: "复用已有资料",
  generate: "AI 生成讲解",
  checked: "生成 · 已联网核对",
};

function getRescueSourceLabel(source = "") {
  return rescueSourceLabels[String(source || "").toLowerCase()] || rescueSourceLabels.generate;
}

function normalizeComparableText(value = "") {
  return String(value || "")
    .replace(/[`\-*#。：:，,！!？?\s]/g, "")
    .trim()
    .toLowerCase();
}

function isMeaningfullyDuplicate(left = "", right = "") {
  const a = normalizeComparableText(left);
  const b = normalizeComparableText(right);
  if (!a || !b) {
    return false;
  }
  return a === b || a.includes(b) || b.includes(a);
}

export const trainingWaitStepKeys = ["understand_question", "retrieve_source", "compose_explanation", "generate_followup"];

export function createTrainingWaitState({ submittedAnswer = "", intent = "" } = {}) {
  return {
    submittedAnswer,
    intent,
    currentStepKey: "understand_question",
    completedStepKeys: [],
    streamingText: "",
    slow: false,
    startedAt: Date.now(),
  };
}

export function appendCompletedStep(completedStepKeys = [], stepKey = "") {
  if (!stepKey || completedStepKeys.includes(stepKey)) {
    return completedStepKeys;
  }
  return completedStepKeys.concat(stepKey);
}

export function getNextTrainingWaitStep(stepKey = "") {
  const currentIndex = trainingWaitStepKeys.indexOf(stepKey);
  if (currentIndex < 0 || currentIndex >= trainingWaitStepKeys.length - 1) {
    return trainingWaitStepKeys[trainingWaitStepKeys.length - 1];
  }
  return trainingWaitStepKeys[currentIndex + 1];
}

export function normalizeTrainingWaitStepKey(progressEvent = {}) {
  const explicitStepKey = String(progressEvent.stepKey || "").trim();
  if (trainingWaitStepKeys.includes(explicitStepKey)) {
    return explicitStepKey;
  }
  const phase = String(progressEvent.phase || "").trim();
  if (trainingWaitStepKeys.includes(phase)) {
    return phase;
  }
  if (phase === "intent" || phase === "assessment") {
    return "understand_question";
  }
  if (phase === "retrieval") {
    return "retrieve_source";
  }
  if (phase === "reply") {
    return "compose_explanation";
  }
  if (phase === "next_step") {
    return "generate_followup";
  }
  return "";
}

function getTrainingWaitCopy(submission = {}) {
  const stepKey = String(submission?.currentStepKey || "").trim();
  const hasStreamingText = Boolean(String(submission?.streamingText || "").trim());
  const explanationCompleted = (submission?.completedStepKeys || []).includes("compose_explanation");
  if (stepKey === "generate_followup" && hasStreamingText && explanationCompleted) {
    return {
      label: "正在计算下一步",
      detail: "正在落账评分与记忆，并判断继续追问、进入下一题还是收口总结。",
    };
  }
  if (hasStreamingText) {
    return {
      label: "参考讲解生成中",
      detail: "",
    };
  }
  if (stepKey === "generate_followup") {
    return {
      label: "正在组织参考讲解",
      detail: "讲解还没稳定显示前，不切换到下一步状态。",
    };
  }
  if (stepKey === "retrieve_source") {
    return {
      label: "正在对照原文依据",
      detail: "先确认这题对应的材料位置，再组织讲解。",
    };
  }
  if (stepKey === "compose_explanation") {
    return {
      label: "正在组织参考讲解",
      detail: "会先给出当前答案的关键判断，再补齐边界。",
    };
  }
  return {
    label: "正在理解你的回答",
    detail: "对齐你的回答、当前训练点和评分边界。",
  };
}

function getScoreTone(score = 0) {
  const numericScore = Number(score || 0);
  if (numericScore >= 90) {
    return {
      key: "solid",
      label: "完全掌握",
      background: "#F0FAF6",
      color: "#1D9E75",
    };
  }
  if (numericScore >= 50) {
    return {
      key: "partial",
      label: "部分掌握",
      background: "#FFF9F0",
      color: "#EF9F27",
    };
  }
  return {
    key: "weak",
    label: "未掌握",
    background: "#FCEBEB",
    color: "#E27272",
  };
}

function normalizeScoreSummary(scoreSummary = null) {
  if (!scoreSummary) {
    return null;
  }
  const score = Number(scoreSummary.score || 0);
  const tone = getScoreTone(score);
  return {
    ...scoreSummary,
    score,
    tone,
    label: scoreSummary.stateLabel || tone.label,
    reason: scoreSummary.judgmentReason || scoreSummary.reasons?.join("；") || "这次回答已记录，但后端没有给出更细的评分理由。",
  };
}

function extractPrefixedLine(content = "", prefix = "") {
  const normalizedPrefix = String(prefix || "").replace(/[:：]$/, "");
  return String(content || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .find((line) => line.replace(/[:：].*$/, "") === normalizedPrefix)
    ?.replace(new RegExp(`^${normalizedPrefix}[:：]\\s*`), "")
    .trim() || "";
}

function stripFeedbackPrefixes(content = "") {
  return String(content || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => !/^(回答评分|评分理由|已确认|需要校准|怎么涨分|下一步)[:：]/.test(line))
    .join("\n\n")
    .trim();
}

function buildExplanationParts(exchange = {}) {
  const feedback = exchange.feedbackTurn || {};
  const explanation = String(feedback.markdown || feedback.content || "").trim();
  const markdown = stripFeedbackPrefixes(explanation) || explanation || "这轮讲解已经生成，但没有拿到更多可展示的正文。";
  const tldr = String(feedback.tldr || feedback.takeaway || "").trim();
  return {
    tldr,
    markdown,
    // Keep the legacy fields for older support-card comparisons while the UI
    // renders the complete markdown through TrainingGenerationPanel.
    formula: tldr,
    body: markdown,
  };
}

export function buildTrainingExchanges(session = null) {
  const turns = session?.turns || [];
  const exchangeMap = new Map();
  const exchangeOrder = [];
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    if (turn?.role !== "learner") {
      continue;
    }

    const previousTurns = turns.slice(0, index).reverse();
    const questionTurn = previousTurns.find((item) => item?.role === "tutor" && item.kind === "question") || null;
    const followingTurns = turns.slice(index + 1);
    const nextLearnerIndex = followingTurns.findIndex((item) => item?.role === "learner");
    const windowTurns = nextLearnerIndex >= 0 ? followingTurns.slice(0, nextLearnerIndex) : followingTurns;
    const evaluationTurn = windowTurns.find((item) => item?.role === "tutor" && item.kind === "evaluation") || null;
    const feedbackTurn = windowTurns.find((item) => item?.role === "tutor" && item.kind === "feedback" && item.action !== "complete") || null;
    const memoryTurn = windowTurns.find((item) => item?.role === "tutor" && item.kind === "memory") || null;
    const nextQuestionTurn = windowTurns.find((item) => item?.role === "tutor" && item.kind === "question") || null;
    const scoreSummary = normalizeScoreSummary(evaluationTurn?.scoreSummary || null);
    const improvement = extractPrefixedLine(evaluationTurn?.content, "怎么涨分") || feedbackTurn?.gap || "";
    const takeaway = feedbackTurn?.takeaway || extractPrefixedLine(feedbackTurn?.content, "带走一句") || scoreSummary?.keyClaim || "";
    const questionMeta = questionTurn?.questionMeta || {};
    const progress = questionMeta.trainingProgress || null;
    const nextProgress = nextQuestionTurn?.questionMeta?.trainingProgress || null;
    const exchangeKey = turn.kind === "control" && turn.action === "teach"
      ? `control:teach:${questionTurn?.checkpointId || turn.checkpointId || feedbackTurn?.checkpointId || evaluationTurn?.checkpointId || index}`
      : `turn:${turn.turnId || turn.timestamp || index}`;
    if (!exchangeMap.has(exchangeKey)) {
      exchangeOrder.push(exchangeKey);
    }

    exchangeMap.set(exchangeKey, {
      id: turn.turnId || `${turn.timestamp || index}`,
      question: questionTurn?.content || session?.currentProbe || "",
      answer: turn.content || "",
      learnerKind: turn.kind || "answer",
      learnerAction: turn.action || "",
      answeredAt: turn.timestamp || "",
      pointTitle: progress?.trainingPoint?.title || questionTurn?.conceptTitle || turn.conceptTitle || "当前训练点",
      pointIndex: progress?.trainingPoint?.currentIndex || 1,
      pointTotal: progress?.trainingPoint?.total || session?.trainingPoints?.length || 1,
      checkpointId: questionTurn?.checkpointId || turn.checkpointId || feedbackTurn?.checkpointId || evaluationTurn?.checkpointId || "",
      checkpointStatement: progress?.checkpoint?.statement || questionTurn?.checkpointStatement || "",
      checkpointIndex: progress?.checkpoint?.currentIndex || 1,
      checkpointTotal: progress?.checkpoint?.total || 1,
      scoreSummary,
      evaluationTurn,
      feedbackTurn,
      memoryText: memoryTurn?.content || "",
      improvement,
      takeaway,
      explanation: buildExplanationParts({
        feedbackTurn,
        pointTitle: progress?.trainingPoint?.title || questionTurn?.conceptTitle || "",
        checkpointStatement: progress?.checkpoint?.statement || questionTurn?.checkpointStatement || "",
        scoreSummary,
      }),
      transition: nextQuestionTurn ? {
        completedPointId: progress?.trainingPoint?.id || "",
        completedPointIndex: progress?.trainingPoint?.currentIndex || 1,
        completedPointTitle: progress?.trainingPoint?.title || questionTurn?.conceptTitle || "当前训练点",
        nextPointId: nextProgress?.trainingPoint?.id || "",
        nextPointTitle: nextProgress?.trainingPoint?.title || nextQuestionTurn.conceptTitle || "下一训练点",
        nextCheckpointStatement: nextProgress?.checkpoint?.statement || nextQuestionTurn.checkpointStatement || nextQuestionTurn.content || "",
        answeredCount: scoreSummary ? 1 : 0,
        totalCount: 1,
        minutes: Math.max(1, Math.round(((nextQuestionTurn.timestamp || Date.now()) - (questionTurn?.timestamp || turn.timestamp || Date.now())) / 60000)),
      } : null,
    });
  }
  return exchangeOrder.map((key) => exchangeMap.get(key)).filter(Boolean);
}

export function getCurrentTrainingQuestion(session = null) {
  const turns = session?.turns || [];
  const questionTurn = [...turns].reverse().find((turn) => turn?.role === "tutor" && turn.kind === "question") || null;
  const meta = questionTurn?.questionMeta || session?.currentQuestionMeta || {};
  const progress = meta.trainingProgress || null;
  return {
    text: session?.currentProbe || questionTurn?.content || "",
    pointTitle: progress?.trainingPoint?.title || questionTurn?.conceptTitle || "当前训练点",
    pointIndex: progress?.trainingPoint?.currentIndex || 1,
    pointTotal: progress?.trainingPoint?.total || session?.trainingPoints?.length || 1,
    checkpointStatement: progress?.checkpoint?.statement || questionTurn?.checkpointStatement || "",
    checkpointIndex: progress?.checkpoint?.currentIndex || 1,
    checkpointTotal: progress?.checkpoint?.total || 1,
  };
}

export function hasTeachExplanationForCurrentQuestion(session = null, question = null) {
  const checkpointId = question?.checkpointId || session?.currentCheckpointId || "";
  if (!checkpointId) {
    return false;
  }
  const turns = session?.turns || [];
  return turns.some((turn, index) => {
    if (turn?.role !== "learner" || turn.kind !== "control" || turn.action !== "teach" || turn.checkpointId !== checkpointId) {
      return false;
    }
    const followingTurns = turns.slice(index + 1);
    const nextLearnerIndex = followingTurns.findIndex((item) => item?.role === "learner");
    const windowTurns = nextLearnerIndex >= 0 ? followingTurns.slice(0, nextLearnerIndex) : followingTurns;
    return windowTurns.some((item) => item?.role === "tutor" && item.kind === "feedback" && item.action !== "complete" && item.checkpointId === checkpointId);
  });
}

export function buildTrainingStats(session = null, currentPoint = null) {
  const point = currentPoint || null;
  const checkpointIds = new Set((point?.checkpoints || []).map((checkpoint) => checkpoint.id));
  const evaluationTurns = (session?.turns || []).filter((turn) =>
    turn?.kind === "evaluation" &&
    turn.scoreSummary &&
    (!checkpointIds.size || checkpointIds.has(turn.checkpointId))
  );
  const scores = evaluationTurns.map((turn) => Number(turn.scoreSummary.score || 0)).filter(Number.isFinite);
  const total = point?.checkpoints?.length || Math.max(1, scores.length || 1);
  const answered = Math.min(total, scores.length);
  const average = scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : 0;
  return { answered, total, average, scores };
}

export function buildTrainingStatus({ isStarting, isAnswering, liveTurns, error, session, stats }) {
  if (error) {
    return {
      key: "error",
      label: "错误",
      detail: "AI 暂时不可用，10 秒后重试或重新提交。",
    };
  }
  if (isStarting) {
    return {
      key: "generating",
      label: "生成中",
      detail: "正在为你准备训练，通常需要 3–5 秒。",
    };
  }
  if (isAnswering) {
    const hasGeneratedTurn = (liveTurns || []).some((turn) => turn?.role === "tutor");
    return hasGeneratedTurn
      ? {
          key: "generating",
          label: "生成中",
          detail: "正在为你准备讲解，通常需要 3–5 秒。",
        }
      : {
          key: "thinking",
          label: "生成中",
          detail: "正在为你准备讲解，通常需要 3–5 秒。",
        };
  }
  const pointCount = session?.trainingPoints?.length || 0;
  const itemCount = (session?.trainingPoints || []).reduce((sum, point) => sum + (point.checkpoints?.length || 0), 0);
  return {
    key: "ready",
    label: "就绪",
    detail: `已拆解 ${pointCount || 0} 个训练点 · ${itemCount || stats?.total || 0} 个子项 · 等待你回答下一题`,
  };
}

function buildTrainingOverview(session = null) {
  const points = session?.trainingPoints || [];
  const states = session?.trainingPointStates || [];
  const evaluationTurns = (session?.turns || []).filter((turn) => turn?.kind === "evaluation" && turn?.scoreSummary);
  const scores = evaluationTurns
    .map((turn) => Number(turn.scoreSummary?.score || 0))
    .filter(Number.isFinite);
  const totalCheckpoints = points.reduce((sum, point) => sum + Math.max(1, point.checkpoints?.length || 0), 0);
  return {
    points,
    states,
    totalCheckpoints,
    answeredCount: Math.min(totalCheckpoints || scores.length, scores.length),
    averageScore: scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : 0,
    activePointId: session?.currentTrainingPointId || "",
  };
}

function TrainingOverviewCard({ session, currentQuestion }) {
  const overview = buildTrainingOverview(session);
  const points = overview.points;
  const states = overview.states;
  const totalPoints = points.length || currentQuestion.pointTotal || 1;
  return (
    <section className="ll-rail-card ll-training-overview-card">
      <div className="ll-training-overview-head">
        <div>
          <span className="ll-rail-card-kicker">当前进度</span>
          <h3>{`训练点 ${currentQuestion.pointIndex} / ${totalPoints}`}</h3>
        </div>
      </div>
      <div className="ll-training-overview-bars" aria-label="训练点进度">
        {(points.length ? points : Array.from({ length: totalPoints }).map((_, index) => ({ id: `placeholder-${index}` }))).map((point) => {
          const state = states.find((item) => item.pointId === point.id) || {};
          const active = point.id === overview.activePointId || (!overview.activePointId && point === points[currentQuestion.pointIndex - 1]);
          const color = state.completed ? "#1D9E75" : active ? "#534AB7" : "#DAD9D4";
          return <span key={point.id} style={{ background: color }} />;
        })}
      </div>
      <div className="ll-training-overview-metrics">
        <div>
          <span>总进度</span>
          <strong>{`${overview.answeredCount} / ${Math.max(1, overview.totalCheckpoints || 1)} 题`}</strong>
        </div>
        <div>
          <span>本轮平均</span>
          <strong>{overview.averageScore || "—"}</strong>
        </div>
      </div>
    </section>
  );
}

function TrainingPendingThreadCard({ question, submission, onRetryGeneration, onSkipExplanation }) {
  const submittedAnswer = String(submission?.submittedAnswer || "").trim();
  if (!question?.text || !submittedAnswer) {
    return null;
  }
  const waitCopy = getTrainingWaitCopy(submission);
  const isControlRequest = Boolean(submission?.intent);
  const focusLine = question?.checkpointStatement && question.checkpointStatement !== question.text
    ? question.checkpointStatement
    : "";
  return (
    <section className="ll-training-card ll-training-thread pending">
      <div className="ll-training-card-chip-row">
        <span className="ll-training-chip">{`训练点 ${question.pointIndex} · 子项 ${question.checkpointIndex}/${question.checkpointTotal}`}</span>
        <span className="ll-training-status-label">{isControlRequest ? "请求已发送" : "回答已发送"}</span>
      </div>
      <h2>{question.text}</h2>
      {focusLine ? (
        <div className="ll-thread-context-row">
          <span>目标</span>
          <p>{focusLine}</p>
        </div>
      ) : null}
      {isControlRequest ? (
        <div className="ll-thread-request-inline">
          <span>已选择</span>
          <strong>{submittedAnswer}</strong>
          <em>刚刚</em>
        </div>
      ) : (
        <div className="ll-thread-message user">
          <div className="ll-answer-label">你的回答 · 刚刚</div>
          <pre className="ll-answer-snapshot">{submittedAnswer}</pre>
        </div>
      )}
      <div className="ll-thread-message assistant pending explanation">
        <TrainingGenerationPanel
          embedded
          streamingText={submission.streamingText}
          label={waitCopy.label}
          statusDetail={waitCopy.detail}
          slow={submission.slow}
          onRetry={onRetryGeneration}
          onSkip={onSkipExplanation}
          testId={submission.streamingText ? "training-streaming-card" : "training-waiting-card"}
        />
      </div>
    </section>
  );
}

function TrainingThreadCard({ exchange }) {
  const isControlRequest = exchange.learnerKind === "control";
  const focusLine = exchange.checkpointStatement && exchange.checkpointStatement !== exchange.question
    ? exchange.checkpointStatement
    : "";
  const supportItems = [
    exchange.improvement ? { key: "improve", title: "怎么涨分", body: exchange.improvement, tone: "improve" } : null,
    exchange.takeaway && !isMeaningfullyDuplicate(exchange.takeaway, exchange.explanation.formula)
      ? { key: "takeaway", title: "带走一句", body: exchange.takeaway, tone: "takeaway" }
      : null,
  ].filter(Boolean);
  return (
    <section className="ll-training-card ll-training-thread">
      <div className="ll-training-card-chip-row">
        <span className="ll-training-chip">{`训练点 ${exchange.pointIndex} · ${exchange.pointTitle}`}</span>
        <span className="ll-training-status-label">已完成</span>
      </div>
      <h2>{exchange.question}</h2>
      {focusLine ? (
        <div className="ll-thread-context-row">
          <span>目标</span>
          <p>{focusLine}</p>
        </div>
      ) : null}
      {isControlRequest ? (
        <div className="ll-thread-request-inline">
          <span>已选择</span>
          <strong>{exchange.answer}</strong>
          <em>{getTurnTimeLabel(exchange.answeredAt)}</em>
        </div>
      ) : (
        <div className="ll-thread-message user">
          <div className="ll-answer-label">{`你的回答 · ${getTurnTimeLabel(exchange.answeredAt)}`}</div>
          <pre className="ll-answer-snapshot">{exchange.answer}</pre>
        </div>
      )}
      <div className="ll-thread-message assistant explanation">
        <TrainingGenerationPanel
          embedded
          complete
          markdown={exchange.explanation.markdown || exchange.explanation.body}
          testId="training-ready-explanation-card"
        />
      </div>
      {exchange.explanation.tldr ? (
        <div className="ll-thread-message assistant tldr" data-testid="training-ready-tldr-card">
          <div className="ll-training-generation-section-title success">
            <span className="ll-training-generation-section-dot" aria-hidden="true" />
            <span>AI 提炼一句</span>
          </div>
          <p className="ll-thread-tldr-text">{exchange.explanation.tldr}</p>
        </div>
      ) : null}
      {exchange.scoreSummary ? (
        <div
          className={`ll-thread-score-summary tone-${exchange.scoreSummary.tone.key}`}
          style={{
            "--thread-score-color": exchange.scoreSummary.tone.color,
            "--thread-score-bg": exchange.scoreSummary.tone.background,
          }}
        >
          <div className="ll-thread-score-main">
            <strong>{`回答评分 ${exchange.scoreSummary.score}`}</strong>
            <span>{exchange.scoreSummary.label}</span>
          </div>
          {exchange.scoreSummary.reason ? <p>{exchange.scoreSummary.reason}</p> : null}
        </div>
      ) : null}
      {supportItems.length ? (
        <div className="ll-thread-support-grid">
          {supportItems.map((item) => (
            <article key={item.key} className={`ll-thread-support-card ${item.tone}`}>
              <strong>{item.title}</strong>
              <p>{item.body}</p>
            </article>
          ))}
        </div>
      ) : null}
      <RememberedContent text={exchange.memoryText} />
      <TrainingTransition transition={exchange.transition} />
    </section>
  );
}

function RememberedContent({ text }) {
  const [open, setOpen] = useState(false);
  if (!text) {
    return null;
  }
  return (
    <section className="ll-remembered-block">
      <button type="button" onClick={() => setOpen((value) => !value)}>
        <span>{`已记住的内容(系统会基于这些追问) ${open ? "▾" : "▸"}`}</span>
      </button>
      {open ? <p>{text}</p> : null}
    </section>
  );
}

function TrainingTransition({ transition }) {
  if (!transition) {
    return null;
  }
  const samePoint = transition.completedPointId && transition.nextPointId && transition.completedPointId === transition.nextPointId;
  return (
    <section className="ll-training-transition">
      <p>{`✓ 训练点 ${transition.completedPointIndex} 完成 · 答对 ${transition.answeredCount}/${transition.totalCount} · 用时 ${transition.minutes} 分钟`}</p>
      <div>
        <span>{samePoint ? "继续当前训练点" : "下一个训练点"}</span>
        <strong>{samePoint ? transition.nextCheckpointStatement : transition.nextPointTitle}</strong>
        {!samePoint && transition.nextCheckpointStatement ? <p>{transition.nextCheckpointStatement}</p> : null}
      </div>
    </section>
  );
}

function NextQuestionCard({ question, answer, setAnswer, isAnswering, onSubmit, onExplain }) {
  if (!question.text) {
    return (
      <section className="ll-training-card ll-next-question">
        <div className="ll-training-chip">训练已收口</div>
        <h2>当前没有新的题目。</h2>
        <p className="ll-training-question-desc">可以回到阅读页，或稍后从薄弱点重新训练。</p>
      </section>
    );
  }
  return (
    <section className="ll-training-card ll-next-question" data-testid="training-next-question">
      <div className="ll-training-card-chip-row">
        <span className="ll-training-chip">{`训练点 ${question.pointIndex} · 子项 ${question.checkpointIndex}/${question.checkpointTotal}`}</span>
      </div>
      <h2>{question.text}</h2>
      <form
        className="ll-next-answer-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <textarea
          rows="4"
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          placeholder="写下你的理解。"
        />
        <div className="ll-next-answer-actions">
          <button type="button" className="ll-tool-button" onClick={onExplain}>
            查看解析
          </button>
          <button type="submit" className="ll-training-primary" disabled={isAnswering || !answer.trim()}>
            提交回答
          </button>
        </div>
      </form>
    </section>
  );
}

function TrainingAssistantRail({ session, currentQuestion, stats }) {
  return (
    <aside className="ll-training-rail" data-testid="qa-panel">
      <TrainingOverviewCard session={session} currentQuestion={currentQuestion} />
      <section className="ll-rail-card">
        <h3>本训练点表现</h3>
        <div className="ll-performance-number">
          <strong>{stats.answered}</strong>
          <span>{`/ ${stats.total} 题`}</span>
          <em>{`平均 ${stats.average || "—"}`}</em>
        </div>
        <div className="ll-performance-bars">
          {Array.from({ length: stats.total }).map((_, index) => {
            const score = stats.scores[index] || 0;
            const color = score >= 85 ? "#1D9E75" : score > 0 ? "#EF9F27" : "#E8E6DC";
            return <span key={index} style={{ background: color }} />;
          })}
        </div>
      </section>
    </aside>
  );
}

export function RescuePlaylistStrip({
  playlist = null,
  activeItemId = "",
  menuOpen = false,
  onToggleMenu,
  onSelectItem,
  onNextItem,
}) {
  const items = playlist?.items || [];
  const activeIndex = Math.max(0, items.findIndex((item) => item.id === activeItemId));
  const activeItem = items[activeIndex] || items[0] || null;
  const readyCount = Number(playlist?.readyCount || 0);
  const totalCount = Number(playlist?.totalCount || items.length || 0);
  const nextReadyItem = items.find((item, index) => index > activeIndex && (item.status === "ready" || item.status === "learned")) || null;
  if (!playlist || !activeItem) {
    return null;
  }
  return (
    <div className="rescue-playlist-shell">
      <div className="rescue-playlist-strip">
        <div className="rescue-playlist-strip-copy">
          <span>补救清单</span>
          <strong>{`第 ${activeIndex + 1}/${totalCount} 篇`}</strong>
          <em>{`已就绪 ${readyCount}/${totalCount}`}</em>
        </div>
        <div className="rescue-playlist-strip-actions">
          <button type="button" onClick={onToggleMenu}>清单</button>
          <button type="button" className="next" disabled={!nextReadyItem} onClick={onNextItem}>
            下一篇
          </button>
        </div>
      </div>
      {menuOpen ? (
        <div className="rescue-playlist-menu" data-testid="rescue-playlist-menu">
          {items.map((item, index) => {
            const clickable = item.status === "ready" || item.status === "learned";
            return (
              <button
                key={item.id}
                type="button"
                className={[
                  "rescue-playlist-menu-item",
                  item.id === activeItemId ? "is-active" : "",
                  clickable ? "" : "is-disabled",
                ].filter(Boolean).join(" ")}
                disabled={!clickable}
                onClick={() => onSelectItem(item.id)}
              >
                <div className="rescue-playlist-menu-index">{index + 1}</div>
                <div className="rescue-playlist-menu-copy">
                  <strong>{item.title}</strong>
                  <span>{getRescueSourceLabel(item.source)}</span>
                </div>
                <em>{item.status === "learned" ? "已学" : item.status === "ready" ? "就绪" : "生成中"}</em>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function TrainingWorkspace({
  documentTitle,
  session,
  exchanges,
  currentQuestion,
  stats,
  answer,
  setAnswer,
  isAnswering,
  trainingWaitState,
  isPreparingTraining,
  onSubmit,
  onExplain,
  onRetryGeneration,
  onSkipExplanation,
  onBackToReading,
  currentQuestionHasTeachExplanation = false,
  rescuePlaylistStrip = null,
}) {
  const shouldShowNextQuestion = Boolean(currentQuestion.text) || !isPreparingTraining;
  const awaitingExplanation = Boolean(trainingWaitState);
  return (
    <main className="learn-shell ll-training-page" data-testid="learn-shell">
      <header className="ll-training-topbar">
        <div className="ll-training-title">
          <Link href="/" className="ll-training-back">‹</Link>
          <h1>{documentTitle}</h1>
        </div>
        <div className="ll-training-tabs">
          <button type="button" onClick={onBackToReading}>阅读</button>
          <button type="button" className="active">训练</button>
        </div>
      </header>
      {rescuePlaylistStrip}
      <section className="ll-training-main">
        <div className="ll-training-flow">
          {isPreparingTraining ? (
            <article className="ll-training-card ll-training-prep" data-testid="training-prep-card">
              <div className="ll-training-chip">训练准备</div>
              <h2>正在准备训练</h2>
              <p>正在拆解这篇文档的训练点，并准备第一道诊断题。</p>
            </article>
          ) : null}
          {exchanges.map((exchange) => (
            <article key={exchange.id} className="ll-training-exchange">
              <TrainingThreadCard exchange={exchange} />
            </article>
          ))}
          {awaitingExplanation ? (
            <TrainingPendingThreadCard
              question={currentQuestion}
              submission={trainingWaitState}
              onRetryGeneration={onRetryGeneration}
              onSkipExplanation={onSkipExplanation}
            />
          ) : null}
          {!awaitingExplanation && shouldShowNextQuestion && !currentQuestionHasTeachExplanation ? (
            <NextQuestionCard
              question={currentQuestion}
              answer={answer}
              setAnswer={setAnswer}
              isAnswering={isAnswering}
              onSubmit={onSubmit}
              onExplain={onExplain}
            />
          ) : null}
        </div>
        <TrainingAssistantRail
          session={session}
          currentQuestion={currentQuestion}
          stats={stats}
        />
      </section>
    </main>
  );
}
