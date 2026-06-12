"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { apiFetch, postJson } from "../lib/api";
import { getStoredUserId } from "../lib/user-session";
import { TrainingGenerationPanel } from "./training-generation-panel";

// 面试准备页 — PRODUCT.md「面试战役」的 campaign Goal 详情视图。
// 纯视图：倒计时 + 覆盖度 + 就绪度 + 练习入口 + 模拟入口 + 面后复盘，零自有引擎/状态（§1.3）。
// 文案纪律：界面不出现内部术语（战役/drill/账本/锚点/shaky 等），全部用大白话。

const coverageLabels = {
  uncovered: "没练过",
  shaky: "生疏",
  solid: "扎实",
};

function formatPercent(value = 0) {
  return `${Math.round((Number(value) || 0) * 100)}%`;
}

function formatDeadline(deadline = "") {
  const ms = Date.parse(deadline);
  if (!Number.isFinite(ms)) {
    return deadline;
  }
  const date = new Date(ms);
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

function CampaignCreateForm({ creating, error, onCreate }) {
  const [role, setRole] = useState("");
  const [deadline, setDeadline] = useState("");
  const [jdText, setJdText] = useState("");

  return (
    <form
      className="ll-training-card ll-campaign-create-card"
      data-testid="campaign-create-form"
      onSubmit={(event) => {
        event.preventDefault();
        onCreate({ role, deadline, jdText });
      }}
    >
      <h2>准备一场面试</h2>
      <p className="ll-campaign-form-hint">
        贴上职位描述（JD），系统会拆成一份可以逐个练习的话题清单（已上传过简历会自动对照，简历里写了的优先验证）。
      </p>
      <div className="ll-campaign-form-grid">
        <label>
          岗位
          <input value={role} onChange={(event) => setRole(event.target.value)} placeholder="Java 后端" required />
        </label>
        <label>
          面试日期（可选）
          <input type="date" value={deadline} onChange={(event) => setDeadline(event.target.value)} />
        </label>
      </div>
      <label className="ll-campaign-jd-label">
        职位描述（JD）
        <textarea
          rows="8"
          value={jdText}
          onChange={(event) => setJdText(event.target.value)}
          placeholder="把职位描述整段贴进来。"
          required
        />
      </label>
      {error ? <p className="ll-campaign-error">{error}</p> : null}
      <button type="submit" className="ll-training-primary" disabled={creating}>
        {creating ? "正在拆解 JD..." : "生成练习清单"}
      </button>
    </form>
  );
}

function ReadinessPanel({ readiness }) {
  if (!readiness) {
    return null;
  }
  const hasDeadline = readiness.daysLeft !== null && readiness.daysLeft !== undefined;
  return (
    <section className="ll-campaign-readiness" data-testid="campaign-readiness">
      <div className="ll-campaign-readiness-stats">
        {hasDeadline ? (
          <div>
            <strong>{readiness.daysLeft}</strong>
            <span>天后面试</span>
          </div>
        ) : null}
        <div>
          <strong>{formatPercent(readiness.coverageRate)}</strong>
          <span>练过的话题</span>
        </div>
        <div>
          <strong>{formatPercent(readiness.masteryRate)}</strong>
          <span>讲得稳的话题</span>
        </div>
      </div>
      {readiness.likelyToFail?.length ? (
        <div className="ll-campaign-risk-list">
          <span>最可能被问倒的</span>
          {readiness.likelyToFail.map((gap) => (
            <em key={gap.topicId}>{gap.topic}</em>
          ))}
        </div>
      ) : (
        <div className="ll-campaign-risk-list">
          <span>清单上的话题都讲得稳了，去模拟面试再验一遍。</span>
        </div>
      )}
      <p className="ll-campaign-disclaimer">这份读数只是你自己的薄弱点地图，不代表面试结果。</p>
    </section>
  );
}

function TopicDrillPanel({ campaignId, topic, onClose, onCampaignUpdate }) {
  const [drill, setDrill] = useState(null);
  const [answer, setAnswer] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function loadQuestion() {
    try {
      setLoading(true);
      setError("");
      setDrill(null);
      setAnswer("");
      const data = await postJson(
        `/api/campaigns/${encodeURIComponent(campaignId)}/topics/${encodeURIComponent(topic.id)}/drill`,
        { action: "start" },
      );
      setDrill(data);
    } catch (nextError) {
      setError(nextError.message || "练习题生成失败。");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadQuestion();
    // 切换话题时重新出题。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId, topic.id]);

  async function submitAnswer() {
    const submitted = answer.trim();
    if (!drill?.question || !submitted) {
      return;
    }
    try {
      setLoading(true);
      setError("");
      const data = await postJson(
        `/api/campaigns/${encodeURIComponent(campaignId)}/topics/${encodeURIComponent(topic.id)}/drill`,
        { action: "answer", question: drill.question, answer: submitted },
      );
      setDrill(data);
      if (data.campaign) {
        onCampaignUpdate(data.campaign);
      }
    } catch (nextError) {
      setError(nextError.message || "判分失败。");
    } finally {
      setLoading(false);
    }
  }

  const answered = Boolean(drill?.judgment);
  const passed = Boolean(drill?.passed);
  const misses = Array.isArray(drill?.judgment?.misses) ? drill.judgment.misses : [];
  const hits = Array.isArray(drill?.judgment?.hits) ? drill.judgment.hits : [];

  return (
    <article className="ll-training-card ll-campaign-drill-card" data-testid="campaign-drill-panel">
      <div className="ll-training-card-chip-row">
        <span className="ll-training-chip">{`练这个话题 · ${coverageLabels[topic.coverage] || "没练过"}`}</span>
        <button type="button" className="ll-tool-button" onClick={onClose}>关闭</button>
      </div>
      <h2>{drill?.question || (loading ? "正在出题..." : error || "正在出题...")}</h2>
      {error && drill?.question ? <p className="ll-campaign-error">{error}</p> : null}

      {!answered ? (
        <form
          className="ll-next-answer-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submitAnswer();
          }}
        >
          <textarea
            rows="6"
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            placeholder="像面试一样作答：先结论，再机制、边界和取舍。"
            disabled={loading || !drill?.question}
          />
          <div className="ll-next-answer-actions">
            <button type="button" className="ll-tool-button" onClick={() => void loadQuestion()} disabled={loading}>
              换一道
            </button>
            <button type="submit" className="ll-training-primary" disabled={loading || !answer.trim() || !drill?.question}>
              {loading ? "判分中..." : "提交回答"}
            </button>
          </div>
        </form>
      ) : (
        <section className="ll-review-drill-result">
          <div
            className={`ll-thread-score-summary tone-${passed ? "solid" : "weak"}`}
            style={{ "--thread-score-color": passed ? "#1D9E75" : "#E27272" }}
          >
            <div className="ll-thread-score-main">
              <strong>{passed ? "过了，这个话题标记为扎实" : "没讲稳，已加进你的复习计划"}</strong>
              <span>{passed ? "扎实" : "生疏"}</span>
            </div>
            <p>
              {passed
                ? "这个话题先放一放，后面用模拟面试再验证一遍。"
                : "这个点会出现在首页的今日复习里，先看下面的讲解补上。"}
            </p>
          </div>
          {hits.length || misses.length ? (
            <div className="ll-thread-support-grid">
              {hits.length ? (
                <article className="ll-thread-support-card takeaway">
                  <strong>你讲到位的点</strong>
                  <p>{hits.join("；")}</p>
                </article>
              ) : null}
              {misses.length ? (
                <article className="ll-thread-support-card improve">
                  <strong>还没讲到的关键点</strong>
                  <p>{misses.join("；")}</p>
                </article>
              ) : null}
            </div>
          ) : null}
          {!passed && drill.rescue?.markdown ? (
            <div className="ll-thread-message assistant explanation">
              <TrainingGenerationPanel
                embedded
                complete
                markdown={drill.rescue.markdown}
                testId="campaign-drill-rescue-card"
              />
            </div>
          ) : null}
          <div className="ll-next-answer-actions">
            <button type="button" className="ll-tool-button" onClick={() => void loadQuestion()} disabled={loading}>
              再练一题
            </button>
            <button type="button" className="ll-training-primary" onClick={onClose}>
              回话题清单
            </button>
          </div>
        </section>
      )}
    </article>
  );
}

function DebriefPanel({ campaignId, onCampaignUpdate }) {
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");

  async function submitDebrief() {
    const misses = text
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => ({ handle: line }));
    if (!misses.length) {
      return;
    }
    try {
      setSubmitting(true);
      setError("");
      const data = await postJson(`/api/campaigns/${encodeURIComponent(campaignId)}/debrief`, { misses });
      setResult(`已加进复习计划，共 ${data.reviewItems?.length || 0} 条。`);
      setText("");
      if (data.campaign) {
        onCampaignUpdate(data.campaign);
      }
    } catch (nextError) {
      setError(nextError.message || "保存失败。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="ll-campaign-debrief" data-testid="campaign-debrief">
      <h3>面试后复盘</h3>
      <p>面试里真被问到、却没答上来的点，一行一个写下来——这些最值得练，会直接进你的复习计划。</p>
      <textarea
        rows="3"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={"例：Kafka 重平衡期间消息会怎样\n例：G1 的 mixed GC 触发条件"}
      />
      <div className="ll-next-answer-actions">
        <button type="button" className="ll-training-primary" onClick={() => void submitDebrief()} disabled={submitting || !text.trim()}>
          {submitting ? "保存中..." : "加进复习计划"}
        </button>
      </div>
      {result ? <p className="ll-campaign-debrief-done">{result}</p> : null}
      {error ? <p className="ll-campaign-error">{error}</p> : null}
    </section>
  );
}

export function CampaignDashboard() {
  const router = useRouter();
  const [campaigns, setCampaigns] = useState(null);
  const [activeId, setActiveId] = useState("");
  const [activeTopic, setActiveTopic] = useState(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await apiFetch("/api/campaigns");
        if (!cancelled) {
          const list = Array.isArray(data.campaigns) ? data.campaigns : [];
          setCampaigns(list);
          setActiveId((current) => current || list[0]?.id || "");
        }
      } catch (error) {
        if (!cancelled) {
          setLoadError(error.message || "加载失败。");
          setCampaigns([]);
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  function applyCampaignUpdate(updated) {
    setCampaigns((current) => (current || []).map((campaign) => (campaign.id === updated.id ? updated : campaign)));
  }

  async function createCampaign({ role, deadline, jdText }) {
    try {
      setCreating(true);
      setCreateError("");
      const data = await postJson("/api/campaigns", {
        role,
        deadline,
        jdText,
        userId: getStoredUserId(),
      });
      setCampaigns((current) => [...(current || []), data.campaign]);
      setActiveId(data.campaign.id);
    } catch (error) {
      setCreateError(error.message || "创建失败。");
    } finally {
      setCreating(false);
    }
  }

  async function archiveCampaign(id) {
    try {
      await postJson(`/api/campaigns/${encodeURIComponent(id)}/archive`, {});
      setCampaigns((current) => (current || []).filter((campaign) => campaign.id !== id));
      setActiveId("");
      setActiveTopic(null);
    } catch (error) {
      setLoadError(error.message || "操作失败。");
    }
  }

  const activeCampaign = (campaigns || []).find((campaign) => campaign.id === activeId) || null;

  return (
    <main className="learn-shell ll-campaign-page" data-testid="campaign-dashboard">
      <header className="ll-training-topbar">
        <div className="ll-training-title">
          <button type="button" className="ll-training-back" onClick={() => router.push("/?mode=status&panel=home")}>‹</button>
          <div>
            <span>面试准备</span>
            <h1>{activeCampaign ? `${activeCampaign.role}${activeCampaign.company ? ` @ ${activeCampaign.company}` : ""}` : "新面试"}</h1>
          </div>
        </div>
        <div className="ll-training-tabs">
          {(campaigns || []).map((campaign) => (
            <button
              key={campaign.id}
              type="button"
              className={campaign.id === activeId ? "active" : ""}
              onClick={() => {
                setActiveId(campaign.id);
                setActiveTopic(null);
              }}
            >
              {campaign.role}
            </button>
          ))}
          <button type="button" className={!activeId ? "active" : ""} onClick={() => { setActiveId(""); setActiveTopic(null); }}>
            ＋ 新面试
          </button>
        </div>
      </header>

      {loadError ? <section className="feedback-banner error-banner narrow-banner">{loadError}</section> : null}

      <section className="ll-campaign-main">
        {campaigns === null ? (
          <p className="ll-campaign-loading">加载中...</p>
        ) : !activeCampaign ? (
          <CampaignCreateForm creating={creating} error={createError} onCreate={createCampaign} />
        ) : (
          <div className="ll-campaign-detail">
            <div className="ll-campaign-meta-row">
              <span>{activeCampaign.deadline ? `面试日 ${formatDeadline(activeCampaign.deadline)}` : "还没定面试日期"}</span>
              <div className="ll-campaign-meta-actions">
                <Link href="/loopassist" className="ll-tool-button">模拟面试</Link>
                <button type="button" className="ll-tool-button" onClick={() => void archiveCampaign(activeCampaign.id)}>
                  结束这场面试
                </button>
              </div>
            </div>

            <ReadinessPanel readiness={activeCampaign.readiness} />

            {activeTopic ? (
              <TopicDrillPanel
                campaignId={activeCampaign.id}
                topic={activeTopic}
                onClose={() => setActiveTopic(null)}
                onCampaignUpdate={(updated) => {
                  applyCampaignUpdate(updated);
                  setActiveTopic((current) => {
                    if (!current) {
                      return current;
                    }
                    const next = updated.topics.find((topic) => topic.id === current.id);
                    return next || current;
                  });
                }}
              />
            ) : (
              <ul className="ll-campaign-topic-list" data-testid="campaign-topic-list">
                {activeCampaign.topics.map((topic) => (
                  <li key={topic.id}>
                    <button type="button" className="ll-campaign-topic-row" onClick={() => setActiveTopic(topic)}>
                      <span className={`ll-campaign-topic-dot is-${topic.coverage}`} aria-hidden="true" />
                      <span className="ll-campaign-topic-text">{topic.topic}</span>
                      {topic.importance === "core" ? <span className="ll-campaign-topic-core">重点</span> : null}
                      <span className={`ll-state-tag ll-state-${topic.coverage === "solid" ? "solid" : "shaky"}`}>
                        {coverageLabels[topic.coverage] || "没练过"}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <DebriefPanel campaignId={activeCampaign.id} onCampaignUpdate={applyCampaignUpdate} />
          </div>
        )}
      </section>
    </main>
  );
}
