"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { apiFetch, postJson } from "../lib/api";
import { getStoredUserId } from "../lib/user-session";
import { TrainingGenerationPanel } from "./training-generation-panel";

// 面试战役仪表盘 — PRODUCT.md「面试战役」的 campaign Goal 详情视图。
// 纯视图：倒计时 + 覆盖度 + 就绪度 + drill 入口 + 模拟入口 + 面后回灌，零自有引擎/状态（§1.3）。

const coverageLabels = {
  uncovered: "未覆盖",
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
  const [company, setCompany] = useState("");
  const [role, setRole] = useState("");
  const [deadline, setDeadline] = useState("");
  const [jdText, setJdText] = useState("");

  return (
    <form
      className="ll-training-card ll-campaign-create-card"
      data-testid="campaign-create-form"
      onSubmit={(event) => {
        event.preventDefault();
        onCreate({ company, role, deadline, jdText });
      }}
    >
      <h2>开一场面试战役</h2>
      <p className="ll-campaign-form-hint">
        贴上 JD，系统当场拆成可操练的话题清单（已上传过简历会自动交叉，简历声称会的优先验）。
      </p>
      <div className="ll-campaign-form-grid">
        <label>
          公司（可选）
          <input value={company} onChange={(event) => setCompany(event.target.value)} placeholder="Acme" />
        </label>
        <label>
          岗位
          <input value={role} onChange={(event) => setRole(event.target.value)} placeholder="Java 后端" required />
        </label>
        <label>
          面试日期
          <input type="date" value={deadline} onChange={(event) => setDeadline(event.target.value)} required />
        </label>
      </div>
      <label className="ll-campaign-jd-label">
        JD 原文
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
        {creating ? "正在拆解 JD..." : "建战役并拆话题"}
      </button>
    </form>
  );
}

function ReadinessPanel({ readiness }) {
  if (!readiness) {
    return null;
  }
  return (
    <section className="ll-campaign-readiness" data-testid="campaign-readiness">
      <div className="ll-campaign-readiness-stats">
        <div>
          <strong>{readiness.daysLeft}</strong>
          <span>天倒计时</span>
        </div>
        <div>
          <strong>{formatPercent(readiness.coverageRate)}</strong>
          <span>覆盖率（碰过没）</span>
        </div>
        <div>
          <strong>{formatPercent(readiness.masteryRate)}</strong>
          <span>达标度（会不会）</span>
        </div>
      </div>
      {readiness.likelyToFail?.length ? (
        <div className="ll-campaign-risk-list">
          <span>最可能被问崩</span>
          {readiness.likelyToFail.map((gap) => (
            <em key={gap.topicId}>{gap.topic}</em>
          ))}
        </div>
      ) : (
        <div className="ll-campaign-risk-list">
          <span>缺口已清零，再用模拟面校一遍。</span>
        </div>
      )}
      <p className="ll-campaign-disclaimer">{readiness.disclaimer}</p>
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
        <span className="ll-training-chip">{`话题操练 · ${coverageLabels[topic.coverage] || "未覆盖"}`}</span>
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
              <strong>{passed ? "过线，话题转扎实" : "答崩了，已写进失败账本"}</strong>
              <span>{passed ? "solid" : "shaky"}</span>
            </div>
            <p>
              {passed
                ? "覆盖度清单里这条标为扎实。碰过 ≠ 会，账本不会为一次过的留痕。"
                : "这个点会按面试日封顶的节奏出现在今日复习里，先看补讲。"}
            </p>
          </div>
          {hits.length || misses.length ? (
            <div className="ll-thread-support-grid">
              {hits.length ? (
                <article className="ll-thread-support-card takeaway">
                  <strong>命中的锚点</strong>
                  <p>{hits.join("；")}</p>
                </article>
              ) : null}
              {misses.length ? (
                <article className="ll-thread-support-card improve">
                  <strong>漏掉的锚点</strong>
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
      setResult(`已转成 ${data.reviewItems?.length || 0} 条复习项，进了失败账本。`);
      setText("");
      if (data.campaign) {
        onCampaignUpdate(data.campaign);
      }
    } catch (nextError) {
      setError(nextError.message || "回灌失败。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="ll-campaign-debrief" data-testid="campaign-debrief">
      <h3>面试后回灌</h3>
      <p>真被问到却没答上的点，一行一个写下来——真实失败最值钱，直接转复习项。</p>
      <textarea
        rows="3"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={"例：Kafka 重平衡期间消息会怎样\n例：G1 的 mixed GC 触发条件"}
      />
      <div className="ll-next-answer-actions">
        <button type="button" className="ll-training-primary" onClick={() => void submitDebrief()} disabled={submitting || !text.trim()}>
          {submitting ? "写入账本..." : "转成复习项"}
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
          setLoadError(error.message || "战役列表加载失败。");
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

  async function createCampaign({ company, role, deadline, jdText }) {
    try {
      setCreating(true);
      setCreateError("");
      const data = await postJson("/api/campaigns", {
        company,
        role,
        deadline,
        jdText,
        userId: getStoredUserId(),
      });
      setCampaigns((current) => [...(current || []), data.campaign]);
      setActiveId(data.campaign.id);
    } catch (error) {
      setCreateError(error.message || "建战役失败。");
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
      setLoadError(error.message || "归档失败。");
    }
  }

  const activeCampaign = (campaigns || []).find((campaign) => campaign.id === activeId) || null;

  return (
    <main className="learn-shell ll-campaign-page" data-testid="campaign-dashboard">
      <header className="ll-training-topbar">
        <div className="ll-training-title">
          <button type="button" className="ll-training-back" onClick={() => router.push("/?mode=status&panel=home")}>‹</button>
          <div>
            <span>面试战役</span>
            <h1>{activeCampaign ? `${activeCampaign.role}${activeCampaign.company ? ` @ ${activeCampaign.company}` : ""}` : "备战仪表盘"}</h1>
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
            ＋ 新战役
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
              <span>{`面试日 ${formatDeadline(activeCampaign.deadline)}`}</span>
              <div className="ll-campaign-meta-actions">
                <Link href="/loopassist" className="ll-tool-button">模拟面（连播）</Link>
                <button type="button" className="ll-tool-button" onClick={() => void archiveCampaign(activeCampaign.id)}>
                  结束战役归档
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
                      {topic.importance === "core" ? <span className="ll-campaign-topic-core">core</span> : null}
                      <span className={`ll-state-tag ll-state-${topic.coverage === "solid" ? "solid" : "shaky"}`}>
                        {coverageLabels[topic.coverage] || "未覆盖"}
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
