// 资料域共享：文档归组/信号色/库树构建，供首页（推荐位）与 /library 二级页共用。

export const rootLibraryKey = "root";

export const groupMeta = {
  reading: { label: "在读", defaultExpanded: true },
  review: { label: "练习中", defaultExpanded: true },
  finished: { label: "已读完", defaultExpanded: false },
  unstarted: { label: "未学", defaultExpanded: false },
};

export function compareIsoTimestamp(left = "", right = "") {
  return String(left || "").localeCompare(String(right || ""));
}

export function normalizePercentage(value) {
  const numericValue = Number(value || 0);
  if (!Number.isFinite(numericValue)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(numericValue)));
}

export function daysAgo(timestamp = "") {
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

export function formatLastActivity(timestamp = "") {
  const value = daysAgo(timestamp);
  if (value === null) {
    return "未开始";
  }
  return `上次学习 ${value <= 0 ? "今天" : `${value} 天前`}`;
}

export function getTitleFromPath(docPath = "") {
  return decodeURIComponent(String(docPath || ""))
    .split("/")
    .at(-1)
    ?.replace(/\.md$/i, "")
    .replace(/-/g, " ")
    || "未命名文档";
}

export function toRouteSlug(docPath = "") {
  return getTitleFromPath(docPath)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "document";
}

export function getTypeLabel(document) {
  if (document.sourceType === "custom-material") {
    return "资料";
  }
  return "笔记";
}

export function getTypeIcon(document) {
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

export function getFolderIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M2 5.5h5l1.5 1.8H18v7.2a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 2 14.5z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M2 6V4.7A1.7 1.7 0 0 1 3.7 3h3.6L8.5 4.4H16.3A1.7 1.7 0 0 1 18 6.1V6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

// 源层只许有覆盖事实（读完/收尾），不许有 per-doc 掌握态（PRODUCT §4）。
// "已掌握" 是旧标签，按"已读完"覆盖事实迁移。
export function getDocumentGroup(progress = {}) {
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

export function getSignalColor(document) {
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

export function getSidebarMetric(document) {
  if (document.ignored) {
    return "忽略";
  }
  if (document.progressPercentage > 0) {
    return `${document.progressPercentage}%`;
  }
  return "新";
}

export function flattenLibrarySegments(folderLabels = []) {
  if (!folderLabels.length) {
    return [];
  }
  if (folderLabels.length === 1) {
    return [folderLabels[0]];
  }
  return [folderLabels[0], folderLabels.slice(1).join(" / ")];
}

export function encodeNodeKey(path = []) {
  if (!path.length) {
    return rootLibraryKey;
  }
  return path.map((segment) => encodeURIComponent(segment)).join("/");
}

export function sortDocuments(documents = []) {
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

export function aggregateFolderCounts(documents = []) {
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

export function buildLibraryTree(documents = []) {
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

export function buildSidebarDocument(document, progressEntries = {}, options = {}) {
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
  };
}

export function buildLearningHref(document, options = {}) {
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
