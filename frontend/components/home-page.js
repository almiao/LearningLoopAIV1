"use client";

import Link from "next/link";
import { useDeferredValue, useEffect, useMemo, useRef, useState, startTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apiFetch, postJson } from "../lib/api";
import { buildReentryPlan } from "../lib/reentry-actions";
import { getStoredUserId, setStoredUserId } from "../lib/user-session";

const profileDirtyStorageKey = "learning-loop-profile-dirty-at";
const rootLibraryKey = "root";

const groupMeta = {
  reading: { label: "在读", defaultExpanded: true },
  review: { label: "练习中", defaultExpanded: true },
  finished: { label: "已读完", defaultExpanded: false },
  unstarted: { label: "未学", defaultExpanded: false },
};

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

function getInitials(name) {
  return String(name || "L").trim().slice(0, 1).toUpperCase() || "L";
}

function compareIsoTimestamp(left = "", right = "") {
  return String(left || "").localeCompare(String(right || ""));
}

function normalizePercentage(value) {
  const numericValue = Number(value || 0);
  if (!Number.isFinite(numericValue)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(numericValue)));
}

function daysAgo(timestamp = "") {
  if (!timestamp) {
    return null;
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const diffMs = Date.now() - date.getTime();
  return Math.max(0, Math.floor(diffMs / (24 * 60 * 60 * 1000)));
}

function formatDaysAgoLabel(timestamp = "") {
  const value = daysAgo(timestamp);
  if (value === null) {
    return "刚收进资料库";
  }
  if (value <= 0) {
    return "今天";
  }
  return `${value} 天前`;
}

function formatLastActivity(timestamp = "") {
  const value = daysAgo(timestamp);
  if (value === null) {
    return "未开始";
  }
  return `上次学习 ${value <= 0 ? "今天" : `${value} 天前`}`;
}

function getTitleFromPath(docPath = "") {
  return decodeURIComponent(String(docPath || ""))
    .split("/")
    .at(-1)
    ?.replace(/\.md$/i, "")
    .replace(/-/g, " ")
    || "未命名文档";
}

function toRouteSlug(docPath = "") {
  return getTitleFromPath(docPath)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "document";
}

function getTypeLabel(document) {
  if (document.sourceType === "custom-material") {
    return "资料";
  }
  return "笔记";
}

function getTypeIcon(document) {
  if (document.sourceType === "custom-material") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M4 1.5h5l3 3V14a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 4 14z" fill="none" stroke="currentColor" strokeWidth="1.2" />
        <path d="M9 1.5V5h3" fill="none" stroke="currentColor" strokeWidth="1.2" />
        <path d="M5.2 10.8h1.5c.7 0 1.2-.4 1.2-1s-.5-1-1.2-1H5.2zm3.8 0H10c.9 0 1.6-.7 1.6-1.5S10.9 7.8 10 7.8H9zm-3.8 2.2V7.8m3.8 5.2V7.8" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 2.5h8a1 1 0 0 1 1 1v9.5l-2.4-1.2L8 13l-2.6-1.2L3 13V3.5a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M5.2 5.5h5.6M5.2 8h5.6" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function getFolderIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M2 5.5h5l1.5 1.8H18v7.2a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 2 14.5z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M2 6V4.7A1.7 1.7 0 0 1 3.7 3h3.6L8.5 4.4H16.3A1.7 1.7 0 0 1 18 6.1V6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

function buildStageState(progress = {}) {
  const progressPercentage = normalizePercentage(progress.progressPercentage);
  const trainingAnswers = Number(progress.trainingAnswerCount || 0);

  const study = progressPercentage >= 100
    ? { state: "done", value: "✓" }
    : progressPercentage > 0
      ? { state: "active", value: `${progressPercentage}%` }
      : { state: "idle", value: "—" };

  const practice = progress.trainingCompleted
    ? { state: "done", value: "✓" }
    : progress.trainingStarted
      ? { state: "active", value: trainingAnswers > 0 ? `${trainingAnswers} 题` : "进行中" }
      : { state: "idle", value: "—" };

  return { study, practice };
}

// 源层只许有覆盖事实（读完/收尾），不许有 per-doc 掌握态（PRODUCT §4）。
// "已掌握" 是旧标签，按"已读完"覆盖事实迁移。
function getDocumentGroup(progress = {}) {
  const progressPercentage = normalizePercentage(progress.progressPercentage);
  const learningStatus = progress.learningStatusLabel || "";

  if (
    progress.trainingCompleted
    || progress.trainingSkipped
    || learningStatus === "训练完成"
    || learningStatus === "已跳过"
    || learningStatus === "已掌握"
    || (learningStatus === "仅阅读" && progressPercentage >= 100)
  ) {
    return "finished";
  }
  if (
    progressPercentage >= 100
    || progress.trainingStarted
    || learningStatus === "训练中"
    || learningStatus === "已开启训练"
  ) {
    return "review";
  }
  if (progressPercentage > 0 || progress.isCurrent) {
    return "reading";
  }
  return "unstarted";
}

function getSignalColor(document) {
  if (document.ignored) {
    return "#888780";
  }
  if (document.group === "finished") {
    return "#1D9E75";
  }
  if (document.group === "unstarted") {
    return "#888780";
  }
  if (document.progressPercentage >= 40) {
    return "#BA7517";
  }
  return "#E27272";
}

function getSidebarMetric(document) {
  if (document.ignored) {
    return "忽略";
  }
  if (document.progressPercentage > 0) {
    return `${document.progressPercentage}%`;
  }
  return "新";
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

function getDocumentPreview(document) {
  const focus = document.folderLabels.at(-1) || document.folderLabels.at(0) || "这份资料";
  const resume = String(document.readingPreview || "").trim();
  const chapter = String(document.readingChapter || "").trim();
  if (document.ignored) {
    return "这篇已被标记为忽略，默认不进入日常学习流。需要时可以在包含忽略文档后重新打开。";
  }
  if (document.progressPercentage >= 100) {
    if (document.trainingCompleted) {
      return `正文和训练都已完成，可以回看 ${focus} 的关键内容，或继续下一份资料。`;
    }
    if (document.trainingStarted) {
      return `正文已读完，当前训练进行中；继续把 ${focus} 的关键问题练完。`;
    }
    if (document.trainingSkipped) {
      return `正文已读完，并已按仅阅读完成收尾；需要时仍可重新训练。`;
    }
    return `正文已读完，下一步适合用一轮训练确认 ${focus} 里的概念、边界和常见追问是否真的掌握。`;
  }
  if (document.progressPercentage > 0) {
    if (resume) {
      return `上次读到 ${document.progressPercentage}%${chapter ? ` · ${chapter}` : ""}：${resume}`;
    }
    return `上次读到 ${document.progressPercentage}%，可以从 ${focus} 继续读。`;
  }
  return `这篇资料聚焦 ${focus}，先抓住核心概念、典型问题和实践边界；读完后可直接进入训练确认掌握度。`;
}

function getActionHint(document) {
  return buildReentryPlan(document).reason;
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

function getPracticeStateLabel(document = {}) {
  if (document.trainingCompleted) {
    return "训练已收口";
  }
  if (document.trainingStarted) {
    return "训练进行中";
  }
  if (document.trainingSkipped) {
    return "按仅阅读收尾";
  }
  if (document.trainingAvailability === "unavailable") {
    return "当前只支持阅读";
  }
  return "还没开始训练";
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

function buildPrimaryAction(document) {
  return buildReentryPlan(document).primaryAction;
}

function isRecommendationSnoozed(document = {}) {
  const until = new Date(document.snoozedRecommendationUntil || "");
  return Number.isFinite(until.getTime()) && until.getTime() > Date.now();
}

function buildLearningHref(document, options = {}) {
  const params = new URLSearchParams();
  params.set("doc", document.path);
  if (options.intent) {
    params.set("intent", options.intent);
  }
  if (options.autostart) {
    params.set("autostart", "1");
  }
  return `/learn?${params.toString()}`;
}

// ReviewItem 跳 drill 的链接 (§4 session 回路第 2 步:Agent 拿某项 + 原文跑 drill)。
// source_ref 必须是真实 docPath(用过 /learn?doc= 进过的文档)才能跳;
// demo://、baseline-pack 出来的空 source_ref、loopassist 出来的 sourceLabel
// 当前都不可跳,返回 null,UI 显示「来源不可达」。
function buildReviewItemDrillHref(item = {}) {
  const ref = String(item.source_ref || "").trim();
  if (!ref) return null;
  // 排除非文档 scheme(demo://、rescue:// 等)。真 docPath 形如 "java/concurrency/aqs.md"。
  if (/^[a-z]+:\/\//i.test(ref)) return null;
  const params = new URLSearchParams();
  params.set("doc", ref);
  params.set("intent", "quick_review");
  params.set("autostart", "1");
  return `/learn?${params.toString()}`;
}

function flattenLibrarySegments(folderLabels = []) {
  if (!folderLabels.length) {
    return [];
  }
  if (folderLabels.length === 1) {
    return [folderLabels[0]];
  }
  return [folderLabels[0], folderLabels.slice(1).join(" / ")];
}

function encodeNodeKey(path = []) {
  if (!path.length) {
    return rootLibraryKey;
  }
  return path.map((segment) => encodeURIComponent(segment)).join("/");
}

function decodeNodeKey(key = "") {
  if (!key || key === rootLibraryKey) {
    return [];
  }
  return String(key)
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
}

function isNodeOnSelectedPath(nodePath = [], selectedPath = []) {
  if (!nodePath.length) {
    return false;
  }
  return nodePath.every((segment, index) => selectedPath[index] === segment);
}

function sortDocuments(documents = []) {
  return documents.slice().sort((left, right) => {
    if (left.path === right.path) {
      return 0;
    }
    if (left.isCurrent && !right.isCurrent) {
      return -1;
    }
    if (right.isCurrent && !left.isCurrent) {
      return 1;
    }
    const timeCompare = compareIsoTimestamp(right.lastActivityAt, left.lastActivityAt);
    if (timeCompare !== 0) {
      return timeCompare;
    }
    return left.title.localeCompare(right.title, "zh-CN");
  });
}

function aggregateFolderCounts(documents = []) {
  return documents.reduce((summary, document) => {
    if (document.group === "finished") {
      summary.finished += 1;
    } else if (document.group === "unstarted") {
      summary.unstarted += 1;
    } else {
      summary.active += 1;
    }
    return summary;
  }, { finished: 0, active: 0, unstarted: 0 });
}

function createLibraryNode({ key, label, path, level }) {
  return {
    key,
    label,
    path,
    level,
    children: [],
    directDocuments: [],
    allDocuments: [],
    documentCount: 0,
    aggregate: {
      finished: 0,
      active: 0,
      unstarted: 0,
    },
  };
}

function buildLibraryTree(documents = []) {
  const root = createLibraryNode({
    key: rootLibraryKey,
    label: "我的资料",
    path: [],
    level: -1,
  });
  const nodeMap = new Map([[root.key, root]]);

  function ensureNode(path) {
    const key = encodeNodeKey(path);
    if (nodeMap.has(key)) {
      return nodeMap.get(key);
    }

    const parentPath = path.slice(0, -1);
    const parentNode = parentPath.length ? ensureNode(parentPath) : root;
    const node = createLibraryNode({
      key,
      label: path.at(-1) || "未命名",
      path,
      level: path.length - 1,
    });
    parentNode.children.push(node);
    nodeMap.set(key, node);
    return node;
  }

  for (const document of documents) {
    const repoNode = ensureNode([document.repoLabel]);
    const branchSegments = flattenLibrarySegments(document.folderLabels);
    const deepestPath = branchSegments.length
      ? [document.repoLabel, ...branchSegments]
      : [document.repoLabel];
    const deepestNode = ensureNode(deepestPath);
    deepestNode.directDocuments.push(document);
    if (!branchSegments.length) {
      repoNode.directDocuments.push(document);
    }
  }

  function finalizeNode(node) {
    node.children.sort((left, right) => left.label.localeCompare(right.label, "zh-CN"));
    node.directDocuments = sortDocuments(
      node.level >= 0
        ? node.directDocuments.filter((document, index, items) => items.findIndex((item) => item.path === document.path) === index)
        : node.directDocuments
    );
    for (const child of node.children) {
      finalizeNode(child);
    }
    const allDocuments = sortDocuments([
      ...node.directDocuments,
      ...node.children.flatMap((child) => child.allDocuments),
    ]).filter((document, index, items) => items.findIndex((item) => item.path === document.path) === index);
    node.allDocuments = allDocuments;
    node.documentCount = allDocuments.length;
    node.aggregate = aggregateFolderCounts(allDocuments);
  }

  finalizeNode(root);
  return {
    root,
    nodeMap,
  };
}

function buildSidebarDocument(document, progressEntries = {}, options = {}) {
  const progress = progressEntries?.[document.path] || {};
  const progressPercentage = normalizePercentage(progress.progressPercentage);
  const group = getDocumentGroup({
    ...progress,
    progressPercentage,
    readingPreview: progress.readingPreview || "",
    readingChapter: progress.readingChapter || "",
  });
  const repoLabel = document.providerLabel || "未命名仓库";

  return {
    path: document.path,
    routeSlug: toRouteSlug(document.path),
    title: document.title || getTitleFromPath(document.path),
    sidebarTitle: document.title || getTitleFromPath(document.path),
    sourceType: document.sourceType || "built-in-document",
    providerLabel: document.providerLabel || "JavaGuide",
    repoLabel,
    folderLabels: document.folderLabels || [],
    libraryPath: [repoLabel, ...flattenLibrarySegments(document.folderLabels || [])],
    progressPercentage,
    learningStatusLabel: progress.learningStatusLabel || "未训练",
    readingLabel: progress.readingLabel || "未读",
    trainingStarted: Boolean(progress.trainingStarted),
    trainingCompleted: Boolean(progress.trainingCompleted),
    trainingSkipped: Boolean(progress.trainingSkipped),
    trainingAvailability: progress.trainingAvailability || "",
    trainingCheckpointProgressLabel: progress.trainingCheckpointProgressLabel || "",
    trainingAnswerCount: Number(progress.trainingAnswerCount || 0),
    assessedConceptCount: Number(progress.assessedConceptCount || 0),
    totalConceptCount: Number(progress.totalConceptCount || 0),
    evidenceCount: Number(progress.evidenceCount || 0),
    isCurrent: Boolean(progress.isCurrent),
    lastActivityAt: progress.lastActivityAt || "",
    ignored: Boolean(options.ignored),
    ignoredAt: options.ignoredAt || "",
    snoozedRecommendationUntil: options.snoozedRecommendationUntil || "",
    group,
    stageState: buildStageState(progress),
  };
}

function DocumentRow({ document, active, onSelect }) {
  const color = getSignalColor(document);

  return (
    <button
      type="button"
      className={`ll-doc-row${active ? " is-active" : ""}${document.ignored ? " is-ignored" : ""}`}
      onClick={() => onSelect(document, "status")}
      aria-pressed={active}
      data-testid={`status-doc-row-${document.routeSlug}`}
    >
      <span className="ll-doc-row-bar" style={{ background: color }} aria-hidden="true" />
      <span className="ll-doc-row-icon" style={{ color }}>
        {getTypeIcon(document)}
      </span>
      <span className="ll-doc-row-title" title={document.title}>
        {document.sidebarTitle}
        {document.ignored ? <span className="ll-ignored-chip">已忽略</span> : null}
      </span>
      <span className="ll-doc-row-value" style={{ color }}>
        {getSidebarMetric(document)}
      </span>
    </button>
  );
}

function StageChip({ label, state }) {
  const tone = state.state === "done" ? "success" : state.state === "active" ? "active" : "idle";

  return (
    <div className={`ll-stage-chip tone-${tone}`}>
      <span>{label}</span>
      <strong>{state.value}</strong>
    </div>
  );
}

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

function LibraryTreeNode({ node, currentNodeKey, selectedDocPath, selectedLibraryPath, onOpenNode }) {
  const active = currentNodeKey === node.key;
  const ancestor = isNodeOnSelectedPath(node.path, selectedLibraryPath);
  const containsSelectedDoc = Boolean(selectedDocPath) && node.allDocuments.some((document) => document.path === selectedDocPath);

  return (
    <div className="ll-tree-node">
      <button
        type="button"
        className={`ll-tree-button${active ? " is-active" : ""}${ancestor ? " is-ancestor" : ""}${containsSelectedDoc ? " has-selected-doc" : ""}`}
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
              selectedDocPath={selectedDocPath}
              selectedLibraryPath={selectedLibraryPath}
              onOpenNode={onOpenNode}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function DefaultFocusView({ featuredDocument, recommendedNewDocument, reviewDue, materialPool, hasProfile, onSnoozeRecommendation }) {
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
      <div className="ll-kicker">今天先做什么</div>
      {!hasProfile ? (
        <p className="ll-status-note">当前还没连接学习档案，先打开一篇 JavaGuide 文档，阅读与训练进度会自动回到这里。</p>
      ) : null}
      <div className="ll-hero-card">
        <span className="ll-hero-bar" style={{ background: color }} aria-hidden="true" />
        <div className="ll-hero-main">
          <div className="ll-hero-layout">
            <div className="ll-hero-body">
              <section className="ll-hero-task ll-hero-recommendation">
                <div className="ll-reentry-badge">{heroCopy.badge}</div>
                <h1 className="ll-reentry-title">{heroCopy.title}</h1>
                <p className="ll-reentry-reason">{heroCopy.reason}</p>
              </section>

              <section className="ll-hero-support-strip">
                <div className="ll-hero-context-row">
                  <span className="ll-doc-row-icon" style={{ color }}>
                    {getTypeIcon(featuredDocument)}
                  </span>
                  <div className="ll-doc-title-block">
                    <p className="ll-hero-caption">材料</p>
                    <Link href={buildLearningHref(featuredDocument)} className="ll-title-link">
                      <h2>{featuredDocument.title}</h2>
                    </Link>
                    <p>{`来源 ${featuredDocument.providerLabel} · ${featuredDocument.folderLabels.join(" / ") || "资料库"} · ${formatLastActivity(featuredDocument.lastActivityAt)}`}</p>
                  </div>
                </div>
                {recommendationFacts.length ? (
                  <div className="ll-hero-footer-row">
                    <div className="ll-recommendation-facts" aria-label="推荐依据">
                      {recommendationFacts.map((fact) => (
                        <span key={fact} className="ll-recommendation-chip">{fact}</span>
                      ))}
                    </div>
                  </div>
                ) : null}
              </section>
            </div>
            <aside className="ll-hero-cta">
              <strong className="ll-hero-score" style={{ color }}>
                {getHeroMetric(featuredDocument)}
              </strong>
              <Link href={buildLearningHref(featuredDocument, { autostart: action.autostart, intent: action.kind })} className="ll-primary-button">
                {action.label}
              </Link>
              <Link
                href={recommendedNewDocument ? buildLearningHref(recommendedNewDocument) : "/?mode=library&panel=library"}
                className="ll-secondary-button ll-hero-explore-button"
              >
                开始新的一篇 →
              </Link>
              {featuredDocument.group !== "unstarted" ? (
                <button
                  type="button"
                  className="ll-text-button"
                  onClick={() => onSnoozeRecommendation(featuredDocument)}
                >
                  {snoozeLabel}
                </button>
              ) : null}
              {reentryPlan.secondaryActions?.length ? (
                <div className="ll-reentry-secondary-links" aria-label="备选动作">
                  {reentryPlan.secondaryActions.map((secondaryAction) => (
                    <Link
                      key={`${featuredDocument.path}:${secondaryAction.kind}`}
                      href={buildLearningHref(featuredDocument, { autostart: secondaryAction.autostart, intent: secondaryAction.kind })}
                      className="ll-reentry-secondary-link"
                    >
                      {secondaryAction.label}
                    </Link>
                  ))}
                </div>
              ) : null}
            </aside>
          </div>
        </div>
      </div>

      <section className="ll-review-section">
        <div className="ll-section-head">
          <div>
            <h2>今日复习</h2>
          </div>
          <div className="ll-review-head-actions">
            <span className="ll-danger-badge">{reviewItems.length}</span>
            <span className="ll-section-hint">失败账本 · 到期复习项</span>
          </div>
        </div>
        {reviewItems.length ? (
          <ul className="ll-review-list">
            {reviewItems.map((item) => {
              const handle = item.handle || "(无标题)";
              const stateClass = `ll-state-tag ll-state-${item.state || "shaky"}`;
              const stateLabel = item.state || "shaky";
              const reDrillHref = buildReviewItemDrillHref(item);
              // 有可跳 docPath → 整行作链接;没有 → 不可点 + 一个解释 chip
              if (reDrillHref) {
                return (
                  <li key={item.id} className="ll-review-row">
                    <Link href={reDrillHref} className="ll-review-link" title={`重练:${handle}`}>
                      <span className="ll-review-dot" aria-hidden="true" />
                      <span className="ll-review-handle">{handle}</span>
                      <span className={stateClass}>{stateLabel}</span>
                    </Link>
                  </li>
                );
              }
              return (
                <li key={item.id} className="ll-review-row is-unanchored" title="来源不可达 — 这条复习项没有可跳的原文">
                  <span className="ll-review-dot" aria-hidden="true" />
                  <span className="ll-review-handle">{handle}</span>
                  <span className="ll-review-unanchored">来源不可达</span>
                  <span className={stateClass}>{stateLabel}</span>
                </li>
              );
            })}
          </ul>
        ) : (
          <article className="ll-review-empty">
            <strong>今天没有到期的复习项</strong>
            <p>做一轮 drill,答崩的点会自动出现在这里。</p>
          </article>
        )}
      </section>

      <section className="ll-new-source-section">
        <div className="ll-section-head">
          <div><h2>学点新的</h2></div>
          <div className="ll-review-head-actions">
            <span className="ll-section-hint">丢一篇进来,或从素材池挑</span>
          </div>
        </div>
        <div className="ll-new-source-row">
          <Link href="/?mode=library&panel=library" className="ll-new-source-drop">
            <span className="ll-new-source-plus" aria-hidden="true">+</span>
            <span>丢一篇进来</span>
          </Link>
          {poolItems.length ? (
            <div className="ll-pool-chips" aria-label="素材池">
              {poolItems.map((document) => (
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
          ) : (
            <p className="ll-pool-empty">素材池是空的。导入一篇,这里就会出现。</p>
          )}
        </div>
      </section>

    </section>
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

function LibraryBrowser({
  currentNode,
  selectedDocPath,
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
                active={document.path === selectedDocPath}
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

function DocumentPlaceholder({ document }) {
  const reentryPlan = buildReentryPlan(document);
  const color = getSignalColor(document);
  const action = reentryPlan.primaryAction;

  return (
    <section className="ll-detail-placeholder">
      <div className="ll-detail-header">
        <span className="ll-detail-pill">文档预览</span>
      </div>
      <div className="ll-detail-card">
        <div className="ll-detail-layout">
          <div className="ll-detail-main">
            <section className="ll-hero-task ll-detail-task">
              <div className="ll-reentry-badge">{reentryPlan.stageLabel}</div>
              <strong className="ll-reentry-title">{reentryPlan.title}</strong>
              <p className="ll-reentry-reason">{reentryPlan.reason}</p>
            </section>
            <div className="ll-detail-card-top">
              <span className="ll-doc-row-icon" style={{ color }}>
                {getTypeIcon(document)}
              </span>
              <div>
                <Link href={buildLearningHref(document)} className="ll-title-link">
                  <h2>{document.title}</h2>
                </Link>
                <p>{`来源 ${document.providerLabel} · ${document.folderLabels.join(" / ") || "资料库"} · ${formatLastActivity(document.lastActivityAt)}`}</p>
              </div>
            </div>
            <p className="ll-detail-copy">{getDocumentPreview(document)}</p>
            <div className="ll-stage-row">
              <StageChip label="学" state={document.stageState.study} />
              <StageChip label="练" state={document.stageState.practice} />
            </div>
          </div>
          <aside className="ll-detail-cta">
            <strong className="ll-detail-score" style={{ color }}>
              {getHeroMetric(document)}
            </strong>
            <Link href={buildLearningHref(document, { autostart: action.autostart, intent: action.kind })} className="ll-primary-button">
              {action.label}
            </Link>
            <span>{getActionHint(document)}</span>
            {reentryPlan.secondaryActions?.length ? (
              <div className="ll-reentry-secondary-links" aria-label="备选动作">
                {reentryPlan.secondaryActions.map((secondaryAction) => (
                  <Link
                    key={`${document.path}:${secondaryAction.kind}`}
                    href={buildLearningHref(document, { autostart: secondaryAction.autostart, intent: secondaryAction.kind })}
                    className="ll-reentry-secondary-link"
                  >
                    {secondaryAction.label}
                  </Link>
                ))}
              </div>
            ) : null}
          </aside>
        </div>
      </div>
    </section>
  );
}

export function HomePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const searchInputRef = useRef(null);
  const lastProfileSyncRef = useRef(0);

  const [userId, setUserId] = useState("");
  const [knowledgeDocuments, setKnowledgeDocuments] = useState([]);
  const [reviewDue, setReviewDue] = useState([]);
  const [profile, setProfile] = useState(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [addMaterialOpen, setAddMaterialOpen] = useState(false);
  const [includeIgnoredDocuments, setIncludeIgnoredDocuments] = useState(false);
  const [mobilePane, setMobilePane] = useState("detail");

  const deferredQuery = useDeferredValue(search.trim().toLowerCase());
  const mode = searchParams.get("mode") || "status";
  const panel = searchParams.get("panel") || (mode === "library" ? "library" : "home");
  const selectedDocPath = searchParams.get("doc") || "";
  const selectedNodeKeyParam = searchParams.get("node") || "";

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

        if (userId) {
          const nextProfile = await apiFetch(`/api/profile/${userId}`);
          setProfile(nextProfile);
          lastProfileSyncRef.current = Date.now();
        } else {
          setProfile(null);
        }

        try {
          // Today Queue「今日复习」= 失败账本按 next_due 渲染（全局，不依赖 userId）。
          const reviewPayload = await apiFetch("/api/review/today");
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
  const snoozedRecommendationDocPaths = useMemo(
    () => new Set(documentProgress?.snoozedRecommendationDocPaths || []),
    [documentProgress?.snoozedRecommendationDocPaths]
  );
  const ignoredDocumentCount = ignoredDocPaths.size;

  const allUiDocuments = useMemo(() => (
    knowledgeDocuments.map((document) => buildSidebarDocument(document, documentProgress?.docs || {}, {
      ignored: ignoredDocPaths.has(document.path),
      ignoredAt: ignoredDocs[document.path]?.ignoredAt || "",
      snoozedRecommendationUntil: documentProgress?.snoozedRecommendations?.[document.path]?.snoozedUntil || "",
    }))
  ), [documentProgress?.docs, documentProgress?.snoozedRecommendations, ignoredDocPaths, ignoredDocs, knowledgeDocuments]);

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

  const groupedDocuments = useMemo(() => ({
    reading: filteredDocuments.filter((document) => document.group === "reading"),
    review: filteredDocuments.filter((document) => document.group === "review"),
    finished: filteredDocuments.filter((document) => document.group === "finished"),
    unstarted: filteredDocuments.filter((document) => document.group === "unstarted"),
  }), [filteredDocuments]);

  const selectedDocument = uiDocuments.find((document) => document.path === selectedDocPath) || null;
  const selectedLibraryPath = selectedDocument?.libraryPath || [];

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
      || filteredDocuments.find((document) => !isRecommendationSnoozed(document))
      || candidatePool[0]
      || null;
  }, [documentProgress?.currentDocPath, documentProgress?.recentDocs, filteredDocuments, groupedDocuments, uiDocuments]);

  const recommendedNewDocument = useMemo(() => {
    const preferred = groupedDocuments.unstarted.find((document) => !snoozedRecommendationDocPaths.has(document.path));
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

  const libraryTree = useMemo(() => buildLibraryTree(filteredDocuments), [filteredDocuments]);
  const currentNodeKey = selectedNodeKeyParam || rootLibraryKey;
  const currentLibraryNode = libraryTree.nodeMap.get(currentNodeKey) || libraryTree.root;

  function replaceState(next = {}) {
    const params = new URLSearchParams(searchParams.toString());
    const nextMode = next.mode ?? mode;
    const nextPanel = next.panel ?? panel;
    const nextDoc = Object.prototype.hasOwnProperty.call(next, "doc") ? next.doc : selectedDocPath;
    const nextNode = Object.prototype.hasOwnProperty.call(next, "node") ? next.node : selectedNodeKeyParam;

    if (nextMode && nextMode !== "status") {
      params.set("mode", nextMode);
    } else {
      params.delete("mode");
    }

    if (nextPanel && !(nextMode === "status" && nextPanel === "home")) {
      params.set("panel", nextPanel);
    } else {
      params.delete("panel");
    }

    if (nextDoc) {
      params.set("doc", nextDoc);
    } else {
      params.delete("doc");
    }

    if (nextNode && nextNode !== rootLibraryKey) {
      params.set("node", nextNode);
    } else {
      params.delete("node");
    }

    startTransition(() => {
      router.replace(params.toString() ? `/?${params.toString()}` : "/", { scroll: false });
    });
  }


  function openDefaultView() {
    replaceState({
      mode: "status",
      panel: "home",
      doc: "",
    });
    setMobilePane("detail");
  }

  function openLibraryRoot() {
    replaceState({
      mode: "library",
      panel: "library",
      node: rootLibraryKey,
    });
    setMobilePane("detail");
  }

  function openLibraryNode(nodeKey) {
    replaceState({
      mode: "library",
      panel: "library",
      node: nodeKey,
    });
    setMobilePane("detail");
  }

  function openDocument(document, source = "") {
    router.push(buildLearningHref(document, {
      autostart: document.trainingStarted || document.progressPercentage >= 100,
      intent: buildReentryPlan(document).primaryAction.kind,
    }));
    setMobilePane("detail");
  }

  async function toggleIgnoredDocument(document) {
    if (!userId) {
      setLoginOpen(true);
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
      lastProfileSyncRef.current = Date.now();
    } catch (nextError) {
      setError(nextError.message);
    }
  }

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
    openDefaultView();
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
        <button type="button" className="ll-brand" onClick={openDefaultView}>
          <span className="ll-brand-mark" aria-hidden="true" />
          <span>LearningLoop</span>
        </button>
        <div className="ll-topbar-actions">
          <button type="button" className="ll-mobile-nav" onClick={() => setMobilePane((pane) => (pane === "sidebar" ? "detail" : "sidebar"))}>
            {mobilePane === "sidebar" ? "查看详情" : "资料库"}
          </button>
          <Link href="/loopassist" className="ll-interview-button">
            <span aria-hidden="true">AI</span>
            <span>LoopAssist</span>
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

      {reviewDue.length > 0 ? (
        <section className="ll-today-review" aria-label="今日复习">
          <div className="ll-today-review-head">
            <h2>今日复习</h2>
            <span className="ll-today-review-count">{reviewDue.length}</span>
            <span className="ll-today-review-hint">失败账本 · 到期</span>
          </div>
          <ul className="ll-today-review-list">
            {reviewDue.map((item) => (
              <li key={item.id} className="ll-today-review-row">
                <span className="ll-today-review-dot" aria-hidden="true" />
                <span className="ll-today-review-handle">{item.handle}</span>
                <span className={`ll-today-review-tag is-${item.state === "solid" ? "solid" : "shaky"}`}>
                  {item.state === "solid" ? "solid" : "shaky"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

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
            <button type="button" className="ll-library-entry is-active" onClick={openLibraryRoot}>
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
                selectedDocPath={selectedDocPath}
                selectedLibraryPath={selectedLibraryPath}
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

          {panel === "doc" && selectedDocument ? <DocumentPlaceholder document={selectedDocument} /> : null}

          {panel !== "doc" && mode === "library" ? (
            <LibraryBrowser
              currentNode={currentLibraryNode}
              selectedDocPath={selectedDocPath}
              includeIgnoredDocuments={includeIgnoredDocuments}
              ignoredDocumentCount={ignoredDocumentCount}
              onOpenNode={openLibraryNode}
              onOpenDocument={openDocument}
              onIncludeIgnoredChange={setIncludeIgnoredDocuments}
              onToggleIgnored={toggleIgnoredDocument}
            />
          ) : null}

          {panel !== "doc" && mode !== "library" && featuredDocument ? (
            <DefaultFocusView
              featuredDocument={featuredDocument}
              recommendedNewDocument={recommendedNewDocument}
              reviewDue={reviewDue}
              materialPool={materialPool}
              hasProfile={Boolean(profile?.user?.id)}
              onSnoozeRecommendation={snoozeFeaturedDocument}
            />
          ) : null}
        </section>
      </div>

      {addMaterialOpen ? <AddMaterialModal onClose={() => setAddMaterialOpen(false)} /> : null}
      {loginOpen ? <LoginModal onClose={() => setLoginOpen(false)} onLoginSuccess={handleLoginSuccess} /> : null}
    </main>
  );
}
