"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiFetch, postJson } from "../lib/api";
import {
  getStoredUserId,
  setStoredUserId,
} from "../lib/user-session";

const profileDirtyStorageKey = "learning-loop-profile-dirty-at";

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

function getDocumentProgress(documentProgress = null, docPath = "") {
  const storedProgress = documentProgress?.docs?.[docPath]?.progressPercentage;
  if (Number.isFinite(Number(storedProgress))) {
    return Math.max(0, Math.min(100, Number(storedProgress)));
  }
  if (documentProgress?.currentDocPath === docPath) {
    return 10;
  }
  return 0;
}

function getDocumentLearningState(documentProgress = null, docPath = "") {
  const matchedDoc = documentProgress?.docs?.[docPath] || null;
  const percentage = Number(matchedDoc?.masteryPercentage || 0);
  return {
    percentage: Number.isFinite(percentage) ? Math.max(0, Math.min(100, percentage)) : 0,
    masteryPercentage: Number.isFinite(percentage) ? Math.max(0, Math.min(100, percentage)) : 0,
    masteryLabel: matchedDoc?.masteryLabel || "未开始",
    learningStatusLabel: matchedDoc?.learningStatusLabel || "未训练",
    trainingStarted: Boolean(matchedDoc?.trainingStarted),
    assessedConceptCount: matchedDoc?.assessedConceptCount || 0,
    totalConceptCount: matchedDoc?.totalConceptCount || 0,
  };
}

function formatProgressBadge(progressPercentage = 0, isCurrent = false) {
  if (isCurrent) {
    if (progressPercentage >= 100) {
      return "当前 · 已读";
    }
    if (progressPercentage > 0) {
      return "当前 · 在读";
    }
    return "当前 · 已打开";
  }
  if (progressPercentage >= 100) {
    return "已读";
  }
  if (progressPercentage > 0) {
    return "在读";
  }
  return "未读";
}

function formatLearningBadge(learning = {}) {
  const status = learning.learningStatusLabel || "未训练";
  if (status === "已开启训练") {
    return "已开训练";
  }
  return status;
}

function formatLastStudiedAt(timestamp = "") {
  if (!timestamp) {
    return "上次学习时间未知";
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "上次学习时间未知";
  }
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `上次学习 ${month}-${day} ${hour}:${minute}`;
}

