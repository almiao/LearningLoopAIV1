"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apiFetch, postJson } from "../lib/api";
import { buildReentryPlan } from "../lib/reentry-actions";
import { ensureLocalUserId, ensureLocalUserProfile, getStoredUserId } from "../lib/user-session";
import {
  buildLearningHref,
  buildSidebarDocument,
  formatLastActivity,
  getTypeIcon,
} from "./library/shared";

const profileDirtyStorageKey = "learning-loop-profile-dirty-at";

function getInitials(name) {
  return String(name || "L").trim().slice(0, 1).toUpperCase() || "L";
}

function getHeroMetric(document) {
  if (document.ignored) {
    return "已忽略";
  }
  if (document.group === "finished") {
    return "已读完";
  }
  if (!Number(document.progressPercentage)) {
    return "还没开始";
  }
  return `阅读 ${document.progressPercentage}%`;
}

function buildHeroCopy(document = {}, plan = buildReentryPlan(document)) {
  if (plan.intent === "resume_training") {
    return {
      badge: document.trainingCheckpointProgressLabel
        ? `上次停在 ${document.trainingCheckpointProgressLabel}`
        : "中断恢复",
      title: "先把这轮接上",
      reason: "你上次练到一半，直接恢复上下文，比重新开始更省力。",
    };
  }
  if (plan.intent === "quick_review") {
    return {
      badge: "快速复习",
      title: "先把关键点拉回来",
      reason: "这篇你已经学过了，现在更适合用一轮短复习把它重新唤醒。",
    };
  }
  if (plan.intent === "start_training") {
    return {
      badge: "开始训练",
      title: "该把这篇材料练成会讲",
      reason: "正文已经看完了，下一步最值回票价的是留下一轮真实答题证据。",
    };
  }
  if (plan.intent === "resume_reading") {
    return {
      // 进度信息已经在 meta 行里（阅读 N%），不再用 badge 重复。
      badge: "",
      title: "从上次位置接着读",
      reason: "上下文已经建立好，顺着这一篇推进最省心。",
    };
  }
  return {
    badge: plan.stageLabel,
    title: plan.title,
    reason: plan.reason,
  };
}

function formatReviewWindow(nextReviewAt = "") {
  if (!nextReviewAt) {
    return "";
  }
  const date = new Date(nextReviewAt);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const diffMs = date.getTime() - Date.now();
  if (diffMs <= 0) {
    return "复习时间已到";
  }
  const diffDays = Math.ceil(diffMs / (24 * 60 * 60 * 1000));
  if (diffDays <= 1) {
    return "建议明天前复习";
  }
  return `${diffDays} 天内适合复习`;
}

function buildRecommendationFacts(document = {}, plan = buildReentryPlan(document)) {
  const facts = [];

  if (plan.intent === "resume_reading") {
    const lastFolder = document.folderLabels?.at(-1);
    if (document.readingChapter && document.readingChapter !== lastFolder) {
      facts.push(`上次在 ${document.readingChapter}`);
    }
    return facts.slice(0, 2);
  }

  if (plan.intent === "resume_training") {
    if (document.trainingCheckpointProgressLabel) {
      facts.push(`停在 ${document.trainingCheckpointProgressLabel}`);
    }
    if (document.evidenceCount > 0) {
      facts.push(`已记录 ${document.evidenceCount} 条回答证据`);
    }
    return facts.slice(0, 2);
  }

  if (plan.intent === "start_training") {
    facts.push("正文已读完");
    facts.push(document.evidenceCount > 0 ? `已记录 ${document.evidenceCount} 条回答证据` : "还没留下答题证据");
    return facts.slice(0, 2);
  }

  const reviewWindow = formatReviewWindow(document.nextReviewAt);
  if (reviewWindow) {
    facts.push(reviewWindow);
  }

  if (document.evidenceCount > 0) {
    facts.push(`已记录 ${document.evidenceCount} 条回答证据`);
  }

  if (!facts.length && document.progressPercentage >= 100) {
    facts.push("正文已读完");
  }

  return facts.slice(0, 2);
}

function getSnoozeLabel(plan = {}) {
  return plan.intent === "resume_reading" ? "今天先不读这个" : "今天先不练这个";
}

function isRecommendationSnoozed(document = {}) {
  const until = new Date(document.snoozedRecommendationUntil || "");
  return Number.isFinite(until.getTime()) && until.getTime() > Date.now();
}

function buildReviewItemPracticeHref(item = {}) {
  const params = new URLSearchParams();
  params.set("reviewItem", item.id || "");
  return `/learn?${params.toString()}`;
}

