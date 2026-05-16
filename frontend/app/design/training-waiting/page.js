"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { TrainingGenerationPanel } from "../../../components/training-generation-panel";

const countdownMs = 5000;
const circumference = 119.4;
const tldrText = "ThreadLocal 的值挂在当前线程自己的 ThreadLocalMap 里，ThreadLocal 本身只是查这张 map 的 key。";
const markdownChunks = [
  "**关键关系**是：`Thread -> ThreadLocalMap -> value`。",
  "调用 `set(value)` 时，当前线程会把这个 `ThreadLocal` 实例作为 key，把 value 写进自己的 `ThreadLocalMap`。",
  "- 不同线程访问同一个 `ThreadLocal`，查的是各自线程里的 map。",
  "- 所以隔离来自“每个 Thread 各有一张 map”，不是 ThreadLocal 自己保存全局 value。",
  "> 面试里可以说：Thread 持有 ThreadLocalMap，ThreadLocal 是访问这个 map 的 key。",
];
const supplementText = "如果你把 ThreadLocal 想成变量本身，就会误以为所有线程共享一份值；更稳的理解是：每个 Thread 都有自己的 map，ThreadLocal 只是用来定位这一格数据。";
const animationRows = [
  ["顶部状态", "0", "5800", "spinner 0.8s linear infinite；完成后切 sparkles"],
  ["TL;DR callout", "600", "约1900", "打字机 26 字/秒，cursor 1s step-end infinite"],
  ["markdown 主体", "3100", "400", "block fade-in，ease-out"],
  ["列表项 1", "3900", "400", "li fade-in，ease-out"],
  ["列表项 2", "5000", "400", "li fade-in，ease-out"],
  ["auto toolbar", "5800", "300", "opacity 0.35 -> 1，ease-out"],
  ["倒计时圆环", "5800", "5000", "stroke-dashoffset 119.4 -> 0，linear，可暂停"],
  ["还没懂补充", "click", "约1800", "主讲解下方追加一段 markdown 流；完成后重置倒计时"],
];

function getSnapshot(elapsedMs) {
  const tldrStarted = elapsedMs >= 600;
  const tldrCount = tldrStarted
    ? Math.min(tldrText.length, Math.floor(((elapsedMs - 600) / 1000) * 26))
    : 0;
  const tldr = elapsedMs >= 2500 ? tldrText : tldrText.slice(0, Math.max(0, tldrCount));
  const chunks = [];
  if (elapsedMs >= 3100) chunks.push(markdownChunks[0]);
  if (elapsedMs >= 3500) chunks.push(markdownChunks[1]);
  if (elapsedMs >= 3900) chunks.push(markdownChunks[2]);
  if (elapsedMs >= 5000) chunks.push(markdownChunks[3]);
  if (elapsedMs >= 5400) chunks.push(markdownChunks[4]);

  return {
    tldr,
    markdown: chunks.join("\n\n"),
    complete: elapsedMs >= 5800,
  };
}

function CountdownRing({ remainingMs, paused }) {
  const progress = Math.max(0, Math.min(1, remainingMs / countdownMs));
  return (
    <svg className={`ll-auto-ring${paused ? " paused" : ""}`} width="22" height="22" viewBox="0 0 44 44" aria-hidden="true">
      <circle cx="22" cy="22" r="19" />
      <circle
        cx="22"
        cy="22"
        r="19"
        pathLength={circumference}
        style={{ strokeDasharray: circumference, strokeDashoffset: circumference * (1 - progress) }}
      />
    </svg>
  );
}

function QuestionBlock({ nextStarted }) {
  return (
    <section className={`ll-single-question-block${nextStarted ? " next" : ""}`}>
      <div className="ll-single-question-kicker">
        <span>Q</span>
        <strong>{nextStarted ? "下一题" : "单题讲解"}</strong>
      </div>
      <h1>
        {nextStarted
          ? "ThreadLocalMap 的 key 为什么要设计成弱引用？"
          : "ThreadLocal 的 value 到底存在哪里，为什么同一个 ThreadLocal 在不同线程不会互相覆盖？"}
      </h1>
      <div className="ll-user-action-strip">
        <span>你的回答 · 刚刚</span>
        <p>{nextStarted ? "已自动进入下一题。" : "应该是放到线程本地内存吧？"}</p>
      </div>
    </section>
  );
}

