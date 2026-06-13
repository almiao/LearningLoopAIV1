"use client";

import { useEffect, useState } from "react";

import { postJson } from "../../lib/api";
import { PracticeResult } from "./practice-result";

async function callEndpoint(endpoint, payload) {
  if (typeof endpoint === "function") {
    return endpoint(payload);
  }
  if (typeof endpoint === "string" && endpoint) {
    return postJson(endpoint, payload);
  }
  throw new Error("practice endpoint is required.");
}

export function PracticeShell({
  seed = null,
  endpoints = null,
  streaming = false,
  adversarial = "off",
  practice: controlledPractice,
  answer: controlledAnswer,
  setAnswer: setControlledAnswer,
  loading: controlledLoading = false,
  error: controlledError = "",
  onSubmit,
  onRefreshQuestion,
  onJudged,
  renderEvidence,
  actions = {},
  className = "ll-training-card ll-review-practice-card",
  testId = "practice-shell",
  questionFallback = "正在为这个点出一道新题...",
  showQuestion = true,
  answerPlaceholder = "一次性写下你的回答。先结论，再机制、边界和取舍。",
  formTestId = "",
  textareaTestId = "",
  submitTestId = "",
  resultLabels = {},
  supportLabels,
  rescueTestId,
  beforeQuestion = null,
}) {
  const [localPractice, setLocalPractice] = useState(null);
  const [localAnswer, setLocalAnswer] = useState("");
  const [localLoading, setLocalLoading] = useState(false);
  const [localError, setLocalError] = useState("");
  const isControlled = Boolean(onSubmit || controlledPractice || setControlledAnswer);
  const practice = isControlled ? controlledPractice : localPractice;
  const answer = isControlled ? controlledAnswer : localAnswer;
  const setAnswer = isControlled ? setControlledAnswer : setLocalAnswer;
  const loading = isControlled ? controlledLoading : localLoading;
  const error = isControlled ? controlledError : localError;
  const answered = Boolean(practice?.judgment || practice?.passed != null);
  const passed = Boolean(practice?.passed);
  const hits = Array.isArray(practice?.judgment?.hits) ? practice.judgment.hits : [];
  const misses = Array.isArray(practice?.judgment?.misses) ? practice.judgment.misses : [];

  async function loadQuestion() {
    if (onRefreshQuestion) {
      await onRefreshQuestion();
      return;
    }
    try {
      setLocalLoading(true);
      setLocalError("");
      setLocalPractice(null);
      setLocalAnswer("");
      const data = await callEndpoint(endpoints?.start, {
        action: "start",
        seed,
        streaming,
        adversarial,
      });
      setLocalPractice(data);
    } catch (nextError) {
      setLocalError(nextError.message || "出题失败，请重试。");
    } finally {
      setLocalLoading(false);
    }
  }

  async function submitAnswer() {
    const submitted = String(answer || "").trim();
    if (!practice?.question || !submitted) {
      return;
    }
    if (onSubmit) {
      await onSubmit();
      return;
    }
    try {
      setLocalLoading(true);
      setLocalError("");
      const data = await callEndpoint(endpoints?.answer || endpoints?.start, {
        action: "answer",
        seed,
        question: practice.question,
        answer: submitted,
        streaming,
        adversarial,
      });
      setLocalPractice(data);
      onJudged?.(data);
    } catch (nextError) {
      setLocalError(nextError.message || "判分失败，请重试。");
    } finally {
      setLocalLoading(false);
    }
  }

  useEffect(() => {
    if (isControlled || !endpoints?.start) {
      return;
    }
    void loadQuestion();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isControlled, endpoints?.start, seed?.type, seed?.payload?.id]);

  return (
    <article className={className} data-testid={testId}>
      {beforeQuestion}
      {error && !practice?.question ? <p className="ll-campaign-error">{error}</p> : null}
      {showQuestion ? <h2>{practice?.question || questionFallback}</h2> : null}
      {typeof renderEvidence === "function" ? renderEvidence({ practice, seed }) : null}
      {error && practice?.question ? (
        <div className="ll-practice-error" role="alert">
          <p className="ll-campaign-error">{error}</p>
          {!answered && String(answer || "").trim() ? (
            <p className="ll-practice-error-note">你的回答已保留，点下面「重试判分」直接重发。</p>
          ) : null}
        </div>
      ) : null}

      {!answered ? (
        <form
          className="ll-next-answer-form"
          data-testid={formTestId || undefined}
          onSubmit={(event) => {
            event.preventDefault();
            void submitAnswer();
          }}
        >
          <textarea
            rows="6"
            value={answer || ""}
            onChange={(event) => setAnswer?.(event.target.value)}
            placeholder={answerPlaceholder}
            disabled={loading || !practice?.question}
            data-testid={textareaTestId || undefined}
          />
          <div className="ll-next-answer-actions">
            <button
              type="button"
              className={actions.retryClassName || "ll-tool-button"}
              onClick={() => void loadQuestion()}
              disabled={loading}
            >
              {actions.retry || "换一道题"}
            </button>
            <button
              type="submit"
              className={actions.submitClassName || "ll-training-primary"}
              disabled={loading || !String(answer || "").trim() || !practice?.question}
              data-testid={submitTestId || undefined}
            >
              {loading
                ? (actions.loading || "判分中...")
                : (error && practice?.question ? "重试判分" : (actions.submit || "提交回答"))}
            </button>
          </div>
          {loading && practice?.question ? (
            <p className="ll-practice-judging-hint">判分通常十几秒，稍候即可，回答不会丢。</p>
          ) : null}
        </form>
      ) : (
        <PracticeResult
          passed={passed}
          hits={hits}
          misses={misses}
          rescueMarkdown={practice?.rescue?.markdown || ""}
          rescuePending={Boolean(practice?.rescue?.pending)}
          passLabel={resultLabels.passLabel}
          failLabel={resultLabels.failLabel}
          passDetail={resultLabels.passDetail}
          failDetail={resultLabels.failDetail}
          stateLabel={resultLabels.stateLabel}
          answer={practice?.answer}
          supportLabels={supportLabels}
          rescueTestId={rescueTestId}
        >
          <div className="ll-next-answer-actions">
            <button
              type="button"
              className={actions.retryClassName || "ll-tool-button"}
              onClick={() => void loadQuestion()}
              disabled={loading}
            >
              {actions.retryAnswered || actions.retry || "再练一题"}
            </button>
            {actions.next ? (
              <button type="button" className="ll-training-primary" onClick={actions.onNext}>
                {actions.next}
              </button>
            ) : null}
          </div>
        </PracticeResult>
      )}
    </article>
  );
}