function pickActiveCampaign(campaigns = []) {
  const activeCampaigns = (campaigns || []).filter((campaign) => !campaign.archived_at);
  return activeCampaigns.sort((left, right) => {
    const leftDays = left?.readiness?.daysLeft;
    const rightDays = right?.readiness?.daysLeft;
    if (leftDays === null && rightDays !== null) {
      return 1;
    }
    if (leftDays !== null && rightDays === null) {
      return -1;
    }
    if (leftDays !== rightDays) {
      return Number(leftDays ?? Number.MAX_SAFE_INTEGER) - Number(rightDays ?? Number.MAX_SAFE_INTEGER);
    }
    return String(right?.created_at || "").localeCompare(String(left?.created_at || ""));
  })[0] || null;
}

function getCampaignCountdownLabel(campaign = {}) {
  const daysLeft = campaign?.readiness?.daysLeft;
  if (daysLeft === null || daysLeft === undefined) {
    return "面试日期未设置";
  }
  if (daysLeft <= 0) {
    return "今天面试";
  }
  return `${daysLeft} 天后面试`;
}

function getCampaignCoveragePercent(campaign = {}) {
  return Math.round((Number(campaign?.readiness?.coverageRate || 0) || 0) * 100);
}

function AvatarMenu({ open, onToggle, userName }) {
  return (
    <div className="ll-avatar-wrap">
      <button
        type="button"
        className="ll-avatar"
        onClick={onToggle}
        aria-expanded={open}
        aria-label="打开本机档案菜单"
      >
        {getInitials(userName)}
      </button>
      {open ? (
        <div className="ll-avatar-menu">
          <Link href="/profile">本机档案</Link>
          <Link href="/library">资料库</Link>
        </div>
      ) : null}
    </div>
  );
}

