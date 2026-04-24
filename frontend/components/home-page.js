"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiFetch, postJson } from "../lib/api";
import {
  getStoredTargetBaselineId,
  getStoredUserId,
  setStoredTargetBaselineId,
  setStoredUserId,
} from "../lib/user-session";

const profileDirtyStorageKey = "learning-loop-profile-dirty-at";

const promptChips = [
  { label: "Java 面试（JavaGuide版）", query: "Java" },
  { label: "JVM & 并发", query: "JVM" },
  { label: "数据库", query: "数据库" },
];

const defaultPrimaryTrack = {
  title: "Java 面试（JavaGuide版）",
  subtitle: "Java 后端工程师",
  description: "围绕并发、数据库、JVM 等高频主题，进入后直接开始练习与复盘。",
  targetBaselineId: "bigtech-java-backend",
};

const defaultPathCards = [
  { key: "java-basics", title: "Java基础", subtitle: "集合、语法、网络基础" },
  { key: "jvm-concurrency", title: "JVM&并发", subtitle: "JVM、内存、并发控制" },
  { key: "database", title: "数据库", subtitle: "MySQL、Redis、缓存治理" },
  { key: "spring", title: "Spring", subtitle: "事务、AOP、运行时" },
  { key: "project", title: "项目", subtitle: "高可用、消息队列、工程取舍" },
];

const laneConfig = [
  { key: "java-basics", title: "基础", subtitle: "集合、语法、网络基础", matchIds: ["network-http-tcp"] },
  { key: "jvm-concurrency", title: "JVM", subtitle: "JVM、内存、并发控制", matchIds: ["java-concurrency", "jvm-basics"] },
  { key: "database", title: "数据库", subtitle: "MySQL、Redis、缓存治理", matchIds: ["database-core", "redis-cache"] },
  { key: "spring", title: "Spring", subtitle: "事务、AOP、运行时", matchIds: ["spring-runtime"] },
  { key: "project", title: "项目", subtitle: "高可用、消息队列、工程取舍", matchIds: ["service-reliability", "messaging-async"] },
];

function getPackSubtitle(pack) {
  if (!pack) {
    return "";
  }
  return pack.targetRole || pack.shortTitle || "学习路线";
}

function average(values = []) {
  if (!values.length) {
    return 0;
  }
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function formatRelativeTime(value) {
  if (!value) {
    return "还没开始";
  }
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) {
    return "刚刚更新";
  }
  const diffHours = Math.max(0, Math.round((Date.now() - time) / (1000 * 60 * 60)));
  if (diffHours < 1) {
    return "刚刚学习";
  }
  if (diffHours < 24) {
    return `${diffHours} 小时前`;
  }
  const diffDays = Math.round(diffHours / 24);
  if (diffDays < 30) {
    return `${diffDays} 天前`;
  }
  return `${Math.round(diffDays / 30)} 个月前`;
}

function stateText(state) {
  if (state === "solid") {
    return "已掌握";
  }
  if (state === "partial") {
    return "不稳定";
  }
  if (state === "weak") {
    return "未掌握";
  }
  return "未开始";
}

function pickMostActionableItem(items = []) {
  const ordered = [...items].sort((left, right) => {
    if ((left.progressPercentage || 0) !== (right.progressPercentage || 0)) {
      return (left.progressPercentage || 0) - (right.progressPercentage || 0);
    }
    return (right.evidenceCount || 0) - (left.evidenceCount || 0);
  });
  return ordered[0] || null;
}

function getLearningHref(targetBaselineId = "", item = null, domain = null) {
  const params = new URLSearchParams();
  if (targetBaselineId) {
    params.set("target", targetBaselineId);
  }
  const docPath = domain?.currentDocPath || item?.primaryDocPath || "";
  if (docPath) {
    params.set("doc", docPath);
  }
  const conceptId = domain?.currentAbilityItemId || item?.abilityItemId || "";
  if (conceptId) {
    params.set("concept", conceptId);
  }
  params.set("autostart", "1");
  return `/learn?${params.toString()}`;
}

