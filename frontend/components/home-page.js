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

function filterKnowledgeTree(nodes = [], query = "") {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return nodes;
  }

  return nodes
    .map((node) => {
      if (node.type === "document") {
        const haystack = `${node.label} ${node.path}`.toLowerCase();
        return haystack.includes(normalizedQuery) ? node : null;
      }

      const folderMatches = `${node.label} ${node.key}`.toLowerCase().includes(normalizedQuery);
      const filteredChildren = filterKnowledgeTree(node.children || [], normalizedQuery);
      if (!folderMatches && !filteredChildren.length) {
        return null;
      }
      return {
        ...node,
        children: folderMatches ? node.children : filteredChildren,
      };
    })
    .filter(Boolean);
}

function documentHref(docPath = "") {
  const params = new URLSearchParams();
  params.set("doc", docPath);
  return `/learn?${params.toString()}`;
}

function KnowledgeTreeNodes({ nodes, depth = 0 }) {
  return (
    <div className={depth === 0 ? "knowledge-tree-list" : "knowledge-tree-list nested"}>
      {nodes.map((node) => {
        if (node.type === "document") {
          return (
            <Link
              key={node.key}
              className="chapter-row knowledge-doc-row"
              href={documentHref(node.path)}
            >
              <span className="status-bullet" />
              <span className="chapter-row-title">{node.label}</span>
              <span className="chapter-row-tag">文档</span>
            </Link>
          );
        }

        const documentCount = countDocuments(node.children || []);
        return (
          <details key={node.key} className="knowledge-folder" open={depth === 0}>
            <summary>
              <span>{node.label}</span>
              <span>{documentCount} 篇</span>
            </summary>
            <KnowledgeTreeNodes nodes={node.children || []} depth={depth + 1} />
          </details>
        );
      })}
    </div>
  );
}

export function HomePage() {
  const [handle, setHandle] = useState("");
  const [pin, setPin] = useState("");
  const [search, setSearch] = useState("");
  const [expandedSectionKeys, setExpandedSectionKeys] = useState([]);
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
  const visibleSections = useMemo(() => filterKnowledgeTree(knowledgeTree, search), [knowledgeTree, search]);
  const totalDocumentCount = knowledgeDocuments.length;
  const matchingDocumentCount = countDocuments(visibleSections);

  useEffect(() => {
    const availableKeys = new Set(visibleSections.filter((section) => section.type === "folder").map((section) => section.key));
    const nextExpanded = expandedSectionKeys.filter((key) => availableKeys.has(key));
    if (nextExpanded.length) {
      if (nextExpanded.length !== expandedSectionKeys.length) {
        setExpandedSectionKeys(nextExpanded);
      }
      return;
    }

    const firstFolder = visibleSections.find((section) => section.type === "folder");
    if (firstFolder) {
      setExpandedSectionKeys([firstFolder.key]);
    }
  }, [expandedSectionKeys, visibleSections]);

  function toggleSection(sectionKey) {
    setExpandedSectionKeys((currentKeys) => (
      currentKeys.includes(sectionKey)
        ? currentKeys.filter((key) => key !== sectionKey)
        : [...currentKeys, sectionKey]
    ));
  }

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

      <section className="home-hero">
        <p className="section-kicker">JavaGuide 静态文档库</p>
        <h1>选择一篇文档开始阅读</h1>
        <label className="search-shell" aria-label="搜索目录或文档">
          <span className="search-icon">⌕</span>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索目录或文档"
          />
        </label>
        {search.trim() ? (
          <p className="search-feedback" aria-live="polite">
            {matchingDocumentCount
              ? `正在按“${search.trim()}”筛选文档，找到 ${matchingDocumentCount} 个匹配。`
              : `没有找到“${search.trim()}”相关文档，可以换个关键词。`}
          </p>
        ) : null}
        <div className="prompt-chip-row">
          {promptChips.map((chip) => (
            <button
              key={chip.label}
              type="button"
              className={chip.query === "java" ? "topic-chip topic-chip-dark" : "topic-chip"}
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

      <section className="learning-browser-card">
        <div className="learning-browser-head">
          <div className="learning-browser-copy">
            <span className="learning-header-kicker">目录浏览</span>
            <h2>JavaGuide 全量目录</h2>
          </div>
          <div className="progress-summary">
            <strong>{totalDocumentCount}</strong>
            <span>篇静态文档</span>
          </div>
        </div>

        <div className="learning-browser-tabs" aria-label="JavaGuide 顶层目录">
          {visibleSections.map((section) => (
            section.type === "folder" ? (
              <button
                key={section.key}
                type="button"
                className={expandedSectionKeys.includes(section.key) ? "learning-browser-tab active" : "learning-browser-tab"}
                onClick={() => toggleSection(section.key)}
              >
                <span>{section.label}</span>
                <strong>{countDocuments(section.children || [])}</strong>
              </button>
            ) : null
          ))}
        </div>

        {visibleSections.length ? (
          <div className="learning-browser-directory-list">
            {visibleSections.map((section) => {
              if (section.type === "document") {
                return (
                  <Link
                    key={section.key}
                    className="chapter-row knowledge-doc-row"
                    href={documentHref(section.path)}
                  >
                    <span className="status-bullet" />
                    <span className="chapter-row-title">{section.label}</span>
                    <span className="chapter-row-tag">文档</span>
                  </Link>
                );
              }

              const isExpanded = expandedSectionKeys.includes(section.key);
              const sectionDocumentCount = countDocuments(section.children || []);
              return (
                <section
                  key={section.key}
                  className={isExpanded ? "directory-card expanded" : "directory-card"}
                >
                  <button
                    type="button"
                    className="directory-card-toggle"
                    onClick={() => toggleSection(section.key)}
                    aria-expanded={isExpanded}
                  >
                    <div className="directory-card-copy">
                      <span className="chapter-panel-kicker">{sectionDocumentCount} 篇文档</span>
                      <h3>{section.label}</h3>
                      <p>{section.key}</p>
                    </div>
                    <div className="directory-card-meta">
                      <span className="directory-card-progress">{sectionDocumentCount}</span>
                      <span className="directory-card-arrow">{isExpanded ? "收起" : "展开"}</span>
                    </div>
                  </button>

                  {isExpanded ? (
                    <div className="learning-browser-body">
                      <KnowledgeTreeNodes nodes={section.children || []} />
                    </div>
                  ) : null}
                </section>
              );
            })}
          </div>
        ) : (
          <div className="chapter-empty">
            <p>当前搜索还没有匹配到文档，换个关键词试试。</p>
          </div>
        )}
      </section>
    </main>
  );
}
