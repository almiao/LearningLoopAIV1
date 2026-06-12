"use client";

import { TrainingGenerationPanel } from "../training-generation-panel";

const defaultSupportLabels = {
  hits: "你讲到位的点",
  misses: "还没讲到的关键点",
};

export function PracticeResult({
  passed = false,
  hits = [],
  misses = [],
  rescueMarkdown = "",
  passLabel = "过了",
  failLabel = "还没讲稳",
  passDetail = "",
  failDetail = "",
  stateLabel = "",
  answer = "",
  answerLabel = "你的回答",
  supportLabels = defaultSupportLabels,
  supportItems = [],
  rescueTestId = "practice-rescue-card",
  toneKey = "",
  scoreColor,
  scoreBackground,
  showSummary = true,
  children,
}) {
  const normalizedHits = Array.isArray(hits) ? hits.filter(Boolean) : [];
  const normalizedMisses = Array.isArray(misses) ? misses.filter(Boolean) : [];
  const detail = passed ? passDetail : failDetail;
  const threadScoreStyle = {
    "--thread-score-color": scoreColor || (passed ? "#1D9E75" : "#E27272"),
  };
  if (scoreBackground) {
    threadScoreStyle["--thread-score-bg"] = scoreBackground;
  }

  return (
    <section className="ll-review-practice-result">
      {showSummary ? (
        <div
          className={`ll-thread-score-summary tone-${toneKey || (passed ? "solid" : "weak")}`}
          style={threadScoreStyle}
        >
          <div className="ll-thread-score-main">
            <strong>{passed ? passLabel : failLabel}</strong>
            {stateLabel ? <span>{stateLabel}</span> : null}
          </div>
          {detail ? <p>{detail}</p> : null}
        </div>
      ) : null}

      {answer ? (
        <div className="ll-thread-message user">
          <div className="ll-answer-label">{answerLabel}</div>
          <pre className="ll-answer-snapshot">{answer}</pre>
        </div>
      ) : null}

      {supportItems.length ? (
        <div className="ll-thread-support-grid">
          {supportItems.map((item) => (
            <article key={item.key || item.title} className={`ll-thread-support-card ${item.tone || ""}`}>
              <strong>{item.title}</strong>
              <p>{item.body}</p>
            </article>
          ))}
        </div>
      ) : normalizedHits.length || normalizedMisses.length ? (
        <div className="ll-thread-support-grid">
          {normalizedHits.length ? (
            <article className="ll-thread-support-card takeaway">
              <strong>{supportLabels.hits || defaultSupportLabels.hits}</strong>
              <p>{normalizedHits.join("；")}</p>
            </article>
          ) : null}
          {normalizedMisses.length ? (
            <article className="ll-thread-support-card improve">
              <strong>{supportLabels.misses || defaultSupportLabels.misses}</strong>
              <p>{normalizedMisses.join("；")}</p>
            </article>
          ) : null}
        </div>
      ) : null}

      {!passed && rescueMarkdown ? (
        <div className="ll-thread-message assistant explanation">
          <TrainingGenerationPanel
            embedded
            complete
            markdown={rescueMarkdown}
            testId={rescueTestId}
          />
        </div>
      ) : null}

      {children}
    </section>
  );
}
