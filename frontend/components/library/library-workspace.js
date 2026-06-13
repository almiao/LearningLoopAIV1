"use client";

import Link from "next/link";
import { useDeferredValue, useEffect, useMemo, useRef, useState, startTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apiFetch, postJson } from "../../lib/api";
import { buildReentryPlan } from "../../lib/reentry-actions";
import { ensureLocalUserId } from "../../lib/user-session";
import {
  rootLibraryKey,
  groupMeta,
  buildLibraryTree,
  buildLearningHref,
  buildSidebarDocument,
  encodeNodeKey,
  getFolderIcon,
  getSidebarMetric,
  getSignalColor,
  getTypeLabel,
} from "./shared";

const addMaterialOptions = [
  {
    key: "upload",
    title: "上传 PDF",
    description: "把课件、论文或文档直接放进资料库。",
    href: "/materials?source=upload",
  },
  {
    key: "link",
    title: "粘贴链接",
    description: "保存网页、博客或官方文档，后续继续学。",
    href: "/materials?source=link",
  },
  {
    key: "note",
    title: "写笔记",
    description: "把自己的零散理解先沉淀成一份材料。",
    href: "/materials?source=note",
  },
];

function FolderAggregateBar({ aggregate, total }) {
  const finishedWidth = total ? (aggregate.finished / total) * 100 : 0;
  const activeWidth = total ? (aggregate.active / total) * 100 : 0;
  const unstartedWidth = total ? (aggregate.unstarted / total) * 100 : 0;

  return (
    <div className="ll-folder-progress" aria-hidden="true">
      <span style={{ width: `${finishedWidth}%`, background: "#1D9E75" }} />
      <span style={{ width: `${activeWidth}%`, background: "#BA7517" }} />
      <span style={{ width: `${unstartedWidth}%`, background: "#DAD9D4" }} />
    </div>
  );
}

function FolderCard({ node, onOpen }) {
  return (
    <button
      type="button"
      className="ll-folder-card"
      onClick={() => onOpen(node.key)}
      data-testid={`library-folder-card-${encodeURIComponent(node.label)}`}
    >
      <div className="ll-folder-card-top" />
      <div className="ll-folder-card-body">
        <div className="ll-folder-card-head">
          <span className="ll-folder-card-icon">{getFolderIcon()}</span>
          <span className="ll-folder-card-count">{node.documentCount} 篇</span>
        </div>
        <strong>{node.label}</strong>
        <FolderAggregateBar aggregate={node.aggregate} total={node.documentCount} />
        <p>{`已读完 ${node.aggregate.finished} · 在读 ${node.aggregate.active} · 未学 ${node.aggregate.unstarted}`}</p>
      </div>
    </button>
  );
}

function LibraryDocumentCard({ document, active, managementMode, onOpen, onToggleIgnored }) {
  const color = getSignalColor(document);

  return (
    <article
      role="button"
      tabIndex={0}
      className={`ll-library-document-card${active ? " is-active" : ""}${document.ignored ? " is-ignored" : ""}`}
      onClick={() => onOpen(document, "library")}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen(document, "library");
        }
      }}
      data-testid={`library-document-card-${document.routeSlug}`}
    >
      <div className="ll-library-document-head">
        <span className="ll-library-document-kind">{document.ignored ? "已忽略" : getTypeLabel(document)}</span>
        <span className="ll-library-document-score" style={{ color }}>
          {getSidebarMetric(document)}
        </span>
      </div>
      <strong>{document.title}</strong>
      <p>{`${document.providerLabel} / ${document.folderLabels.join(" / ") || "资料库"}`}</p>
      <div className="ll-library-document-foot">
        <span className={`ll-library-status tone-${document.group}`}>{groupMeta[document.group].label}</span>
        <span>{document.ignored ? "默认隐藏" : document.readingLabel}</span>
      </div>
      {managementMode ? (
        <button
          type="button"
          className="ll-library-ignore-button"
          onClick={(event) => {
            event.stopPropagation();
            onToggleIgnored(document);
          }}
        >
          {document.ignored ? "取消忽略" : "忽略"}
        </button>
      ) : null}
    </article>
  );
}

