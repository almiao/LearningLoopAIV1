"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { apiFetch, postJson } from "../lib/api";
import {
  getStoredTargetBaselineId,
  getStoredUserId,
  setStoredTargetBaselineId,
  setStoredUserId,
} from "../lib/user-session";

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
    }));
  }

  const unlockedIndex = laneConfig.findIndex((lane) =>
    (target.domains || []).some((domain) => lane.matchIds.includes(domain.id) && (domain.progressPercentage || 0) < 80)
  );

  return laneConfig.map((lane, index) => {
    const matchedDomains = (target.domains || []).filter((domain) => lane.matchIds.includes(domain.id));
    const allItems = matchedDomains.flatMap((domain) => domain.items || []);
    const recommendedItem = pickMostActionableItem(allItems);
    const latestItem = [...allItems]
      .filter((item) => item.evidenceCount > 0)
      .sort((left, right) => String(right.lastUpdatedAt || "").localeCompare(String(left.lastUpdatedAt || "")))[0] || recommendedItem;
    const statusItems = [...allItems]
      .sort((left, right) => (left.progressPercentage || 0) - (right.progressPercentage || 0))
      .slice(0, 3)
      .map((item) => ({
        title: item.title,
        label: stateText(item.state),
        rawState: item.state,
      }));

    return {
      key: lane.key,
      title: lane.title,
      subtitle: lane.subtitle,
      progress: average(matchedDomains.map((domain) => domain.progressPercentage || 0)),
      href: `/learn?target=${target.targetBaselineId}${recommendedItem?.abilityItemId ? `&concept=${recommendedItem.abilityItemId}` : ""}&autostart=1`,
      unlocked: unlockedIndex < 0 ? index === 0 : index <= unlockedIndex + 1,
      latestTitle: latestItem?.title || "",
      recommendedTitle: recommendedItem?.title || "",
      updatedLabel: formatRelativeTime(latestItem?.lastUpdatedAt || ""),
      statusItems,
    };
  });
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

  const allItems = (target.domains || []).flatMap((domain) =>
    (domain.items || []).map((item) => ({
      ...item,
      domainId: domain.id,
      domainTitle: domain.title,
    }))
  );
  const nextItem = pickMostActionableItem(allItems);
  const lane = laneConfig.find((entry) => entry.matchIds.includes(nextItem?.domainId || "")) || laneConfig[0];

  return {
    title: nextItem ? nextItem.title : `${target.title} · 继续推进`,
    reason: nextItem
      ? nextItem.state === "weak"
        ? "原因：这是面试高频 + 你未掌握"
        : "原因：这个模块当前不稳定，继续补强最划算"
      : "原因：继续沿着当前目标推进，比重新选方向更高效",
    lastSignal: nextItem ? `你上次卡在：${nextItem.title}` : "你上次卡在：还没有历史学习记录",
    href: `/learn?target=${target.targetBaselineId}${nextItem?.abilityItemId ? `&concept=${nextItem.abilityItemId}` : ""}&autostart=1`,
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
    apiFetch(`/api/profile/${userId}`)
      .then((data) => setProfile(data))
      .catch(() => setStoredUserId(""));
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
              <div key={lane.key} className={`path-step${nextStep.laneKey === lane.key ? " active" : ""}${relatedCard?.unlocked ? "" : " locked"}`}>
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
              className={`path-card${nextStep.laneKey === card.key ? " active" : ""}${card.unlocked ? "" : " locked"}`}
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
                    <span className="path-card-status-label">{item.label}</span>
                  </div>
                ))}
              </div>
              <div className="path-card-meta">
                <span>上次做到：{card.latestTitle || "还没开始"}</span>
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