function buildPathCards(target) {
  if (!target) {
    return defaultPathCards.map((lane, index) => ({
      ...lane,
      progress: 0,
      href: "#login-panel",
      unlocked: index === 0,
      latestTitle: "",
      recommendedTitle: "",
      statusItems: [],
      isCurrent: index === 0,
    }));
  }

  const cards = laneConfig.map((lane) => {
    const matchedDomains = lane.matchIds
      .map((domainId) => (target.readingDomains || []).find((domain) => domain.id === domainId))
      .filter(Boolean)
      .map((domain) => ({
        ...domain,
        isCurrent: domain.id === target.currentDomainId,
      }));

    const laneDocs = matchedDomains.flatMap((domain) =>
      (domain.docs || []).map((doc) => ({
        ...doc,
        domainId: domain.id,
        domainTitle: domain.title,
      }))
    );
    const currentDomain = matchedDomains.find((domain) => domain.id === target.currentDomainId) || matchedDomains[0] || null;
    const currentDoc =
      currentDomain?.previewDocs?.[0] ||
      laneDocs.find((doc) => !doc.started) ||
      laneDocs[0] ||
      null;
    const previewItems = (currentDomain?.previewDocs || laneDocs.slice(0, 3)).map((doc) => ({
      title: doc.title,
      label: doc.started ? "已开始" : "",
      rawState: doc.started ? "partial" : "",
    }));
    const latestItem =
      currentDoc ||
      laneDocs.find((doc) => doc.started) ||
      null;
    const hasUnstarted = laneDocs.some((doc) => !doc.started);
    const fallbackLatestDocTitle = target.currentDocTitle || "";

    return {
      key: lane.key,
      title: lane.title,
      subtitle: lane.subtitle,
      progress: average(matchedDomains.map((domain) => domain.progressPercentage || 0)),
      href: getLearningHref(target.targetBaselineId, {
        primaryDocPath: currentDoc?.path || "",
        primaryDocTitle: currentDoc?.title || "",
      }, currentDomain),
      unlocked: true,
      latestTitle: latestItem?.title || "",
      latestDocTitle:
        currentDomain?.currentDocTitle ||
        (target.currentDomainId && matchedDomains.some((domain) => domain.id === target.currentDomainId) ? fallbackLatestDocTitle : "") ||
        currentDoc?.title ||
        "",
      recommendedTitle: currentDoc?.title || "",
      updatedLabel: formatRelativeTime(target.readingProgress?.lastUpdatedAt || ""),
      statusItems: previewItems,
      containsCurrentDomain: matchedDomains.some((domain) => domain.id === target.currentDomainId),
      hasUnstarted,
    };
  });

  const activeKey =
    cards.find((card) => card.containsCurrentDomain)?.key ||
    cards.find((card) => card.hasUnstarted)?.key ||
    cards[0]?.key ||
    "";

  return cards.map(({ containsCurrentDomain, hasUnstarted, ...card }) => ({
    ...card,
    isCurrent: card.key === activeKey,
  }));
}

function buildNextStep(target) {
  if (!target) {
    return {
      title: "先连接档案，系统会给出下一步建议",
      reason: "原因：先建立学习档案，再让系统判断你最值得开始的节点。",
      lastSignal: "你上次卡在：还没有历史学习记录",
      href: "#login-panel",
      cta: "开始使用",
      laneKey: "java-basics",
    };
  }

  const allDocs = (target.readingDomains || []).flatMap((domain) =>
    (domain.docs || []).map((item) => ({
      ...item,
      domainId: domain.id,
      domainTitle: domain.title,
    }))
  );
  const nextItem =
    allDocs.find((item) => item.path === target.currentDocPath) ||
    allDocs.find((item) => !item.started) ||
    allDocs[0];
  const lane = laneConfig.find((entry) => entry.matchIds.includes(nextItem?.domainId || "")) || laneConfig[0];

  return {
    title: nextItem ? nextItem.title : `${target.title} · 继续推进`,
    reason: nextItem
      ? "原因：继续沿着你上次阅读的位置推进，打断最少。"
      : "原因：继续沿着当前目标推进，比重新选方向更高效",
    lastSignal: target.currentDocTitle
      ? `你上次读到：${target.currentDocTitle}`
      : nextItem
        ? `你上次读到：${nextItem.title}`
        : "你上次卡在：还没有历史学习记录",
    href: getLearningHref(target.targetBaselineId, {
      primaryDocPath: nextItem?.path || "",
      primaryDocTitle: nextItem?.title || "",
    }, (target.readingDomains || []).find((domain) => domain.id === nextItem?.domainId) || null),
    cta: "开始学习",
    laneKey: lane.key,
    weakness: nextItem?.domainTitle || "当前推荐模块",
  };
}

