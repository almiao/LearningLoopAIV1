"use client";

import Link from "next/link";
import { useDeferredValue, useEffect, useState } from "react";
import { apiFetch, postJson } from "../lib/api";
import { buildChatTimeline } from "../lib/chat-transcript";

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

function renderMemoryEventLabel(event) {
  return event.summary || event.message || event.title || "有新的进展更新";
}

export function AppShell() {
  const [handle, setHandle] = useState("");
  const [pin, setPin] = useState("");
  const [profile, setProfile] = useState(null);
  const [baselines, setBaselines] = useState([]);
  const [targetBaselineId, setTargetBaselineId] = useState("");
  const [interactionPreference, setInteractionPreference] = useState("balanced");
  const [session, setSession] = useState(null);
  const [answer, setAnswer] = useState("");
  const [burdenSignal, setBurdenSignal] = useState("normal");
  const [error, setError] = useState("");
  const deferredTurns = useDeferredValue(session?.turns || []);
  const chatTimeline = buildChatTimeline(deferredTurns);
  const visibleMemoryEvents = (session?.latestMemoryEvents?.length
    ? session.latestMemoryEvents
    : session?.memoryEvents || []).slice(-4);

  useEffect(() => {
    (async () => {
      try {
        const data = await apiFetch("/api/baselines");
        setBaselines(data.baselines || []);
        setTargetBaselineId(data.baselines?.[0]?.id || "");
      } catch (nextError) {
        setError(nextError.message);
      }
    })();
  }, []);

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
        targetBaselineId,
        interactionPreference
      });
      setSession(data);
      await refreshProfile();
    } catch (nextError) {
      setError(nextError.message);
    }
  }

  async function submitAnswer(intent = answer) {
    if (!session?.sessionId) {
      return;
    }
    try {
      setError("");
      const data = await postJson("/api/interview/answer", {
        sessionId: session.sessionId,
        answer: intent,
        burdenSignal,
        interactionPreference
      });
      setSession(data);
      setAnswer("");
      await refreshProfile();
    } catch (nextError) {
      setError(nextError.message);
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
          <h2>开始目标诊断</h2>
          <form onSubmit={onStartTarget}>
            <div className="field">
              <label htmlFor="targetBaselineId">目标包</label>
              <select id="targetBaselineId" value={targetBaselineId} onChange={(event) => setTargetBaselineId(event.target.value)}>
                {baselines.map((baseline) => (
                  <option key={baseline.id} value={baseline.id}>{baseline.title}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="interactionPreference">互动风格</label>
              <select id="interactionPreference" value={interactionPreference} onChange={(event) => setInteractionPreference(event.target.value)}>
                <option value="balanced">平衡</option>
                <option value="probe-heavy">偏追问</option>
                <option value="explain-first">偏讲解</option>
              </select>
            </div>
            <button type="submit" disabled={!profile}>开始目标诊断</button>
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
                <span className="chip">当前点：{session.currentConceptId || "未定位"}</span>
              </div>
            </div>

            <div className="chat-thread">
              {chatTimeline.map((entry) => {
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
                      <p>{entry.body}</p>
                      {entry.followUpQuestion ? (
                        <div className="chat-followup">
                          <small className="muted">接下来 Tutor 会继续问</small>
                          <p>{entry.followUpQuestion}</p>
                        </div>
                      ) : null}
                      {entry.coachingStep ? <p className="muted">下一步：{entry.coachingStep}</p> : null}
                    </div>
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
                  <button type="submit">提交回答</button>
                  <button type="button" className="secondary" onClick={() => submitAnswer("讲一下")}>讲一下</button>
                  <button type="button" className="secondary" onClick={() => submitAnswer("下一题")}>下一题</button>
                </div>
              </div>
            </form>
          </section>

          <aside className="session-sidebar">
            <section className="panel">
              <h2>当前进展</h2>
              <div className="card">
                <div className="tag">待你回答</div>
                <p>{session.currentProbe || "当前没有待回答问题。"}</p>
                {session.latestFeedback?.turnResolution ? (
                  <p className="muted">流程决策：{renderResolution(session.latestFeedback.turnResolution)}</p>
                ) : null}
              </div>
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
                  {session.latestFeedback.coachingStep ? <p className="muted">下一步：{session.latestFeedback.coachingStep}</p> : null}
                </div>
              ) : null}
              <div className="list" style={{ marginTop: 12 }}>
                {visibleMemoryEvents.length ? (
                  visibleMemoryEvents.map((event, index) => (
                    <article className="card compact-card" key={`${event.type || "memory"}-${index}`}>
                      <small className="muted">{event.type || "memory"}</small>
                      <div>{renderMemoryEventLabel(event)}</div>
                    </article>
                  ))
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
