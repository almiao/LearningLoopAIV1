"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apiFetch, postJson } from "../lib/api";
import { buildReentryPlan } from "../lib/reentry-actions";
import { getStoredUserId, setStoredUserId } from "../lib/user-session";
import {
  buildLearningHref,
  buildSidebarDocument,
  formatLastActivity,
  getSignalColor,
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
      badge: "阅读中",
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
    facts.push("未读完正文");
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

function LoginModal({ onClose, onLoginSuccess }) {
  const [handle, setHandle] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [loginError, setLoginError] = useState("");

  async function onSubmit(event) {
    event.preventDefault();
    try {
      setBusy(true);
      setLoginError("");
      const data = await postJson("/api/auth/login", {
        handle: handle.trim(),
        pin,
      });
      onLoginSuccess(data.profile);
    } catch (nextError) {
      setLoginError(nextError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ll-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="ll-modal ll-login-modal"
        role="dialog"
        aria-modal="true"
        aria-label="登录 LearningLoop"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="ll-modal-head">
          <div>
            <p>登录</p>
            <h3>接上你的学习档案</h3>
          </div>
          <button type="button" className="ll-icon-button" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <form className="ll-login-form" onSubmit={onSubmit}>
          <label>
            <span>昵称</span>
            <input
              value={handle}
              onChange={(event) => setHandle(event.target.value)}
              placeholder="lee_backend"
              autoFocus
              required
            />
          </label>
          <label>
            <span>PIN</span>
            <input
              type="password"
              value={pin}
              onChange={(event) => setPin(event.target.value)}
              placeholder="4-12 位数字"
              required
            />
          </label>
          {loginError ? <p className="ll-login-error">{loginError}</p> : null}
          <button type="submit" className="ll-primary-button" disabled={busy}>
            {busy ? "登录中..." : "登录 / 创建账号"}
          </button>
          <p className="ll-login-hint">现在先用昵称 + PIN 进入，后续再接正式账号体系。</p>
        </form>
      </div>
    </div>
  );
}

function AvatarMenu({ open, onToggle, onLogout, onLoginClick, userName, isLoggedIn }) {
  return (
    <div className="ll-avatar-wrap">
      <button
        type="button"
        className={`ll-avatar${isLoggedIn ? "" : " is-guest"}`}
        onClick={isLoggedIn ? onToggle : onLoginClick}
        aria-expanded={isLoggedIn ? open : undefined}
        aria-label={isLoggedIn ? "打开账户菜单" : "登录 LearningLoop"}
      >
        {getInitials(userName)}
      </button>
      {isLoggedIn && open ? (
        <div className="ll-avatar-menu">
          <Link href="/profile">个人档案</Link>
          <button type="button" onClick={onLogout}>退出登录</button>
        </div>
      ) : null}
    </div>
  );
}

function DefaultFocusView({ featuredDocument, recommendedNewDocument, reviewDue, materialPool, hasProfile, hasActiveCampaign, onSnoozeRecommendation }) {
  const reentryPlan = buildReentryPlan(featuredDocument);
  const action = reentryPlan.primaryAction;
  const color = getSignalColor(featuredDocument);
  const heroCopy = buildHeroCopy(featuredDocument, reentryPlan);
  const recommendationFacts = buildRecommendationFacts(featuredDocument, reentryPlan);
  const snoozeLabel = getSnoozeLabel(reentryPlan);
  const reviewItems = Array.isArray(reviewDue) ? reviewDue : [];
  const poolItems = Array.isArray(materialPool) ? materialPool : [];

  return (
    <section className="ll-default-view">
      <div className="ll-kicker ll-today-kicker">{hasActiveCampaign ? "为了这场面试，今天做三件事" : "今天先做什么"}</div>
      {!hasProfile ? (
        <p className="ll-status-note">当前还没连接学习档案，先打开一篇 JavaGuide 文档，阅读与训练进度会自动回到这里。</p>
      ) : null}

      <div className="ll-today-grid">
        <section className="ll-today-card">
          <span className="ll-today-tag">① 继续读</span>
          <div className="ll-reentry-badge">{heroCopy.badge}</div>
          <Link href={buildLearningHref(featuredDocument)} className="ll-title-link">
            <h2 className="ll-today-doc-title">{featuredDocument.title}</h2>
          </Link>
          <p className="ll-today-sub">{heroCopy.reason}</p>
          {recommendationFacts.length ? (
            <div className="ll-recommendation-facts" aria-label="推荐依据">
              {recommendationFacts.map((fact) => (
                <span key={fact} className="ll-recommendation-chip">{fact}</span>
              ))}
            </div>
          ) : null}
          <div className="ll-today-grow" />
          <div className="ll-today-progress-row">
            <div className="ll-today-bar" role="presentation">
              <i style={{ width: `${Math.min(Math.max(featuredDocument.progressPercentage || 0, 0), 100)}%` }} />
            </div>
            <span className="ll-today-metric" style={{ color }}>{getHeroMetric(featuredDocument)}</span>
          </div>
          <div className="ll-today-actions">
            <Link href={buildLearningHref(featuredDocument, { autostart: action.autostart, intent: action.kind })} className="ll-primary-button">
              {action.label}
            </Link>
            {reentryPlan.secondaryActions?.length ? (
              reentryPlan.secondaryActions.map((secondaryAction) => (
                <Link
                  key={`${featuredDocument.path}:${secondaryAction.kind}`}
                  href={buildLearningHref(featuredDocument, { autostart: secondaryAction.autostart, intent: secondaryAction.kind })}
                  className="ll-reentry-secondary-link"
                >
                  {secondaryAction.label}
                </Link>
              ))
            ) : null}
          </div>
          {featuredDocument.group !== "unstarted" ? (
            <button
              type="button"
              className="ll-text-button"
              onClick={() => onSnoozeRecommendation(featuredDocument)}
            >
              {snoozeLabel}
            </button>
          ) : null}
        </section>

        <section className="ll-today-card is-muted">
          <span className="ll-today-tag">② 复习巩固</span>
          {reviewItems.length ? (
            <>
              <div className="ll-today-review-count">
                <span className="ll-danger-badge">{reviewItems.length}</span>
                <span className="ll-section-hint">没讲稳的点 · 今天到期</span>
              </div>
              <ul className="ll-review-list">
                {reviewItems.slice(0, 4).map((item) => {
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
              {reviewItems.length > 4 ? (
                <p className="ll-today-sub">共 {reviewItems.length} 个，先从最上面的开始。</p>
              ) : null}
            </>
          ) : (
            <>
              <h2 className="ll-today-doc-title">今天没有要复习的点</h2>
              <p className="ll-today-sub">练习里没讲稳的点，会自动出现在这里。</p>
            </>
          )}
        </section>

        <section className="ll-today-card">
          <span className="ll-today-tag">{hasActiveCampaign ? "③ 学点新的（按冲刺缺口推荐）" : "③ 学点新的"}</span>
          {recommendedNewDocument ? (
            <>
              <Link href={buildLearningHref(recommendedNewDocument)} className="ll-title-link">
                <h2 className="ll-today-doc-title">{recommendedNewDocument.title}</h2>
              </Link>
              <p className="ll-today-sub">{`来源 ${recommendedNewDocument.providerLabel} · ${recommendedNewDocument.folderLabels?.join(" / ") || "资料库"}`}</p>
            </>
          ) : (
            <>
              <h2 className="ll-today-doc-title">素材池是空的</h2>
              <p className="ll-today-sub">导入一篇，这里就会出现推荐。</p>
            </>
          )}
          {poolItems.length > 1 ? (
            <div className="ll-pool-chips is-compact" aria-label="素材池">
              {poolItems
                .filter((document) => document.path !== recommendedNewDocument?.path)
                .slice(0, 3)
                .map((document) => (
                  <Link
                    key={document.path}
                    href={buildLearningHref(document)}
                    className="ll-pool-chip"
                    title={document.title}
                  >
                    {document.title}
                  </Link>
                ))}
            </div>
          ) : null}
          <div className="ll-today-grow" />
          <div className="ll-today-actions">
            <Link
              href={recommendedNewDocument ? buildLearningHref(recommendedNewDocument) : "/library"}
              className="ll-primary-button"
            >
              开始新的一篇 →
            </Link>
            <Link href="/library" className="ll-reentry-secondary-link">+ 丢一篇进来</Link>
          </div>
        </section>
      </div>

      <section className="ll-home-foot-row">
        <span>我的资料</span>
        <Link href="/library" className="ll-section-link">浏览我的资料 →</Link>
      </section>
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
  const topicCount = Number(readiness.topicCount || 0);
  const solidCount = Math.max(topicCount - (readiness.gaps?.length || 0), 0);
  return (
    <section className="ll-sprint-hero" aria-label="进行中的面试冲刺">
      <div className="ll-sprint-hero-label">
        <span className="ll-sprint-pill">面试冲刺 · 进行中</span>
        <span className="ll-sprint-countdown">{getCampaignCountdownLabel(campaign)}</span>
      </div>
      <h1>{campaign.role || "当前岗位"}</h1>
      <div className="ll-sprint-stats">
        <div className="ll-sprint-stat">
          <strong>{coveragePercent}%</strong>
          <span>话题覆盖</span>
        </div>
        {topicCount ? (
          <div className="ll-sprint-stat">
            <strong>{solidCount}/{topicCount}</strong>
            <span>已讲稳</span>
          </div>
        ) : null}
        <div className="ll-sprint-focus">
          {topGap ? (
            <>今天优先补：<b>{topGap.topic}</b></>
          ) : (
            "先做一轮模拟，继续压实高风险话题"
          )}
        </div>
        <Link href="/campaign" className="ll-primary-button ll-sprint-cta">
          进入冲刺 →
        </Link>
      </div>
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
  const [loginOpen, setLoginOpen] = useState(false);

  // 旧资料库深链（/?mode=library）迁移到二级页 /library。
  const legacyLibraryMode = searchParams.get("mode") === "library";
  useEffect(() => {
    if (legacyLibraryMode) {
      router.replace("/library");
    }
  }, [legacyLibraryMode, router]);

  useEffect(() => {
    setUserId(getStoredUserId());
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
      if (!getStoredUserId()) {
        return;
      }
      try {
        const nextProfile = await apiFetch(`/api/profile/${getStoredUserId()}`);
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

  // 素材池(act-led 首页「学点新的」):还没开过的资料(后续 capability-memory 退役时
  // 这里换成"所有导入但 reading-progress 为空"的派生即可,接口不变)。
  const materialPool = useMemo(() => (
    (groupedDocuments.unstarted || [])
      .filter((document) => !document.ignored && !snoozedRecommendationDocPaths.has(document.path))
      .slice(0, 6)
  ), [groupedDocuments.unstarted, snoozedRecommendationDocPaths]);

  async function snoozeFeaturedDocument(document) {
    const activeUserId = profile?.user?.id || userId;
    if (!activeUserId) {
      setLoginOpen(true);
      return;
    }
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

  function handleLogout() {
    setStoredUserId("");
    setUserId("");
    setProfile(null);
    setAvatarOpen(false);
  }

  function handleLoginSuccess(nextProfile) {
    setStoredUserId(nextProfile.user.id);
    setUserId(nextProfile.user.id);
    setProfile(nextProfile);
    lastProfileSyncRef.current = Date.now();
    setLoginOpen(false);
    setAvatarOpen(false);
    setError("");
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
            我的资料
          </Link>
          <Link href="/campaign" className="ll-interview-button">
            <span aria-hidden="true">AI</span>
            <span>面试冲刺</span>
          </Link>
          <AvatarMenu
            open={avatarOpen}
            onToggle={() => setAvatarOpen((open) => !open)}
            onLogout={handleLogout}
            onLoginClick={() => setLoginOpen(true)}
            userName={profile?.user?.handle || "未登录"}
            isLoggedIn={Boolean(profile?.user?.id)}
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
            materialPool={materialPool}
            hasProfile={Boolean(profile?.user?.id)}
            hasActiveCampaign={Boolean(activeCampaign)}
            onSnoozeRecommendation={snoozeFeaturedDocument}
          />
        ) : null}
      </div>

      {loginOpen ? <LoginModal onClose={() => setLoginOpen(false)} onLoginSuccess={handleLoginSuccess} /> : null}
    </main>
  );
}