function buildRecentReadingDocuments(documentProgress = null, catalogDocuments = []) {
  const catalogByPath = new Map(catalogDocuments.map((document) => [document.path, document]));
  const source = Array.isArray(documentProgress?.recentDocs)
    ? documentProgress.recentDocs
    : Object.values(documentProgress?.docs || {}).sort((left, right) => (
      String(right.lastActivityAt || "").localeCompare(String(left.lastActivityAt || ""))
    ));

  return source
    .filter((document) => document?.docPath || document?.path)
    .map((document) => {
      const docPath = document.docPath || document.path;
      const catalogDocument = catalogByPath.get(docPath);
      return {
        path: docPath,
        title: document.docTitle || catalogDocument?.label || "未命名文档",
        lastStudiedAt: document.lastActivityAt || "",
        isCurrent: Boolean(document.isCurrent || documentProgress?.currentDocPath === docPath),
      };
    });
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
  const currentDocumentProgress = profile?.documentProgress || null;
  const recentReadingDocuments = useMemo(
    () => buildRecentReadingDocuments(currentDocumentProgress, allCatalogDocuments),
    [allCatalogDocuments, currentDocumentProgress]
  );
  const selectedHistory = selectedSectionKey === "history";
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
  const visibleHistoryDocuments = useMemo(() => {
    const normalizedQuery = search.trim().toLowerCase();
    if (!normalizedQuery) {
      return recentReadingDocuments;
    }
    return recentReadingDocuments.filter((document) => (
      `${document.title} ${document.path}`.toLowerCase().includes(normalizedQuery)
    ));
  }, [recentReadingDocuments, search]);
  const totalDocumentCount = knowledgeDocuments.length;
  const displayDocuments = selectedHistory ? visibleHistoryDocuments : visibleDocuments;
  const matchingDocumentCount = displayDocuments.length;
  const currentReading = currentDocumentProgress?.currentDocPath ? {
    path: currentDocumentProgress.currentDocPath,
    title: currentDocumentProgress.currentDocTitle || allCatalogDocuments.find((document) => document.path === currentDocumentProgress.currentDocPath)?.label || "继续当前文档",
    progress: getDocumentProgress(currentDocumentProgress, currentDocumentProgress.currentDocPath),
  } : null;
  const currentReadingSection = useMemo(() => {
    if (!currentReading?.path) {
      return null;
    }
    return sections.find((section) => flattenDocuments(section.children || [], section.label).some((document) => document.path === currentReading.path)) || null;
  }, [currentReading?.path, sections]);
  const recommendedDocuments = useMemo(() => {
    return displayDocuments.slice(0, 18);
  }, [displayDocuments]);
  const sectionSummaries = useMemo(
    () => sections.map((section) => {
      const documents = flattenDocuments(section.children || [], section.label);
      return {
        ...section,
        documentCount: documents.length,
      };
    }),
    [sections]
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
    if (selectedSectionKey === "history") {
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
        <div className="catalog-workbench">
          <nav className="catalog-section-rail" aria-label="文档分类">
            <label className="catalog-rail-search" aria-label="筛选左侧分类下的文档">
              <span className="catalog-rail-search-icon">⌕</span>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={selectedHistory ? "筛选历史文档" : "筛选当前目录"}
              />
            </label>
            {recentReadingDocuments.length ? (
              <button
                type="button"
                className={selectedHistory ? "catalog-section-tab active" : "catalog-section-tab"}
                onClick={() => setSelectedSectionKey("history")}
              >
                <span>历史文档</span>
                <strong>{recentReadingDocuments.length}</strong>
              </button>
            ) : null}
            <button
              type="button"
              className={selectedSectionKey === "all" ? "catalog-section-tab active" : "catalog-section-tab"}
              onClick={() => setSelectedSectionKey("all")}
            >
              <span>全部</span>
              <strong>{totalDocumentCount}</strong>
            </button>
            {sectionSummaries.map((section) => (
              <button
                key={section.key}
                type="button"
                className={selectedSectionKey === section.key ? "catalog-section-tab active" : "catalog-section-tab"}
                onClick={() => setSelectedSectionKey(section.key)}
              >
                <span>{section.label}</span>
                <strong>{section.documentCount}</strong>
              </button>
            ))}
          </nav>

          <div className="catalog-main-panel">
            <div className="catalog-list-head">
              <div>
                <p aria-live="polite">
                  {search.trim()
                    ? `找到 ${matchingDocumentCount} 篇匹配`
                    : selectedHistory ? "历史文档" : selectedSection ? "当前分类" : "全部文档"}
                </p>
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
                  const documentTitle = document.label || document.title || "未命名文档";
                  const isCurrent = document.path === currentReading?.path;
                  const progressPercentage = getDocumentProgress(currentDocumentProgress, document.path);
                  const mastery = getDocumentLearningState(currentDocumentProgress, document.path);
                  const secondaryLabel = selectedHistory
                    ? formatLastStudiedAt(document.lastStudiedAt)
                    : isCurrent ? "当前阅读" : simplifyPath(document.path);

                  return (
                    <Link
                      key={document.key || document.path}
                      className={isCurrent ? "catalog-doc-row current" : "catalog-doc-row"}
                      href={documentHref(document.path)}
                    >
                      <span className="catalog-doc-dot" />
                      <span className="catalog-doc-title">{documentTitle}</span>
                      <span className="catalog-doc-badges">
                        <span className="catalog-doc-progress">{formatProgressBadge(progressPercentage, isCurrent)}</span>
                        <span className="catalog-doc-mastery">{formatLearningBadge(mastery)}</span>
                      </span>
                      <span className="catalog-doc-path">
                        {secondaryLabel}
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
