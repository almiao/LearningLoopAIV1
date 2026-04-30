"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiFetch, postJson } from "../lib/api";
import {
  getStoredUserId,
  setStoredUserId,
} from "../lib/user-session";

const profileDirtyStorageKey = "learning-loop-profile-dirty-at";

const promptChips = [
  { label: "Java", query: "java" },
  { label: "JVM", query: "jvm" },
  { label: "数据库", query: "数据库" },
  { label: "并发", query: "concurrent" },
  { label: "Spring", query: "spring" },
];

const entryOptions = [
  { key: "javaguide", label: "Java面试（JavaGuide）" },
  { key: "ielts", label: "雅思考试" },
  { key: "frontend", label: "前端面试" },
];

function buildKnowledgeTree(documents = []) {
  const root = [];

  for (const document of documents) {
    const relativePath = String(document.path || "").replace(/^docs\//, "");
    const segments = relativePath.split("/");
    const folderSegments = segments.slice(0, -1);
    let level = root;

    folderSegments.forEach((segment, index) => {
      const key = folderSegments.slice(0, index + 1).join("/");
      let node = level.find((item) => item.type === "folder" && item.key === key);
      if (!node) {
        node = {
          type: "folder",
          key,
          label: document.folderLabels?.[index] || segment,
          children: [],
        };
        level.push(node);
      }
      level = node.children;
    });

    level.push({
      type: "document",
      key: document.path,
      path: document.path,
      label: document.title,
    });
  }

  return root;
}

function countDocuments(nodes = []) {
  return nodes.reduce((count, node) => {
    if (node.type === "document") {
      return count + 1;
    }
    return count + countDocuments(node.children || []);
  }, 0);
}

function documentHref(docPath = "") {
  const params = new URLSearchParams();
  params.set("doc", docPath);
  return `/learn?${params.toString()}`;
}

function flattenDocuments(nodes = [], sectionLabel = "") {
  return nodes.flatMap((node) => {
    if (node.type === "document") {
      return [{ ...node, sectionLabel }];
    }
    return flattenDocuments(node.children || [], node.label || sectionLabel);
  });
}

function simplifyPath(docPath = "") {
  return String(docPath || "")
    .replace(/^docs\//, "")
    .replace(/\/[^/]+\.md$/, "")
    .replace(/-/g, " / ");
}

function averageProgress(documents = [], target = null) {
  if (!documents.length) {
    return 0;
  }
  const total = documents.reduce((sum, document) => sum + getDocumentProgress(target, document.path), 0);
  return Math.round(total / documents.length);
}

function averageMastery(documents = [], target = null) {
  if (!documents.length) {
    return 0;
  }
  const total = documents.reduce((sum, document) => sum + getDocumentMastery(target, document.path).percentage, 0);
  return Math.round(total / documents.length);
}

function getDocumentProgress(target = null, docPath = "") {
  const storedProgress = target?.readingProgress?.docs?.[docPath]?.progressPercentage;
  if (Number.isFinite(Number(storedProgress))) {
    return Math.max(0, Math.min(100, Number(storedProgress)));
  }
  if (target?.currentDocPath === docPath) {
    return 10;
  }
  return 0;
}

function getDocumentMastery(target = null, docPath = "") {
  const matchedDoc = (target?.readingDomains || [])
    .flatMap((domain) => domain.docs || [])
    .find((document) => document.path === docPath);
  const percentage = Number(matchedDoc?.masteryPercentage || 0);
  return {
    percentage: Number.isFinite(percentage) ? Math.max(0, Math.min(100, percentage)) : 0,
    label: matchedDoc?.masteryLabel || "未训练",
    assessedConceptCount: matchedDoc?.assessedConceptCount || 0,
    totalConceptCount: matchedDoc?.totalConceptCount || 0,
  };
}

function formatProgressBadge(progressPercentage = 0, isCurrent = false) {
  if (isCurrent) {
    return `当前 ${Math.max(10, progressPercentage)}%`;
  }
  if (progressPercentage >= 100) {
    return "已读";
  }
  if (progressPercentage >= 25) {
    return `${progressPercentage}%`;
  }
  if (progressPercentage > 0) {
    return "已打开";
  }
  return "未读";
}

function formatMasteryBadge(mastery = {}) {
  if (!mastery.assessedConceptCount) {
    return "未训练";
  }
  return `掌握 ${mastery.percentage}%`;
}

export function HomePage() {
  const [handle, setHandle] = useState("");
  const [pin, setPin] = useState("");
  const [search, setSearch] = useState("");
  const [selectedEntry, setSelectedEntry] = useState("javaguide");
  const [selectedSectionKey, setSelectedSectionKey] = useState("all");
  const [knowledgeDocuments, setKnowledgeDocuments] = useState([]);
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
    apiFetch("/api/knowledge/docs")
      .then((data) => setKnowledgeDocuments(data.documents || []))
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

  const knowledgeTree = useMemo(() => buildKnowledgeTree(knowledgeDocuments), [knowledgeDocuments]);
  const sections = useMemo(
    () => knowledgeTree.filter((section) => section.type === "folder"),
    [knowledgeTree]
  );
  const allCatalogDocuments = useMemo(() => flattenDocuments(knowledgeTree), [knowledgeTree]);
  const selectedSection = useMemo(
    () => sections.find((section) => section.key === selectedSectionKey) || null,
    [sections, selectedSectionKey]
  );
  const scopedDocuments = useMemo(
    () => selectedSection ? flattenDocuments(selectedSection.children || [], selectedSection.label) : allCatalogDocuments,
    [allCatalogDocuments, selectedSection]
  );
  const visibleDocuments = useMemo(() => {
    const normalizedQuery = search.trim().toLowerCase();
    if (!normalizedQuery) {
      return scopedDocuments;
    }
    return scopedDocuments.filter((document) => (
      `${document.label} ${document.path} ${document.sectionLabel}`.toLowerCase().includes(normalizedQuery)
    ));
  }, [scopedDocuments, search]);
  const totalDocumentCount = knowledgeDocuments.length;
  const matchingDocumentCount = visibleDocuments.length;
  const currentTarget = profile?.targets?.[0] || null;
  const currentReading = currentTarget?.currentDocPath ? {
    path: currentTarget.currentDocPath,
    title: currentTarget.currentDocTitle || allCatalogDocuments.find((document) => document.path === currentTarget.currentDocPath)?.label || "继续当前文档",
    targetTitle: currentTarget.title || "",
    progress: getDocumentProgress(currentTarget, currentTarget.currentDocPath),
  } : null;
  const currentReadingSection = useMemo(() => {
    if (!currentReading?.path) {
      return null;
    }
    return sections.find((section) => flattenDocuments(section.children || [], section.label).some((document) => document.path === currentReading.path)) || null;
  }, [currentReading?.path, sections]);
  const recommendedDocuments = useMemo(() => {
    return visibleDocuments.slice(0, 18);
  }, [visibleDocuments]);
  const allProgress = useMemo(
    () => averageProgress(allCatalogDocuments, currentTarget),
    [allCatalogDocuments, currentTarget]
  );
  const sectionSummaries = useMemo(
    () => sections.map((section) => {
      const documents = flattenDocuments(section.children || [], section.label);
      return {
        ...section,
        documentCount: documents.length,
        progressPercentage: averageProgress(documents, currentTarget),
        masteryPercentage: averageMastery(documents, currentTarget),
      };
    }),
    [currentTarget, sections]
  );

  useEffect(() => {
    if (selectedSectionKey !== "all" || !currentReadingSection?.key) {
      return;
    }
    setSelectedSectionKey(currentReadingSection.key);
  }, [currentReadingSection?.key, selectedSectionKey]);

  useEffect(() => {
    if (selectedSectionKey === "all") {
      return;
    }
    if (!sections.some((section) => section.key === selectedSectionKey)) {
      setSelectedSectionKey("all");
    }
  }, [sections, selectedSectionKey]);

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
            <a className="primary-pill" href="#login-panel">登录</a>
          </div>
        )}
      </section>

      <section className="home-hero compact-home-hero">
        <p className="section-kicker">LearningLoop AI</p>
        <h1>搜索技术资料或选择入口</h1>
        <label className="search-shell" aria-label="搜索目录或文档">
          <span className="search-icon">⌕</span>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索技术文档、知识点或学习入口"
          />
        </label>
        <div className="entry-option-row" aria-label="快捷入口">
          {entryOptions.map((option) => (
            <button
              key={option.key}
              type="button"
              className={selectedEntry === option.key ? "entry-option active" : "entry-option"}
              onClick={() => setSelectedEntry(option.key)}
            >
              {option.label}
            </button>
          ))}
        </div>
        {search.trim() ? (
          <p className="search-feedback" aria-live="polite">
            {matchingDocumentCount
              ? `找到 ${matchingDocumentCount} 篇匹配文档`
              : `没有找到“${search.trim()}”相关文档`}
          </p>
        ) : null}
      </section>

      {!profile ? (
        <section className="auth-strip" id="login-panel">
          <form className="auth-form-inline" onSubmit={onLogin}>
            <div className="auth-copy">
              <div>
                <strong>登录后同步学习进度</strong>
                <p>目录浏览不需要登录，登录后阅读页会记录你的进度。</p>
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

      {selectedEntry === "javaguide" ? (
      <section className="learning-browser-card compact-catalog">
        <header className="catalog-hero">
          <div className="catalog-stats" aria-label="文档数量">
            <strong>{totalDocumentCount}</strong>
            <span>篇文档</span>
          </div>
        </header>

        <div className="catalog-search-row">
          <div className="prompt-chip-row compact">
            {promptChips.map((chip) => (
              <button
                key={chip.label}
                type="button"
                className={search === chip.query ? "topic-chip active" : "topic-chip"}
                onClick={() => setSearch(chip.query)}
              >
                {chip.label}
              </button>
            ))}
          </div>
        </div>

        <div className="catalog-workbench">
          <nav className="catalog-section-rail" aria-label="文档分类">
            {currentReading ? (
              <button
                type="button"
                className="catalog-section-tab current-reading-tab"
                onClick={() => setSelectedSectionKey(currentReadingSection?.key || "all")}
              >
                <span>当前阅读</span>
                <strong>{formatProgressBadge(currentReading.progress, true)}</strong>
              </button>
            ) : null}
            <button
              type="button"
              className={selectedSectionKey === "all" ? "catalog-section-tab active" : "catalog-section-tab"}
              onClick={() => setSelectedSectionKey("all")}
            >
              <span>全部</span>
              <strong>{totalDocumentCount} · {allProgress}%读</strong>
            </button>
            {sectionSummaries.map((section) => (
              <button
                key={section.key}
                type="button"
                className={selectedSectionKey === section.key ? "catalog-section-tab active" : "catalog-section-tab"}
                onClick={() => setSelectedSectionKey(section.key)}
                title={`${section.progressPercentage}% 阅读进度，${section.masteryPercentage}% 掌握度`}
              >
                <span>{section.label}</span>
                <strong>{section.documentCount} · {section.progressPercentage}%读</strong>
              </button>
            ))}
          </nav>

          <div className="catalog-main-panel">
            <div className="catalog-list-head">
              <div>
                <p aria-live="polite">
                  {search.trim()
                    ? `找到 ${matchingDocumentCount} 篇匹配`
                    : selectedSection ? "当前分类" : "全部文档"}
                </p>
                <span
                  className="catalog-progress-rule"
                  title="打开文档记为已打开；阅读深度按最大滚动位置累计；滚到 90% 且停留 45 秒记为已读。训练掌握度另算。"
                >
                  进度规则
                </span>
              </div>
              {search.trim() ? (
                <button type="button" className="catalog-clear-button" onClick={() => setSearch("")}>
                  清除
                </button>
              ) : null}
            </div>

            {recommendedDocuments.length ? (
              <div className="catalog-doc-grid">
                {recommendedDocuments.map((document) => {
                  const isCurrent = document.path === currentReading?.path;
                  const progressPercentage = getDocumentProgress(currentTarget, document.path);
                  const mastery = getDocumentMastery(currentTarget, document.path);

                  return (
                    <Link
                      key={document.key}
                      className={isCurrent ? "catalog-doc-row current" : "catalog-doc-row"}
                      href={documentHref(document.path)}
                    >
                      <span className="catalog-doc-dot" />
                      <span className="catalog-doc-title">{document.label}</span>
                      <span className="catalog-doc-badges">
                        <span className="catalog-doc-progress">{formatProgressBadge(progressPercentage, isCurrent)}</span>
                        <span className="catalog-doc-mastery">{formatMasteryBadge(mastery)}</span>
                      </span>
                      <span className="catalog-doc-path">
                        {isCurrent ? "当前阅读" : simplifyPath(document.path)}
                      </span>
                    </Link>
                  );
                })}
              </div>
            ) : (
              <div className="chapter-empty">
                <p>当前搜索没有匹配到文档，换个关键词试试。</p>
              </div>
            )}
          </div>
        </div>
      </section>
      ) : null}

      {selectedEntry !== "javaguide" ? (
        <section className="learning-browser-card entry-empty-panel">
          <h2>{entryOptions.find((option) => option.key === selectedEntry)?.label}</h2>
        </section>
      ) : null}
    </main>
  );
}
