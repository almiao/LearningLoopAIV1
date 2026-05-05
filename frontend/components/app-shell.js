"use client";

import Link from "next/link";
import { useDeferredValue, useEffect, useState } from "react";
import { apiFetch, postEventStream, postJson } from "../lib/api";
import { buildChatTimeline } from "../../src/view/chat-transcript";
import { buildVisibleSessionView } from "../../src/view/visible-session-view";

const userIdStorageKey = "learning-loop-user-id";

function getStoredUserId() {
  if (typeof window === "undefined") {
    return "";
  }
  return window.localStorage.getItem(userIdStorageKey) || "";
}

function setStoredUserId(userId) {
  if (typeof window === "undefined") {
    return;
  }
  if (userId) {
    window.localStorage.setItem(userIdStorageKey, userId);
  } else {
    window.localStorage.removeItem(userIdStorageKey);
  }
}

function renderResolution(turnResolution) {
  if (!turnResolution) {
    return "";
  }
  if (turnResolution.mode === "switch") {
    return `切到下一个点：${turnResolution.finalConceptTitle || "下一题"}`;
  }
  if (turnResolution.mode === "stay") {
    return "继续围绕当前点推进";
  }
  return "这一轮先收口";
}

function splitTextBlocks(value) {
  return String(value || "")
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function patchLiveTurn(turns = [], patch = {}) {
  if (!patch?.turnId) {
    return turns;
  }
  return turns.map((turn) => (
    turn?.turnId === patch.turnId
      ? {
          ...turn,
          content: patch.content ?? turn.content ?? "",
        }
      : turn
  ));
}

function renderQuestionPhase(meta) {
  switch (meta?.phase) {
    case "teach-back":
      return "讲解后复述";
    case "follow-up":
      return "追问";
    case "revisit":
      return "回访";
    default:
      return "首问";
  }
}

function getTrainingPointProgress(points = [], currentPointId = "") {
  if (!points.length) {
    return null;
  }
  const currentIndex = Math.max(0, points.findIndex((point) => point.id === currentPointId));
  return {
    currentIndex: currentIndex + 1,
    total: points.length
  };
}

export function AppShell() {
  const [handle, setHandle] = useState("");
  const [pin, setPin] = useState("");
  const [profile, setProfile] = useState(null);
  const [interactionPreference, setInteractionPreference] = useState("balanced");
  const [session, setSession] = useState(null);
  const [answer, setAnswer] = useState("");
  const [burdenSignal, setBurdenSignal] = useState("normal");
  const [error, setError] = useState("");
  const [isAnswering, setIsAnswering] = useState(false);
  const [liveTurns, setLiveTurns] = useState([]);
  const deferredSession = useDeferredValue(session);
  const visibleView = buildVisibleSessionView(deferredSession || {});
  const chatTimeline = visibleView.chatTimeline || [];
  const liveTimeline = buildChatTimeline(liveTurns, {
    limit: Math.max(liveTurns.length, 24),
  });
  const latestMemorySummary = visibleView.latestMemorySummary || "";
  const sessionTakeaway = session?.latestFeedback?.takeaway || "";
  const sessionClosed = Boolean(session) && !session?.currentProbe;
  const trainingPointProgress = getTrainingPointProgress(session?.trainingPoints || [], session?.currentTrainingPointId || "");

  useEffect(() => {
    const userId = getStoredUserId();
    if (!userId) {
      return;
    }
    apiFetch(`/api/profile/${userId}`)
      .then((data) => setProfile(data))
      .catch(() => setStoredUserId(""));
  }, []);

  async function refreshProfile() {
    if (!profile?.user?.id) {
      return;
    }
    const data = await apiFetch(`/api/profile/${profile.user.id}`);
    setProfile(data);
  }

  async function onLogin(event) {
    event.preventDefault();
    try {
      setError("");
      const data = await postJson("/api/auth/login", { handle, pin });
      setProfile(data.profile);
      setStoredUserId(data.profile.user.id);
      setHandle("");
      setPin("");
    } catch (nextError) {
      setError(nextError.message);
    }
  }

  async function onStartTarget(event) {
    event.preventDefault();
    if (!profile?.user?.id) {
      setError("请先登录。");
      return;
    }
    try {
      setError("");
      const data = await postJson("/api/interview/start-target", {
        userId: profile.user.id,
        interactionPreference
      });
      setSession(data);
      await refreshProfile();
    } catch (nextError) {
      setError(nextError.message);
    }
  }

  async function submitAnswer({ answer: nextAnswer = answer, intent = "" } = {}) {
    if (!session?.sessionId) {
      return;
    }
    let finalSession = null;
    try {
      setError("");
      setIsAnswering(true);
      setLiveTurns([]);
      await postEventStream("/api/interview/answer-stream", {
        sessionId: session.sessionId,
        answer: nextAnswer,
        intent,
        burdenSignal,
        interactionPreference
      }, async (event, data) => {
        if (event === "turn_append" && data.turn) {
          setLiveTurns((items) => items.concat([data.turn]));
        }
        if (event === "turn_patch" && data.turnId) {
          setLiveTurns((items) => patchLiveTurn(items, data));
        }
        if (event === "turn_result" || event === "session") {
          finalSession = data;
          setSession(data);
          setAnswer("");
          setLiveTurns([]);
        }
        if (event === "error") {
          throw new Error(data.error || "流式回答失败。");
        }
      });
      if (finalSession) {
        await refreshProfile();
      }
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setIsAnswering(false);
      if (!finalSession) {
        setLiveTurns([]);
      }
    }
  }

  async function focusDomain(domainId) {
    if (!session?.sessionId) {
      return;
    }
    try {
      setSession(await postJson("/api/interview/focus-domain", {
        sessionId: session.sessionId,
        domainId
      }));
    } catch (nextError) {
      setError(nextError.message);
    }
  }

  return (
    <main className="page">
      <section className="hero">
        <p className="eyebrow">Frontend / BFF / AI Service Split</p>
        <h1>Learning Loop AI</h1>
        <p className="lede">当前页面运行在独立 Next.js 前端，只通过 BFF 调用目标、档案与面试主链。</p>
      </section>

      {error ? <section className="panel"><div className="chip">{error}</div></section> : null}

      <section className="grid two">
        <section className="panel">
          <h2>登录</h2>
          {!profile ? (
            <form onSubmit={onLogin}>
              <div className="field">
                <label htmlFor="handle">昵称</label>
                <input id="handle" value={handle} onChange={(event) => setHandle(event.target.value)} placeholder="lee_backend" />
              </div>
              <div className="field">
                <label htmlFor="pin">PIN</label>
                <input id="pin" type="password" value={pin} onChange={(event) => setPin(event.target.value)} placeholder="4-12 位数字" />
              </div>
              <button type="submit">登录 / 创建账号</button>
            </form>
          ) : (
            <div className="list">
              <div className="card">
                <div className="tag">当前用户</div>
                <h3>{profile.user.handle}</h3>
                <p className="muted">档案与长期记忆已绑定到这个账号。</p>
              </div>
              <div className="actions">
                <button className="secondary" type="button" onClick={() => refreshProfile()}>刷新档案</button>
                <button className="secondary" type="button" onClick={() => {
                  setProfile(null);
                  setSession(null);
                  setStoredUserId("");
                }}>退出登录</button>
                <Link className="secondary" href="/profile">打开 Profile 页</Link>
              </div>
            </div>
          )}
        </section>

        <section className="panel">
          <h2>开始训练诊断</h2>
          <form onSubmit={onStartTarget}>
            <div className="field">
              <label htmlFor="interactionPreference">互动风格</label>
              <select id="interactionPreference" value={interactionPreference} onChange={(event) => setInteractionPreference(event.target.value)}>
                <option value="balanced">平衡</option>
                <option value="probe-heavy">偏追问</option>
                <option value="explain-first">偏讲解</option>
              </select>
            </div>
            <button type="submit" disabled={!profile}>开始训练诊断</button>
          </form>
          <p className="muted" style={{ marginTop: 12 }}>本轮允许重整接口与路由，因此新主链统一走 `/api/interview/*`。</p>
        </section>
      </section>

      {profile ? (
        <section className="panel">
          <h2>档案摘要</h2>
          <div className="summary-grid">
            {[
              ["目标数", profile.summary.totalTargets],
              ["累计会话", profile.summary.sessionsStarted],
              ["已评估项", profile.summary.assessedAbilityItems],
              ["Solid", profile.summary.solidItems],
              ["Partial", profile.summary.partialItems],
              ["Weak", profile.summary.weakItems]
            ].map(([label, value]) => (
              <article className="card summary-card" key={label}>
                <small className="muted">{label}</small>
                <strong>{value}</strong>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {session ? (
        <section className="session-layout">
          <section className="panel chat-panel">
            <div className="chat-header">
              <div>
                <div className="eyebrow">Interview Chat</div>
                <h2>当前面试</h2>
              </div>
              <div className="chat-status">
                <span className="chip subtle-chip session-chip">会话 ID：{session.sessionId}</span>
                <span className="chip">当前训练点：{session.currentTrainingPointId || "未定位"}</span>
              </div>
            </div>

            <div className="chat-thread">
              {chatTimeline.concat(liveTimeline).map((entry) => {
                if (entry.type === "event") {
                  return (
                    <div className="chat-event" key={entry.id}>
                      <span>{entry.label}</span>
                    </div>
                  );
                }

                return (
                  <article className={`chat-message ${entry.role}`} key={entry.id}>
                    <div className="chat-meta">
                      <strong>{entry.role === "assistant" ? "Tutor" : "你"}</strong>
                      {entry.conceptTitle ? <span>{entry.conceptTitle}</span> : null}
                      {entry.intentLabel ? <span className="chip subtle-chip">{entry.intentLabel}</span> : null}
                    </div>
                    <div className="chat-bubble">
                      {entry.topicShiftLabel ? <p className="muted chat-shift">{entry.topicShiftLabel}</p> : null}
                      {(entry.bodyParts?.length ? entry.bodyParts : [entry.body]).filter(Boolean).map((block, blockIndex) => (
                        <p key={`${entry.id}:body:${blockIndex}`}>{block}</p>
                      ))}
                      {entry.takeaway ? (
                        <p className="muted"><strong>带走一句：</strong>{entry.takeaway}</p>
                      ) : null}
                    </div>
                    {entry.followUpQuestion || entry.candidateFollowUpQuestion || entry.coachingStep ? (
                      <div className="chat-next-step">
                        <small className="muted">
                          {entry.followUpQuestion
                            ? "接下来 Tutor 会继续问"
                            : entry.candidateFollowUpQuestion
                              ? "如果继续留在这一题，Tutor 会追问"
                              : "下一步"}
                        </small>
                        <p>{entry.followUpQuestion || entry.candidateFollowUpQuestion || entry.coachingStep}</p>
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>

            <form
              className="composer"
              onSubmit={(event) => {
                event.preventDefault();
                submitAnswer();
              }}
            >
              <div className="field">
                <label htmlFor="answer">你的回答</label>
                <textarea id="answer" rows="6" value={answer} onChange={(event) => setAnswer(event.target.value)} />
              </div>
              <div className="composer-row">
                <div className="field composer-burden">
                  <label htmlFor="burdenSignal">当前负荷</label>
                  <select id="burdenSignal" value={burdenSignal} onChange={(event) => setBurdenSignal(event.target.value)}>
                    <option value="normal">正常</option>
                    <option value="high">高负荷</option>
                  </select>
                </div>
                <div className="actions composer-actions">
                  <button type="submit" disabled={isAnswering}>提交回答</button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={isAnswering}
                    onClick={() => submitAnswer({ answer: "讲一下", intent: "teach" })}
                  >
                    讲一下
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={isAnswering}
                    onClick={() => submitAnswer({ answer: "下一题", intent: "advance" })}
                  >
                    下一题
                  </button>
                </div>
              </div>
            </form>
          </section>

          <aside className="session-sidebar">
            <section className="panel">
              <h2>当前进展</h2>
              <div className="card">
                <div className="tag">会话 ID</div>
                <p className="session-id">{session.sessionId}</p>
              </div>
              <div className="card">
                <div className="tag">待你回答</div>
                <p>{session.currentProbe || "当前没有待回答问题。"}</p>
                {trainingPointProgress ? (
                  <p className="muted">
                    训练点 {trainingPointProgress.currentIndex} / {trainingPointProgress.total} · {renderQuestionPhase(session.currentQuestionMeta)}
                  </p>
                ) : null}
                {session.latestFeedback?.turnResolution ? (
                  <p className="muted">流程决策：{renderResolution(session.latestFeedback.turnResolution)}</p>
                ) : null}
              </div>
              {sessionClosed && sessionTakeaway ? (
                <div className="card" style={{ marginTop: 12 }}>
                  <div className="tag">本题已收口</div>
                  <p><strong>带走一句：</strong>{sessionTakeaway}</p>
                  <p className="muted">{session.latestFeedback?.explanation || "这一轮已经整理成可复述版本。"}</p>
                </div>
              ) : null}
              <div className="card" style={{ marginTop: 12 }}>
                <div className="tag">目标匹配度</div>
                <h3>{session.targetMatch?.percentage || 0}%</h3>
                <p className="muted">{session.targetMatch?.explanation || "还在累计有效证据。"}</p>
              </div>
            </section>

            <section className="panel">
              <h2>切换主题</h2>
              <div className="actions">
                {(session.summary?.overviewDomains || []).map((domain) => (
                  <button key={domain.id} type="button" className="secondary" onClick={() => focusDomain(domain.id)}>
                    {domain.title}
                  </button>
                ))}
              </div>
            </section>

            <section className="panel">
              <h2>记忆与反馈</h2>
              {session.latestFeedback ? (
                <div className="card">
                  <div className="tag">本轮反馈</div>
                  <p>{session.latestFeedback.explanation}</p>
                  {session.latestFeedback.takeaway ? <p className="muted"><strong>带走一句：</strong>{session.latestFeedback.takeaway}</p> : null}
                  {session.latestFeedback.coachingStep ? <p className="muted">下一步：{session.latestFeedback.coachingStep}</p> : null}
                </div>
              ) : null}
              <div className="list" style={{ marginTop: 12 }}>
                {latestMemorySummary ? (
                  <article className="card compact-card">
                    <small className="muted">learning memory</small>
                    <div>{latestMemorySummary}</div>
                  </article>
                ) : (
                  <div className="card compact-card">
                    <div className="muted">这一轮还没有新的记忆写回或进展事件。</div>
                  </div>
                )}
              </div>
            </section>
          </aside>
        </section>
      ) : null}
    </main>
  );
}