function AddMaterialModal({ onClose }) {
  return (
    <div className="ll-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="ll-modal"
        role="dialog"
        aria-modal="true"
        aria-label="添加材料"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="ll-modal-head">
          <div>
            <p>添加材料</p>
            <h3>把内容带进来，后续交给 AI 帮你学透</h3>
          </div>
          <button type="button" className="ll-icon-button" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <div className="ll-add-grid">
          {addMaterialOptions.map((option) => (
            <Link key={option.key} href={option.href} className="ll-add-option" onClick={onClose}>
              <strong>{option.title}</strong>
              <p>{option.description}</p>
              <span>继续 →</span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

function IgnoredDocumentToggle({ checked, count, onChange, className = "" }) {
  const toggleClassName = className ? `ll-include-ignored-toggle ${className}` : "ll-include-ignored-toggle";

  return (
    <label className={toggleClassName}>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>包含忽略文档</span>
      <strong>{count}</strong>
    </label>
  );
}

function LibraryTreeNode({ node, currentNodeKey, onOpenNode }) {
  const active = currentNodeKey === node.key;

  return (
    <div className="ll-tree-node">
      <button
        type="button"
        className={`ll-tree-button${active ? " is-active" : ""}`}
        onClick={() => onOpenNode(node.key)}
        style={{ paddingLeft: `${12 + node.level * 16}px` }}
      >
        <span className="ll-tree-button-label">{node.label}</span>
        <span className="ll-tree-button-count">{node.documentCount}</span>
      </button>
      {node.children.length ? (
        <div className="ll-tree-children">
          {node.children.map((child) => (
            <LibraryTreeNode
              key={child.key}
              node={child}
              currentNodeKey={currentNodeKey}
              onOpenNode={onOpenNode}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function LibraryBrowser({
  currentNode,
  includeIgnoredDocuments,
  ignoredDocumentCount,
  onOpenNode,
  onOpenDocument,
  onIncludeIgnoredChange,
  onToggleIgnored,
}) {
  const breadcrumbs = [
    { key: rootLibraryKey, label: "我的资料" },
    ...currentNode.path.map((segment, index) => ({
      key: encodeNodeKey(currentNode.path.slice(0, index + 1)),
      label: segment,
    })),
  ];
  const hasChildren = currentNode.children.length > 0;
  const directDocuments = currentNode.directDocuments;
  const breadcrumbLabel = currentNode.path.length
    ? `我的资料 / ${currentNode.path.join(" / ")}`
    : "我的资料";
  const [managementMode, setManagementMode] = useState(false);

  return (
    <section className="ll-library-browser">
      <div className="ll-library-head">
        <div>
          <div className="ll-breadcrumbs" data-testid="library-breadcrumbs">
            {breadcrumbs.map((item, index) => (
              <span key={item.key} className="ll-breadcrumb-item">
                <button type="button" onClick={() => onOpenNode(item.key)}>
                  {item.label}
                </button>
                {index < breadcrumbs.length - 1 ? <span>/</span> : null}
              </span>
            ))}
          </div>
          <h2>{breadcrumbLabel}</h2>
        </div>
        <div className="ll-library-head-actions">
          <span>共 {currentNode.documentCount} 篇</span>
          {ignoredDocumentCount > 0 ? (
            <IgnoredDocumentToggle
              checked={includeIgnoredDocuments}
              count={ignoredDocumentCount}
              onChange={onIncludeIgnoredChange}
              className="is-library-head"
            />
          ) : null}
          <button
            type="button"
            className={managementMode ? "ll-library-manage-button is-active" : "ll-library-manage-button"}
            onClick={() => setManagementMode((value) => !value)}
          >
            {managementMode ? "完成" : "管理"}
          </button>
        </div>
      </div>

      {hasChildren ? (
        <section className="ll-library-section">
          <div className="ll-library-section-title">子文件夹</div>
          <div className="ll-folder-grid">
            {currentNode.children.map((child) => (
              <FolderCard key={child.key} node={child} onOpen={onOpenNode} />
            ))}
          </div>
        </section>
      ) : null}

      {directDocuments.length ? (
        <section className="ll-library-section">
          <div className="ll-library-section-title">{hasChildren ? "当前层级文档" : "文档"}</div>
          <div className="ll-library-document-grid">
            {directDocuments.map((document) => (
              <LibraryDocumentCard
                key={document.path}
                document={document}
                active={false}
                managementMode={managementMode}
                onOpen={onOpenDocument}
                onToggleIgnored={onToggleIgnored}
              />
            ))}
          </div>
        </section>
      ) : null}

      {!hasChildren && !directDocuments.length ? (
        <div className="ll-status-note">当前层级下还没有匹配的文档。</div>
      ) : null}
    </section>
  );
}

export function LibraryWorkspace() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const searchInputRef = useRef(null);

  const [userId, setUserId] = useState("");
  const [knowledgeDocuments, setKnowledgeDocuments] = useState([]);
  const [profile, setProfile] = useState(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [addMaterialOpen, setAddMaterialOpen] = useState(false);
  const [includeIgnoredDocuments, setIncludeIgnoredDocuments] = useState(false);
  const [mobilePane, setMobilePane] = useState("detail");

  const deferredQuery = useDeferredValue(search.trim().toLowerCase());
  const selectedNodeKeyParam = searchParams.get("node") || "";

  useEffect(() => {
    ensureLocalUserId()
      .then((storedUserId) => setUserId(storedUserId || ""))
      .catch((nextError) => setError(nextError.message));
  }, []);

  useEffect(() => {
    async function loadLibraryData() {
      try {
        setError("");
        const docsQuery = userId ? `?userId=${encodeURIComponent(userId)}` : "";
        const docsPayload = await apiFetch(`/api/knowledge/docs${docsQuery}`);
        const javaGuideDocs = (docsPayload.documents || []).filter((document) => document.providerLabel === "JavaGuide");
        setKnowledgeDocuments(javaGuideDocs);

        if (userId) {
          const nextProfile = await apiFetch(`/api/profile/${userId}`);
          setProfile(nextProfile);
        } else {
          setProfile(null);
        }
      } catch (nextError) {
        setError(nextError.message);
      }
    }

    void loadLibraryData();
  }, [userId]);

  useEffect(() => {
    function handleKeydown(event) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInputRef.current?.focus();
      }
    }

    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, []);

  const documentProgress = profile?.documentProgress || null;
  const ignoredDocs = documentProgress?.ignoredDocs || {};
  const ignoredDocPaths = useMemo(
    () => new Set(documentProgress?.ignoredDocPaths || []),
    [documentProgress?.ignoredDocPaths]
  );
  const ignoredDocumentCount = ignoredDocPaths.size;

  const allUiDocuments = useMemo(() => (
    knowledgeDocuments.map((document) => buildSidebarDocument(document, documentProgress?.docs || {}, {
      ignored: ignoredDocPaths.has(document.path),
      ignoredAt: ignoredDocs[document.path]?.ignoredAt || "",
    }))
  ), [documentProgress?.docs, ignoredDocPaths, ignoredDocs, knowledgeDocuments]);

  const uiDocuments = useMemo(
    () => allUiDocuments.filter((document) => includeIgnoredDocuments || !document.ignored),
    [allUiDocuments, includeIgnoredDocuments]
  );

  const filteredDocuments = useMemo(() => (
    uiDocuments.filter((document) => {
      if (!deferredQuery) {
        return true;
      }
      return [
        document.title,
        document.path,
        document.folderLabels.join(" "),
        document.repoLabel,
      ].some((value) => String(value || "").toLowerCase().includes(deferredQuery));
    })
  ), [deferredQuery, uiDocuments]);

  const libraryTree = useMemo(() => buildLibraryTree(filteredDocuments), [filteredDocuments]);
  const currentNodeKey = selectedNodeKeyParam || rootLibraryKey;
  const currentLibraryNode = libraryTree.nodeMap.get(currentNodeKey) || libraryTree.root;

  function openLibraryNode(nodeKey) {
    const params = new URLSearchParams();
    if (nodeKey && nodeKey !== rootLibraryKey) {
      params.set("node", nodeKey);
    }
    startTransition(() => {
      router.replace(params.toString() ? `/library?${params.toString()}` : "/library", { scroll: false });
    });
    setMobilePane("detail");
  }

  function openDocument(document) {
    router.push(buildLearningHref(document, {
      autostart: document.trainingStarted || document.progressPercentage >= 100,
      intent: buildReentryPlan(document).primaryAction.kind,
    }));
  }

  async function toggleIgnoredDocument(document) {
    if (!userId) {
      setError("本机档案准备好后才能管理资料。");
      return;
    }
    try {
      setError("");
      const nextProfile = await postJson("/api/profile/ignored-document", {
        userId,
        docPath: document.path,
        docTitle: document.title,
        ignored: !document.ignored,
      });
      setProfile(nextProfile);
    } catch (nextError) {
      setError(nextError.message);
    }
  }

  return (
    <main className="ll-home-page ll-library-page">
      <header className="ll-topbar">
        <Link href="/" className="ll-brand">
          <span className="ll-brand-mark" aria-hidden="true" />
          <span>LearningLoop</span>
        </Link>
        <div className="ll-topbar-actions">
          <button type="button" className="ll-mobile-nav" onClick={() => setMobilePane((pane) => (pane === "sidebar" ? "detail" : "sidebar"))}>
            {mobilePane === "sidebar" ? "查看文档" : "目录"}
          </button>
          <Link href="/" className="ll-secondary-button">
            ← 返回首页
          </Link>
        </div>
      </header>

      <div className="ll-workspace">
        <aside className={`ll-sidebar${mobilePane === "sidebar" ? " is-mobile-active" : ""}`}>
          <div className="ll-search-shell">
            <input
              ref={searchInputRef}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索资料..."
              aria-label="搜索资料"
            />
            <span>⌘K</span>
          </div>

          <div className="ll-sidebar-switcher">
            <button type="button" className="ll-library-entry is-active" onClick={() => openLibraryNode(rootLibraryKey)}>
              <div className="ll-library-entry-left">
                <span className="ll-folder-icon" aria-hidden="true">
                  <svg viewBox="0 0 16 16">
                    <path d="M1.5 4.5h4l1.2 1.4h7.8v6.6a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                    <path d="M1.5 5V3.7a1 1 0 0 1 1-1h2.7l1 1.1H13.5a1 1 0 0 1 1 1V5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                  </svg>
                </span>
                <strong>我的资料</strong>
              </div>
              <span>{uiDocuments.length}</span>
            </button>
          </div>

          <div className="ll-tree-shell" data-testid="library-tree">
            {libraryTree.root.children.map((node) => (
              <LibraryTreeNode
                key={node.key}
                node={node}
                currentNodeKey={currentLibraryNode.key}
                onOpenNode={openLibraryNode}
              />
            ))}
          </div>

          <button type="button" className="ll-add-button" onClick={() => setAddMaterialOpen(true)}>
            + 添加材料
          </button>
        </aside>

        <section className={`ll-detail${mobilePane === "detail" ? " is-mobile-active" : ""}`}>
          {error ? <p className="ll-status-note">{error}</p> : null}
          <LibraryBrowser
            currentNode={currentLibraryNode}
            includeIgnoredDocuments={includeIgnoredDocuments}
            ignoredDocumentCount={ignoredDocumentCount}
            onOpenNode={openLibraryNode}
            onOpenDocument={openDocument}
            onIncludeIgnoredChange={setIncludeIgnoredDocuments}
            onToggleIgnored={toggleIgnoredDocument}
          />
        </section>
      </div>

      {addMaterialOpen ? <AddMaterialModal onClose={() => setAddMaterialOpen(false)} /> : null}
    </main>
  );
}
