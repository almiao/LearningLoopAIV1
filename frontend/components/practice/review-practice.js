"use client";

import { PracticeShell } from "./practice-shell";

export function ReviewPracticeWorkspace({
  practice,
  answer,
  setAnswer,
  loading,
  error,
  onSubmit,
  onRefreshQuestion,
  onHome,
}) {
  const item = practice?.reviewItem || {};
  const evidence = item.evidence || {};
  const missedAnchors = Array.isArray(evidence.missedAnchors) ? evidence.missedAnchors : [];
  const stateLabel = item.state === "solid" ? "扎实" : "生疏";

  return (
    <main className="learn-shell ll-review-practice-page" data-testid="review-practice-workspace">
      <header className="ll-training-topbar">
        <div className="ll-training-title">
          <button type="button" className="ll-training-back" onClick={onHome}>‹</button>
          <div>
            <span>今日复习</span>
            <h1>{item.handle || "重练这个点"}</h1>
          </div>
        </div>
        <div className="ll-training-tabs">
          <button type="button" className="active">复练</button>
          <button type="button" onClick={onHome}>回首页</button>
        </div>
      </header>

      {error ? <section className="feedback-banner error-banner narrow-banner">{error}</section> : null}

      <section className="ll-review-practice-main">
        <PracticeShell
          seed={{ type: "review-item", payload: item }}
          practice={practice}
          answer={answer}
          setAnswer={setAnswer}
          loading={loading}
          error=""
          onSubmit={onSubmit}
          onRefreshQuestion={onRefreshQuestion}
          className="ll-training-card ll-review-practice-card"
          testId="review-practice-shell"
          answerPlaceholder="一次性写下你的回答。先结论，再机制、边界和取舍。"
          resultLabels={{
            passLabel: "过了，这个点转为扎实",
            failLabel: "还没讲稳，已安排复习",
            passDetail: "这个点的复习间隔会拉长，暂时不用管它。",
            failDetail: "这个点很快会再出现，先看下面的讲解补上。",
            stateLabel: practice?.passed ? "扎实" : "生疏",
          }}
          rescueTestId="review-practice-rescue-card"
          actions={{
            retry: "换一道题",
            retryAnswered: "再练一题",
            next: "回首页",
            onNext: onHome,
          }}
          beforeQuestion={(
            <div className="ll-training-card-chip-row">
              <span className="ll-training-chip">{`待复习 · ${stateLabel}`}</span>
              <span className="ll-training-status-label">{practice?.source?.available ? "已结合原文出题" : "没有原文也能练"}</span>
            </div>
          )}
          renderEvidence={() => (
            <>
              {evidence.question ? (
                <div className="ll-review-practice-evidence">
                  <span>上次没答好的题</span>
                  <p>{evidence.question}</p>
                </div>
              ) : null}
              {missedAnchors.length ? (
                <div className="ll-review-practice-anchor-list">
                  {missedAnchors.map((anchor) => (
                    <span key={anchor}>{anchor}</span>
                  ))}
                </div>
              ) : null}
            </>
          )}
        />
      </section>
    </main>
  );
}