function DefaultFocusView({ featuredDocument, recommendedNewDocument, reviewDue, hasProfile, onSnoozeRecommendation }) {
  const reentryPlan = buildReentryPlan(featuredDocument);
  const action = reentryPlan.primaryAction;
  const heroCopy = buildHeroCopy(featuredDocument, reentryPlan);
  const recommendationFacts = buildRecommendationFacts(featuredDocument, reentryPlan);
  const snoozeLabel = getSnoozeLabel(reentryPlan);
  const reviewItems = Array.isArray(reviewDue) ? reviewDue : [];

  return (
    <section className="ll-default-view">
      <h1 className="ll-today-heading">今天从这里推进</h1>
      {!hasProfile ? (
        <p className="ll-status-note">正在准备本机档案；阅读、训练和面试冲刺都会记在这台机器上。</p>
      ) : null}

      <div className="ll-step-card">
        <section className="ll-step">
          <span className="ll-step-num is-on">接着学</span>
          <div className="ll-step-body">
            {heroCopy.badge ? <span className="ll-reentry-badge">{heroCopy.badge}</span> : null}
            <h2 className="ll-step-title">
              <Link href={buildLearningHref(featuredDocument)} className="ll-title-link">
                {featuredDocument.title}
              </Link>
            </h2>
            <span className="ll-step-doc-meta">{`${featuredDocument.providerLabel} · ${getHeroMetric(featuredDocument)}`}</span>
            <p className="ll-step-sub">{heroCopy.reason}</p>
            {recommendationFacts.length ? (
              <div className="ll-recommendation-facts" aria-label="推荐依据">
                {recommendationFacts.map((fact) => (
                  <span key={fact} className="ll-recommendation-chip">{fact}</span>
                ))}
              </div>
            ) : null}
          </div>
          <div className="ll-step-actions">
            <Link href={buildLearningHref(featuredDocument, { autostart: action.autostart, intent: action.kind })} className="ll-primary-button">
              {action.label}
            </Link>
            {/* 首页只留一个辅助动作；「只打开原文」这类等价入口收进阅读页。 */}
            {reentryPlan.secondaryActions?.filter((secondaryAction) => secondaryAction.kind !== "open-document").slice(0, 1).map((secondaryAction) => (
              <Link
                key={`${featuredDocument.path}:${secondaryAction.kind}`}
                href={buildLearningHref(featuredDocument, { autostart: secondaryAction.autostart, intent: secondaryAction.kind })}
                className="ll-reentry-secondary-link"
              >
                {secondaryAction.label}
              </Link>
            ))}
            {featuredDocument.group !== "unstarted" ? (
              <button
                type="button"
                className="ll-text-button"
                onClick={() => onSnoozeRecommendation(featuredDocument)}
              >
                {snoozeLabel}
              </button>
            ) : null}
          </div>
        </section>

        <section className="ll-step">
          <span className="ll-step-num">学新的</span>
          <div className="ll-step-body">
            {recommendedNewDocument ? (
              <>
                <h2 className="ll-step-title">
                  <Link href={buildLearningHref(recommendedNewDocument)} className="ll-title-link">
                    {recommendedNewDocument.title}
                  </Link>
                </h2>
                <span className="ll-step-doc-meta">{`${recommendedNewDocument.providerLabel} · ${recommendedNewDocument.folderLabels?.join(" / ") || "资料库"}`}</span>
                <p className="ll-step-sub">不想接着读上一篇时，从这篇新的开始。</p>
              </>
            ) : (
              <>
                <h2 className="ll-step-title">学点新的</h2>
                <p className="ll-step-sub">还没有待开始的新材料。导入一篇，这里就会出现推荐。</p>
              </>
            )}
          </div>
          <div className="ll-step-actions">
            <Link
              href={recommendedNewDocument ? buildLearningHref(recommendedNewDocument) : "/library"}
              className="ll-secondary-button"
            >
              {recommendedNewDocument ? "开始读这篇 →" : "浏览资料库 →"}
            </Link>
            <Link href="/materials" className="ll-reentry-secondary-link">添加新材料</Link>
          </div>
        </section>

        <section className="ll-step">
          <span className="ll-step-num">补复习</span>
          <div className="ll-step-body">
            <h2 className="ll-step-title">补今天到期的复习</h2>
            {reviewItems.length ? (
              <>
                <p className="ll-step-sub">{reviewItems.length} 个没讲稳的点今天到期，先从最上面的开始。</p>
                <ul className="ll-review-list">
                  {reviewItems.slice(0, 3).map((item) => {
                    const handle = item.handle || "(无标题)";
                    const stateClass = `ll-state-tag ll-state-${item.state || "shaky"}`;
                    const stateLabel = item.state === "solid" ? "扎实" : "生疏";
                    const rePracticeHref = buildReviewItemPracticeHref(item);
                    return (
                      <li key={item.id} className="ll-review-row">
                        <Link href={rePracticeHref} className="ll-review-link" title={`重练:${handle}`}>
                          <span className="ll-review-dot" aria-hidden="true" />
                          <span className="ll-review-handle">{handle}</span>
                          <span className={stateClass}>{stateLabel}</span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : (
              <p className="ll-step-sub">今天没有到期的复习点；练习里没讲稳的会出现在这里。</p>
            )}
          </div>
          <div className="ll-step-actions">
            {reviewItems.length ? (
              <span className="ll-danger-badge">{reviewItems.length}</span>
            ) : null}
          </div>
        </section>

      </div>
    </section>
  );
}

function CampaignHero({ campaign }) {
  if (!campaign) {
    return null;
  }
  const readiness = campaign?.readiness || {};
  const topGap = readiness.gaps?.[0] || null;
  const coveragePercent = getCampaignCoveragePercent(campaign);
  const hasInterviewDate = readiness.daysLeft !== null && readiness.daysLeft !== undefined;
  return (
    <section className="ll-sprint-strip" aria-label="进行中的面试冲刺">
      <div className="ll-sprint-strip-copy">
        <span className="ll-sprint-pill">面试冲刺 · 进行中</span>
        <h2>{campaign.role || "当前岗位"}</h2>
        <p className="ll-sprint-strip-meta">
          {hasInterviewDate ? (
            getCampaignCountdownLabel(campaign)
          ) : (
            <Link href="/campaign" className="ll-sprint-date-link">设置面试日期 →</Link>
          )}
          {" · "}
          {topGap ? (
            <>今天优先补：<Link href="/campaign" className="ll-sprint-gap-link">{topGap.topic}</Link></>
          ) : (
            "先做一轮模拟，继续压实高风险话题"
          )}
        </p>
      </div>
      <div className="ll-sprint-strip-progress">
        <span>{`已覆盖 ${coveragePercent}%`}</span>
        <div className="ll-today-bar" role="presentation">
          <i style={{ width: `${coveragePercent}%` }} />
        </div>
      </div>
      <Link
        href="/campaign"
        className={`${hasInterviewDate ? "ll-primary-button" : "ll-secondary-button"} ll-sprint-cta`}
      >
        进入冲刺 →
      </Link>
    </section>
  );
}

export function HomePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const lastProfileSyncRef = useRef(0);

  const [userId, setUserId] = useState("");
  const [knowledgeDocuments, setKnowledgeDocuments] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [reviewDue, setReviewDue] = useState([]);
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState("");
  const [avatarOpen, setAvatarOpen] = useState(false);

  // 旧资料库深链（/?mode=library）迁移到二级页 /library。
  const legacyLibraryMode = searchParams.get("mode") === "library";
  useEffect(() => {
    if (legacyLibraryMode) {
      router.replace("/library");
    }
  }, [legacyLibraryMode, router]);

  useEffect(() => {
    let cancelled = false;

    ensureLocalUserProfile()
      .then((nextProfile) => {
        if (cancelled) {
          return;
        }
        setUserId(nextProfile?.user?.id || getStoredUserId());
        setProfile(nextProfile || null);
        lastProfileSyncRef.current = Date.now();
      })
      .catch((nextError) => {
        if (!cancelled) {
          setError(nextError.message);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    async function loadHomeData() {
      try {
        setError("");
        const docsQuery = userId ? `?userId=${encodeURIComponent(userId)}` : "";
        const docsPayload = await apiFetch(`/api/knowledge/docs${docsQuery}`);
        const javaGuideDocs = (docsPayload.documents || []).filter((document) => document.providerLabel === "JavaGuide");
        setKnowledgeDocuments(javaGuideDocs);

        let nextCampaigns = [];
        try {
          const campaignPayload = await apiFetch("/api/campaigns");
          nextCampaigns = Array.isArray(campaignPayload?.campaigns) ? campaignPayload.campaigns : [];
        } catch {
          nextCampaigns = [];
        }
        setCampaigns(nextCampaigns);

        if (userId) {
          const nextProfile = await apiFetch(`/api/profile/${userId}`);
          setProfile(nextProfile);
          lastProfileSyncRef.current = Date.now();
        } else {
          setProfile(null);
        }

        try {
          // Today Queue「今日复习」= 失败账本按 next_due 渲染（全局，不依赖 userId）。
          const activeCampaign = pickActiveCampaign(nextCampaigns);
          const reviewQuery = activeCampaign?.id ? `?campaignId=${encodeURIComponent(activeCampaign.id)}` : "";
          const reviewPayload = await apiFetch(`/api/review/today${reviewQuery}`);
          setReviewDue(Array.isArray(reviewPayload?.items) ? reviewPayload.items : []);
        } catch {
          // 账本是可选读出口：读失败不拖垮首页其余部分。
          setReviewDue([]);
        }
      } catch (nextError) {
        setError(nextError.message);
      }
    }

    void loadHomeData();
  }, [userId]);

  useEffect(() => {
    function shouldRefreshProfile() {
      const raw = window.localStorage.getItem(profileDirtyStorageKey) || "0";
      const dirtyAt = Number.parseInt(raw, 10);
      if (!Number.isFinite(dirtyAt)) {
        return false;
      }
      return dirtyAt > lastProfileSyncRef.current;
    }

    async function refreshProfile() {
      try {
        const activeUserId = await ensureLocalUserId();
        const nextProfile = await apiFetch(`/api/profile/${activeUserId}`);
        setUserId(activeUserId);
        let nextCampaigns = [];
        try {
          const campaignPayload = await apiFetch("/api/campaigns");
          nextCampaigns = Array.isArray(campaignPayload?.campaigns) ? campaignPayload.campaigns : [];
        } catch {
          nextCampaigns = [];
        }
        setCampaigns(nextCampaigns);
        try {
          const activeCampaign = pickActiveCampaign(nextCampaigns);
          const reviewQuery = activeCampaign?.id ? `?campaignId=${encodeURIComponent(activeCampaign.id)}` : "";
          const reviewPayload = await apiFetch(`/api/review/today${reviewQuery}`);
          setReviewDue(Array.isArray(reviewPayload?.items) ? reviewPayload.items : []);
        } catch {
          setReviewDue([]);
        }
        setProfile(nextProfile);
        lastProfileSyncRef.current = Date.now();
      } catch (nextError) {
        setError(nextError.message);
      }
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

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  const documentProgress = profile?.documentProgress || null;
  const activeCampaign = useMemo(() => pickActiveCampaign(campaigns), [campaigns]);
  const ignoredDocs = documentProgress?.ignoredDocs || {};
  const ignoredDocPaths = useMemo(
    () => new Set(documentProgress?.ignoredDocPaths || []),
    [documentProgress?.ignoredDocPaths]
  );
  const snoozedRecommendationDocPaths = useMemo(
    () => new Set(documentProgress?.snoozedRecommendationDocPaths || []),
    [documentProgress?.snoozedRecommendationDocPaths]
  );

  const uiDocuments = useMemo(() => (
    knowledgeDocuments
      .filter((document) => !ignoredDocPaths.has(document.path))
      .map((document) => buildSidebarDocument(document, documentProgress?.docs || {}, {
        ignoredAt: ignoredDocs[document.path]?.ignoredAt || "",
        snoozedRecommendationUntil: documentProgress?.snoozedRecommendations?.[document.path]?.snoozedUntil || "",
      }))
  ), [documentProgress?.docs, documentProgress?.snoozedRecommendations, ignoredDocPaths, ignoredDocs, knowledgeDocuments]);

  const groupedDocuments = useMemo(() => ({
    reading: uiDocuments.filter((document) => document.group === "reading"),
    review: uiDocuments.filter((document) => document.group === "review"),
    finished: uiDocuments.filter((document) => document.group === "finished"),
    unstarted: uiDocuments.filter((document) => document.group === "unstarted"),
  }), [uiDocuments]);

  const featuredDocument = useMemo(() => {
    const availableDocuments = uiDocuments.filter((document) => !isRecommendationSnoozed(document));
    const candidatePool = availableDocuments.length ? availableDocuments : uiDocuments;
    const currentDoc = candidatePool.find((document) => document.path === documentProgress?.currentDocPath);
    if (currentDoc) {
      return currentDoc;
    }
    const recentDoc = (documentProgress?.recentDocs || [])
      .map((recent) => candidatePool.find((document) => document.path === recent.docPath))
      .find(Boolean);
    if (recentDoc) {
      return recentDoc;
    }
    return candidatePool.find((document) => document.group === "reading")
      || candidatePool.find((document) => document.group === "review")
      || candidatePool.find((document) => document.group === "finished")
      || candidatePool.find((document) => document.group === "unstarted")
      || candidatePool[0]
      || null;
  }, [documentProgress?.currentDocPath, documentProgress?.recentDocs, uiDocuments]);

  const recommendedNewDocument = useMemo(() => {
    const preferred = groupedDocuments.unstarted.find((document) => (
      document.path !== featuredDocument?.path
      && !snoozedRecommendationDocPaths.has(document.path)
    ));
    if (preferred) {
      return preferred;
    }
    return uiDocuments.find((document) => (
      document.path !== featuredDocument?.path
      && !document.ignored
      && !snoozedRecommendationDocPaths.has(document.path)
    )) || null;
  }, [featuredDocument?.path, groupedDocuments.unstarted, snoozedRecommendationDocPaths, uiDocuments]);

  async function snoozeFeaturedDocument(document) {
    const activeUserId = profile?.user?.id || userId || await ensureLocalUserId();
    try {
      setError("");
      const nextProfile = await postJson("/api/profile/recommendation-snooze", {
        userId: activeUserId,
        docPath: document.path,
        docTitle: document.title,
        hours: 12,
      });
      setProfile(nextProfile);
      lastProfileSyncRef.current = Date.now();
    } catch (nextError) {
      setError(nextError.message);
    }
  }

  return (
    <main className="ll-home-page">
      <header className="ll-topbar">
        <Link href="/" className="ll-brand">
          <span className="ll-brand-mark" aria-hidden="true" />
          <span>LearningLoop</span>
        </Link>
        <div className="ll-topbar-actions">
          <Link href="/library" className="ll-library-nav-link">
            资料库
          </Link>
          <Link href="/campaign" className="ll-interview-button">
            <span aria-hidden="true">AI</span>
            <span>面试冲刺</span>
          </Link>
          <AvatarMenu
            open={avatarOpen}
            onToggle={() => setAvatarOpen((open) => !open)}
            userName={profile?.user?.handle || "本机"}
          />
        </div>
      </header>

      <div className="ll-home-main">
        <CampaignHero campaign={activeCampaign} />
        {error ? <p className="ll-status-note">{error}</p> : null}
        {featuredDocument ? (
          <DefaultFocusView
            featuredDocument={featuredDocument}
            recommendedNewDocument={recommendedNewDocument}
            reviewDue={reviewDue}
            hasProfile={Boolean(profile?.user?.id)}
            onSnoozeRecommendation={snoozeFeaturedDocument}
          />
        ) : null}
      </div>
    </main>
  );
}
