"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { apiFetch, postJson } from "../lib/api";
import { getStoredUserId } from "../lib/user-session";
import { PracticeShell } from "./practice/practice-shell";
import { getPracticeSeedSourceLabel, practiceSeedTypes } from "./practice/seed-types";

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

// 这页只回答「今天练哪个」：默认只摊开缺口最大的前几个，其余折叠，别一次砸 19 个给用户。
const FOCUS_COUNT = 3;

// 用大白话说清每个考点的来路，拼进 hero 说明里（区别于清单行里的短标签）。
const originLabels = {
  "jd-topic": "职位描述",
  "resume-claim": "你的简历",
  "report-seed": "常考面经",
  "review-item": "复习记录",
};

function describeOrigins(topics = []) {
  const seen = [];
  for (const topic of topics) {
    const label = originLabels[topic.source] || originLabels["jd-topic"];
    if (!seen.includes(label)) {
      seen.push(label);
    }
  }
  return seen.join("、") || "职位描述";
}

async function postJsonWithTimeout(pathname, payload, { timeoutMs = 45000, timeoutMessage = "AI 响应超时，请稍后重试。" } = {}) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await apiFetch(pathname, {
      method: "POST",
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(timeoutMessage);
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

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

// 清单直接按缺口顺序排（最可能被问倒的在最上面），不再单独放「优先补强」条。
function orderTopicsByGap(campaign) {
  const topics = campaign?.topics || [];
  const gapOrder = new Map((campaign?.readiness?.gaps || []).map((gap, index) => [gap.topicId, index]));
  return [...topics].sort((a, b) => {
    const rankA = gapOrder.has(a.id) ? gapOrder.get(a.id) : Number.MAX_SAFE_INTEGER;
    const rankB = gapOrder.has(b.id) ? gapOrder.get(b.id) : Number.MAX_SAFE_INTEGER;
    return rankA - rankB;
  });
}

// 按主题分组（展开态用）：主题顺序沿用缺口排序里第一次出现的位置，组内保持缺口顺序。
function groupTopicsByTheme(orderedTopics = []) {
  const groups = [];
  const byTheme = new Map();
  for (const topic of orderedTopics) {
    const theme = topic.theme || "其他";
    if (!byTheme.has(theme)) {
      const group = { theme, topics: [] };
      byTheme.set(theme, group);
      groups.push(group);
    }
    byTheme.get(theme).topics.push(topic);
  }
  return groups;
}

function buildCampaignInterviewHref(campaignId = "") {
  const params = new URLSearchParams();
  params.set("mode", "interview");
  if (campaignId) {
    params.set("campaignId", campaignId);
  }
  return `/learn?${params.toString()}`;
}

// 主轴三选一：贴 JD / 从库里选 JD / 从面经选。互斥（同一个范围槽位的三种填法）。
const spineTabs = [
  { key: "jd-paste", label: "贴 JD" },
  { key: "jd-library", label: "从库里选 JD" },
  { key: "interview-library", label: "从面经选" },
];

// 库内 JD/面经选择器：关键词搜索（防抖）+ 岗位过滤（仅 JD）+ 可点选列表。
function CampaignLibraryPicker({ kind, selected, onSelect }) {
  const [query, setQuery] = useState("");
  const [role, setRole] = useState("");
  const [items, setItems] = useState([]);
  const [roles, setRoles] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        setLoading(true);
        const params = new URLSearchParams();
        if (query.trim()) {
          params.set("q", query.trim());
        }
        if (role) {
          params.set("role", role);
        }
        params.set("pageSize", "20");
        const data = await apiFetch(`/api/campaign/library/${kind}?${params.toString()}`);
        if (!cancelled) {
          setItems(Array.isArray(data.items) ? data.items : []);
          setRoles(Array.isArray(data.roles) ? data.roles : []);
          setTotal(Number(data.total) || 0);
        }
      } catch {
        if (!cancelled) {
          setItems([]);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [kind, query, role]);

  // 点选后取全文，让用户确认选的是哪一份（列表只给 160 字摘要，看不全）。
  async function pickItem(item) {
    try {
      setDetailLoading(true);
      const full = await apiFetch(`/api/campaign/library/${kind}/${encodeURIComponent(item.id)}`);
      onSelect({ ...item, text: full?.text || "" });
    } catch {
      onSelect(item); // 取全文失败也不挡选择，create 时服务端还会按 id 重取。
    } finally {
      setDetailLoading(false);
    }
  }

  // 选中态：展示原文 + 「换一个」回到搜索列表。
  if (selected) {
    return (
      <div className="ll-campaign-library" data-testid={`campaign-library-${kind}`}>
        <div className="ll-campaign-library-picked">
          <div className="ll-campaign-library-picked-head">
            <span className="ll-campaign-library-item-title">{selected.title}</span>
            <button type="button" className="ll-campaign-action" onClick={() => onSelect(null)}>换一个</button>
          </div>
          {selected.role ? <span className="ll-campaign-library-item-role">{selected.role}</span> : null}
          <pre className="ll-campaign-library-fulltext" data-testid={`campaign-library-fulltext-${kind}`}>
            {detailLoading ? "读取原文中..." : (selected.text || selected.excerpt || "")}
          </pre>
        </div>
      </div>
    );
  }

  return (
    <div className="ll-campaign-library" data-testid={`campaign-library-${kind}`}>
      <div className="ll-campaign-library-controls">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={kind === "jd" ? "搜岗位 / 技能，如 RAG、Java、大模型" : "搜面经，如 字节、后端、RAG"}
        />
        {kind === "jd" && roles.length ? (
          <select value={role} onChange={(event) => setRole(event.target.value)}>
            <option value="">全部岗位</option>
            {roles.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        ) : null}
      </div>
      <div className="ll-campaign-library-list">
        {loading ? (
          <p className="ll-campaign-library-empty">搜索中...</p>
        ) : items.length ? (
          items.map((item) => (
            <button
              key={item.id}
              type="button"
              className="ll-campaign-library-item"
              onClick={() => pickItem(item)}
            >
              <span className="ll-campaign-library-item-head">
                <span className="ll-campaign-library-item-title">{item.title}</span>
                {item.role ? <span className="ll-campaign-library-item-role">{item.role}</span> : null}
              </span>
              <span className="ll-campaign-library-item-excerpt">{item.excerpt}</span>
            </button>
          ))
        ) : (
          <p className="ll-campaign-library-empty">没找到，换个关键词试试。</p>
        )}
      </div>
      {total > items.length ? (
        <p className="ll-campaign-library-more">共 {total} 条，输入关键词缩小范围</p>
      ) : null}
    </div>
  );
}

function CampaignCreateForm({ creating, error, onCreate }) {
  const [role, setRole] = useState("");
  const [deadline, setDeadline] = useState("");
  const [spineTab, setSpineTab] = useState("jd-paste");
  const [jdText, setJdText] = useState("");
  const [pickedJd, setPickedJd] = useState(null);
  const [pickedInterview, setPickedInterview] = useState(null);
  const [resumeText, setResumeText] = useState("");
  const [showResume, setShowResume] = useState(false);

  let spine = null;
  if (spineTab === "jd-library") {
    spine = pickedJd ? { source: "jd-library", libraryId: pickedJd.id } : null;
  } else if (spineTab === "interview-library") {
    spine = pickedInterview ? { source: "interview-library", libraryId: pickedInterview.id } : null;
  } else if (jdText.trim()) {
    spine = { source: "jd-paste", text: jdText };
  }

  // 选中库内 JD 时若岗位还空着，用它的岗位预填，省一次手填。
  function pickJd(item) {
    setPickedJd(item);
    if (item && !role.trim() && item.role) {
      setRole(item.role);
    }
  }

  return (
    <form
      className="ll-training-card ll-campaign-create-card"
      data-testid="campaign-create-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!spine) {
          return;
        }
        onCreate({ role, deadline, resumeText, spine });
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

      <div className="ll-campaign-spine">
        <div className="ll-campaign-spine-tabs" data-testid="campaign-spine-tabs">
          {spineTabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              className={tab.key === spineTab ? "active" : ""}
              onClick={() => setSpineTab(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {spineTab === "jd-paste" ? (
          <label className="ll-campaign-jd-label">
            <textarea
              rows="8"
              value={jdText}
              onChange={(event) => setJdText(event.target.value)}
              placeholder="把职位描述整段贴进来，会拆成可逐个练习的话题。"
            />
          </label>
        ) : spineTab === "jd-library" ? (
          <CampaignLibraryPicker kind="jd" selected={pickedJd} onSelect={pickJd} />
        ) : (
          <CampaignLibraryPicker kind="interview" selected={pickedInterview} onSelect={setPickedInterview} />
        )}
      </div>

      {/* 简历是叠加层（与主轴交叉校准），不是第四种主轴：默认收起为可选入口，避免抢焦点。 */}
      {showResume || resumeText.trim() ? (
        <div className="ll-campaign-resume">
          <div className="ll-campaign-resume-head">
            <span>简历校准（可选）</span>
            <button type="button" className="ll-campaign-resume-collapse" onClick={() => { setShowResume(false); setResumeText(""); }}>
              不用了
            </button>
          </div>
          <p className="ll-campaign-field-hint">贴上简历，会把你声称会的点也排进清单，并标出和上面来源的差距。</p>
          <textarea
            rows="5"
            value={resumeText}
            onChange={(event) => setResumeText(event.target.value)}
            placeholder="贴上简历片段……"
            autoFocus={showResume && !resumeText}
          />
        </div>
      ) : (
        <button type="button" className="ll-campaign-resume-toggle" onClick={() => setShowResume(true)}>
          ＋ 加上简历校准（可选）
        </button>
      )}
      {error ? <p className="ll-campaign-error">{error}</p> : null}
      <button type="submit" className="ll-training-primary" disabled={creating || !spine}>
        {creating ? "正在生成清单..." : "生成练习清单"}
      </button>
    </form>
  );
}

function TopicPracticeView({ campaignId, topic, nextLabel, onNext, onCampaignUpdate }) {
  const [practice, setPractice] = useState(null);
  const [answer, setAnswer] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const rescueRequestIdRef = useRef(0);

  async function loadRescue({ question, hits, misses }) {
    const requestId = ++rescueRequestIdRef.current;
    try {
      const data = await postJson(
        `/api/campaigns/${encodeURIComponent(campaignId)}/topics/${encodeURIComponent(topic.id)}/rescue`,
        { question, hits, misses },
      );
      if (rescueRequestIdRef.current !== requestId) {
        return;
      }
      setPractice((current) => {
        if (!current || current.question !== question || current.passed) {
          return current;
        }
        return {
          ...current,
          rescue: data?.rescue || { pending: false, markdown: "" },
        };
      });
    } catch {
      if (rescueRequestIdRef.current !== requestId) {
        return;
      }
      setPractice((current) => {
        if (!current || current.question !== question || current.passed) {
          return current;
        }
        return {
          ...current,
          rescue: { pending: false, markdown: "" },
        };
      });
    }
  }

  async function loadQuestion() {
    try {
      rescueRequestIdRef.current += 1;
      setLoading(true);
      setError("");
      setPractice(null);
      setAnswer("");
      const data = await postJsonWithTimeout(
        `/api/campaigns/${encodeURIComponent(campaignId)}/topics/${encodeURIComponent(topic.id)}/practice`,
        { action: "start" },
        { timeoutMessage: "出题超时，请换一道或稍后重试。" },
      );
      setPractice(data);
    } catch (nextError) {
      setError(nextError.message || "出题失败，请重试。");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    rescueRequestIdRef.current += 1;
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
      const data = await postJsonWithTimeout(
        `/api/campaigns/${encodeURIComponent(campaignId)}/topics/${encodeURIComponent(topic.id)}/practice`,
        { action: "answer", question: practice.question, answer: submitted },
        { timeoutMessage: "判分超时，请稍后重试。" },
      );
      setPractice(data);
      if (!data?.passed && data?.question) {
        void loadRescue({
          question: data.question,
          hits: data?.judgment?.hits || [],
          misses: data?.judgment?.misses || [],
        });
      }
      if (data.campaign) {
        onCampaignUpdate(data.campaign);
      }
    } catch (nextError) {
      setError(nextError.message || "判分失败，请重试。");
    } finally {
      setLoading(false);
    }
  }

  return (
    <PracticeShell
      seed={{ type: topic.source || practiceSeedTypes.jdTopic, payload: topic }}
      practice={practice}
      answer={answer}
      setAnswer={setAnswer}
      loading={loading}
      error={error}
      onSubmit={submitAnswer}
      onRefreshQuestion={loadQuestion}
      className="ll-training-card ll-campaign-practice-card"
      testId="campaign-practice-panel"
      questionFallback="正在出题..."
      answerPlaceholder="像面试一样作答：先结论，再机制、边界和取舍。"
      resultLabels={{
        passLabel: "过了 · 标记为扎实",
        failLabel: "没讲稳 · 已加入复习计划",
      }}
      supportLabels={{ hits: "讲到位的", misses: "没讲到的" }}
      rescueTestId="campaign-practice-rescue-card"
      actions={{
        retry: "换一道",
        retryAnswered: "同话题再练",
        retryClassName: "ll-campaign-action",
        next: nextLabel || "练下一个",
        onNext,
      }}
    />
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
      <textarea
        rows="3"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={"一行一个，例：Kafka 重平衡期间消息会怎样"}
      />
      <div className="ll-next-answer-actions">
        <button type="button" className="ll-campaign-action" onClick={() => void submitDebrief()} disabled={submitting || !text.trim()}>
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
  const [showAllTopics, setShowAllTopics] = useState(false);

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

  async function createCampaign({ role, deadline, resumeText, spine }) {
    try {
      setCreating(true);
      setCreateError("");
      const data = await postJson("/api/campaigns", {
        role,
        deadline,
        resumeText,
        spine,
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
  const topics = activeCampaign ? orderTopicsByGap(activeCampaign) : [];
  const solidCount = topics.filter((topic) => topic.coverage === "solid").length;
  const shakyCount = topics.filter((topic) => topic.coverage === "shaky").length;
  const uncoveredCount = topics.filter((topic) => topic.coverage === "uncovered").length;
  const daysLeft = activeCampaign?.readiness?.daysLeft;
  const nextTopic = activeCampaign ? nextGapTopic(activeCampaign) : null;
  const scheduleLabel = activeCampaign?.deadline
    ? daysLeft === 0
      ? `今天面试 · ${formatDeadline(activeCampaign.deadline)}`
      : `${daysLeft} 天后面试 · ${formatDeadline(activeCampaign.deadline)}`
    : "面试日期未设置";
  // 与清单行徽标同一套词（扎实/生疏/没练过），一行读数替代原三张统计卡。
  const readoutParts = [
    `${topics.length} 个考点`,
    `扎实 ${solidCount}`,
    `生疏 ${shakyCount}`,
    `没练过 ${uncoveredCount}`,
  ];
  const notSolidCount = shakyCount + uncoveredCount;
  const solidPercent = topics.length ? Math.round((solidCount / topics.length) * 100) : 0;
  // 标签只标例外：全是重点就不标重点，来源只在清单里混了多种来源时才显示（#1 去重复）。
  const everyTopicCore = topics.length > 0 && topics.every((topic) => topic.importance === "core");
  const hasMixedSource = new Set(topics.map((topic) => topic.source || "jd-topic")).size > 1;
  const focusActive = topics.length > FOCUS_COUNT && !showAllTopics;
  const visibleTopics = focusActive ? topics.slice(0, FOCUS_COUNT) : topics;
  // 展开态且每条都有主题时按主题分组；任一条缺主题（老 campaign）就退回扁平。
  const allThemed = topics.length > 0 && topics.every((topic) => Boolean(topic.theme));
  const groupByTheme = !focusActive && allThemed && topics.length > FOCUS_COUNT;
  const themeGroups = groupByTheme ? groupTopicsByTheme(topics) : [];
  // hero 讲整场冲刺：标题给具体进度，下面一句说清这些考点从哪来、练它图什么（#7）。
  const heroHeadline = notSolidCount > 0
    ? `还有 ${notSolidCount} 个考点没讲稳`
    : "考点都讲稳了，去模拟面试检验全程";
  const heroExplain = activeCampaign
    ? `这 ${topics.length} 个考点是从${describeOrigins(topics)}里拆出来的，按最可能被问倒的排在前面。逐个讲清楚，真面试被问到时就不容易卡壳。`
    : "";

  function startNextTopic() {
    const target = nextGapTopic(activeCampaign);
    if (!target) {
      return;
    }
    setActiveTopic(target);
  }

  // 单行渲染：扁平态与主题分组态共用，标签去重逻辑（#1）集中在这里。
  function renderTopicRow(topic) {
    const isPriority = nextTopic?.id === topic.id;
    const coverageTone = topic.coverage === "solid" ? "solid" : topic.coverage === "shaky" ? "shaky" : "uncovered";
    const showCore = !everyTopicCore && Boolean(importanceLabels[topic.importance]);
    const showTheme = focusActive && Boolean(topic.theme);
    const hasAnyLabel = showTheme || showCore || hasMixedSource || isPriority;
    return (
      <li key={topic.id}>
        <button
          type="button"
          className={`ll-campaign-topic-row${isPriority ? " is-priority" : ""}`}
          onClick={() => setActiveTopic(topic)}
        >
          <div className="ll-campaign-topic-main">
            {hasAnyLabel ? (
              <div className="ll-campaign-topic-labels">
                {showTheme ? (
                  <span className="ll-campaign-topic-theme">{topic.theme}</span>
                ) : null}
                {showCore ? (
                  <span className="ll-campaign-topic-core">{importanceLabels[topic.importance]}</span>
                ) : null}
                {hasMixedSource ? (
                  <span className="ll-campaign-topic-source">{getPracticeSeedSourceLabel(topic.source)}</span>
                ) : null}
                {isPriority ? <span className="ll-campaign-topic-priority">建议先练</span> : null}
              </div>
            ) : null}
            <span className="ll-campaign-topic-text">{topic.topic}</span>
          </div>
          <div className="ll-campaign-topic-side">
            <span className={`ll-state-tag ll-state-${coverageTone}`}>
              {coverageLabels[topic.coverage] || "没练过"}
            </span>
          </div>
        </button>
      </li>
    );
  }

  return (
    <main className="learn-shell ll-campaign-page" data-testid="campaign-dashboard">
      <header className="ll-training-topbar">
        <div className="ll-training-title">
          <button
            type="button"
            className="ll-training-back"
            onClick={() => (activeTopic ? setActiveTopic(null) : router.push("/?mode=status&panel=home"))}
          >‹</button>
          <div>
            <span>面试冲刺</span>
            <h1 className="ll-campaign-topbar-title" title={activeTopic ? activeTopic.topic : undefined}>
              {activeTopic ? activeTopic.topic : activeCampaign ? activeCampaign.role : "新面试"}
            </h1>
          </div>
        </div>
        <div className="ll-training-tabs ll-campaign-tabs">
          {(campaigns || []).map((campaign) => (
            <button
              key={campaign.id}
              type="button"
              className={campaign.id === activeId ? "active ll-campaign-tab-button" : "ll-campaign-tab-button"}
              onClick={() => {
                setActiveId(campaign.id);
                setActiveTopic(null);
              }}
            >
              {campaign.role}
            </button>
          ))}
          <span className="ll-campaign-tab-divider" aria-hidden="true" />
          <button
            type="button"
            className={!activeId ? "active ll-campaign-tab-create" : "ll-campaign-tab-create"}
            onClick={() => { setActiveId(""); setActiveTopic(null); }}
          >
            <span aria-hidden="true">＋</span>
            <span>新面试</span>
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
            nextLabel={nextTopic ? "练下一个" : "回待练清单"}
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
                  {activeCampaign.deadline ? (
                    <div className="ll-campaign-summary-kicker">
                      <span className="ll-campaign-status-pill is-dated">{scheduleLabel}</span>
                    </div>
                  ) : null}
                  <h2>{heroHeadline}</h2>
                  <p className="ll-campaign-summary-explain">{heroExplain}</p>
                </div>
                <div className="ll-campaign-summary-actions">
                  {nextTopic ? (
                    <button type="button" className="ll-training-primary" onClick={startNextTopic} title={nextTopic.topic}>
                      练下一个
                    </button>
                  ) : (
                    <Link href={buildCampaignInterviewHref(activeCampaign.id)} className="ll-training-primary">开始模拟面试</Link>
                  )}
                  {nextTopic ? (
                    <Link href={buildCampaignInterviewHref(activeCampaign.id)} className="ll-campaign-action">开始模拟面试</Link>
                  ) : null}
                </div>
              </div>
              <div className="ll-campaign-progress" data-testid="campaign-progress">
                <div className="ll-campaign-progress-head">
                  <span>已讲稳 {solidCount}/{topics.length}</span>
                  <span>{solidPercent}%</span>
                </div>
                <div className="ll-campaign-progress-track">
                  <div className="ll-campaign-progress-fill" style={{ width: `${solidPercent}%` }} />
                </div>
              </div>
              <p className="ll-campaign-readout" data-testid="campaign-readout">
                {readoutParts.map((part) => (
                  <span key={part}>{part}</span>
                ))}
              </p>
            </section>

            <section className="ll-campaign-topic-section">
              <div className="ll-campaign-section-head">
                <h3>{focusActive ? `今天先练这 ${visibleTopics.length} 个` : "待练清单"}</h3>
                <span>共 {topics.length} 个考点</span>
              </div>

              {groupByTheme ? (
                <div className="ll-campaign-theme-groups" data-testid="campaign-topic-list">
                  {themeGroups.map((group) => {
                    const groupSolid = group.topics.filter((topic) => topic.coverage === "solid").length;
                    return (
                      <div key={group.theme} className="ll-campaign-theme-group">
                        <div className="ll-campaign-theme-head">
                          <span className="ll-campaign-theme-name">{group.theme}</span>
                          <span className="ll-campaign-theme-count">讲稳 {groupSolid}/{group.topics.length}</span>
                        </div>
                        <ul className="ll-campaign-topic-list">
                          {group.topics.map((topic) => renderTopicRow(topic))}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <ul className="ll-campaign-topic-list" data-testid="campaign-topic-list">
                  {visibleTopics.map((topic) => renderTopicRow(topic))}
                </ul>
              )}

              {topics.length > FOCUS_COUNT ? (
                <button
                  type="button"
                  className="ll-campaign-topic-toggle"
                  onClick={() => setShowAllTopics((current) => !current)}
                  data-testid="campaign-topic-toggle"
                >
                  {focusActive ? `展开全部 ${topics.length} 个` : `只看今天 ${FOCUS_COUNT} 个`}
                </button>
              ) : null}
            </section>

            <DebriefPanel campaignId={activeCampaign.id} onCampaignUpdate={applyCampaignUpdate} />

            <div className="ll-campaign-footer">
              <button type="button" className="ll-campaign-action ll-campaign-action-danger" onClick={() => void archiveCampaign(activeCampaign.id)}>
                归档这场准备
              </button>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