function PrototypeControls({ onReplay, onPreset }) {
  const states = [
    ["stream30", "流式 30%"],
    ["stream70", "流式 70%"],
    ["countdown", "倒计时中"],
    ["paused", "已暂停"],
    ["followup", "还没懂追问中"],
    ["used", "已用完追问"],
    ["failed", "失败"],
    ["slow", "慢"],
    ["offline", "断流"],
  ];
  return (
    <div className="ll-prototype-controls" aria-label="prototype controls">
      <button type="button" className="primary" onClick={onReplay}>重放</button>
      {states.map(([key, label]) => (
        <button key={key} type="button" onClick={() => onPreset(key)}>{label}</button>
      ))}
    </div>
  );
}

function AutoToolbar({
  visible,
  paused,
  supplementing,
  remainingMs,
  followupUsed,
  markedDifficult,
  nextStarted,
  onConfused,
  onStartNow,
}) {
  if (!visible || nextStarted) {
    return null;
  }
  return (
    <section className="ll-auto-toolbar">
      <div className="ll-auto-toolbar-left">
        <CountdownRing remainingMs={remainingMs} paused={paused} />
        <div>
          <strong>
            {supplementing
              ? "AI 正在补充讲解"
              : paused
                ? "已暂停 · 移开继续"
                : `将在 ${Math.max(0, Math.ceil(remainingMs / 1000))} 秒后进入下一题`}
          </strong>
          <span>{supplementing ? "补充完成后重新倒计时" : "下一题：ThreadLocalMap 的 key 为什么要设计成弱引用？"}</span>
        </div>
        {markedDifficult ? <em>📌 已标记为难点</em> : null}
      </div>
      <div className="ll-auto-toolbar-actions">
        <button type="button" className="secondary" onClick={onConfused} disabled={followupUsed}>
          {followupUsed ? "✓ 已用一次" : "还没懂"}
        </button>
        <button type="button" className="primary" onClick={onStartNow}>立即开始 →</button>
      </div>
    </section>
  );
}