export function HomePage() {
  const [handle, setHandle] = useState("");
  const [pin, setPin] = useState("");
  const [search, setSearch] = useState("");
  const [baselines, setBaselines] = useState([]);
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const lastProfileSyncRef = useRef(0);

  async function refreshProfile() {
    const userId = getStoredUserId();
    if (!userId) {
      return;
    }
    try {
      const data = await apiFetch(`/api/profile/${userId}`);
      setProfile(data);
      lastProfileSyncRef.current = Date.now();
    } catch {
      setStoredUserId("");
    }
  }

  useEffect(() => {
    apiFetch("/api/baselines")
      .then((data) => {
        setBaselines(data.baselines || []);
        if (!getStoredTargetBaselineId() && data.baselines?.[0]?.id) {
          setStoredTargetBaselineId(data.baselines[0].id);
        }
      })
      .catch((nextError) => setError(nextError.message));
  }, []);

  useEffect(() => {
    const userId = getStoredUserId();
    if (!userId) {
      return;
    }
    void refreshProfile();
  }, []);

  useEffect(() => {
    function shouldRefreshProfile() {
      const raw = window.localStorage.getItem(profileDirtyStorageKey) || "0";
      const dirtyAt = Number.parseInt(raw, 10);
      if (!Number.isFinite(dirtyAt)) {
        return false;
      }
      return dirtyAt > lastProfileSyncRef.current;
    }

    function handlePotentialReturn(force = false) {
      if (force || shouldRefreshProfile()) {
        void refreshProfile();
      }
    }

    function handleFocus() {
      handlePotentialReturn();
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        handlePotentialReturn();
      }
    }

    function handlePageShow() {
      handlePotentialReturn(true);
    }

    function handlePopState() {
      handlePotentialReturn(true);
    }

    window.addEventListener("focus", handleFocus);
    window.addEventListener("pageshow", handlePageShow);
    window.addEventListener("popstate", handlePopState);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("pageshow", handlePageShow);
      window.removeEventListener("popstate", handlePopState);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  const primaryPack = baselines[0] || null;
  const activeTarget = profile?.targets?.[0] || null;
  const pathCards = useMemo(() => buildPathCards(activeTarget), [activeTarget]);
  const visiblePathCards = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    if (!normalizedSearch) {
      return pathCards;
    }
    return pathCards.filter((card) =>
      `${card.title} ${card.subtitle} ${card.recommendedTitle} ${card.latestTitle}`.toLowerCase().includes(normalizedSearch)
    );
  }, [pathCards, search]);
  const nextStep = useMemo(() => buildNextStep(activeTarget), [activeTarget]);
  const currentProgress = activeTarget?.completionPercentage || 0;
  const heroTrack = primaryPack
    ? {
        ...defaultPrimaryTrack,
        subtitle: getPackSubtitle(primaryPack),
        description: primaryPack.packSummary || defaultPrimaryTrack.description,
        targetBaselineId: primaryPack.id,
      }
    : defaultPrimaryTrack;
  const aiSignal = activeTarget
    ? `你当前最大短板：${nextStep.weakness}`
    : "先进入一轮学习，系统会自动判断你当前最大的短板。";

  async function onLogin(event) {
    event.preventDefault();
    try {
      setIsSubmitting(true);
      setError("");
      const data = await postJson("/api/auth/login", { handle, pin });
      setProfile(data.profile);
      setStoredUserId(data.profile.user.id);
      setHandle("");
      setPin("");
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setIsSubmitting(false);
    }
  }

  function withStoredTarget(href) {
    const baselineId = activeTarget?.targetBaselineId || primaryPack?.id;
    if (baselineId) {
      setStoredTargetBaselineId(baselineId);
    }
    return href;
  }

  return (
    <main className="app-shell home-shell">
      <section className="home-topbar">
        <div className="brand-mark">
          <span className="brand-dot" />
          <span>LearningLoop AI</span>
        </div>
        {profile ? (
          <div className="topbar-actions">
            <Link className="secondary-pill" href="/interview-assist">
              真实面试辅助
            </Link>
            <Link className="secondary-pill profile-entry-pill" href="/profile">
              <span className="status-dot" />
              <span>{profile.user.handle}</span>
              <span className="profile-entry-divider" />
              <span>个人档案</span>
            </Link>
            <button
              type="button"
              className="secondary-pill"
              onClick={() => {
                setProfile(null);
                setStoredUserId("");
              }}
            >
              退出
            </button>
          </div>
        ) : (
          <div className="topbar-actions">
            <Link className="secondary-pill" href="/interview-assist">真实面试辅助</Link>
            <a className="primary-pill" href="#login-panel">开始使用</a>
          </div>
        )}
      </section>

      <section className="home-hero">
        <p className="section-kicker">面向开发者的主动学习路径</p>
        <h1>今天想学习什么？</h1>
        <p className="hero-ai-signal">{aiSignal}</p>
        <label className="search-shell" aria-label="搜索学习路线、知识点或面经">
          <span className="search-icon">⌕</span>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索学习路线、知识点或面经"
          />
        </label>
        <p className="search-feedback" aria-live="polite">
          {search.trim()
            ? (visiblePathCards.length
                ? `正在按“${search.trim()}”筛选下方模块，找到 ${visiblePathCards.length} 个匹配。`
                : `没有找到“${search.trim()}”相关模块，可以换个关键词。`)
            : "输入关键词会筛选下方模块，也可以直接选择一个主题。"}
        </p>
        <div className="prompt-chip-row">
          {promptChips.map((chip) => (
            <button
              key={chip.label}
              type="button"
              className={chip.query === "Java" ? "topic-chip topic-chip-dark" : "topic-chip"}
              onClick={() => setSearch(chip.query)}
            >
              {chip.label}
            </button>
          ))}
        </div>
      </section>

      {!profile ? (
        <section className="auth-strip" id="login-panel">
          <form className="auth-form-inline" onSubmit={onLogin}>
            <div className="auth-copy">
              <div>
                <strong>先连接你的学习档案</strong>
                <p>输入昵称和 PIN，后续进度、记忆和目标会持续沉淀。</p>
              </div>
            </div>
            <div className="auth-fields-inline">
              <input aria-label="昵称" value={handle} onChange={(event) => setHandle(event.target.value)} placeholder="昵称" />
              <input aria-label="PIN" type="password" value={pin} onChange={(event) => setPin(event.target.value)} placeholder="PIN" />
              <button type="submit" className="primary-pill" disabled={isSubmitting}>登录</button>
            </div>
          </form>
        </section>
      ) : null}

      {error ? <section className="feedback-banner error-banner">{error}</section> : null}

      <section className="learning-overview">
        <section className="next-step-panel featured-next-step">
          <div className="next-step-copy">
            <span className="next-step-kicker">继续学习（推荐）</span>
            <h3>{nextStep.title}</h3>
            <p>{nextStep.reason}</p>
            <p className="next-step-feedback">{nextStep.lastSignal}</p>
          </div>
          <Link
            className="primary-pill next-step-primary"
            href={profile ? nextStep.href : "#login-panel"}
            onClick={() => withStoredTarget(nextStep.href)}
          >
            {profile ? nextStep.cta : "开始使用"}
          </Link>
        </section>

        <article className="learning-header-card">
          <div className="learning-header-copy">
            <span className="learning-header-kicker">Java 面试 · JavaGuide</span>
            <h2>{activeTarget?.title || heroTrack.title}</h2>
            <p>{activeTarget ? "从推荐入口继续学习，模块卡片用于切换专题。" : heroTrack.description}</p>
          </div>
          <div className="learning-header-side">
            <div className="progress-summary">
              <strong>{currentProgress}%</strong>
              <span>{activeTarget?.completionLabel || "准备开始"}</span>
            </div>
          </div>
          <div className="progress-bar-shell">
            <span className="progress-bar-fill" style={{ width: `${currentProgress}%` }} />
          </div>
        </article>

        <div className="path-steps">
          {laneConfig.map((lane, index) => {
            const relatedCard = pathCards.find((card) => card.key === lane.key);
            return (
              <div key={lane.key} className={`path-step${relatedCard?.isCurrent ? " active" : ""}${relatedCard?.unlocked ? "" : " locked"}`}>
                <span>{lane.title}</span>
                {index < laneConfig.length - 1 ? <span className="path-step-arrow">→</span> : null}
              </div>
            );
          })}
        </div>

        <section className="learning-path-grid">
          {visiblePathCards.map((card) => (
            <Link
              key={card.key}
              className={`path-card${card.isCurrent ? " active" : ""}${card.unlocked ? "" : " locked"}`}
              href={profile ? card.href : "#login-panel"}
              onClick={() => withStoredTarget(card.href)}
            >
              <div className="path-card-top">
                <h3>{card.title}</h3>
                <span className="path-card-progress">{card.progress}%</span>
              </div>
              <div className="path-card-status-list">
                {(card.statusItems || []).slice(0, 3).map((item) => (
                  <div className="path-card-status" key={`${card.key}-${item.title}`}>
                    <span className={`status-bullet${item.rawState === "solid" ? " solid" : item.rawState === "partial" ? " partial" : item.rawState === "weak" ? " weak" : ""}`} />
                    <span className="path-card-status-title">{item.title}</span>
                    {item.label ? <span className="path-card-status-label">{item.label}</span> : null}
                  </div>
                ))}
              </div>
              <div className="path-card-meta">
                <span>上次读到：{card.latestDocTitle || card.latestTitle || "还没开始"}</span>
              </div>
              <div className="path-card-hover">
                <span>{card.recommendedTitle || "点击后直接进入对话学习"}</span>
                <span>{card.updatedLabel}</span>
              </div>
            </Link>
          ))}
        </section>
      </section>
    </main>
  );
}
