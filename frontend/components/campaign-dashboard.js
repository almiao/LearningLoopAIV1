"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { apiFetch, postJson } from "../lib/api";
import { getStoredUserId } from "../lib/user-session";
import { TrainingGenerationPanel } from "./training-generation-panel";

// 面试冲刺页 — PRODUCT.md「面试冲刺」的 campaign Goal 详情视图（纯视图，零自有引擎/状态，§1.3）。
// 第一性：这页只回答「今天练哪个」。清单态 = 一行读数 + 主按钮「练下一个」+ 话题清单；
// 练题态 = 整页只剩题目与作答。解释性文字一律不上屏（文案纪律见 ui-copy-no-jargon）。

const coverageLabels = {
  uncovered: "没练过",
  shaky: "生疏",
  solid: "扎实",
};

const importanceLabels = {
  core: "重点",
};

function formatDeadline(deadline = "") {
  const ms = Date.parse(deadline);
  if (!Number.isFinite(ms)) {
    return deadline;
  }
  const date = new Date(ms);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

// 「练下一个」= 就绪度缺口排序的第一个（最可能被问倒的优先）。
function nextGapTopic(campaign) {
  const gaps = campaign?.readiness?.gaps || [];
  if (!gaps.length) {
    return null;
  }
  return (campaign.topics || []).find((topic) => topic.id === gaps[0].topicId) || null;
}

function topGapTopics(campaign, limit = 3) {
  const gaps = campaign?.readiness?.gaps || [];
  const topicsById = new Map((campaign?.topics || []).map((topic) => [topic.id, topic]));
  return gaps
    .map((gap) => topicsById.get(gap.topicId))
    .filter(Boolean)
    .slice(0, limit);
}

function buildCampaignInterviewHref(campaignId = "") {
  const params = new URLSearchParams();
  params.set("mode", "interview");
  if (campaignId) {
    params.set("campaignId", campaignId);
  }
  return `/learn?${params.toString()}`;
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
      <h2>开启一次面试冲刺</h2>
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
          placeholder="把职位描述整段贴进来，会拆成可逐个练习的话题。"
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

function TopicPracticeView({ campaignId, topic, onBack, onNext, onCampaignUpdate }) {
  const [practice, setPractice] = useState(null);
  const [answer, setAnswer] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function loadQuestion() {
    try {
      setLoading(true);
      setError("");
      setPractice(null);
      setAnswer("");
      const data = await postJson(
        `/api/campaigns/${encodeURIComponent(campaignId)}/topics/${encodeURIComponent(topic.id)}/practice`,
        { action: "start" },
      );
      setPractice(data);
    } catch (nextError) {
      setError(nextError.message || "出题失败，请重试。");
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
    if (!practice?.question || !submitted) {
      return;
    }
    try {
      setLoading(true);
      setError("");
      const data = await postJson(
        `/api/campaigns/${encodeURIComponent(campaignId)}/topics/${encodeURIComponent(topic.id)}/practice`,
        { action: "answer", question: practice.question, answer: submitted },
      );
      setPractice(data);
      if (data.campaign) {
        onCampaignUpdate(data.campaign);
      }
    } catch (nextError) {
      setError(nextError.message || "判分失败，请重试。");
    } finally {
      setLoading(false);
    }
  }

  const answered = Boolean(practice?.judgment);
  const passed = Boolean(practice?.passed);
  const misses = Array.isArray(practice?.judgment?.misses) ? practice.judgment.misses : [];
  const hits = Array.isArray(practice?.judgment?.hits) ? practice.judgment.hits : [];

  return (
    <article className="ll-training-card ll-campaign-practice-card" data-testid="campaign-practice-panel">
      <div className="ll-campaign-practice-head">
        <button type="button" className="ll-campaign-action" onClick={onBack}>‹ 待练清单</button>
        <span className="ll-campaign-practice-topic">{topic.topic}</span>
      </div>
      {error && !practice?.question ? <p className="ll-campaign-error">{error}</p> : null}
      <h2>{practice?.question || "正在出题..."}</h2>
      {error && practice?.question ? <p className="ll-campaign-error">{error}</p> : null}

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
            disabled={loading || !practice?.question}
          />
          <div className="ll-next-answer-actions">
            <button type="button" className="ll-campaign-action" onClick={() => void loadQuestion()} disabled={loading}>
              换一道
            </button>
            <button type="submit" className="ll-training-primary" disabled={loading || !answer.trim() || !practice?.question}>
              {loading ? "判分中..." : "提交回答"}
            </button>
          </div>
        </form>
      ) : (
        <section className="ll-review-practice-result">
          <div
            className={`ll-thread-score-summary tone-${passed ? "solid" : "weak"}`}
            style={{ "--thread-score-color": passed ? "#1D9E75" : "#E27272" }}
          >
            <div className="ll-thread-score-main">
              <strong>{passed ? "过了 · 标记为扎实" : "没讲稳 · 已加入复习计划"}</strong>
            </div>
          </div>
          {hits.length || misses.length ? (
            <div className="ll-thread-support-grid">
              {hits.length ? (
                <article className="ll-thread-support-card takeaway">
                  <strong>讲到位的</strong>
                  <p>{hits.join("；")}</p>
                </article>
              ) : null}
              {misses.length ? (
                <article className="ll-thread-support-card improve">
                  <strong>没讲到的</strong>
                  <p>{misses.join("；")}</p>
                </article>
              ) : null}
            </div>
          ) : null}
          {!passed && practice.rescue?.markdown ? (
            <div className="ll-thread-message assistant explanation">
              <TrainingGenerationPanel
                embedded
                complete
                markdown={practice.rescue.markdown}
                testId="campaign-practice-rescue-card"
              />
            </div>
          ) : null}
          <div className="ll-next-answer-actions">
            <button type="button" className="ll-campaign-action" onClick={() => void loadQuestion()} disabled={loading}>
              同话题再练
            </button>
            <button type="button" className="ll-training-primary" onClick={onNext}>
              练下一个
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
      setResult(`已加入复习计划，共 ${data.reviewItems?.length || 0} 条。`);
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
    <details className="ll-campaign-debrief" data-testid="campaign-debrief">
      <summary>真实面试结束后，把被问住的点回填进来</summary>
      <p>这里记录的是你在真实面试里临场没讲稳的点，不是当前这道练习题的操作。</p>
      <textarea
        rows="3"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={"一行一个，例：Kafka 重平衡期间消息会怎样"}
      />
      <div className="ll-next-answer-actions">
        <button type="button" className="ll-training-primary" onClick={() => void submitDebrief()} disabled={submitting || !text.trim()}>
          {submitting ? "保存中..." : "加进复习计划"}
        </button>
      </div>
      {result ? <p className="ll-campaign-debrief-done">{result}</p> : null}
      {error ? <p className="ll-campaign-error">{error}</p> : null}
    </details>
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
      setActiveTopic(null);
    } catch (error) {
      setCreateError(error.message || "创建失败。");
    } finally {
      setCreating(false);
    }
  }

  async function archiveCampaign(id) {
    if (typeof window !== "undefined" && !window.confirm("结束这次面试冲刺？练习记录会保留在复习计划里。")) {
      return;
    }
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
  const topics = activeCampaign?.topics || [];
  const practicedCount = topics.filter((topic) => topic.coverage !== "uncovered").length;
  const solidCount = topics.filter((topic) => topic.coverage === "solid").length;
  const shakyCount = topics.filter((topic) => topic.coverage === "shaky").length;
  const uncoveredCount = topics.filter((topic) => topic.coverage === "uncovered").length;
  const daysLeft = activeCampaign?.readiness?.daysLeft;
  const nextTopic = activeCampaign ? nextGapTopic(activeCampaign) : null;
  const priorityTopics = activeCampaign ? topGapTopics(activeCampaign) : [];
  const scheduleLabel = activeCampaign?.deadline
    ? daysLeft === 0
      ? `今天面试 · ${formatDeadline(activeCampaign.deadline)}`
      : `${daysLeft} 天后面试 · ${formatDeadline(activeCampaign.deadline)}`
    : "面试日期未设置";
  const scheduleHint = activeCampaign?.deadline
    ? "系统会按剩余天数和话题风险安排优先级。"
    : "这不是问题，先按 JD 重点和薄弱点开始练就行。";
  const statusCards = [
    {
      label: "已练话题",
      value: `${practicedCount}/${topics.length || 0}`,
      tone: practicedCount ? "warm" : "neutral",
    },
    {
      label: "讲稳的话题",
      value: `${solidCount}`,
      tone: solidCount ? "solid" : "neutral",
    },
    {
      label: "待补的话题",
      value: `${shakyCount + uncoveredCount}`,
      tone: shakyCount + uncoveredCount ? "alert" : "solid",
    },
  ];

  function startNextTopic() {
    const target = nextGapTopic(activeCampaign);
    if (!target) {
      return;
    }
    setActiveTopic(target);
  }

  return (
    <main className="learn-shell ll-campaign-page" data-testid="campaign-dashboard">
      <header className="ll-training-topbar">
        <div className="ll-training-title">
          <button type="button" className="ll-training-back" onClick={() => router.push("/?mode=status&panel=home")}>‹</button>
          <div>
            <span>面试冲刺</span>
            <h1>{activeTopic ? "单题练习" : activeCampaign ? "当前准备" : "新面试"}</h1>
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
        ) : activeTopic ? (
          <TopicPracticeView
            campaignId={activeCampaign.id}
            topic={activeTopic}
            onBack={() => setActiveTopic(null)}
            onNext={() => {
              const target = nextGapTopic(
                (campaigns || []).find((campaign) => campaign.id === activeId) || activeCampaign,
              );
              setActiveTopic(target);
            }}
            onCampaignUpdate={(updated) => {
              applyCampaignUpdate(updated);
              setActiveTopic((current) => {
                if (!current) {
                  return current;
                }
                return updated.topics.find((topic) => topic.id === current.id) || current;
              });
            }}
          />
        ) : (
          <div className="ll-campaign-detail">
            <section className="ll-campaign-summary" data-testid="campaign-readiness">
              <div className="ll-campaign-summary-hero">
                <div className="ll-campaign-summary-copy">
                  <div className="ll-campaign-summary-kicker">
                    <span className={`ll-campaign-status-pill${activeCampaign.deadline ? " is-dated" : ""}`}>{scheduleLabel}</span>
                    {nextTopic ? <span className="ll-campaign-status-pill">下一步先练 {nextTopic.topic}</span> : null}
                  </div>
                  <div>
                    <h2>这场面试先把最容易失分的话题讲稳</h2>
                    <p>{scheduleHint}</p>
                  </div>
                </div>
                <div className="ll-campaign-summary-actions">
                  {nextTopic ? (
                    <button type="button" className="ll-training-primary" onClick={startNextTopic} title={nextTopic.topic}>
                      练下一个
                    </button>
                  ) : (
                    <Link href={buildCampaignInterviewHref(activeCampaign.id)} className="ll-training-primary">开始模拟面试</Link>
                  )}
                  <Link href={buildCampaignInterviewHref(activeCampaign.id)} className="ll-campaign-action">开始模拟面试</Link>
                  <button type="button" className="ll-campaign-action ll-campaign-action-danger" onClick={() => void archiveCampaign(activeCampaign.id)}>
                    归档这场准备
                  </button>
                </div>
              </div>
              <div className="ll-campaign-summary-stats">
                {statusCards.map((card) => (
                  <article key={card.label} className={`ll-campaign-stat-card tone-${card.tone}`}>
                    <span>{card.label}</span>
                    <strong>{card.value}</strong>
                  </article>
                ))}
              </div>
              {priorityTopics.length ? (
                <div className="ll-campaign-priority-strip">
                  <span>优先补强</span>
                  <div className="ll-campaign-priority-topics">
                    {priorityTopics.map((topic) => (
                      <button key={topic.id} type="button" className="ll-campaign-priority-chip" onClick={() => setActiveTopic(topic)}>
                        {topic.topic}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              <p className="ll-campaign-footnote">读数只用来找薄弱点，不代表真实面试结果。</p>
            </section>

            <section className="ll-campaign-topic-section">
              <div className="ll-campaign-section-head">
                <div>
                  <h3>待练清单</h3>
                  <p>上面先看全局安排，下面逐题进入练习。</p>
                </div>
                <span>{topics.length} 个话题</span>
              </div>

              <ul className="ll-campaign-topic-list" data-testid="campaign-topic-list">
                {topics.map((topic) => {
                  const isPriority = nextTopic?.id === topic.id;
                  const coverageTone = topic.coverage === "solid" ? "solid" : topic.coverage === "shaky" ? "shaky" : "uncovered";
                  return (
                    <li key={topic.id}>
                      <button
                        type="button"
                        className={`ll-campaign-topic-row${isPriority ? " is-priority" : ""}`}
                        onClick={() => setActiveTopic(topic)}
                      >
                        <div className="ll-campaign-topic-main">
                          <div className="ll-campaign-topic-labels">
                            {importanceLabels[topic.importance] ? (
                              <span className="ll-campaign-topic-core">{importanceLabels[topic.importance]}</span>
                            ) : null}
                            {isPriority ? <span className="ll-campaign-topic-priority">建议先练</span> : null}
                          </div>
                          <span className="ll-campaign-topic-text">{topic.topic}</span>
                        </div>
                        <div className="ll-campaign-topic-side">
                          <span className={`ll-state-tag ll-state-${coverageTone}`}>
                            {coverageLabels[topic.coverage] || "没练过"}
                          </span>
                          <span className="ll-campaign-topic-arrow">开始</span>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>

            <DebriefPanel campaignId={activeCampaign.id} onCampaignUpdate={applyCampaignUpdate} />
          </div>
        )}
      </section>
    </main>
  );
}