function MotionSpecTable() {
  return (
    <section className="ll-motion-spec">
      <h2>动效参数表</h2>
      <table>
        <thead>
          <tr>
            <th>对象</th>
            <th>延迟 ms</th>
            <th>时长 ms</th>
            <th>缓动 / 规则</th>
          </tr>
        </thead>
        <tbody>
          {animationRows.map(([name, delay, duration, easing]) => (
            <tr key={name}>
              <td>{name}</td>
              <td>{delay}</td>
              <td>{duration}</td>
              <td>{easing}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export default function TrainingWaitingPreviewPage() {
  const [elapsedMs, setElapsedMs] = useState(0);
  const [running, setRunning] = useState(true);
  const [remainingMs, setRemainingMs] = useState(countdownMs);
  const [paused, setPaused] = useState(false);
  const [slow, setSlow] = useState(false);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState("");
  const [followupUsed, setFollowupUsed] = useState(false);
  const [followupStreaming, setFollowupStreaming] = useState(false);
  const [supplementMarkdown, setSupplementMarkdown] = useState("");
  const [markedDifficult, setMarkedDifficult] = useState(false);
  const [nextStarted, setNextStarted] = useState(false);
  const scrollPauseTimer = useRef(null);
  const codePauseTimer = useRef(null);

  const snapshot = useMemo(() => getSnapshot(elapsedMs), [elapsedMs]);
  const toolbarVisible = snapshot.complete || followupUsed || markedDifficult;

  function resetFlow() {
    window.clearTimeout(scrollPauseTimer.current);
    window.clearTimeout(codePauseTimer.current);
    setElapsedMs(0);
    setRunning(true);
    setRemainingMs(countdownMs);
    setPaused(false);
    setSlow(false);
    setOffline(false);
    setError("");
    setFollowupUsed(false);
    setFollowupStreaming(false);
    setSupplementMarkdown("");
    setMarkedDifficult(false);
    setNextStarted(false);
  }

  function applyPreset(key) {
    resetFlow();
    setRunning(false);
    if (key === "stream30") setElapsedMs(1900);
    if (key === "stream70") setElapsedMs(4300);
    if (key === "countdown") {
      setElapsedMs(5900);
      setRemainingMs(3600);
    }
    if (key === "paused") {
      setElapsedMs(5900);
      setRemainingMs(3600);
      setPaused(true);
    }
    if (key === "followup") {
      setElapsedMs(5900);
      setFollowupUsed(true);
      setFollowupStreaming(true);
      setSupplementMarkdown(supplementText.slice(0, 42));
      setRemainingMs(countdownMs);
      setPaused(true);
    }
    if (key === "used") {
      setElapsedMs(5900);
      setFollowupUsed(true);
      setSupplementMarkdown(supplementText);
      setMarkedDifficult(true);
      setRemainingMs(4200);
    }
    if (key === "failed") {
      setElapsedMs(4300);
      setError("生成失败，已保留上方已生成内容。");
      setPaused(true);
    }
    if (key === "slow") {
      setElapsedMs(5400);
      setSlow(true);
    }
    if (key === "offline") {
      setElapsedMs(4300);
      setOffline(true);
      setPaused(true);
    }
  }

  function pauseForDelay(delay = 3000) {
    setPaused(true);
    window.clearTimeout(codePauseTimer.current);
    codePauseTimer.current = window.setTimeout(() => setPaused(false), delay);
  }

  function handleScrollPause() {
    setPaused(true);
    window.clearTimeout(scrollPauseTimer.current);
    scrollPauseTimer.current = window.setTimeout(() => setPaused(false), 3000);
  }

  function handleCardClick(event) {
    const target = event.target;
    if (target instanceof HTMLElement && (target.closest("code") || target.closest("a"))) {
      pauseForDelay(3000);
    }
  }

  function handleConfused() {
    if (followupUsed) {
      return;
    }
    setFollowupUsed(true);
    setFollowupStreaming(true);
    setPaused(true);
    setRemainingMs(countdownMs);
    setSupplementMarkdown("");
    const startedAt = performance.now();
    const timer = window.setInterval(() => {
      const count = Math.min(supplementText.length, Math.floor(((performance.now() - startedAt) / 1000) * 26));
      setSupplementMarkdown(supplementText.slice(0, count));
      if (count >= supplementText.length) {
        window.clearInterval(timer);
        setFollowupStreaming(false);
        setMarkedDifficult(true);
        setRemainingMs(countdownMs);
        setPaused(false);
      }
    }, 50);
  }

  useEffect(() => {
    if (!running || elapsedMs >= 5800) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      setElapsedMs((value) => Math.min(5800, value + 50));
    }, 50);
    return () => window.clearInterval(timer);
  }, [elapsedMs, running]);

  useEffect(() => {
    if (!toolbarVisible || paused || nextStarted || followupStreaming || error || offline) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      setRemainingMs((value) => {
        const next = Math.max(0, value - 50);
        if (next === 0) {
          setNextStarted(true);
        }
        return next;
      });
    }, 50);
    return () => window.clearInterval(timer);
  }, [error, followupStreaming, nextStarted, offline, paused, toolbarVisible]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const state = params.get("state");
    if (state) {
      applyPreset(state);
    }
  }, []);

  return (
    <main className="ll-single-flow-page">
      <PrototypeControls onReplay={resetFlow} onPreset={applyPreset} />
      <section className="ll-single-flow-shell" data-testid="single-question-flow-prototype">
        <QuestionBlock nextStarted={nextStarted} />
        {!nextStarted ? (
          <>
            <div
              className="ll-single-card-wrap"
              onMouseEnter={() => setPaused(true)}
              onMouseLeave={() => setPaused(false)}
              onScroll={handleScrollPause}
              onClick={handleCardClick}
            >
              <TrainingGenerationPanel
                tldr={snapshot.tldr}
                markdown={snapshot.markdown}
                supplementMarkdown={supplementMarkdown}
                complete={snapshot.complete && !followupStreaming}
                slow={slow}
                disconnected={offline}
                error={error}
                label={followupStreaming ? "AI 补充中" : ""}
                onRetry={resetFlow}
                onSkip={() => setNextStarted(true)}
              />
            </div>
            <AutoToolbar
              visible={toolbarVisible}
              paused={paused}
              supplementing={followupStreaming}
              remainingMs={remainingMs}
              followupUsed={followupUsed}
              markedDifficult={markedDifficult}
              nextStarted={nextStarted}
              onConfused={handleConfused}
              onStartNow={() => setNextStarted(true)}
            />
          </>
        ) : null}
      </section>
      <MotionSpecTable />
    </main>
  );
}
