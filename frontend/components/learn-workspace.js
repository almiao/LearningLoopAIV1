"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch, postEventStream, postJson } from "../lib/api";
import { readHeading, renderMarkdownContent, slugifyHeading } from "../lib/render-markdown-content";
import { getDocumentOutline, getReaderRenderer } from "../lib/document-reader-renderers";
import { TrainingGenerationPanel } from "./training-generation-panel";
import {
  getStoredUserId,
  setStoredUserId,
} from "../lib/user-session";
import { buildChatTimeline } from "../../src/view/chat-transcript";
import { buildVisibleSessionView } from "../../src/view/visible-session-view";

const profileDirtyStorageKey = "learning-loop-profile-dirty-at";
const learnPanelLayoutStorageKey = "learning-loop-learn-panel-layout-v1";
const readerZoomStorageKey = "learning-loop-reader-zoom-v1";
const minQaPanelPercent = 30;
const maxQaPanelPercent = 58;
const minReaderZoom = 70;
const maxReaderZoom = 200;
const readerZoomStep = 10;
const trainingWaitStepKeys = ["understand_question", "retrieve_source", "compose_explanation", "generate_followup"];

function clampQaPanelPercent(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return 42;
  }
  return Math.min(maxQaPanelPercent, Math.max(minQaPanelPercent, numericValue));
}

function readStoredPanelLayout() {
  if (typeof window === "undefined") {
    return {
      mode: "auto",
      qaPercent: null,
    };
  }

  try {
    const rawValue = window.localStorage.getItem(learnPanelLayoutStorageKey);
    if (!rawValue) {
      return {
        mode: "auto",
        qaPercent: null,
      };
    }

    const parsedValue = JSON.parse(rawValue);
    if (parsedValue?.mode === "manual" && Number.isFinite(parsedValue?.qaPercent)) {
      return {
        mode: "manual",
        qaPercent: clampQaPanelPercent(parsedValue.qaPercent),
      };
    }
  } catch {}

  return {
    mode: "auto",
    qaPercent: null,
  };
}

function clampReaderZoom(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return 100;
  }
  return Math.min(maxReaderZoom, Math.max(minReaderZoom, numericValue));
}

function readStoredReaderZoom() {
  if (typeof window === "undefined") {
    return 100;
  }

  try {
    const storedZoom = window.localStorage.getItem(readerZoomStorageKey);
    return storedZoom ? clampReaderZoom(storedZoom) : 100;
  } catch {}

  return 100;
}

function splitTextBlocks(value) {
  return String(value || "")
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeComparableText(value = "") {
  return String(value || "")
    .replace(/[`\-*#。：:，,！!？?\s]/g, "")
    .trim()
    .toLowerCase();
}

function isMeaningfullyDuplicate(left = "", right = "") {
  const a = normalizeComparableText(left);
  const b = normalizeComparableText(right);
  if (!a || !b) {
    return false;
  }
  return a === b || a.includes(b) || b.includes(a);
}

function patchLiveTurn(turns = [], patch = {}) {
  if (!patch?.turnId) {
    return turns;
  }
  return turns.map((turn) => (
    turn?.turnId === patch.turnId
      ? {
          ...turn,
          content: patch.content ?? turn.content ?? "",
        }
      : turn
  ));
}

function createTrainingWaitState({ submittedAnswer = "", intent = "" } = {}) {
  return {
    submittedAnswer,
    intent,
    currentStepKey: "understand_question",
    completedStepKeys: [],
    streamingText: "",
    slow: false,
    startedAt: Date.now(),
  };
}

function appendCompletedStep(completedStepKeys = [], stepKey = "") {
  if (!stepKey || completedStepKeys.includes(stepKey)) {
    return completedStepKeys;
  }
  return completedStepKeys.concat(stepKey);
}

function getNextTrainingWaitStep(stepKey = "") {
  const currentIndex = trainingWaitStepKeys.indexOf(stepKey);
  if (currentIndex < 0 || currentIndex >= trainingWaitStepKeys.length - 1) {
    return trainingWaitStepKeys[trainingWaitStepKeys.length - 1];
  }
  return trainingWaitStepKeys[currentIndex + 1];
}

function normalizeTrainingWaitStepKey(progressEvent = {}) {
  const explicitStepKey = String(progressEvent.stepKey || "").trim();
  if (trainingWaitStepKeys.includes(explicitStepKey)) {
    return explicitStepKey;
  }
  const phase = String(progressEvent.phase || "").trim();
  if (trainingWaitStepKeys.includes(phase)) {
    return phase;
  }
  if (phase === "intent" || phase === "assessment") {
    return "understand_question";
  }
  if (phase === "retrieval") {
    return "retrieve_source";
  }
  if (phase === "reply") {
    return "compose_explanation";
  }
  if (phase === "next_step") {
    return "generate_followup";
  }
  return "";
}

function getTrainingWaitCopy(submission = {}) {
  const stepKey = String(submission?.currentStepKey || "").trim();
  const hasStreamingText = Boolean(String(submission?.streamingText || "").trim());
  const explanationCompleted = (submission?.completedStepKeys || []).includes("compose_explanation");
  if (stepKey === "generate_followup" && hasStreamingText && explanationCompleted) {
    return {
      label: "正在计算下一步",
      detail: "正在落账评分与记忆，并判断继续追问、进入下一题还是收口总结。",
    };
  }
  if (hasStreamingText) {
    return {
      label: "参考讲解生成中",
      detail: "",
    };
  }
  if (stepKey === "generate_followup") {
    return {
      label: "正在组织参考讲解",
      detail: "讲解还没稳定显示前，不切换到下一步状态。",
    };
  }
  if (stepKey === "retrieve_source") {
    return {
      label: "正在对照原文依据",
      detail: "先确认这题对应的材料位置，再组织讲解。",
    };
  }
  if (stepKey === "compose_explanation") {
    return {
      label: "正在组织参考讲解",
      detail: "会先给出当前答案的关键判断，再补齐边界。",
    };
  }
  return {
    label: "正在理解你的回答",
    detail: "对齐你的回答、当前训练点和评分边界。",
  };
}

function buildDomainMap(session) {
  const conceptMap = new Map((session?.concepts || []).map((concept) => [concept.id, concept]));
  return (session?.summary?.overviewDomains || []).map((domain) => ({
    ...domain,
    items: (domain.sampleItems || []).map((title, index) => {
      const exact = (session?.concepts || []).find(
        (concept) => concept.domainId === domain.id && concept.title === title
      );
      if (exact) {
        return exact;
      }
      return {
        id: `${domain.id}:${index}`,
        title,
        domainId: domain.id,
      };
    }).concat(
      (session?.concepts || []).filter((concept) => concept.domainId === domain.id && !domain.sampleItems?.includes(concept.title))
    ).filter((concept, index, items) => items.findIndex((item) => item.id === concept.id) === index)
      .map((concept) => conceptMap.get(concept.id) || concept),
  }));
}

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

function buildLearnDocumentHref(docPath = "", options = {}) {
  const params = new URLSearchParams();
  if (docPath) {
    params.set("doc", docPath);
  }
  if (options.autostart) {
    params.set("autostart", "1");
  }
  return `/learn${params.toString() ? `?${params.toString()}` : ""}`;
}

function getAutoAdvanceDocumentAfterIgnore({
  documents = [],
  documentProgress = null,
  currentDocPath = "",
} = {}) {
  const ignoredDocPaths = new Set(documentProgress?.ignoredDocPaths || []);
  const currentIndex = Math.max(0, documents.findIndex((document) => document.path === currentDocPath));
  const candidateDocuments = documents
    .map((document, index) => {
      const progress = documentProgress?.docs?.[document.path] || null;
      const progressPercentage = Number(progress?.progressPercentage || 0);
      const trainingClosed = Boolean(
        progress?.trainingCompleted
        || progress?.trainingSkipped
        || progress?.trainingAvailability === "unavailable"
      );
      const rank = !progress || progressPercentage <= 0
        ? 0
        : progressPercentage < 100
          ? 1
          : trainingClosed
            ? 3
            : 2;
      return {
        document,
        rank,
        distance: (index - currentIndex + documents.length) % documents.length,
      };
    })
    .filter(({ document }) => document.path && document.path !== currentDocPath && !ignoredDocPaths.has(document.path));

  return candidateDocuments
    .sort((left, right) => left.rank - right.rank || left.distance - right.distance)[0]?.document || null;
}

function getSourceRefs(entity = {}) {
  return entity?.sourceRefs || entity?.documentSources || [];
}

function sessionBelongsToDocument(session, docPath = "") {
  if (!session?.sessionId) {
    return false;
  }
  if (!docPath) {
    return true;
  }
  const sourceDocPath = session.source?.metadata?.docPath || "";
  if (sourceDocPath) {
    return sourceDocPath === docPath;
  }
  return (session.trainingPoints || []).some((point) =>
    getSourceRefs(point).some((source) => source.path === docPath)
  );
}

function buildDocumentHeadings(markdown = "") {
  const lines = String(markdown || "").replace(/\r/g, "").split("\n");
  const headings = [];

  for (const line of lines) {
    const heading = readHeading(line);
    if (!heading || heading.level > 3) {
      continue;
    }
    headings.push({
      id: slugifyHeading(heading.text),
      label: heading.text,
      level: heading.level,
    });
  }

  return headings;
}

function getTrainingCtaLabel(documentProgressEntry = null) {
  if (documentProgressEntry?.trainingSkipped) {
    return "已跳过训练";
  }
  if (documentProgressEntry?.trainingCompleted) {
    return "训练已完成";
  }
  if (documentProgressEntry?.trainingAvailability === "unavailable") {
    return "暂不支持训练";
  }
  if (!documentProgressEntry?.trainingStarted) {
    return "开始训练";
  }
  const checkpointProgressLabel = String(documentProgressEntry?.trainingCheckpointProgressLabel || "").trim();
  if (checkpointProgressLabel) {
    return `继续训练（${checkpointProgressLabel}）`;
  }
  return "继续训练";
}

function buildReadingTrainingBanner({
  currentReadingCompleted = false,
  trainingStarted = false,
  trainingCompleted = false,
  trainingSkipped = false,
  trainingReadingOnly = false,
  unavailableReason = "",
} = {}) {
  if (trainingCompleted) {
    return {
      label: "训练已完成 · 查看记录",
      tone: "done",
      clickable: true,
    };
  }
  if (trainingSkipped) {
    return {
      label: "已按仅阅读完成收尾 · 重新开启训练 →",
      tone: "muted-action",
      clickable: true,
    };
  }
  if (trainingReadingOnly) {
    return {
      label: unavailableReason || "当前文档仅阅读 · 暂不支持训练",
      tone: "muted",
      clickable: false,
    };
  }
  if (trainingStarted) {
    return {
      label: "训练进行中 · 继续训练 →",
      tone: "action",
      clickable: true,
    };
  }
  if (currentReadingCompleted) {
    return {
      label: "已读完 · 开始训练 →",
      tone: "action",
      clickable: true,
    };
  }
  return {
    label: "读完后建议训练，确认是否真的掌握",
    tone: "ready",
    clickable: false,
  };
}

function buildTrainingCompletion(session = null, points = []) {
  if (!session || session.currentProbe || !points.length) {
    return null;
  }
  const checkpointIds = points.flatMap((point) => (point.checkpoints || []).map((checkpoint) => checkpoint.id));
  if (!checkpointIds.length) {
    return null;
  }
  const conceptStates = session.conceptStates || {};
  const pointStates = session.trainingPointStates || [];
  const hasCheckpointStates = checkpointIds.some((id) => conceptStates[id]);
  const states = checkpointIds.map((id) => conceptStates[id] || {});
  const completedCount = hasCheckpointStates
    ? states.filter((state) => state.completed).length
    : pointStates.reduce((sum, state) => sum + (state.completedCheckpoints || 0), 0);
  const passedCount = hasCheckpointStates
    ? states.filter((state) => state.completed && state.result === "passed").length
    : pointStates.reduce((sum, state) => sum + (state.result === "passed" ? (state.completedCheckpoints || 0) : 0), 0);
  const skippedCount = hasCheckpointStates
    ? states.filter((state) => state.result === "skipped").length
    : 0;
  const reviewCount = hasCheckpointStates
    ? states.filter((state) => state.completed && state.result !== "passed").length
    : Math.max(0, completedCount - passedCount - skippedCount);
  const reviewPoint = hasCheckpointStates
    ? points.find((point) =>
        (point.checkpoints || []).some((checkpoint) => {
          const state = conceptStates[checkpoint.id] || {};
          return state.completed && state.result !== "passed";
        })
      )
    : points.find((point) => {
        const state = pointStates.find((item) => item.pointId === point.id) || {};
        return state.completed && state.result !== "passed";
      });
  return {
    completedCount,
    passedCount,
    reviewCount,
    skippedCount,
    totalCount: checkpointIds.length,
    reviewPointId: reviewPoint?.id || "",
  };
}

const demoTrainingSummary = {
  previousMastery: 62,
  nextMastery: 78,
  completedCount: 12,
  totalCount: 12,
  averageScore: 82,
  durationMinutes: 14,
  reviewInHours: 24,
  otherReviewDocumentCount: 3,
  pointRows: [
    { id: "agent-core", title: "Agent 核心定义", scores: [90, 75] },
    { id: "agent-workflow", title: "Agent vs Workflow", scores: [95, 90] },
    { id: "agent-loop", title: "Agent Loop", scores: [55, 40] },
    { id: "context-engineering", title: "Context Engineering", scores: [78, 85] },
    { id: "tools-register", title: "Tools 注册", scores: [88, 75] },
    { id: "reasoning", title: "推理范式", scores: [62, 68] },
  ],
  weakPoints: [
    {
      id: "agent-loop",
      title: "Agent Loop",
      wrongCount: 2,
      diagnosis: "ReAct 与 Reflection 的区别没说清楚 · 感知-思考-行动循环的触发条件答偏",
      conceptId: "agent-loop",
    },
    {
      id: "reasoning",
      title: "推理范式",
      wrongCount: 1,
      diagnosis: "CoT、ToT、ReAct 的应用场景边界模糊",
      conceptId: "reasoning",
    },
  ],
  takeaways: [
    "AI Agent 核心公式 = LLM + Planning + Memory + Tools",
    "Workflow 是人在做决策，Agent 是 AI 在做决策",
    "Context Engineering 解决的是 Token 窗口下的信息管理",
    "Memory 让 Agent 能跨步骤保持上下文连续性",
    "Tools 注册决定了 Agent 能调用哪些外部能力",
  ],
};

function normalizeScore(value, fallback = 0) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }
  return Math.max(0, Math.min(100, Math.round(numericValue)));
}

function getScoreBand(score = 0) {
  const value = normalizeScore(score);
  if (value >= 90) {
    return { key: "excellent", background: "#1D9E75", color: "#FFFFFF" };
  }
  if (value >= 75) {
    return { key: "solid", background: "#97C459", color: "#0F6E56" };
  }
  if (value >= 60) {
    return { key: "partial", background: "#EF9F27", color: "#FFFFFF" };
  }
  if (value >= 40) {
    return { key: "weak", background: "#E27272", color: "#FFFFFF" };
  }
  return { key: "critical", background: "#A32D2D", color: "#FFFFFF" };
}

function getAverageScoreColor(score = 0) {
  const value = normalizeScore(score);
  if (value >= 90) {
    return "#0F6E56";
  }
  if (value < 60) {
    return "#A32D2D";
  }
  return "#63635E";
}

function uniqueStrings(items = []) {
  return Array.from(new Set(items.map((item) => String(item || "").trim()).filter(Boolean)));
}

function buildTrainingCompletionSummary({
  session = null,
  points = [],
  exchanges = [],
  documentTitle = "",
  progressEntry = null,
} = {}) {
  const pointRows = (points || []).map((point, pointIndex) => {
    const checkpointScores = (point.checkpoints || []).map((checkpoint, checkpointIndex) => {
      const state = session?.conceptStates?.[checkpoint.id] || {};
      const judgeScore = state?.judge?.score;
      const exchange = exchanges.find((item) => item.checkpointStatement === checkpoint.statement || item.checkpointStatement === checkpoint.checkpointStatement);
      return normalizeScore(judgeScore ?? exchange?.scoreSummary?.score, demoTrainingSummary.pointRows[pointIndex]?.scores?.[checkpointIndex] ?? 0);
    }).filter((score) => score > 0);
    const fallback = demoTrainingSummary.pointRows[pointIndex] || {};
    const scores = checkpointScores.length ? checkpointScores : (fallback.scores || [0, 0]);
    return {
      id: point.id || fallback.id || `point-${pointIndex}`,
      title: point.title || fallback.title || `训练点 ${pointIndex + 1}`,
      conceptIds: (point.checkpoints || []).map((checkpoint) => checkpoint.id).filter(Boolean),
      scores,
      average: scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : 0,
    };
  });

  const rows = pointRows.length ? pointRows : demoTrainingSummary.pointRows.map((row) => ({
    ...row,
    average: Math.round(row.scores.reduce((sum, score) => sum + score, 0) / row.scores.length),
    conceptIds: [row.id],
  }));
  const allScores = rows.flatMap((row) => row.scores).filter((score) => score > 0);
  const completedCount = allScores.length || demoTrainingSummary.completedCount;
  const totalCount = Math.max(
    completedCount,
    points.flatMap((point) => point.checkpoints || []).length || demoTrainingSummary.totalCount
  );
  const averageScore = allScores.length
    ? Math.round(allScores.reduce((sum, score) => sum + score, 0) / allScores.length)
    : demoTrainingSummary.averageScore;
  const timestamps = (session?.turns || []).map((turn) => Number(turn.timestamp || 0)).filter((value) => value > 0);
  const durationMinutes = timestamps.length >= 2
    ? Math.max(1, Math.round((Math.max(...timestamps) - Math.min(...timestamps)) / 60000))
    : demoTrainingSummary.durationMinutes;
  const nextMastery = normalizeScore(progressEntry?.masteryPercentage, demoTrainingSummary.nextMastery);
  const previousMastery = normalizeScore(progressEntry?.previousMasteryPercentage, Math.max(0, nextMastery - 16 || demoTrainingSummary.previousMastery));
  const weakRows = rows
    .filter((row) => row.average < 70 || row.scores.some((score) => score < 60))
    .map((row) => {
      const relatedExchanges = exchanges.filter((exchange) => row.conceptIds.includes(exchange.checkpointId) || row.title === exchange.pointTitle);
      const reasons = uniqueStrings(relatedExchanges.map((exchange) => exchange.scoreSummary?.reason || exchange.improvement));
      return {
        id: row.id,
        title: row.title,
        wrongCount: row.scores.filter((score) => score < 60).length || 1,
        diagnosis: reasons.slice(0, 2).join(" · ") || demoTrainingSummary.weakPoints.find((item) => item.id === row.id)?.diagnosis || "关键概念边界还不够稳定，需要用错题再压实一遍。",
        conceptId: row.conceptIds[0] || row.id,
      };
    });
  const takeaways = uniqueStrings([
    ...exchanges.map((exchange) => exchange.takeaway),
    ...demoTrainingSummary.takeaways,
  ]).slice(0, 8);

  return {
    documentTitle: documentTitle || "一文搞懂 AI Agent 核心概念",
    previousMastery,
    nextMastery,
    masteryDelta: Math.max(0, nextMastery - previousMastery),
    masteryGap: Math.max(0, 90 - nextMastery),
    completedCount,
    totalCount,
    averageScore,
    durationMinutes,
    pointRows: rows,
    weakPoints: weakRows.length ? weakRows : demoTrainingSummary.weakPoints,
    takeaways,
    reviewInHours: demoTrainingSummary.reviewInHours,
    otherReviewDocumentCount: demoTrainingSummary.otherReviewDocumentCount,
  };
}

function MiniIcon({ name }) {
  const common = {
    viewBox: "0 0 16 16",
    "aria-hidden": "true",
    focusable: "false",
  };
  if (name === "trend") {
    return (
      <svg {...common}>
        <path d="M2.5 11.5 6 8l2.2 2.2 4.8-5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M10 4.8h3.2V8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (name === "bookmark") {
    return (
      <svg {...common}>
        <path d="M4.5 2.5h7v11L8 11.2l-3.5 2.3z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
    );
  }
  if (name === "send") {
    return (
      <svg {...common}>
        <path d="M2.5 8.4 13.2 3 10 13l-2.4-3.5z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        <path d="M7.6 9.5 13.2 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  }
  if (name === "confetti") {
    return (
      <svg {...common}>
        <path d="m3 12 2.2-7.2L11.6 11z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        <path d="M8.8 3.2 10 2m1.2 4.3 2-.5M5.4 2.5 5.1 1" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        <path d="M5.1 8.5 7.4 6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    );
  }
  if (name === "arrow-right") {
    return (
      <svg {...common}>
        <path d="M3 8h9.5M8.8 4.3 12.5 8l-3.7 3.7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (name === "target") {
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <circle cx="8" cy="8" r="2.4" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <path d="M8 1.5v2M14.5 8h-2M8 14.5v-2M1.5 8h2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    );
  }
  if (name === "calendar") {
    return (
      <svg {...common}>
        <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <path d="M5.4 2.2v2.4M10.6 2.2v2.4M2.8 6.4h10.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        <path d="M5 9h2v2H5z" fill="currentColor" />
      </svg>
    );
  }
  if (name === "share") {
    return (
      <svg {...common}>
        <circle cx="4" cy="8" r="1.7" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <circle cx="12" cy="4" r="1.7" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <circle cx="12" cy="12" r="1.7" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <path d="m5.5 7.2 5-2.4M5.5 8.8l5 2.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    );
  }
  if (name === "book") {
    return (
      <svg {...common}>
        <path d="M3 3.2h4.1c.8 0 1.4.6 1.4 1.4v8.2c0-.8-.6-1.4-1.4-1.4H3zM13 3.2H8.9c-.8 0-1.4.6-1.4 1.4v8.2c0-.8.6-1.4 1.4-1.4H13z" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
      </svg>
    );
  }
  if (name === "list") {
    return (
      <svg {...common}>
        <path d="M5.8 4h7M5.8 8h7M5.8 12h7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        <path d="M3.1 4h.1M3.1 8h.1M3.1 12h.1" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }
  if (name === "focus") {
    return (
      <svg {...common}>
        <path d="M5.5 2.5H3.8c-.7 0-1.3.6-1.3 1.3v1.7M10.5 2.5h1.7c.7 0 1.3.6 1.3 1.3v1.7M13.5 10.5v1.7c0 .7-.6 1.3-1.3 1.3h-1.7M5.5 13.5H3.8c-.7 0-1.3-.6-1.3-1.3v-1.7" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
        <circle cx="8" cy="8" r="2" fill="none" stroke="currentColor" strokeWidth="1.35" />
      </svg>
    );
  }
  if (name === "dots") {
    return (
      <svg {...common}>
        <path d="M4 8h.1M8 8h.1M12 8h.1" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
    );
  }
  if (name === "bulb") {
    return (
      <svg {...common}>
        <path d="M5.7 11.1h4.6M6.5 13.1h3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        <path d="M10.8 7.2c0 1.1-.7 1.8-1.3 2.5H6.6c-.7-.7-1.4-1.4-1.4-2.5a2.8 2.8 0 1 1 5.6 0Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      </svg>
    );
  }
  if (name === "help") {
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <path d="M6.5 6.5A1.7 1.7 0 0 1 8.2 5c1 0 1.8.6 1.8 1.5 0 .7-.4 1.1-1.1 1.6-.5.4-.8.8-.8 1.5M8 11.6h.1" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    );
  }
  if (name === "hint") {
    return (
      <svg {...common}>
        <path d="M5.4 11.2h5.2M6.3 13.3h3.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        <path d="M10.8 7.2c0 1-.5 1.5-1.2 2.2-.4.4-.7.8-.7 1.3H7.1c0-.9.4-1.5 1-2.1.6-.6.9-.9.9-1.4 0-.7-.5-1.1-1.2-1.1-.8 0-1.3.4-1.6 1.1" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        <path d="M3.1 8a4.9 4.9 0 1 1 9.8 0" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M3 8h10M8 3v10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function getTurnTimeLabel(timestamp = "") {
  const numericTimestamp = Number(timestamp || 0);
  if (!Number.isFinite(numericTimestamp) || numericTimestamp <= 0) {
    return "刚刚";
  }
  const diffMinutes = Math.max(0, Math.floor((Date.now() - numericTimestamp) / 60000));
  if (diffMinutes < 1) {
    return "刚刚";
  }
  if (diffMinutes < 60) {
    return `${diffMinutes} 分钟前`;
  }
  return `${Math.floor(diffMinutes / 60)} 小时前`;
}

function cleanInlineMarkdown(value = "") {
  return String(value || "")
    .replace(/!\[[^\]]*]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseReadingTableCells(line = "") {
  return String(line || "")
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cleanInlineMarkdown(cell));
}

function isReadingTableDivider(line = "") {
  return /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(String(line || ""));
}

function readReadingTableBlock(lines = [], startIndex = 0) {
  const header = parseReadingTableCells(lines[startIndex]);
  const rows = [];
  let nextIndex = startIndex + 2;

  while (nextIndex < lines.length) {
    const line = String(lines[nextIndex] || "").trim();
    if (!line || !line.includes("|") || /^#{1,6}\s+/.test(line) || /^(```|~~~)/.test(line)) {
      break;
    }
    rows.push(parseReadingTableCells(line));
    nextIndex += 1;
  }

  return { header, rows, nextIndex };
}

function buildReadingBlocks(markdown = "") {
  const lines = String(markdown || "").replace(/\r/g, "").split("\n");
  const blocks = [];
  let paragraph = [];
  function flushParagraph() {
    const text = cleanInlineMarkdown(paragraph.join(" "));
    paragraph = [];
    if (!text) {
      return;
    }
    const paragraphIndex = blocks.filter((block) => block.type === "paragraph").length + 1;
    const keyPhrase = text.includes("六代关键演进")
      ? "六代关键演进"
      : /2022.+2025/.test(text)
        ? "2022 年到 2025 年"
        : "";
    blocks.push({
      id: `reading-paragraph-${paragraphIndex}`,
      type: "paragraph",
      text,
      paragraphIndex,
      important: Boolean(keyPhrase) || paragraphIndex === 4,
      keyPhrase: keyPhrase || (paragraphIndex === 4 ? "AI Agent" : ""),
    });
  }

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const rawLine = lines[lineIndex] || "";
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      continue;
    }
    if (lineIndex + 1 < lines.length && line.includes("|") && isReadingTableDivider(lines[lineIndex + 1])) {
      flushParagraph();
      const table = readReadingTableBlock(lines, lineIndex);
      blocks.push({
        id: `reading-table-${blocks.length + 1}`,
        type: "table",
        header: table.header,
        rows: table.rows,
      });
      lineIndex = table.nextIndex - 1;
      continue;
    }
    const imageMatch = line.match(/^!\[([^\]]*)]\(([^)]+)\)/);
    if (imageMatch) {
      flushParagraph();
      blocks.push({
        id: `reading-image-${blocks.length + 1}`,
        type: "image",
        alt: cleanInlineMarkdown(imageMatch[1] || "文档配图"),
        src: imageMatch[2],
      });
      continue;
    }
    const fenceMatch = line.match(/^(```|~~~)\s*([\w-]+)?/);
    if (fenceMatch) {
      flushParagraph();
      const fence = fenceMatch[1];
      const language = (fenceMatch[2] || "").trim().toLowerCase();
      const codeLines = [];
      lineIndex += 1;
      while (lineIndex < lines.length) {
        const candidate = String(lines[lineIndex] || "");
        if (candidate.trim().startsWith(fence)) {
          break;
        }
        codeLines.push(candidate);
        lineIndex += 1;
      }
      blocks.push({
        id: `reading-code-${blocks.length + 1}`,
        type: "code",
        language,
        text: codeLines.join("\n").trim(),
      });
      continue;
    }
    const headingMatch = line.match(/^(#{2,3})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      blocks.push({
        id: `reading-heading-${blocks.length + 1}`,
        type: headingMatch[1].length === 2 ? "h2" : "h3",
        text: cleanInlineMarkdown(headingMatch[2]),
      });
      continue;
    }
    if (/^[-*+]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
      flushParagraph();
      const text = cleanInlineMarkdown(line.replace(/^([-*+]|\d+\.)\s+/, ""));
      if (text) {
        const paragraphIndex = blocks.filter((block) => block.type === "paragraph").length + 1;
        blocks.push({
          id: `reading-paragraph-${paragraphIndex}`,
          type: "paragraph",
          text,
          paragraphIndex,
          important: text.includes("六代进化") || text.includes("六代关键演进"),
          keyPhrase: text.includes("六代") ? "六代" : "",
        });
      }
      continue;
    }
    if (/^```/.test(line) || /^---+$/.test(line)) {
      flushParagraph();
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  return blocks.length ? blocks : [{
    id: "reading-paragraph-1",
    type: "paragraph",
    text: "这篇文档已经进入资料库，开始阅读后会持续记录进度、重点和后续训练结果。",
    paragraphIndex: 1,
    important: false,
    keyPhrase: "",
  }];
}

function getDocumentTextForReading(document = {}) {
  return document?.learning?.markdown || document?.markdown || document?.learning?.text || "";
}

function getWordCountLabel(markdown = "") {
  const text = cleanInlineMarkdown(markdown);
  const count = text.length;
  if (count >= 10000) {
    return `${(count / 10000).toFixed(1)}w 字`;
  }
  return `${Math.max(1, Math.round(count / 1000))}k 字`;
}

function getReadingMinutes(markdown = "") {
  const count = cleanInlineMarkdown(markdown).length;
  return Math.max(1, Math.round(count / 520));
}

function buildReadingResumeContext(blocks = [], scrollRatio = 0) {
  const contentBlocks = blocks.filter((block) => block.type === "paragraph" || block.type === "h2" || block.type === "h3");
  if (!contentBlocks.length) {
    return {
      readingPreview: "",
      readingChapter: "",
    };
  }

  const safeRatio = Math.min(1, Math.max(0, Number(scrollRatio || 0)));
  const currentIndex = Math.min(contentBlocks.length - 1, Math.max(0, Math.floor(safeRatio * contentBlocks.length)));
  const currentBlock = contentBlocks[currentIndex];
  const previousHeading = contentBlocks
    .slice(0, currentIndex + 1)
    .reverse()
    .find((block) => block.type === "h2" || block.type === "h3");
  const previewSource = currentBlock?.text || previousHeading?.text || "";
  const readingPreview = cleanInlineMarkdown(previewSource).slice(0, 96);

  return {
    readingPreview,
    readingChapter: previousHeading?.text || "",
  };
}

function getSourceHost(document = {}) {
  const url = document?.source?.url || document?.originalSource?.url || "";
  if (url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {}
  }
  if (document?.providerLabel) {
    return document.providerLabel;
  }
  return "javaguide.cn";
}

function renderTextWithHighlight(text = "", phrase = "") {
  if (!phrase || !text.includes(phrase)) {
    return text;
  }
  const parts = text.split(phrase);
  return parts.flatMap((part, index) => (
    index === parts.length - 1
      ? [part]
      : [part, <mark className="reading-keyword-highlight" key={`${phrase}:${index}`}>{phrase}</mark>]
  ));
}

function getScoreTone(score = 0) {
  const numericScore = Number(score || 0);
  if (numericScore >= 90) {
    return {
      key: "solid",
      label: "完全掌握",
      background: "#F0FAF6",
      color: "#1D9E75",
    };
  }
  if (numericScore >= 50) {
    return {
      key: "partial",
      label: "部分掌握",
      background: "#FFF9F0",
      color: "#EF9F27",
    };
  }
  return {
    key: "weak",
    label: "未掌握",
    background: "#FCEBEB",
    color: "#E27272",
  };
}

function normalizeScoreSummary(scoreSummary = null) {
  if (!scoreSummary) {
    return null;
  }
  const score = Number(scoreSummary.score || 0);
  const tone = getScoreTone(score);
  return {
    ...scoreSummary,
    score,
    tone,
    label: scoreSummary.stateLabel || tone.label,
    reason: scoreSummary.judgmentReason || scoreSummary.reasons?.join("；") || "这次回答已记录，但后端没有给出更细的评分理由。",
  };
}

function extractPrefixedLine(content = "", prefix = "") {
  const normalizedPrefix = String(prefix || "").replace(/[:：]$/, "");
  return String(content || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .find((line) => line.replace(/[:：].*$/, "") === normalizedPrefix)
    ?.replace(new RegExp(`^${normalizedPrefix}[:：]\\s*`), "")
    .trim() || "";
}

function stripFeedbackPrefixes(content = "") {
  return String(content || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => !/^(回答评分|评分理由|已确认|需要校准|怎么涨分|下一步)[:：]/.test(line))
    .join("\n\n")
    .trim();
}

function buildExplanationParts(exchange = {}) {
  const feedback = exchange.feedbackTurn || {};
  const explanation = String(feedback.markdown || feedback.content || "").trim();
  const markdown = stripFeedbackPrefixes(explanation) || explanation || "这轮讲解已经生成，但没有拿到更多可展示的正文。";
  const tldr = String(feedback.tldr || feedback.takeaway || "").trim();
  return {
    tldr,
    markdown,
    // Keep the legacy fields for older support-card comparisons while the UI
    // renders the complete markdown through TrainingGenerationPanel.
    formula: tldr,
    body: markdown,
  };
}

function buildTrainingExchanges(session = null) {
  const turns = session?.turns || [];
  const exchangeMap = new Map();
  const exchangeOrder = [];
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    if (turn?.role !== "learner") {
      continue;
    }

    const previousTurns = turns.slice(0, index).reverse();
    const questionTurn = previousTurns.find((item) => item?.role === "tutor" && item.kind === "question") || null;
    const followingTurns = turns.slice(index + 1);
    const nextLearnerIndex = followingTurns.findIndex((item) => item?.role === "learner");
    const windowTurns = nextLearnerIndex >= 0 ? followingTurns.slice(0, nextLearnerIndex) : followingTurns;
    const evaluationTurn = windowTurns.find((item) => item?.role === "tutor" && item.kind === "evaluation") || null;
    const feedbackTurn = windowTurns.find((item) => item?.role === "tutor" && item.kind === "feedback" && item.action !== "complete") || null;
    const memoryTurn = windowTurns.find((item) => item?.role === "tutor" && item.kind === "memory") || null;
    const nextQuestionTurn = windowTurns.find((item) => item?.role === "tutor" && item.kind === "question") || null;
    const scoreSummary = normalizeScoreSummary(evaluationTurn?.scoreSummary || null);
    const improvement = extractPrefixedLine(evaluationTurn?.content, "怎么涨分") || feedbackTurn?.gap || "";
    const takeaway = feedbackTurn?.takeaway || extractPrefixedLine(feedbackTurn?.content, "带走一句") || scoreSummary?.keyClaim || "";
    const questionMeta = questionTurn?.questionMeta || {};
    const progress = questionMeta.trainingProgress || null;
    const nextProgress = nextQuestionTurn?.questionMeta?.trainingProgress || null;
    const exchangeKey = turn.kind === "control" && turn.action === "teach"
      ? `control:teach:${questionTurn?.checkpointId || turn.checkpointId || feedbackTurn?.checkpointId || evaluationTurn?.checkpointId || index}`
      : `turn:${turn.turnId || turn.timestamp || index}`;
    if (!exchangeMap.has(exchangeKey)) {
      exchangeOrder.push(exchangeKey);
    }

    exchangeMap.set(exchangeKey, {
      id: turn.turnId || `${turn.timestamp || index}`,
      question: questionTurn?.content || session?.currentProbe || "",
      answer: turn.content || "",
      learnerKind: turn.kind || "answer",
      learnerAction: turn.action || "",
      answeredAt: turn.timestamp || "",
      pointTitle: progress?.trainingPoint?.title || questionTurn?.conceptTitle || turn.conceptTitle || "当前训练点",
      pointIndex: progress?.trainingPoint?.currentIndex || 1,
      pointTotal: progress?.trainingPoint?.total || session?.trainingPoints?.length || 1,
      checkpointId: questionTurn?.checkpointId || turn.checkpointId || feedbackTurn?.checkpointId || evaluationTurn?.checkpointId || "",
      checkpointStatement: progress?.checkpoint?.statement || questionTurn?.checkpointStatement || "",
      checkpointIndex: progress?.checkpoint?.currentIndex || 1,
      checkpointTotal: progress?.checkpoint?.total || 1,
      scoreSummary,
      evaluationTurn,
      feedbackTurn,
      memoryText: memoryTurn?.content || "",
      improvement,
      takeaway,
      explanation: buildExplanationParts({
        feedbackTurn,
        pointTitle: progress?.trainingPoint?.title || questionTurn?.conceptTitle || "",
        checkpointStatement: progress?.checkpoint?.statement || questionTurn?.checkpointStatement || "",
        scoreSummary,
      }),
      transition: nextQuestionTurn ? {
        completedPointId: progress?.trainingPoint?.id || "",
        completedPointIndex: progress?.trainingPoint?.currentIndex || 1,
        completedPointTitle: progress?.trainingPoint?.title || questionTurn?.conceptTitle || "当前训练点",
        nextPointId: nextProgress?.trainingPoint?.id || "",
        nextPointTitle: nextProgress?.trainingPoint?.title || nextQuestionTurn.conceptTitle || "下一训练点",
        nextCheckpointStatement: nextProgress?.checkpoint?.statement || nextQuestionTurn.checkpointStatement || nextQuestionTurn.content || "",
        answeredCount: scoreSummary ? 1 : 0,
        totalCount: 1,
        minutes: Math.max(1, Math.round(((nextQuestionTurn.timestamp || Date.now()) - (questionTurn?.timestamp || turn.timestamp || Date.now())) / 60000)),
      } : null,
    });
  }
  return exchangeOrder.map((key) => exchangeMap.get(key)).filter(Boolean);
}

function getCurrentTrainingQuestion(session = null) {
  const turns = session?.turns || [];
  const questionTurn = [...turns].reverse().find((turn) => turn?.role === "tutor" && turn.kind === "question") || null;
  const meta = questionTurn?.questionMeta || session?.currentQuestionMeta || {};
  const progress = meta.trainingProgress || null;
  return {
    text: session?.currentProbe || questionTurn?.content || "",
    pointTitle: progress?.trainingPoint?.title || questionTurn?.conceptTitle || "当前训练点",
    pointIndex: progress?.trainingPoint?.currentIndex || 1,
    pointTotal: progress?.trainingPoint?.total || session?.trainingPoints?.length || 1,
    checkpointStatement: progress?.checkpoint?.statement || questionTurn?.checkpointStatement || "",
    checkpointIndex: progress?.checkpoint?.currentIndex || 1,
    checkpointTotal: progress?.checkpoint?.total || 1,
  };
}

function hasTeachExplanationForCurrentQuestion(session = null, question = null) {
  const checkpointId = question?.checkpointId || session?.currentCheckpointId || "";
  if (!checkpointId) {
    return false;
  }
  const turns = session?.turns || [];
  return turns.some((turn, index) => {
    if (turn?.role !== "learner" || turn.kind !== "control" || turn.action !== "teach" || turn.checkpointId !== checkpointId) {
      return false;
    }
    const followingTurns = turns.slice(index + 1);
    const nextLearnerIndex = followingTurns.findIndex((item) => item?.role === "learner");
    const windowTurns = nextLearnerIndex >= 0 ? followingTurns.slice(0, nextLearnerIndex) : followingTurns;
    return windowTurns.some((item) => item?.role === "tutor" && item.kind === "feedback" && item.action !== "complete" && item.checkpointId === checkpointId);
  });
}

function buildTrainingStats(session = null, currentPoint = null) {
  const point = currentPoint || null;
  const checkpointIds = new Set((point?.checkpoints || []).map((checkpoint) => checkpoint.id));
  const evaluationTurns = (session?.turns || []).filter((turn) =>
    turn?.kind === "evaluation" &&
    turn.scoreSummary &&
    (!checkpointIds.size || checkpointIds.has(turn.checkpointId))
  );
  const scores = evaluationTurns.map((turn) => Number(turn.scoreSummary.score || 0)).filter(Number.isFinite);
  const total = point?.checkpoints?.length || Math.max(1, scores.length || 1);
  const answered = Math.min(total, scores.length);
  const average = scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : 0;
  return { answered, total, average, scores };
}

function buildTrainingStatus({ isStarting, isAnswering, liveTurns, error, session, stats }) {
  if (error) {
    return {
      key: "error",
      label: "错误",
      detail: "AI 暂时不可用，10 秒后重试或重新提交。",
    };
  }
  if (isStarting) {
    return {
      key: "generating",
      label: "生成中",
      detail: "正在为你准备训练，通常需要 3–5 秒。",
    };
  }
  if (isAnswering) {
    const hasGeneratedTurn = (liveTurns || []).some((turn) => turn?.role === "tutor");
    return hasGeneratedTurn
      ? {
          key: "generating",
          label: "生成中",
          detail: "正在为你准备讲解，通常需要 3–5 秒。",
        }
      : {
          key: "thinking",
          label: "生成中",
          detail: "正在为你准备讲解，通常需要 3–5 秒。",
        };
  }
  const pointCount = session?.trainingPoints?.length || 0;
  const itemCount = (session?.trainingPoints || []).reduce((sum, point) => sum + (point.checkpoints?.length || 0), 0);
  return {
    key: "ready",
    label: "就绪",
    detail: `已拆解 ${pointCount || 0} 个训练点 · ${itemCount || stats?.total || 0} 个子项 · 等待你回答下一题`,
  };
}

function buildTrainingOverview(session = null) {
  const points = session?.trainingPoints || [];
  const states = session?.trainingPointStates || [];
  const evaluationTurns = (session?.turns || []).filter((turn) => turn?.kind === "evaluation" && turn?.scoreSummary);
  const scores = evaluationTurns
    .map((turn) => Number(turn.scoreSummary?.score || 0))
    .filter(Number.isFinite);
  const totalCheckpoints = points.reduce((sum, point) => sum + Math.max(1, point.checkpoints?.length || 0), 0);
  return {
    points,
    states,
    totalCheckpoints,
    answeredCount: Math.min(totalCheckpoints || scores.length, scores.length),
    averageScore: scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : 0,
    activePointId: session?.currentTrainingPointId || "",
  };
}

function TrainingOverviewCard({ session, currentQuestion, mastery }) {
  const overview = buildTrainingOverview(session);
  const points = overview.points;
  const states = overview.states;
  const totalPoints = points.length || currentQuestion.pointTotal || 1;
  return (
    <section className="ll-rail-card ll-training-overview-card">
      <div className="ll-training-overview-head">
        <div>
          <span className="ll-rail-card-kicker">当前进度</span>
          <h3>{`训练点 ${currentQuestion.pointIndex} / ${totalPoints}`}</h3>
        </div>
      </div>
      <div className="ll-training-overview-bars" aria-label="训练点进度">
        {(points.length ? points : Array.from({ length: totalPoints }).map((_, index) => ({ id: `placeholder-${index}` }))).map((point) => {
          const state = states.find((item) => item.pointId === point.id) || {};
          const active = point.id === overview.activePointId || (!overview.activePointId && point === points[currentQuestion.pointIndex - 1]);
          const color = state.completed ? "#1D9E75" : active ? "#534AB7" : "#DAD9D4";
          return <span key={point.id} style={{ background: color }} />;
        })}
      </div>
      <div className="ll-training-overview-metrics">
        <div>
          <span>总进度</span>
          <strong>{`${overview.answeredCount} / ${Math.max(1, overview.totalCheckpoints || 1)} 题`}</strong>
        </div>
        <div>
          <span>本轮平均</span>
          <strong>{overview.averageScore || "—"}</strong>
        </div>
        <div>
          <span>掌握度</span>
          <strong className="mastery">{`${mastery}%`}</strong>
        </div>
      </div>
    </section>
  );
}

function TrainingSnapshot({ exchange }) {
  return (
    <section className="ll-training-card ll-training-snapshot">
      <div className="ll-training-card-chip-row">
        <span className="ll-training-chip">{`训练点 ${exchange.pointIndex} · ${exchange.pointTitle}`}</span>
        <span className="ll-training-status-label">已完成</span>
      </div>
      <h2>{exchange.question}</h2>
      <p className="ll-training-question-desc">{exchange.checkpointStatement}</p>
      <div className="ll-answer-label">{`你的回答 · ${getTurnTimeLabel(exchange.answeredAt)}`}</div>
      <pre className="ll-answer-snapshot">{exchange.answer}</pre>
    </section>
  );
}

function TrainingPendingThreadCard({ question, submission, onRetryGeneration, onSkipExplanation }) {
  const submittedAnswer = String(submission?.submittedAnswer || "").trim();
  if (!question?.text || !submittedAnswer) {
    return null;
  }
  const waitCopy = getTrainingWaitCopy(submission);
  const isControlRequest = Boolean(submission?.intent);
  const focusLine = question?.checkpointStatement && question.checkpointStatement !== question.text
    ? question.checkpointStatement
    : "";
  return (
    <section className="ll-training-card ll-training-thread pending">
      <div className="ll-training-card-chip-row">
        <span className="ll-training-chip">{`训练点 ${question.pointIndex} · 子项 ${question.checkpointIndex}/${question.checkpointTotal}`}</span>
        <span className="ll-training-status-label">{isControlRequest ? "请求已发送" : "回答已发送"}</span>
      </div>
      <h2>{question.text}</h2>
      {focusLine ? (
        <div className="ll-thread-context-row">
          <span>目标</span>
          <p>{focusLine}</p>
        </div>
      ) : null}
      {isControlRequest ? (
        <div className="ll-thread-request-inline">
          <span>已选择</span>
          <strong>{submittedAnswer}</strong>
          <em>刚刚</em>
        </div>
      ) : (
        <div className="ll-thread-message user">
          <div className="ll-answer-label">你的回答 · 刚刚</div>
          <pre className="ll-answer-snapshot">{submittedAnswer}</pre>
        </div>
      )}
      <div className="ll-thread-message assistant pending explanation">
        <TrainingGenerationPanel
          embedded
          streamingText={submission.streamingText}
          label={waitCopy.label}
          statusDetail={waitCopy.detail}
          slow={submission.slow}
          onRetry={onRetryGeneration}
          onSkip={onSkipExplanation}
          testId={submission.streamingText ? "training-streaming-card" : "training-waiting-card"}
        />
      </div>
    </section>
  );
}

function TrainingThreadCard({ exchange }) {
  const isControlRequest = exchange.learnerKind === "control";
  const focusLine = exchange.checkpointStatement && exchange.checkpointStatement !== exchange.question
    ? exchange.checkpointStatement
    : "";
  const supportItems = [
    exchange.improvement ? { key: "improve", title: "怎么涨分", body: exchange.improvement, tone: "improve" } : null,
    exchange.takeaway && !isMeaningfullyDuplicate(exchange.takeaway, exchange.explanation.formula)
      ? { key: "takeaway", title: "带走一句", body: exchange.takeaway, tone: "takeaway" }
      : null,
  ].filter(Boolean);
  return (
    <section className="ll-training-card ll-training-thread">
      <div className="ll-training-card-chip-row">
        <span className="ll-training-chip">{`训练点 ${exchange.pointIndex} · ${exchange.pointTitle}`}</span>
        <span className="ll-training-status-label">已完成</span>
      </div>
      <h2>{exchange.question}</h2>
      {focusLine ? (
        <div className="ll-thread-context-row">
          <span>目标</span>
          <p>{focusLine}</p>
        </div>
      ) : null}
      {isControlRequest ? (
        <div className="ll-thread-request-inline">
          <span>已选择</span>
          <strong>{exchange.answer}</strong>
          <em>{getTurnTimeLabel(exchange.answeredAt)}</em>
        </div>
      ) : (
        <div className="ll-thread-message user">
          <div className="ll-answer-label">{`你的回答 · ${getTurnTimeLabel(exchange.answeredAt)}`}</div>
          <pre className="ll-answer-snapshot">{exchange.answer}</pre>
        </div>
      )}
      <div className="ll-thread-message assistant explanation">
        <TrainingGenerationPanel
          embedded
          complete
          markdown={exchange.explanation.markdown || exchange.explanation.body}
          testId="training-ready-explanation-card"
        />
      </div>
      {exchange.explanation.tldr ? (
        <div className="ll-thread-message assistant tldr" data-testid="training-ready-tldr-card">
          <div className="ll-training-generation-section-title success">
            <span className="ll-training-generation-section-dot" aria-hidden="true" />
            <span>AI 提炼一句</span>
          </div>
          <p className="ll-thread-tldr-text">{exchange.explanation.tldr}</p>
        </div>
      ) : null}
      {exchange.scoreSummary ? (
        <div
          className={`ll-thread-score-summary tone-${exchange.scoreSummary.tone.key}`}
          style={{
            "--thread-score-color": exchange.scoreSummary.tone.color,
            "--thread-score-bg": exchange.scoreSummary.tone.background,
          }}
        >
          <div className="ll-thread-score-main">
            <strong>{`回答评分 ${exchange.scoreSummary.score}`}</strong>
            <span>{exchange.scoreSummary.label}</span>
          </div>
          {exchange.scoreSummary.reason ? <p>{exchange.scoreSummary.reason}</p> : null}
        </div>
      ) : null}
      {supportItems.length ? (
        <div className="ll-thread-support-grid">
          {supportItems.map((item) => (
            <article key={item.key} className={`ll-thread-support-card ${item.tone}`}>
              <strong>{item.title}</strong>
              <p>{item.body}</p>
            </article>
          ))}
        </div>
      ) : null}
      <RememberedContent text={exchange.memoryText} />
      <TrainingTransition transition={exchange.transition} />
    </section>
  );
}

function RememberedContent({ text }) {
  const [open, setOpen] = useState(false);
  if (!text) {
    return null;
  }
  return (
    <section className="ll-remembered-block">
      <button type="button" onClick={() => setOpen((value) => !value)}>
        <span>{`已记住的内容(系统会基于这些追问) ${open ? "▾" : "▸"}`}</span>
      </button>
      {open ? <p>{text}</p> : null}
    </section>
  );
}

function TrainingTransition({ transition }) {
  if (!transition) {
    return null;
  }
  const samePoint = transition.completedPointId && transition.nextPointId && transition.completedPointId === transition.nextPointId;
  return (
    <section className="ll-training-transition">
      <p>{`✓ 训练点 ${transition.completedPointIndex} 完成 · 答对 ${transition.answeredCount}/${transition.totalCount} · 用时 ${transition.minutes} 分钟`}</p>
      <div>
        <span>{samePoint ? "继续当前训练点" : "下一个训练点"}</span>
        <strong>{samePoint ? transition.nextCheckpointStatement : transition.nextPointTitle}</strong>
        {!samePoint && transition.nextCheckpointStatement ? <p>{transition.nextCheckpointStatement}</p> : null}
      </div>
    </section>
  );
}

function NextQuestionCard({ question, answer, setAnswer, isAnswering, onSubmit, onExplain }) {
  if (!question.text) {
    return (
      <section className="ll-training-card ll-next-question">
        <div className="ll-training-chip">训练已收口</div>
        <h2>当前没有新的题目。</h2>
        <p className="ll-training-question-desc">可以回到阅读页，或稍后从薄弱点重新训练。</p>
      </section>
    );
  }
  return (
    <section className="ll-training-card ll-next-question" data-testid="training-next-question">
      <div className="ll-training-card-chip-row">
        <span className="ll-training-chip">{`训练点 ${question.pointIndex} · 子项 ${question.checkpointIndex}/${question.checkpointTotal}`}</span>
      </div>
      <h2>{question.text}</h2>
      <form
        className="ll-next-answer-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <textarea
          rows="4"
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          placeholder="写下你的理解。"
        />
        <div className="ll-next-answer-actions">
          <button type="button" className="ll-tool-button" onClick={onExplain}>
            查看解析
          </button>
          <button type="submit" className="ll-training-primary" disabled={isAnswering || !answer.trim()}>
            提交回答
          </button>
        </div>
      </form>
    </section>
  );
}

function TrainingAssistantRail({ session, currentQuestion, stats, mastery, onAsk, sideQuestion, setSideQuestion, isAnswering, awaitingExplanation = false }) {
  const prompts = ["这道题在考什么?", "原文哪一段讲到这个?", "跟上一题关联在哪?", "先看看正确答案"];
  return (
    <aside className="ll-training-rail" data-testid="qa-panel">
      <TrainingOverviewCard session={session} currentQuestion={currentQuestion} mastery={mastery} />
      <section className="ll-rail-card">
        <h3>本训练点表现</h3>
        <div className="ll-performance-number">
          <strong>{stats.answered}</strong>
          <span>{`/ ${stats.total} 题`}</span>
          <em>{`平均 ${stats.average || "—"}`}</em>
        </div>
        <div className="ll-performance-bars">
          {Array.from({ length: stats.total }).map((_, index) => {
            const score = stats.scores[index] || 0;
            const color = score >= 85 ? "#1D9E75" : score > 0 ? "#EF9F27" : "#E8E6DC";
            return <span key={index} style={{ background: color }} />;
          })}
        </div>
      </section>
      <section className={`ll-rail-card${awaitingExplanation ? " pending" : ""}`}>
        <h3>这道题想聊聊</h3>
        {awaitingExplanation ? <p>讲解还在生成，等内容到位后再继续追问会更顺。</p> : null}
        <div className="ll-rail-prompts">
          {prompts.map((prompt) => (
            <button key={prompt} type="button" disabled={awaitingExplanation} onClick={() => onAsk(prompt)}>
              {prompt}
            </button>
          ))}
        </div>
      </section>
      <form
        className={`ll-rail-input${awaitingExplanation ? " pending" : ""}`}
        onSubmit={(event) => {
          event.preventDefault();
          const value = sideQuestion.trim();
          if (!value || awaitingExplanation) {
            return;
          }
          onAsk(value);
          setSideQuestion("");
        }}
      >
        <input
          value={sideQuestion}
          onChange={(event) => setSideQuestion(event.target.value)}
          placeholder={awaitingExplanation ? "讲解生成完成后可继续追问..." : "自由追问..."}
          disabled={awaitingExplanation}
        />
        <button type="submit" disabled={awaitingExplanation || isAnswering || !sideQuestion.trim()} aria-label="发送追问">
          <MiniIcon name="send" />
        </button>
      </form>
    </aside>
  );
}

function TrainingWorkspace({
  documentTitle,
  mastery,
  session,
  exchanges,
  currentQuestion,
  stats,
  answer,
  setAnswer,
  sideQuestion,
  setSideQuestion,
  isAnswering,
  trainingWaitState,
  isPreparingTraining,
  onSubmit,
  onAsk,
  onExplain,
  onRetryGeneration,
  onSkipExplanation,
  onBackToReading,
  currentQuestionHasTeachExplanation = false,
}) {
  const shouldShowNextQuestion = Boolean(currentQuestion.text) || !isPreparingTraining;
  const awaitingExplanation = Boolean(trainingWaitState);
  return (
    <main className="learn-shell ll-training-page" data-testid="learn-shell">
      <header className="ll-training-topbar">
        <div className="ll-training-title">
          <Link href="/" className="ll-training-back">‹</Link>
          <h1>{documentTitle}</h1>
        </div>
        <div className="ll-training-tabs">
          <button type="button" onClick={onBackToReading}>阅读</button>
          <button type="button" className="active">训练</button>
        </div>
      </header>
      <section className="ll-training-main">
        <div className="ll-training-flow">
          {isPreparingTraining ? (
            <article className="ll-training-card ll-training-prep" data-testid="training-prep-card">
              <div className="ll-training-chip">训练准备</div>
              <h2>正在准备训练</h2>
              <p>正在拆解这篇文档的训练点，并准备第一道诊断题。</p>
            </article>
          ) : null}
          {exchanges.map((exchange) => (
            <article key={exchange.id} className="ll-training-exchange">
              <TrainingThreadCard exchange={exchange} />
            </article>
          ))}
          {awaitingExplanation ? (
            <TrainingPendingThreadCard
              question={currentQuestion}
              submission={trainingWaitState}
              onRetryGeneration={onRetryGeneration}
              onSkipExplanation={onSkipExplanation}
            />
          ) : null}
          {!awaitingExplanation && shouldShowNextQuestion && !currentQuestionHasTeachExplanation ? (
            <NextQuestionCard
              question={currentQuestion}
              answer={answer}
              setAnswer={setAnswer}
              isAnswering={isAnswering}
              onSubmit={onSubmit}
              onExplain={onExplain}
            />
          ) : null}
        </div>
        <TrainingAssistantRail
          session={session}
          currentQuestion={currentQuestion}
          stats={stats}
          mastery={mastery}
          onAsk={onAsk}
          sideQuestion={sideQuestion}
          setSideQuestion={setSideQuestion}
          isAnswering={isAnswering}
          awaitingExplanation={awaitingExplanation}
        />
      </section>
    </main>
  );
}

function AnimatedMasteryValue({ from, to, onComplete }) {
  const [value, setValue] = useState(from);

  useEffect(() => {
    let frameId = 0;
    const startedAt = performance.now();
    const duration = 1500;
    function tick(now) {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      setValue(Math.round(from + (to - from) * eased));
      if (progress < 1) {
        frameId = window.requestAnimationFrame(tick);
      } else {
        onComplete?.();
      }
    }
    frameId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frameId);
  }, [from, onComplete, to]);

  return (
    <strong className="ll-summary-new-value">
      {value}
      <span>%</span>
    </strong>
  );
}

function TrainingSummaryHero({ summary }) {
  const [deltaVisible, setDeltaVisible] = useState(false);
  return (
    <section className="ll-summary-hero">
      <div className="ll-summary-chip">
        <MiniIcon name="confetti" />
        本轮训练完成
      </div>
      <p>这份文档的掌握度</p>
      <div className="ll-summary-mastery-row">
        <span className="ll-summary-old-value">{summary.previousMastery}%</span>
        <MiniIcon name="arrow-right" />
        <AnimatedMasteryValue from={summary.previousMastery} to={summary.nextMastery} onComplete={() => setDeltaVisible(true)} />
        <span className={deltaVisible ? "ll-summary-delta visible" : "ll-summary-delta"}>{`+${summary.masteryDelta}`}</span>
      </div>
      <small>{`距离掌握(90%)还差 ${summary.masteryGap} 分 · 通常 1 轮训练能补上`}</small>
    </section>
  );
}

function TrainingSummaryMetricGrid({ summary }) {
  const metrics = [
    { label: "完成", value: `${summary.completedCount} / ${summary.totalCount}`, unit: "题" },
    { label: "平均分", value: summary.averageScore, unit: "分", color: getAverageScoreColor(summary.averageScore) },
    { label: "用时", value: summary.durationMinutes, unit: "分钟" },
  ];
  return (
    <section className="ll-summary-metrics">
      {metrics.map((metric) => (
        <article key={metric.label}>
          <span>{metric.label}</span>
          <strong style={{ color: metric.color || "#191917" }}>{metric.value}</strong>
          <em>{metric.unit}</em>
        </article>
      ))}
    </section>
  );
}

function TrainingPointDistribution({ rows }) {
  return (
    <section className="ll-summary-section ll-summary-distribution">
      <h2>{`${rows.length} 个训练点分布`}</h2>
      <div className="ll-summary-point-list">
        {rows.map((row) => (
          <div key={row.id} className="ll-summary-point-row">
            <strong>{row.title}</strong>
            <div className="ll-summary-score-blocks">
              {row.scores.map((score, index) => {
                const band = getScoreBand(score);
                return (
                  <span key={`${row.id}:${index}`} style={{ background: band.background, color: band.color }}>
                    {score}
                  </span>
                );
              })}
            </div>
            <em>{`${row.average} 分`}</em>
          </div>
        ))}
      </div>
    </section>
  );
}

function WeakPointActions({ weakPoints, onReviewWeakPoint }) {
  return (
    <section className="ll-summary-weak">
      <h2>
        <MiniIcon name="target" />
        {`${weakPoints.length} 处明显薄弱，系统已加入复习队列`}
      </h2>
      <div className="ll-summary-weak-list">
        {weakPoints.map((point) => (
          <article key={point.id} className="ll-summary-weak-card">
            <div>
              <strong>{point.title}</strong>
              <span>{`答错 ${point.wrongCount} 题`}</span>
              <p>{point.diagnosis}</p>
            </div>
            <button type="button" onClick={() => onReviewWeakPoint(point.conceptId)}>
              立即重练
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}

function TakeawayCards({ takeaways }) {
  const [expanded, setExpanded] = useState(false);
  const visibleItems = expanded ? takeaways : takeaways.slice(0, 3);
  return (
    <section className="ll-summary-section ll-summary-takeaways">
      <div className="ll-summary-section-head">
        <h2>本轮带走的</h2>
        <span>{`${takeaways.length} 张知识卡片 · 会出现在未来复习中`}</span>
      </div>
      <div className="ll-summary-takeaway-grid">
        {visibleItems.map((item) => (
          <article key={item}>
            <MiniIcon name="bookmark" />
            <p>{item}</p>
          </article>
        ))}
      </div>
      {takeaways.length > 3 ? (
        <button type="button" className="ll-summary-expand" onClick={() => setExpanded((value) => !value)}>
          {expanded ? "收起知识卡片 ▴" : `展开全部 ${takeaways.length} 张 ▾`}
        </button>
      ) : null}
    </section>
  );
}

function TomorrowReviewBanner({ summary, onReviewPlan, onDismiss }) {
  return (
    <section className="ll-summary-tomorrow">
      <div className="ll-summary-calendar">
        <MiniIcon name="calendar" />
      </div>
      <div>
        <h2>明天还有事</h2>
        <p>{`${summary.weakPoints.length} 处薄弱点会在 ${summary.reviewInHours} 小时后再来一次，趁记忆新鲜补上 · 另有 ${summary.otherReviewDocumentCount} 份其他文档到了复习周期`}</p>
        <div>
          <button type="button" onClick={onReviewPlan}>查看复习计划</button>
          <button type="button" onClick={onDismiss}>关闭提醒</button>
        </div>
      </div>
    </section>
  );
}

function TrainingSharePanel({ summary, onClose }) {
  return (
    <div className="ll-summary-share-backdrop" role="presentation" onClick={onClose}>
      <section className="ll-summary-share-panel" role="dialog" aria-modal="true" aria-label="分享成绩" onClick={(event) => event.stopPropagation()}>
        <div className="ll-summary-section-head">
          <h2>分享成绩</h2>
          <button type="button" onClick={onClose}>关闭</button>
        </div>
        <div className="ll-summary-share-card">
          <span>{summary.documentTitle}</span>
          <strong>{`掌握度 ${summary.previousMastery}% → ${summary.nextMastery}%`}</strong>
          <p>{summary.takeaways.slice(0, 3).join(" / ")}</p>
        </div>
        <p>分享内容只展示你的学习成果，不包含产品宣传。</p>
      </section>
    </div>
  );
}

function TrainingCompletionSummaryPage({
  summary,
  onBackToReading,
  onReviewWeakPoint,
  onReviewPlan,
  onHome,
  onNextDocument,
}) {
  const [shareOpen, setShareOpen] = useState(false);
  const [tomorrowVisible, setTomorrowVisible] = useState(true);
  return (
    <main className="learn-shell ll-training-summary-page" data-testid="training-completion-summary">
      <header className="ll-summary-topbar">
        <button type="button" aria-label="返回" onClick={onBackToReading}>‹</button>
        <h1>{summary.documentTitle}</h1>
        <span>训练完成</span>
      </header>
      <div className="ll-summary-body">
        <TrainingSummaryHero summary={summary} />
        <TrainingSummaryMetricGrid summary={summary} />
        <TrainingPointDistribution rows={summary.pointRows} />
        <WeakPointActions weakPoints={summary.weakPoints} onReviewWeakPoint={onReviewWeakPoint} />
        <TakeawayCards takeaways={summary.takeaways} />
        {tomorrowVisible ? (
          <TomorrowReviewBanner
            summary={summary}
            onReviewPlan={onReviewPlan}
            onDismiss={() => setTomorrowVisible(false)}
          />
        ) : null}
        <footer className="ll-summary-actions">
          <div>
            <button type="button" onClick={onBackToReading}>查看完整记录</button>
            <button type="button" onClick={() => setShareOpen(true)}>
              <MiniIcon name="share" />
              分享成绩
            </button>
          </div>
          <div>
            <button type="button" className="ll-summary-secondary" onClick={onHome}>回首页</button>
            <button type="button" className="ll-summary-primary" onClick={onNextDocument}>继续学下一份 →</button>
          </div>
        </footer>
      </div>
      {shareOpen ? <TrainingSharePanel summary={summary} onClose={() => setShareOpen(false)} /> : null}
    </main>
  );
}

function ReadingSelectionPopover({ popover, onAsk, onQuiz, onSave, onHighlight, onClose }) {
  if (!popover?.visible) {
    return null;
  }
  return (
    <section
      className="reading-selection-popover"
      style={{ left: popover.x, top: popover.y }}
      data-testid="reading-selection-popover"
    >
      <div className="reading-selection-chip">划线段落 · 选择操作</div>
      <div className="reading-selection-actions">
        <button type="button" className="primary" onClick={onAsk}>AI 解释</button>
        <button type="button" onClick={onQuiz}>出题考我</button>
        <button type="button" onClick={onSave}>记下来</button>
        <button type="button" onClick={onHighlight}>高亮</button>
      </div>
      <button type="button" className="reading-selection-close" aria-label="关闭划线操作" onClick={onClose}>×</button>
    </section>
  );
}

function ReadingDocumentContent({
  document,
  blocks,
  readProgress,
  highlightedParagraphId,
  userHighlightedParagraphIds,
  onParagraphAction,
  onBookmark,
}) {
  const markdown = getDocumentTextForReading(document);
  const readingMinutes = getReadingMinutes(markdown);
  const remainingMinutes = Math.max(1, Math.round(readingMinutes * (1 - readProgress / 100)));
  const headings = blocks.filter((block) => block.type === "h2" || block.type === "h3");
  const currentChapter = headings[Math.min(headings.length - 1, Math.max(0, Math.floor((readProgress / 100) * headings.length)))]?.text || "前言";

  return (
    <article className="document-surface reading-document-surface" data-testid="document-surface">
      <div className="reading-doc-meta">
        <span>来源<br />{getSourceHost(document)}</span>
        <span>{getWordCountLabel(markdown)} · 约 {readingMinutes} 分钟</span>
        <span>已读<br /><strong>{readProgress}%</strong></span>
        <span>继续读 {remainingMinutes} 分钟</span>
      </div>
      <div className="reading-document-flow">
        {blocks.map((block) => {
          if (block.type === "h2" || block.type === "h3") {
            const Heading = block.type;
            return <Heading key={block.id} id={slugifyHeading(block.text)}>{block.text}</Heading>;
          }
          if (block.type === "image") {
            return (
              <img
                key={block.id}
                className="markdown-image reading-document-image"
                src={block.src}
                alt={block.alt}
                loading="lazy"
              />
            );
          }
          if (block.type === "code") {
            const isMermaid = block.language === "mermaid";
            return (
              <figure key={block.id} className={isMermaid ? "reading-code-block is-mermaid-source" : "reading-code-block"}>
                {isMermaid ? <figcaption>Mermaid 图表暂以源码显示</figcaption> : null}
                <pre className="markdown-pre">
                  <code data-language={block.language || undefined}>{block.text}</code>
                </pre>
              </figure>
            );
          }
          if (block.type === "table") {
            const columnCount = Math.max(block.header.length, ...block.rows.map((row) => row.length));
            return (
              <div key={block.id} className="markdown-table-wrap reading-document-table">
                <table className="markdown-table">
                  <thead>
                    <tr>
                      {Array.from({ length: columnCount }).map((_, cellIndex) => (
                        <th key={`${block.id}-head-${cellIndex}`}>{block.header[cellIndex] || ""}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr key={`${block.id}-row-${rowIndex}`}>
                        {Array.from({ length: columnCount }).map((_, cellIndex) => (
                          <td key={`${block.id}-cell-${rowIndex}-${cellIndex}`}>{row[cellIndex] || ""}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          }
          const isHighlighted = highlightedParagraphId === block.id || userHighlightedParagraphIds.includes(block.id);
          return (
            <p
              key={block.id}
              id={block.id}
              className={[
                "reading-paragraph",
                block.important ? "is-ai-highlighted" : "",
                isHighlighted ? "is-user-highlighted" : "",
                highlightedParagraphId === block.id ? "is-citation-flash" : "",
              ].filter(Boolean).join(" ")}
              data-reading-paragraph={block.id}
              onClick={(event) => {
                if (block.important) {
                  const rect = event.currentTarget.getBoundingClientRect();
                  onParagraphAction({
                    visible: true,
                    x: Math.min(window.innerWidth - 320, Math.max(18, rect.left + 18)),
                    y: Math.min(window.innerHeight - 132, Math.max(72, rect.bottom + 10)),
                    text: block.text,
                    paragraphId: block.id,
                  });
                }
              }}
            >
              {renderTextWithHighlight(block.text, block.keyPhrase)}
            </p>
          );
        })}
      </div>
      <footer className="reading-chapter-footer">
        <span>{`第 ${Math.max(1, Math.round((readProgress / 100) * Math.max(1, headings.length)))} 章 · ${currentChapter}`}</span>
        <button type="button" onClick={onBookmark}>
          <MiniIcon name="bookmark" />
          记住这里，下次继续
        </button>
      </footer>
    </article>
  );
}

function CitationButton({ value, onClick }) {
  return (
    <sup>
      <button type="button" className="reading-citation" onClick={() => onClick(value)}>
        {value}
      </button>
    </sup>
  );
}

function normalizeAssistantMarkdown(value = "") {
  return String(value || "")
    .replace(/\s+(#{1,4}\s+)/g, "\n\n$1")
    .replace(/\s+(-{3,})\s+/g, "\n\n$1\n\n")
    .replace(/\s+(-\s+\*\*)/g, "\n$1")
    .replace(/\s+(\d+\.\s+\*\*)/g, "\n$1")
    .trim();
}

function ReadingAssistantBubble({ entry, onCitationClick }) {
  if (entry.role === "assistant") {
    return (
      <article className={`message-card assistant reading-ai-message ${entry.isProgressUpdate ? "progress-update" : ""}`}>
        {!entry.isProgressUpdate ? <div className="reading-message-meta">AI</div> : null}
        <div className={`message-body ${entry.body ? "markdown-content" : ""}`}>
          {entry.body ? (
            renderMarkdownContent(normalizeAssistantMarkdown(entry.body), `${entry.id || "reading-ai"}-assistant`)
          ) : (
            <p>
              本质区别在于 <mark>推理框架的引入</mark>。第二代依赖人类逐步提示，第三代通过 ReAct 框架让 Agent 自主完成“思考-行动-观察”循环
              <CitationButton value={2} onClick={onCitationClick} />
              ，实现了自治能力的关键跃迁
              <CitationButton value={5} onClick={onCitationClick} />。
            </p>
          )}
        </div>
      </article>
    );
  }
  return (
    <article className="message-card learner reading-user-message">
      <div className="reading-message-meta">你 · 2 分钟前</div>
      <div className="message-body">
        {(entry.bodyParts?.length ? entry.bodyParts : [entry.body]).filter(Boolean).map((block, index) => (
          <p key={`${entry.id || "message"}:${index}`}>{block}</p>
        ))}
      </div>
    </article>
  );
}

export function LearnWorkspace() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const focusParamEnabled = searchParams.get("focus") === "1";
  const autostartRef = useRef(false);
  const conceptFocusRef = useRef("");
  const readingProgressRef = useRef("");
  const progressDocumentPathRef = useRef("");
  const trainingAnswerStreamAbortRef = useRef(null);
  const readerBodyRef = useRef(null);
  const qaScrollRef = useRef(null);
  const studyMainRef = useRef(null);
  const composerInputRef = useRef(null);
  const [profile, setProfile] = useState(null);
  const [knowledgeDocuments, setKnowledgeDocuments] = useState([]);
  const [interactionPreference, setInteractionPreference] = useState("balanced");
  const [session, setSession] = useState(null);
  const [answer, setAnswer] = useState("");
  const [sideQuestion, setSideQuestion] = useState("");
  const [pendingSubmittedAnswer, setPendingSubmittedAnswer] = useState("");
  const [error, setError] = useState("");
  const [isStarting, setIsStarting] = useState(false);
  const [sessionStartMode, setSessionStartMode] = useState("reading");
  const [isAnswering, setIsAnswering] = useState(false);
  const [readingStreamingTurn, setReadingStreamingTurn] = useState(null);
  const [liveTrainingTurns, setLiveTrainingTurns] = useState([]);
  const [trainingWaitState, setTrainingWaitState] = useState(null);
  const [readingChatTimeline, setReadingChatTimeline] = useState([]);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [knowledgeDoc, setKnowledgeDoc] = useState(null);
  const [readerSourceView, setReaderSourceView] = useState("learning");
  const [docLoading, setDocLoading] = useState(false);
  const [docError, setDocError] = useState("");
  const [workspaceMode, setWorkspaceMode] = useState("reading");
  const [trainingUnlocked, setTrainingUnlocked] = useState(false);
  const [focusMode, setFocusMode] = useState(focusParamEnabled);
  const [focusQaOpen, setFocusQaOpen] = useState(false);
  const [readerZoom, setReaderZoom] = useState(100);
  const [panelLayout, setPanelLayout] = useState({
    mode: "auto",
    qaPercent: null,
  });
  const [panelLayoutLoaded, setPanelLayoutLoaded] = useState(false);
  const [isDraggingLayout, setIsDraggingLayout] = useState(false);
  const [isComposerFocused, setIsComposerFocused] = useState(false);
  const [sessionIdCopied, setSessionIdCopied] = useState(false);
  const [summaryDismissed, setSummaryDismissed] = useState(false);
  const [readProgressPercent, setReadProgressPercent] = useState(0);
  const [selectionPopover, setSelectionPopover] = useState({ visible: false, x: 0, y: 0, text: "", paragraphId: "" });
  const [highlightedParagraphId, setHighlightedParagraphId] = useState("");
  const [userHighlightedParagraphIds, setUserHighlightedParagraphIds] = useState([]);
  const [readerMoreOpen, setReaderMoreOpen] = useState(false);
  const [readingPerspective, setReadingPerspective] = useState("面试准备");
  const [locallySkippedTrainingPaths, setLocallySkippedTrainingPaths] = useState([]);
  const deferredSession = useDeferredValue(session);
  const visibleView = buildVisibleSessionView(deferredSession || {});
  const chatTimeline = visibleView.chatTimeline || [];
  const visibleChatTimeline = useMemo(() => {
    if (trainingUnlocked) {
      return chatTimeline;
    }
    const firstUserIndex = chatTimeline.findIndex((entry) => entry.role === "user");
    if (firstUserIndex < 0) {
      return [];
    }
    return chatTimeline.slice(firstUserIndex);
  }, [chatTimeline, trainingUnlocked]);

  useEffect(() => {
    setPanelLayout(readStoredPanelLayout());
    setReaderZoom(readStoredReaderZoom());
    setPanelLayoutLoaded(true);
  }, []);

  useEffect(() => {
    if (!trainingWaitState?.startedAt || trainingWaitState.streamingText) {
      return undefined;
    }
    const timerId = window.setTimeout(() => {
      setTrainingWaitState((current) => (
        current && current.startedAt === trainingWaitState.startedAt
          ? { ...current, slow: true }
          : current
      ));
    }, 12000);
    return () => window.clearTimeout(timerId);
  }, [trainingWaitState?.startedAt, trainingWaitState?.streamingText]);

  useEffect(() => () => {
    trainingAnswerStreamAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    setSummaryDismissed(false);
  }, [session?.sessionId]);

  useEffect(() => {
    if (typeof window === "undefined" || !panelLayoutLoaded) {
      return;
    }
    window.localStorage.setItem(learnPanelLayoutStorageKey, JSON.stringify(panelLayout));
  }, [panelLayout, panelLayoutLoaded]);

  useEffect(() => {
    if (typeof window === "undefined" || !panelLayoutLoaded) {
      return;
    }
    window.localStorage.setItem(readerZoomStorageKey, String(readerZoom));
  }, [panelLayoutLoaded, readerZoom]);

  useEffect(() => {
    const userId = getStoredUserId();
    const query = userId ? `?userId=${encodeURIComponent(userId)}` : "";
    apiFetch(`/api/knowledge/docs${query}`)
      .then((data) => setKnowledgeDocuments(data.documents || []))
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

  const currentCheckpoint = useMemo(
    () => (session?.concepts || []).find((concept) => concept.id === session?.currentCheckpointId) || null,
    [session]
  );
  const currentTrainingPoint = useMemo(
    () => (session?.trainingPoints || []).find((point) => point.id === session?.currentTrainingPointId) || null,
    [session]
  );
  const currentSource = getSourceRefs(currentCheckpoint)[0] || getSourceRefs(currentTrainingPoint)[0] || session?.summary?.sourceClusters?.[0] || null;
  const activeDocPath = searchParams.get("doc") || currentSource?.path || knowledgeDocuments[0]?.path || "";
  const documentTitle = knowledgeDoc?.title || currentSource?.title || "开始学习";
  const autostart = searchParams.get("autostart") === "1";
  const desiredConceptId = searchParams.get("concept") || "";
  const docConcepts = useMemo(
    () => (session?.trainingPoints || []).filter((point) =>
      getSourceRefs(point).some((source) => source.path === activeDocPath)
    ),
    [session, activeDocPath]
  );
  const trainingConcept = useMemo(
    () => docConcepts.find((point) => point.id === session?.currentTrainingPointId) || docConcepts[0] || null,
    [docConcepts, session]
  );
  const docTrainingReady = Boolean(trainingConcept);
  const docConceptIds = useMemo(() => new Set(docConcepts.map((concept) => concept.id)), [docConcepts]);
  const trainingChatTimeline = useMemo(() => {
    if (!docTrainingReady) {
      return [];
    }
    return visibleChatTimeline.filter((entry) => {
      if (entry.type === "event") {
        return true;
      }
      if (!entry.conceptId) {
        return true;
      }
      return docConceptIds.has(entry.conceptId);
    });
  }, [docConceptIds, docTrainingReady, visibleChatTimeline]);
  const liveTrainingTimeline = useMemo(() => {
    if (!liveTrainingTurns.length) {
      return [];
    }
    return buildChatTimeline(liveTrainingTurns, {
      limit: Math.max(liveTrainingTurns.length, 24),
    }).filter((entry) => {
      if (entry.type === "event") {
        return true;
      }
      if (!entry.conceptId) {
        return true;
      }
      return !docTrainingReady || docConceptIds.has(entry.conceptId);
    });
  }, [docConceptIds, docTrainingReady, liveTrainingTurns]);
  const trainingCompletion = useMemo(
    () => buildTrainingCompletion(sessionBelongsToDocument(session, activeDocPath) ? session : null, docConcepts),
    [activeDocPath, docConcepts, session]
  );
  const knowledgeTree = useMemo(() => buildKnowledgeTree(knowledgeDocuments), [knowledgeDocuments]);
  const documentHeadings = useMemo(
    () => {
      const outline = getDocumentOutline(knowledgeDoc);
      return outline.length ? outline : buildDocumentHeadings(knowledgeDoc?.learning?.markdown || knowledgeDoc?.markdown || "");
    },
    [knowledgeDoc]
  );
  const readingBlocks = useMemo(
    () => buildReadingBlocks(getDocumentTextForReading(knowledgeDoc)),
    [knowledgeDoc]
  );
  const activeDocumentProgressEntry = profile?.documentProgress?.docs?.[activeDocPath] || null;
  const storedReadProgressPercent = Math.min(100, Math.max(0, Number(activeDocumentProgressEntry?.progressPercentage || 0)));
  const isDocumentIgnored = Boolean(activeDocPath && (profile?.documentProgress?.ignoredDocPaths || []).includes(activeDocPath));
  const trainingCtaLabel = getTrainingCtaLabel(activeDocumentProgressEntry);
  const visibleReadProgressPercent = Math.max(readProgressPercent, storedReadProgressPercent);
  const currentReadingCompleted = visibleReadProgressPercent >= 90;
  const trainingSkipped = Boolean(activeDocumentProgressEntry?.trainingSkipped || locallySkippedTrainingPaths.includes(activeDocPath));
  const trainingCompleted = Boolean(activeDocumentProgressEntry?.trainingCompleted);
  const trainingReadingOnly = activeDocumentProgressEntry?.trainingAvailability === "unavailable";
  const trainingStarted = Boolean(
    activeDocumentProgressEntry?.trainingStarted ||
    activeDocumentProgressEntry?.trainingStartedAt ||
    activeDocumentProgressEntry?.activeSessionId ||
    sessionBelongsToDocument(session, activeDocPath)
  );
  const trainingHeaderCtaLabel = currentReadingCompleted && !trainingUnlocked && !trainingCompleted && !trainingReadingOnly
    ? "训练这篇"
    : trainingCtaLabel;
  const readingTrainingBanner = buildReadingTrainingBanner({
    currentReadingCompleted,
    trainingStarted,
    trainingCompleted,
    trainingSkipped,
    trainingReadingOnly,
    unavailableReason: activeDocumentProgressEntry?.trainingUnavailableReason || "",
  });
  const visibleSessionId = session?.sessionId || activeDocumentProgressEntry?.activeSessionId || "";
  const outlineAvailable = documentHeadings.length > 0 || knowledgeTree.length > 0;
  const isPreparingTraining = isStarting && sessionStartMode === "training";
  const readerRenderer = useMemo(() => getReaderRenderer(knowledgeDoc), [knowledgeDoc]);
  const hideLearningViewForFormat = knowledgeDoc?.render?.format === "pdf";
  const canShowOriginalSource = Boolean(knowledgeDoc?.render?.previewable);
  const canShowLearningSource = !hideLearningViewForFormat && Boolean(knowledgeDoc?.learning?.markdown || knowledgeDoc?.markdown);
  const activeWorkspaceMode = isPreparingTraining ? "training" : workspaceMode;
  const readingCompanionHasHistory = readingChatTimeline.length > 0 || Boolean(readingStreamingTurn);
  const trainingHasHistory = trainingChatTimeline.length > 0 || liveTrainingTimeline.length > 0;
  const qaNeedsAttention = Boolean(
    trainingUnlocked ||
    sessionBelongsToDocument(session, activeDocPath) ||
    readingCompanionHasHistory ||
    trainingHasHistory ||
    pendingSubmittedAnswer ||
    readingStreamingTurn ||
    liveTrainingTurns.length > 0 ||
    isStarting ||
    isAnswering ||
    answer.trim() ||
    isComposerFocused
  );
  const autoQaPanelPercent = activeWorkspaceMode === "training"
    ? (trainingHasHistory || qaNeedsAttention ? 52 : 48)
    : (qaNeedsAttention ? 42 : 34);
  const qaPanelPercent = panelLayout.mode === "manual" && Number.isFinite(panelLayout.qaPercent)
    ? clampQaPanelPercent(panelLayout.qaPercent)
    : autoQaPanelPercent;
  const readerScale = readerZoom / 100;
  const trainingExchanges = useMemo(() => buildTrainingExchanges(sessionBelongsToDocument(session, activeDocPath) ? session : null), [activeDocPath, session]);
  const currentTrainingQuestion = useMemo(() => getCurrentTrainingQuestion(sessionBelongsToDocument(session, activeDocPath) ? session : null), [activeDocPath, session]);
  const currentQuestionHasTeachExplanation = useMemo(
    () => hasTeachExplanationForCurrentQuestion(
      sessionBelongsToDocument(session, activeDocPath) ? session : null,
      currentTrainingQuestion
    ),
    [activeDocPath, currentTrainingQuestion, session]
  );
  const trainingStats = useMemo(() => buildTrainingStats(sessionBelongsToDocument(session, activeDocPath) ? session : null, currentTrainingPoint), [activeDocPath, currentTrainingPoint, session]);
  const trainingSummary = useMemo(
    () => buildTrainingCompletionSummary({
      session: sessionBelongsToDocument(session, activeDocPath) ? session : null,
      points: docConcepts,
      exchanges: trainingExchanges,
      documentTitle,
      progressEntry: activeDocumentProgressEntry,
    }),
    [activeDocPath, activeDocumentProgressEntry, docConcepts, documentTitle, session, trainingExchanges]
  );
  const trainingSystemStatus = useMemo(() => buildTrainingStatus({
    isStarting: isPreparingTraining,
    isAnswering,
    liveTurns: liveTrainingTurns,
    error,
    session,
    stats: trainingStats,
  }), [error, isAnswering, isPreparingTraining, liveTrainingTurns, session, trainingStats]);

  useEffect(() => {
    if (progressDocumentPathRef.current !== activeDocPath) {
      progressDocumentPathRef.current = activeDocPath;
      setReadProgressPercent(storedReadProgressPercent);
      return;
    }
    setReadProgressPercent((previous) => Math.max(previous, storedReadProgressPercent));
  }, [activeDocPath, storedReadProgressPercent]);

  function scrollQaToBottom(behavior = "auto") {
    if (!qaScrollRef.current) {
      return;
    }
    qaScrollRef.current.scrollTo({
      top: qaScrollRef.current.scrollHeight,
      behavior,
    });
  }

  function changeReaderZoom(delta) {
    setReaderZoom((value) => clampReaderZoom(value + delta));
  }

  useEffect(() => {
    if (!autostart || autostartRef.current || !profile?.user?.id || session) {
      return;
    }
    autostartRef.current = true;
    void startSession({ mode: "reading" });
  }, [autostart, profile, session]);

  useEffect(() => {
    if (!session?.sessionId || !desiredConceptId || session.currentTrainingPointId === desiredConceptId || conceptFocusRef.current === desiredConceptId) {
      return;
    }
    conceptFocusRef.current = desiredConceptId;
    void focusConcept(desiredConceptId);
  }, [desiredConceptId, session]);

  useEffect(() => {
    if (!readingStreamingTurn && !liveTrainingTurns.length) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      scrollQaToBottom();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [liveTrainingTurns.length, readingStreamingTurn?.id, readingStreamingTurn?.assistantText, readingStreamingTurn?.replyComplete]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      scrollQaToBottom();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [chatTimeline.length, isStarting, session?.sessionId]);

  useEffect(() => {
    if (!outlineOpen) {
      return undefined;
    }
    function handleKeyDown(event) {
      if (event.key === "Escape") {
        setOutlineOpen(false);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [outlineOpen]);

  useEffect(() => {
    setWorkspaceMode("reading");
    setTrainingUnlocked(false);
    setAnswer("");
    setReadingStreamingTurn(null);
    setLiveTrainingTurns([]);
    setReadingChatTimeline([]);
  }, [activeDocPath]);

  useEffect(() => {
    if (!session?.sessionId || sessionBelongsToDocument(session, activeDocPath)) {
      return;
    }
    setSession(null);
    setTrainingUnlocked(false);
    setWorkspaceMode("reading");
    setAnswer("");
    setReadingStreamingTurn(null);
    setReadingChatTimeline([]);
  }, [activeDocPath, session]);

  useEffect(() => {
    if (
      workspaceMode !== "training" ||
      !session?.sessionId ||
      !trainingConcept?.id ||
      session.currentTrainingPointId === trainingConcept.id
    ) {
      return;
    }
    void focusConcept(trainingConcept.id);
  }, [workspaceMode, session, trainingConcept]);

  useEffect(() => {
    setFocusMode(focusParamEnabled);
  }, [focusParamEnabled]);

  useEffect(() => {
    if (!focusMode) {
      setFocusQaOpen(false);
    }
  }, [focusMode]);

  useEffect(() => {
    if (focusMode && activeWorkspaceMode === "training") {
      setFocusQaOpen(true);
    }
  }, [focusMode, activeWorkspaceMode]);

  useEffect(() => {
    if (!activeDocPath) {
      setKnowledgeDoc(null);
      setDocError("");
      setDocLoading(false);
      return;
    }

    let cancelled = false;
    setDocLoading(true);
    setDocError("");
    setKnowledgeDoc(null);
    setReaderSourceView("learning");

    const userId = profile?.user?.id || getStoredUserId();
    const query = new URLSearchParams({ path: activeDocPath });
    if (userId) {
      query.set("userId", userId);
    }
    apiFetch(`/api/knowledge/doc?${query.toString()}`)
      .then((data) => {
        if (!cancelled) {
          setKnowledgeDoc(data);
        }
      })
      .catch((nextError) => {
        if (!cancelled) {
          setKnowledgeDoc(null);
          setDocError(nextError.message);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setDocLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeDocPath, profile?.user?.id]);

  useEffect(() => {
    if (!knowledgeDoc?.path) {
      return;
    }
    if (knowledgeDoc?.render?.defaultView && knowledgeDoc.render.defaultView !== readerSourceView) {
      setReaderSourceView(knowledgeDoc.render.defaultView);
      return;
    }
  }, [knowledgeDoc?.path, knowledgeDoc?.render?.defaultView]);

  useEffect(() => {
    if (!knowledgeDoc?.path) {
      return;
    }
    const rawHash = window.location.hash.replace(/^#/, "");
    if (!rawHash) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const target = document.getElementById(decodeURIComponent(rawHash));
      if (target) {
        target.scrollIntoView({ block: "start", behavior: "smooth" });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [knowledgeDoc?.path, knowledgeDoc?.learning?.markdown, readerSourceView]);

  useEffect(() => {
    if (!profile?.user?.id || !activeDocPath) {
      return;
    }

    const conceptForDoc = currentTrainingPoint && getSourceRefs(currentTrainingPoint).some((source) => source.path === activeDocPath)
      ? currentTrainingPoint
      : docConcepts[0] || null;
    const nextSignature = JSON.stringify({
      userId: profile.user.id,
      domainId: conceptForDoc?.abilityDomainId || conceptForDoc?.domainId || "",
      conceptId: conceptForDoc?.id || "",
      docPath: activeDocPath,
      docTitle: knowledgeDoc?.title || "",
      scrollRatio: 0,
      dwellMs: 0,
    });

    if (readingProgressRef.current === nextSignature) {
      return;
    }
    readingProgressRef.current = nextSignature;

    void apiFetch("/api/profile/reading-progress", {
      method: "POST",
      body: nextSignature,
      keepalive: true,
    })
      .then(() => {
        window.localStorage.setItem(profileDirtyStorageKey, String(Date.now()));
      })
      .catch(() => {
        readingProgressRef.current = "";
      });
  }, [activeDocPath, currentTrainingPoint, docConcepts, knowledgeDoc?.title, profile]);

  useEffect(() => {
    const readerBody = readerBodyRef.current;
    if (!readerBody || !profile?.user?.id || !activeDocPath || !knowledgeDoc?.path) {
      return undefined;
    }

    let maxScrollRatio = Math.min(1, Math.max(0, storedReadProgressPercent / 100));
    let lastSentAt = 0;
    let timeoutId = null;
    let hasScrollInteraction = false;
    const startedAt = Date.now();

    function calculateScrollRatio() {
      const scrollableHeight = readerBody.scrollHeight - readerBody.clientHeight;
      if (scrollableHeight <= 8) {
        return null;
      }
      return Math.min(1, Math.max(0, readerBody.scrollTop / scrollableHeight));
    }

    function markProfileDirty() {
      window.localStorage.setItem(profileDirtyStorageKey, String(Date.now()));
    }

    function sendProgress(force = false) {
      const currentScrollRatio = calculateScrollRatio();
      const dwellMs = Date.now() - startedAt;
      const now = Date.now();
      if (currentScrollRatio === null) {
        return;
      }
      const currentPercent = Math.round(currentScrollRatio * 100);
      setReadProgressPercent((previous) => Math.max(previous, storedReadProgressPercent, currentPercent));
      maxScrollRatio = Math.max(maxScrollRatio, currentScrollRatio);
      if (force && !hasScrollInteraction && maxScrollRatio < 0.9) {
        return;
      }
      const resumeContext = buildReadingResumeContext(readingBlocks, maxScrollRatio);

      if (!force && now - lastSentAt < 10_000 && maxScrollRatio < 0.9) {
        return;
      }
      lastSentAt = now;

      void apiFetch("/api/profile/reading-progress", {
        method: "POST",
        body: JSON.stringify({
          userId: profile.user.id,
          docPath: activeDocPath,
          docTitle: knowledgeDoc.title || "",
          scrollRatio: maxScrollRatio,
          dwellMs,
          readingPreview: resumeContext.readingPreview,
          readingChapter: resumeContext.readingChapter,
        }),
        keepalive: true,
      })
        .then((nextProfile) => {
          markProfileDirty();
          if (maxScrollRatio >= 0.9 && nextProfile?.documentProgress) {
            setProfile(nextProfile);
          }
        })
        .catch(() => {});
    }

    function scheduleProgressSend() {
      hasScrollInteraction = true;
      const currentScrollRatio = calculateScrollRatio();
      if (currentScrollRatio !== null) {
        const currentPercent = Math.round(currentScrollRatio * 100);
        setReadProgressPercent((previous) => Math.max(previous, storedReadProgressPercent, currentPercent));
      }
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }
      timeoutId = window.setTimeout(() => sendProgress(false), 250);
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "hidden") {
        sendProgress(true);
      }
    }

    function handlePageHide() {
      sendProgress(true);
    }

    const initialScrollRatio = calculateScrollRatio();
    if (initialScrollRatio !== null) {
      const initialPercent = Math.round(initialScrollRatio * 100);
      setReadProgressPercent((previous) => Math.max(previous, storedReadProgressPercent, initialPercent));
    }
    readerBody.addEventListener("scroll", scheduleProgressSend, { passive: true });
    window.addEventListener("pagehide", handlePageHide);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }
      sendProgress(true);
      readerBody.removeEventListener("scroll", scheduleProgressSend);
      window.removeEventListener("pagehide", handlePageHide);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [activeDocPath, knowledgeDoc?.path, knowledgeDoc?.title, profile?.user?.id, readingBlocks, storedReadProgressPercent]);

  async function refreshProfile() {
    if (!profile?.user?.id) {
      return;
    }
    const data = await apiFetch(`/api/profile/${profile.user.id}`);
    setProfile(data);
  }

  async function toggleIgnoredDocument() {
    if (!profile?.user?.id || !activeDocPath) {
      appendReadingSystemNote("请先登录后再标记忽略文档。");
      return;
    }
    try {
      const data = await postJson("/api/profile/ignored-document", {
        userId: profile.user.id,
        docPath: activeDocPath,
        docTitle: knowledgeDoc?.title || documentTitle,
        ignored: !isDocumentIgnored,
      });
      setProfile(data);
      window.localStorage.setItem(profileDirtyStorageKey, String(Date.now()));
      setReaderMoreOpen(false);
      if (!isDocumentIgnored) {
        const nextDocument = getAutoAdvanceDocumentAfterIgnore({
          documents: knowledgeDocuments,
          documentProgress: data.documentProgress,
          currentDocPath: activeDocPath,
        });
        if (nextDocument) {
          router.replace(buildLearnDocumentHref(nextDocument.path));
          return;
        }
        appendReadingSystemNote("已标记为忽略，暂时没有其它待读文档。可以回到主页查看已忽略列表。");
        return;
      }
      appendReadingSystemNote("已取消忽略，这篇会重新出现在主页资料流里。");
    } catch (nextError) {
      setError(nextError.message);
    }
  }

  async function copySessionId() {
    if (!visibleSessionId || typeof navigator === "undefined" || !navigator.clipboard) {
      return;
    }
    try {
      await navigator.clipboard.writeText(visibleSessionId);
      setSessionIdCopied(true);
      window.setTimeout(() => setSessionIdCopied(false), 1500);
    } catch {}
  }

  function appendReadingSystemNote(message = "") {
    const body = String(message || "").trim();
    if (!body) {
      return;
    }
    setReadingChatTimeline((items) => items.concat([
      {
        id: `reading-note:${Date.now()}`,
        role: "assistant",
        body,
        isProgressUpdate: true,
      },
    ]));
  }

  function updateTrainingWaitFromProgress(progressEvent = {}) {
    const stepKey = normalizeTrainingWaitStepKey(progressEvent);
    setTrainingWaitState((current) => {
      if (!current || !stepKey) {
        return current;
      }
      const status = String(progressEvent.status || "").trim();
      if (status === "completed") {
        return {
          ...current,
          currentStepKey: getNextTrainingWaitStep(stepKey),
          completedStepKeys: appendCompletedStep(current.completedStepKeys, stepKey),
        };
      }
      if (status === "running") {
        return {
          ...current,
          currentStepKey: stepKey,
          completedStepKeys: trainingWaitStepKeys
            .slice(0, Math.max(0, trainingWaitStepKeys.indexOf(stepKey)))
            .reduce((all, key) => appendCompletedStep(all, key), current.completedStepKeys),
        };
      }
      return current;
    });
  }

  function updateTrainingWaitStreamingText(nextText = "") {
    const streamingText = String(nextText || "");
    if (!streamingText.trim()) {
      return;
    }
    setTrainingWaitState((current) => (
      current
        ? {
            ...current,
            currentStepKey: current.currentStepKey === "generate_followup" ? current.currentStepKey : "compose_explanation",
            completedStepKeys: trainingWaitStepKeys
              .slice(0, Math.max(0, trainingWaitStepKeys.indexOf("compose_explanation")))
              .reduce((all, key) => appendCompletedStep(all, key), current.completedStepKeys),
            streamingText,
          }
        : current
    ));
  }

  async function restartOrAdvanceTrainingGeneration(mode = "retry") {
    const activeWaitState = trainingWaitState;
    if (!activeWaitState?.submittedAnswer || !session?.sessionId) {
      return;
    }
    trainingAnswerStreamAbortRef.current?.abort();
    window.setTimeout(() => {
      void submitAnswerWithSession(session, mode === "skip"
        ? { nextAnswer: "下一题", intent: "advance" }
        : { nextAnswer: activeWaitState.submittedAnswer, intent: activeWaitState.intent || "" });
    }, 0);
  }

  async function startSession({ mode = "reading", restart = false } = {}) {
    if (!profile?.user?.id) {
      return null;
    }
    try {
      setIsStarting(true);
      setSessionStartMode(mode);
      setError("");
      const nextSession = await postJson("/api/interview/start-target", {
        userId: profile.user.id,
        docPath: activeDocPath,
        interactionPreference,
        restartTraining: restart,
      });
      if (nextSession?.trainingAvailability === "unavailable") {
        setSession(null);
        setTrainingUnlocked(false);
        setWorkspaceMode("reading");
        appendReadingSystemNote(nextSession.reasonMessage || "当前文档暂时无法生成训练点，已保留为阅读材料。");
        await refreshProfile();
        return null;
      }
      setSession(nextSession);
      await refreshProfile();
      return nextSession;
    } catch (nextError) {
      setError(nextError.message);
      return null;
    } finally {
      setIsStarting(false);
    }
  }

  async function unlockTraining() {
    if (activeDocumentProgressEntry?.trainingSkipped) {
      appendReadingSystemNote("这篇已标记为跳过训练；你仍然可以重新开启训练。");
    }
    if (activeDocumentProgressEntry?.trainingAvailability === "unavailable") {
      appendReadingSystemNote(activeDocumentProgressEntry.trainingUnavailableReason || "当前文档暂时无法生成训练点，已保留为阅读材料。");
      return;
    }
    let nextSession = sessionBelongsToDocument(session, activeDocPath) ? session : null;
    if (!nextSession) {
      nextSession = await startSession({ mode: "training" });
    }
    if (!nextSession) {
      return;
    }
    setLocallySkippedTrainingPaths((items) => items.filter((item) => item !== activeDocPath));
    setTrainingUnlocked(true);
    setWorkspaceMode("training");
  }

  function handleTrainingModeClick() {
    if (isStarting || isAnswering) {
      return;
    }
    if (trainingReadingOnly) {
      appendReadingSystemNote(activeDocumentProgressEntry?.trainingUnavailableReason || "当前文档暂时无法生成训练点，已保留为阅读材料。");
      return;
    }
    if (trainingUnlocked || sessionBelongsToDocument(session, activeDocPath)) {
      setTrainingUnlocked(true);
      setWorkspaceMode("training");
      return;
    }
    void unlockTraining();
  }

  async function handleReadingTrainingBannerClick() {
    if (!readingTrainingBanner.clickable || isStarting || isAnswering) {
      return;
    }
    if (trainingSkipped) {
      await restartTraining();
      return;
    }
    await unlockTraining();
  }

  async function skipTrainingForDocument() {
    if (!profile?.user?.id || !activeDocPath) {
      return;
    }
    try {
      setIsStarting(true);
      setError("");
      const data = await postJson("/api/profile/skipped-training", {
        userId: profile.user.id,
        docPath: activeDocPath,
        docTitle: knowledgeDoc?.title || documentTitle,
      });
	      setProfile(data);
	      setLocallySkippedTrainingPaths((items) => items.includes(activeDocPath) ? items : items.concat(activeDocPath));
	      setWorkspaceMode("reading");
	      setTrainingUnlocked(false);
	      setReaderMoreOpen(false);
	      appendReadingSystemNote("已把这篇标记为仅阅读完成。之后想练，仍然可以重新开启训练。");
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setIsStarting(false);
    }
  }

  async function restartTraining() {
    setTrainingUnlocked(true);
    setWorkspaceMode("training");
    setPendingSubmittedAnswer("");
    setAnswer("");
    await startSession({ mode: "training", restart: true });
  }

  async function reviewWeakPoint() {
    if (!trainingCompletion?.reviewPointId) {
      return;
    }
    setTrainingUnlocked(true);
    setWorkspaceMode("training");
    setSummaryDismissed(true);
    await focusConcept(trainingCompletion.reviewPointId);
  }

  async function reviewWeakPointByConcept(conceptId = "") {
    setTrainingUnlocked(true);
    setWorkspaceMode("training");
    setSummaryDismissed(true);
    setAnswer("");
    if (conceptId && session?.sessionId) {
      await focusConcept(conceptId);
      return;
    }
    if (trainingCompletion?.reviewPointId) {
      await focusConcept(trainingCompletion.reviewPointId);
    }
  }

  async function ensureSessionForReading() {
    let nextSession = sessionBelongsToDocument(session, activeDocPath) ? session : null;
    if (!nextSession) {
      nextSession = await startSession({ mode: workspaceMode === "training" ? "training" : "reading" });
    }
    return nextSession;
  }

  async function submitAnswerWithSession(activeSession, { nextAnswer = answer, intent = "" } = {}) {
    const submittedAnswer = nextAnswer.trim();
    const shouldClearComposer = nextAnswer === answer;
    if (!activeSession?.sessionId || !submittedAnswer) {
      return;
    }
    let finalSession = null;
    const abortController = new AbortController();
    trainingAnswerStreamAbortRef.current = abortController;
    try {
      setError("");
      setIsAnswering(true);
      setLiveTrainingTurns([]);
      setTrainingWaitState(createTrainingWaitState({
        submittedAnswer,
        intent,
      }));
      if (shouldClearComposer) {
        setAnswer("");
      }

      await postEventStream(
        "/api/interview/answer-stream",
        {
          sessionId: activeSession.sessionId,
          answer: submittedAnswer,
          intent,
          burdenSignal: "normal",
          interactionPreference,
        },
        async (event, data) => {
          if (event === "turn_append" && data.turn) {
            setLiveTrainingTurns((items) => items.concat([data.turn]));
            if (data.turn?.kind === "feedback" && data.turn?.content) {
              updateTrainingWaitStreamingText(data.turn.content);
            }
          }
          if (event === "turn_patch" && data.turnId) {
            setLiveTrainingTurns((items) => patchLiveTurn(items, data));
            updateTrainingWaitStreamingText(data.content ?? data.delta ?? "");
          }
          if (event === "progress") {
            updateTrainingWaitFromProgress(data);
          }
          if (event === "turn_result" || event === "session") {
            finalSession = data;
            if (intent === "teach" && !data?.currentProbe) {
              setSummaryDismissed(true);
            }
            setSession(data);
            setAnswer((current) => (current.trim() ? current : ""));
            setLiveTrainingTurns([]);
            setTrainingWaitState(null);
          }
          if (event === "error") {
            throw new Error(data.error || "流式回答失败。");
          }
        },
        {
          signal: abortController.signal,
        }
      );

      if (finalSession) {
        await refreshProfile();
      }
    } catch (nextError) {
      if (nextError?.name !== "AbortError") {
        setError(nextError.message);
        if (shouldClearComposer) {
          setAnswer(submittedAnswer);
        }
      }
    } finally {
      if (trainingAnswerStreamAbortRef.current === abortController) {
        trainingAnswerStreamAbortRef.current = null;
        setIsAnswering(false);
        if (!finalSession) {
          setLiveTrainingTurns([]);
          setTrainingWaitState(null);
        }
      }
    }
  }

  async function submitReadingQuestion({ nextAnswer = answer, displayAnswer = "", goal = "interview", taskType = "freeform" } = {}) {
    const submittedAnswer = nextAnswer.trim();
    const visibleAnswer = String(displayAnswer || submittedAnswer).trim();
    const shouldClearComposer = nextAnswer === answer;
    if (!submittedAnswer || !activeDocPath) {
      return;
    }
    const turnId = `reading:${activeDocPath}:${Date.now()}`;
    try {
      setError("");
      setIsAnswering(true);
      setReadingStreamingTurn({
        id: turnId,
        mode: "reading",
        answer: visibleAnswer,
        assistantText: "",
        replyComplete: false,
        decisionPending: false,
        progressSteps: [],
        assessmentPreview: null,
        nextMovePreview: null,
      });
      if (shouldClearComposer) {
        setAnswer("");
      }

      const result = await postJson("/api/knowledge/answer", {
        userId: profile?.user?.id || "",
        docPath: activeDocPath,
        question: submittedAnswer,
        goal,
        taskType,
      });
      setReadingChatTimeline((items) => items.concat([
        {
          id: `${turnId}:user`,
          role: "user",
          body: visibleAnswer,
        },
        {
          id: `${turnId}:assistant`,
          role: "assistant",
          body: result.content || "这篇材料里没有足够内容回答这个问题。",
        },
      ]));
      await refreshProfile();
    } catch (nextError) {
      setError(nextError.message);
      if (shouldClearComposer) {
        setAnswer(submittedAnswer);
      }
    } finally {
      setIsAnswering(false);
      setReadingStreamingTurn(null);
    }
  }

  async function submitAnswer(options = {}) {
    const submittedAnswer = (options.nextAnswer ?? answer).trim();
    if (!submittedAnswer) {
      return;
    }
    if (workspaceMode === "reading") {
      await submitReadingQuestion(options);
      return;
    }
    const sessionReady = sessionBelongsToDocument(session, activeDocPath);
    if (!sessionReady) {
      setPendingSubmittedAnswer(submittedAnswer);
    }
    const activeSession = await ensureSessionForReading();
    if (!activeSession) {
      setPendingSubmittedAnswer("");
      return;
    }
    setPendingSubmittedAnswer("");
    await submitAnswerWithSession(activeSession, options);
  }

  async function submitTrainingFollowUp(prompt) {
    const value = String(prompt || "").trim();
    if (!value || isAnswering) {
      return;
    }
    await submitAnswer({
      nextAnswer: value,
      intent: "teach",
    });
  }

  function handleReaderSelection() {
    if (focusMode || typeof window === "undefined") {
      return;
    }
    const selection = window.getSelection();
    const text = selection?.toString().trim() || "";
    if (!text || text.length < 2 || !readerBodyRef.current) {
      return;
    }
    const range = selection.getRangeAt(0);
    const container = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
    if (!container || !readerBodyRef.current.contains(container)) {
      return;
    }
    const paragraph = container.closest?.("[data-reading-paragraph]");
    const rect = range.getBoundingClientRect();
    setSelectionPopover({
      visible: true,
      x: Math.min(window.innerWidth - 320, Math.max(18, rect.left)),
      y: Math.min(window.innerHeight - 132, Math.max(72, rect.bottom + 10)),
      text,
      paragraphId: paragraph?.getAttribute("data-reading-paragraph") || "",
    });
  }

  async function askAiAboutSelection() {
    const text = selectionPopover.text || "";
    setSelectionPopover((value) => ({ ...value, visible: false }));
    if (!text) {
      return;
    }
    await submitReadingQuestion({
      nextAnswer: `请解释这段原文，并结合上下文说明它为什么重要：${text}`,
      goal: "interview",
      taskType: "selection_explain",
    });
  }

  async function quizSelection() {
    const text = selectionPopover.text || "";
    setSelectionPopover((value) => ({ ...value, visible: false }));
    if (!text) {
      return;
    }
    await submitReadingQuestion({
      nextAnswer: `请基于这段原文出一道单点自测题。要求：只考一个最关键概念；不要把多个别名、组成部分、作用混在同一题；题目后给一行参考答案。\n\n原文：${text}`,
      displayAnswer: "请基于划线段落出一道单点自测题。",
      goal: "interview",
      taskType: "inline_quiz",
    });
  }

  function saveSelectionNote() {
    const text = selectionPopover.text || "";
    setSelectionPopover((value) => ({ ...value, visible: false }));
    if (text) {
      appendReadingSystemNote(`已记下这段：${text.slice(0, 80)}${text.length > 80 ? "..." : ""}`);
    }
  }

  function highlightSelection() {
    const paragraphId = selectionPopover.paragraphId;
    setSelectionPopover((value) => ({ ...value, visible: false }));
    if (!paragraphId) {
      return;
    }
    setUserHighlightedParagraphIds((items) => items.includes(paragraphId) ? items : items.concat(paragraphId));
  }

  function jumpToCitationParagraph(value) {
    const paragraph = document.getElementById(`reading-paragraph-${value}`);
    if (!paragraph) {
      return;
    }
    setHighlightedParagraphId(paragraph.id);
    paragraph.scrollIntoView({ block: "center", behavior: "smooth" });
    window.setTimeout(() => {
      setHighlightedParagraphId((current) => current === paragraph.id ? "" : current);
    }, 3000);
  }

  function handleComposerKeyDown(event) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent?.isComposing) {
      return;
    }
    event.preventDefault();
    if (isAnswering || !answer.trim()) {
      return;
    }
    submitAnswer();
  }

  async function focusConcept(conceptId) {
    if (!session?.sessionId) {
      return;
    }
    try {
      setError("");
      setOutlineOpen(false);
      const nextSession = await postJson("/api/interview/focus-concept", {
        sessionId: session.sessionId,
        conceptId,
      });
      setSession(nextSession);
    } catch (nextError) {
      setError(nextError.message);
    }
  }

  function openDocumentFromCatalog(documentPath, conceptId = "") {
    const params = new URLSearchParams();
    if (documentPath) {
      params.set("doc", documentPath);
    }
    if (autostart || session?.sessionId) {
      params.set("autostart", "1");
    }
    if (focusMode) {
      params.set("focus", "1");
    }

    if (conceptId && session?.sessionId) {
      void focusConcept(conceptId);
    } else if (conceptId) {
      params.set("concept", conceptId);
    }

    router.replace(`/learn?${params.toString()}`);
    setOutlineOpen(false);
  }

  function jumpToHeading(headingId) {
    const target = document.getElementById(headingId);
    if (target) {
      target.scrollIntoView({ block: "start", behavior: "smooth" });
    }
    window.history.replaceState(null, "", `#${encodeURIComponent(headingId)}`);
    setOutlineOpen(false);
  }

  function updateManualPanelLayout(nextQaPercent) {
    setPanelLayout({
      mode: "manual",
      qaPercent: clampQaPanelPercent(nextQaPercent),
    });
  }

  function resetPanelLayout() {
    setPanelLayout({
      mode: "auto",
      qaPercent: null,
    });
  }

  function handleDividerPointerDown(event) {
    event.preventDefault();
    if (focusMode || window.innerWidth < 1180) {
      return;
    }

    function handlePointerMove(moveEvent) {
      const bounds = studyMainRef.current?.getBoundingClientRect();
      if (!bounds || bounds.width <= 0) {
        return;
      }
      const nextQaPercent = ((bounds.right - moveEvent.clientX) / bounds.width) * 100;
      setPanelLayout({
        mode: "manual",
        qaPercent: clampQaPanelPercent(nextQaPercent),
      });
    }

    function finishDragging() {
      setIsDraggingLayout(false);
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", finishDragging);
      window.removeEventListener("pointercancel", finishDragging);
    }

    setIsDraggingLayout(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", finishDragging);
    window.addEventListener("pointercancel", finishDragging);
  }

  function handleDividerKeyDown(event) {
    if (focusMode) {
      return;
    }
    const step = event.shiftKey ? 4 : 2;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      updateManualPanelLayout(qaPanelPercent - step);
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      updateManualPanelLayout(qaPanelPercent + step);
      return;
    }
    if (event.key === "Home" || event.key === "Escape") {
      event.preventDefault();
      resetPanelLayout();
    }
  }

  if (!profile) {
    return (
      <main className="learn-shell">
        <Link className="floating-back-link" href="/">‹</Link>
        <section className="gate-card">
          <h1>先连接学习档案，再进入学习页。</h1>
          <p>首页会保存你的账号、目标和长期记忆；连接后再回来，这里会直接回到学习页。</p>
          <Link className="primary-pill" href="/">返回首页</Link>
        </section>
      </main>
    );
  }

  function renderKnowledgeTree(nodes, depth = 0) {
    return nodes.map((node) => (
      node.type === "folder" ? (
        <section className="outline-group" key={node.key}>
          <div className={`outline-folder depth-${Math.min(depth, 2)}`}>{node.label}</div>
          <div className="outline-items">
            {renderKnowledgeTree(node.children || [], depth + 1)}
          </div>
        </section>
      ) : (
        <section className="outline-group" key={node.key}>
          <button
            type="button"
            className={node.path === activeDocPath ? "outline-domain active" : "outline-domain"}
            onClick={() => openDocumentFromCatalog(node.path, node.concepts?.[0]?.id || "")}
          >
            {node.label}
          </button>
          {node.concepts?.length ? (
            <div className="outline-items">
              {node.concepts.map((concept) => (
                <button
                  type="button"
                  key={concept.id}
                  className={concept.id === currentTrainingPoint?.id ? "outline-item active" : "outline-item"}
                  onClick={() => openDocumentFromCatalog(node.path, concept.id)}
                >
                  {concept.title}
                </button>
              ))}
            </div>
          ) : null}
        </section>
      )
    ));
  }

  const isPdfOriginalReader = knowledgeDoc?.render?.format === "pdf" && readerSourceView === "original";
  const readingStarterPrompts = [
    {
      label: "总结全文",
      taskType: "summary",
      value: `请基于面试准备目标，总结《${documentTitle}》这篇文档。`,
    },
    {
      label: "提炼记忆点",
      taskType: "memory_points",
      value: `请基于面试准备目标，提炼《${documentTitle}》这篇文档最值得记住的关键点。`,
    },
    {
      label: "自测问题",
      taskType: "question_points",
      value: `请基于面试准备目标，把《${documentTitle}》这篇文档的关键点转化为自测问题。`,
    },
  ];
  const shouldShowReadingStarterChips = activeWorkspaceMode === "reading"
    && !readingCompanionHasHistory
    && !readingStreamingTurn
    && !pendingSubmittedAnswer
    && !answer.trim();
  function insertReadingStarterPrompt(prompt) {
    setAnswer(prompt.value);
    window.requestAnimationFrame(() => {
      composerInputRef.current?.focus();
    });
  }
  const studyMainClassName = focusMode
    ? `study-main study-mode-${activeWorkspaceMode} focus-reader-layout`
    : `study-main study-mode-${activeWorkspaceMode}${activeWorkspaceMode === "reading" && !trainingUnlocked ? " pre-training-layout" : ""}`;
  const studyMainStyle = focusMode
    ? {
        "--reader-scale": readerScale,
      }
    : {
        "--qa-panel-width": `${qaPanelPercent}%`,
        "--reader-scale": readerScale,
      };

  if (activeWorkspaceMode === "training" && trainingCompletion && !summaryDismissed && !liveTrainingTimeline.length) {
    return (
      <TrainingCompletionSummaryPage
        summary={trainingSummary}
        onBackToReading={() => {
          setSummaryDismissed(true);
          setWorkspaceMode("training");
        }}
        onReviewWeakPoint={reviewWeakPointByConcept}
        onReviewPlan={() => router.push("/?mode=status&panel=home")}
        onHome={() => router.push("/")}
        onNextDocument={() => router.push("/")}
      />
    );
  }

  if (activeWorkspaceMode === "training") {
    return (
      <TrainingWorkspace
        documentTitle={documentTitle}
        mastery={Number(activeDocumentProgressEntry?.masteryPercentage || activeDocumentProgressEntry?.progressPercentage || 0)}
        session={session}
        exchanges={trainingExchanges}
        currentQuestion={currentTrainingQuestion}
        stats={trainingStats}
        answer={answer}
        setAnswer={setAnswer}
        sideQuestion={sideQuestion}
        setSideQuestion={setSideQuestion}
        isAnswering={isAnswering}
        trainingWaitState={trainingWaitState}
        isPreparingTraining={isPreparingTraining}
        currentQuestionHasTeachExplanation={currentQuestionHasTeachExplanation}
        onSubmit={() => submitAnswer()}
        onAsk={submitTrainingFollowUp}
        onExplain={() => {
          void submitTrainingFollowUp("先看看正确答案");
        }}
        onRetryGeneration={() => {
          void restartOrAdvanceTrainingGeneration("retry");
        }}
        onSkipExplanation={() => {
          void restartOrAdvanceTrainingGeneration("skip");
        }}
        onBackToReading={() => setWorkspaceMode("reading")}
      />
    );
  }

  return (
    <main
      className={focusMode ? "learn-shell focus-reader-mode" : "learn-shell"}
      data-focus-mode={focusMode ? "true" : "false"}
      data-testid="learn-shell"
    >
      {error ? <section className="feedback-banner error-banner narrow-banner">{error}</section> : null}

      <section
        className={studyMainClassName}
        ref={studyMainRef}
        style={studyMainStyle}
        data-layout-mode={panelLayout.mode}
        data-testid="study-main"
      >
        <section className="reader-panel" data-testid="reader-panel">
          {focusMode ? <div className="focus-reader-hover-zone" aria-hidden="true" data-testid="focus-hover-zone" /> : null}
          {focusMode ? (
            <button type="button" className="focus-exit-button" onClick={() => setFocusMode(false)}>
              退出
            </button>
          ) : null}
          <header className="reader-header" data-testid="reader-header">
            <div className="reader-header-main">
              <Link className="back-link header-back-link" href="/">‹</Link>
              <div className="reader-heading">
                <h1 title={documentTitle}>{documentTitle}</h1>
              </div>
            </div>
            <div className="reader-tools">
              <div className="reader-action-group" aria-label="阅读工具">
                {canShowOriginalSource && canShowLearningSource ? (
                  <>
                    <button
                      type="button"
                      className={readerSourceView === "learning" ? "reader-tool-button active" : "reader-tool-button"}
                      onClick={() => setReaderSourceView("learning")}
                      disabled={!canShowLearningSource}
                    >
                      学习版
                    </button>
                    <button
                      type="button"
                      className={readerSourceView === "original" ? "reader-tool-button active" : "reader-tool-button"}
                      onClick={() => setReaderSourceView("original")}
                    >
                      原文
                    </button>
                  </>
                ) : null}
                <button
                  type="button"
                  className={outlineOpen ? "reader-tool-button active" : "reader-tool-button"}
                  onClick={() => setOutlineOpen((value) => !value)}
                  disabled={!outlineAvailable}
                  data-testid="outline-toggle"
                  aria-label="目录"
                >
                  <MiniIcon name="list" />
                </button>
                <button
                  type="button"
                  className={focusMode ? "reader-tool-button active" : "reader-tool-button"}
                  onClick={() => setFocusMode((value) => !value)}
                  data-testid="focus-toggle"
                  aria-label={focusMode ? "退出专注模式" : "专注模式"}
                >
                  <MiniIcon name="focus" />
                </button>
                <div className="reader-more-wrap">
                  <button
                    type="button"
                    className={readerMoreOpen ? "reader-tool-button active" : "reader-tool-button"}
                    onClick={() => setReaderMoreOpen((value) => !value)}
                    aria-label="更多"
                  >
                    <MiniIcon name="dots" />
                  </button>
                  {readerMoreOpen ? (
                    <div className="reader-more-menu">
                      <button type="button" onClick={() => setReaderMoreOpen(false)}>你的态度：在学 ▸ 已会</button>
                      <button type="button" onClick={toggleIgnoredDocument}>
                        {isDocumentIgnored ? "取消忽略文档" : "标记为忽略"}
                      </button>
                      {currentReadingCompleted && !trainingSkipped && !trainingCompleted && !trainingReadingOnly ? (
                        <button type="button" onClick={skipTrainingForDocument}>标记为仅阅读完成</button>
                      ) : null}
                      <button type="button" onClick={() => setReaderMoreOpen(false)}>复制链接</button>
                      <button type="button" onClick={() => setReaderMoreOpen(false)}>导出笔记</button>
                      <button type="button" onClick={() => setReaderMoreOpen(false)}>重新解析</button>
                    </div>
                  ) : null}
                </div>
                {focusMode ? (
                  <button
                    type="button"
                    className={focusQaOpen ? "reader-tool-button active" : "reader-tool-button"}
                    onClick={() => setFocusQaOpen((value) => !value)}
                    data-testid="focus-qa-toggle"
                  >
                    {focusQaOpen ? "收起助理" : "助理"}
                  </button>
                ) : null}
              </div>
            </div>
          </header>
          <div className="reader-body" ref={readerBodyRef} onMouseUp={handleReaderSelection} onKeyUp={handleReaderSelection}>
            {knowledgeDoc ? (
              <div className={focusMode ? `focus-reading-flow${isPdfOriginalReader ? " pdf-focus-reading-flow" : ""}` : undefined} data-testid={focusMode ? "focus-reading-flow" : undefined}>
                {focusMode && !isPdfOriginalReader ? (
                  <header className="focus-document-header" data-testid="focus-document-header">
                    <div className="focus-document-eyebrow">专注阅读</div>
                    <h1>{documentTitle}</h1>
                  </header>
                ) : null}
                {readerSourceView === "original" && canShowOriginalSource
                  ? readerRenderer.renderOriginal(knowledgeDoc, { readerZoom })
                  : (
                    <ReadingDocumentContent
                      document={knowledgeDoc}
                      blocks={readingBlocks}
                      readProgress={visibleReadProgressPercent}
                      highlightedParagraphId={highlightedParagraphId}
                      userHighlightedParagraphIds={userHighlightedParagraphIds}
                      onParagraphAction={setSelectionPopover}
                      onBookmark={() => appendReadingSystemNote(`已把当前位置设为书签：已读 ${visibleReadProgressPercent}%`)}
                    />
                  )}
              </div>
            ) : session ? (
              <article className="document-surface" data-testid="document-surface">
                <div className="reader-empty compact-empty">
                  <h2>{docLoading ? "正在载入文档" : "当前题目暂无关联原文"}</h2>
                  <p>{docError || "这一题的文档还没准备好，右侧问答仍然可以继续。"}
                  </p>
                </div>
              </article>
            ) : (
              <article className="reader-empty">
                <h2>开始学习</h2>
                <p>选择互动风格后直接进入当前文档训练。</p>
                <div className="session-launch-card">
                  <label>
                    互动风格
                    <select value={interactionPreference} onChange={(event) => setInteractionPreference(event.target.value)}>
                      <option value="balanced">平衡</option>
                      <option value="probe-heavy">偏追问</option>
                      <option value="explain-first">偏讲解</option>
                    </select>
                  </label>
                  <button type="button" className="primary-pill" disabled={isStarting} onClick={() => startSession()}>
                    {isStarting ? "进入中..." : "进入学习"}
                  </button>
                </div>
              </article>
            )}
            <ReadingSelectionPopover
              popover={selectionPopover}
              onAsk={askAiAboutSelection}
              onQuiz={quizSelection}
              onSave={saveSelectionNote}
              onHighlight={highlightSelection}
              onClose={() => setSelectionPopover((value) => ({ ...value, visible: false }))}
            />

            {outlineOpen ? (
              <button
                type="button"
                className="outline-backdrop"
                aria-label="关闭知识目录"
                onClick={() => setOutlineOpen(false)}
                data-testid="outline-backdrop"
              />
            ) : null}

            <aside className={outlineOpen ? "outline-panel open" : "outline-panel"} aria-hidden={!outlineOpen} data-testid="outline-panel">
              <div className="outline-toolbar">
                <div className="outline-title">知识目录</div>
                <button
                  type="button"
                  className="outline-close"
                  aria-label="关闭知识目录"
                  onClick={() => setOutlineOpen(false)}
                  data-testid="outline-close"
                >
                  ×
                </button>
              </div>
              <div className="outline-scroll">
                {documentHeadings.length ? (
                  <section className="outline-section">
                    <div className="outline-section-title">当前文档</div>
                    <div className="outline-items">
                      {documentHeadings.map((heading) => (
                        <button
                          type="button"
                          key={heading.id}
                          className={`outline-item heading-level-${heading.level}`}
                          onClick={() => jumpToHeading(heading.id)}
                        >
                          {heading.label}
                        </button>
                      ))}
                    </div>
                  </section>
                ) : null}
                {knowledgeTree.length ? (
                  <section className="outline-section">
                    <div className="outline-catalog-toggle" data-testid="outline-catalog">
                      <div className="outline-catalog-summary">
                        全部目录 · {knowledgeDocuments.length} 篇
                      </div>
                      <div className="outline-items">{renderKnowledgeTree(knowledgeTree)}</div>
                    </div>
                  </section>
                ) : !documentHeadings.length ? (
                  <p className="empty-copy">
                    {docLoading ? "正在整理知识目录..." : "当前还没有可展开的文档目录。"}
                  </p>
                ) : null}
              </div>
            </aside>
          </div>
        </section>

        {!focusMode ? (
          <div className="workspace-divider-shell" aria-hidden="true">
            <button
              type="button"
              className={isDraggingLayout ? "workspace-divider dragging" : "workspace-divider"}
              aria-label="调整文档区与交互区宽度"
              aria-valuemin={minQaPanelPercent}
              aria-valuemax={maxQaPanelPercent}
              aria-valuenow={Math.round(qaPanelPercent)}
              onPointerDown={handleDividerPointerDown}
              onKeyDown={handleDividerKeyDown}
              onDoubleClick={resetPanelLayout}
              data-testid="workspace-divider"
            >
              <span className="workspace-divider-grip" />
            </button>
          </div>
        ) : null}

        <aside className={`qa-panel qa-panel-${activeWorkspaceMode}${focusMode ? " focus-qa-panel" : ""}${focusQaOpen ? " focus-open" : ""}`} data-testid="qa-panel">
          <header className="qa-header">
            <div className="qa-title-group">
              <strong>{activeWorkspaceMode === "training" ? "训练" : "阅读助理"}</strong>
            </div>
            <span className="qa-header-spacer" />
            <div className="qa-header-controls">
              <div className="workspace-tabs" aria-label="学习模式">
                <button
                  type="button"
                  className={activeWorkspaceMode === "reading" ? "workspace-tab active" : "workspace-tab"}
                  onClick={() => setWorkspaceMode("reading")}
                >
                  <MiniIcon name="book" />
                  阅读
                </button>
                <button
                  type="button"
                  className={activeWorkspaceMode === "training" ? "workspace-tab active" : trainingReadingOnly ? "workspace-tab locked" : "workspace-tab"}
                  onClick={handleTrainingModeClick}
                  disabled={isStarting || isAnswering || trainingReadingOnly}
                  title={trainingReadingOnly ? (activeDocumentProgressEntry?.trainingUnavailableReason || "当前文档暂不支持训练") : "进入训练"}
                >
                  <MiniIcon name="target" />
                  训练
                </button>
              </div>
            </div>
          </header>

          <div className="qa-scroll" ref={qaScrollRef}>
            <section className="chat-stack">
              {activeWorkspaceMode === "reading" ? (
                <button
                  type="button"
                  className={`reading-training-banner tone-${readingTrainingBanner.tone}`}
                  onClick={readingTrainingBanner.clickable ? handleReadingTrainingBannerClick : undefined}
                  disabled={!readingTrainingBanner.clickable}
                >
                  <span className="reading-training-dot" />
                  {readingTrainingBanner.label}
                </button>
              ) : null}
              {activeWorkspaceMode === "reading" ? (
                <article className={readingCompanionHasHistory ? "reading-companion-card compact" : "reading-companion-card"}>
                  <div className="reading-companion-source">阅读助手</div>
                  <h3>问这篇文档</h3>
                  <p>
                    基于原文回答，每条都带出处。默认面向
                    <button
                      type="button"
                      className="reading-perspective-button"
                      onClick={() => setReadingPerspective((value) => (
                        value === "面试准备" ? "系统学习" : value === "系统学习" ? "快速扫描" : value === "快速扫描" ? "深度研究" : "面试准备"
                      ))}
                    >
                      {` ${readingPerspective} `}
                    </button>
                    角度。
                  </p>
                </article>
              ) : null}
              {pendingSubmittedAnswer ? (
                <article className="message-card learner">
                  <div className="message-body">
                    <p>{pendingSubmittedAnswer}</p>
                  </div>
                </article>
              ) : null}
              {activeWorkspaceMode === "training" && isPreparingTraining ? (
                <article className="message-card assistant" aria-live="polite" data-testid="training-prep-card">
                  <div className="message-body">
                    <p>正在准备训练，会先拆解这篇文档的训练点。</p>
                  </div>
                </article>
              ) : null}
              {(
                activeWorkspaceMode === "training"
                  ? trainingChatTimeline.concat(liveTrainingTimeline)
                  : readingChatTimeline
              ).map((entry) => (
                entry.type === "event" ? (
                  <div className="chat-event-row" key={entry.id}>{entry.label}</div>
                ) : activeWorkspaceMode === "reading" ? (
                  <div
                    key={`${entry.id}:group-shell`}
                    className={entry.role === "assistant" ? "chat-message-group assistant-group" : "chat-message-group learner-group"}
                  >
                    <ReadingAssistantBubble entry={entry} onCitationClick={jumpToCitationParagraph} />
                  </div>
                ) : (
                  <div
                    key={`${entry.id}:group-shell`}
                    className={entry.role === "assistant" ? "chat-message-group assistant-group" : "chat-message-group learner-group"}
                  >
                    <article className={entry.role === "assistant" ? `message-card assistant ${entry.isProgressUpdate ? "progress-update" : ""}` : "message-card learner"} key={entry.id}>
                      <div className={`message-body ${entry.role === "assistant" ? "markdown-content" : ""}`}>
                        {entry.role === "assistant"
                          ? renderMarkdownContent(
                              (entry.bodyParts?.length ? entry.bodyParts.join("\n\n") : entry.body) || "",
                              `${entry.id}-assistant`
                            )
                          : (entry.bodyParts?.length ? entry.bodyParts : [entry.body]).filter(Boolean).map((block, index) => (
                              <p key={`${entry.id}:${index}`}>{block}</p>
                            ))}
                        {entry.takeaway ? <p><strong>带走一句：</strong>{entry.takeaway}</p> : null}
                      </div>
                    </article>
                  </div>
                )
              ))}

              {/* Timeline contract:
                  - backend emits append-only turns (intro/evaluation/feedback/question/process/memory)
                  - frontend renders them in order and does not split, reorder, or backfill them */}

              {activeWorkspaceMode === "training" && trainingCompletion && !liveTrainingTimeline.length ? (
                <section className="training-complete-actions-card" data-testid="training-complete-actions" aria-label="训练完成后的下一步操作">
                  {/* The backend feedback:complete turn owns the final summary.
                      This block is intentionally controls-only so replayed chat
                      history stays append-only and never duplicates completion copy. */}
                  <div className="training-complete-actions-copy">
                    <span>下一步</span>
                    <p>总结和长期记忆说明在上方对话。</p>
                  </div>
                  <div className="training-complete-actions">
                    <button type="button" className="secondary-pill" disabled={isStarting || isAnswering || !trainingCompletion.reviewPointId} onClick={reviewWeakPoint}>
                      再练薄弱点
                    </button>
                    <button type="button" className="secondary-pill" disabled={isStarting || isAnswering} onClick={restartTraining}>
                      重新训练一轮
                    </button>
                    <button type="button" className="secondary-pill" disabled={isStarting || isAnswering} onClick={() => {
                      setWorkspaceMode("reading");
                      setTrainingUnlocked(false);
                    }}>
                      回到阅读
                    </button>
                  </div>
                </section>
              ) : null}

              {readingStreamingTurn ? (
                <>
                  <article className="message-card learner">
                    <div className="message-body"><p>{readingStreamingTurn.answer}</p></div>
                  </article>
                  <article className="message-card assistant">
                    <div className="message-body markdown-content">
                      {renderMarkdownContent(
                        splitTextBlocks(normalizeAssistantMarkdown(readingStreamingTurn.assistantText)).length
                          ? splitTextBlocks(normalizeAssistantMarkdown(readingStreamingTurn.assistantText)).join("\n\n")
                          : "正在生成回复...",
                        `${readingStreamingTurn.id}-stream`
                      )}
                    </div>
                  </article>
                </>
              ) : null}
            </section>
          </div>

          <form
            className="composer-shell question-input"
            onSubmit={(event) => {
              event.preventDefault();
              submitAnswer();
            }}
          >
            {shouldShowReadingStarterChips ? (
              <div className="reading-composer-starters" aria-label="阅读助手快捷问题">
                {readingStarterPrompts.map((prompt, index) => (
                  <button
                    key={prompt.label}
                    type="button"
                    className="reading-quick-chip"
                    disabled={isStarting || isAnswering}
                    onClick={() => insertReadingStarterPrompt(prompt)}
                  >
                    <MiniIcon name={index === 0 ? "list" : index === 1 ? "bulb" : "help"} />
                    {prompt.label}
                  </button>
                ))}
              </div>
            ) : null}
            <textarea
              rows="1"
              ref={composerInputRef}
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              onFocus={() => setIsComposerFocused(true)}
              onBlur={() => setIsComposerFocused(false)}
              placeholder={isAnswering ? "已发送，正在等待下一步..." : activeWorkspaceMode === "reading" ? "问任何关于这篇的问题..." : "输入回答、追问，或引用原文段落。"}
            />

            <div className="question-input-row">
              {activeWorkspaceMode === "training" ? (
                <div className="suggested-actions">
                  <button type="button" className="secondary-pill" disabled={!session || isAnswering || !docTrainingReady} onClick={() => submitAnswer({ nextAnswer: "查看解析", intent: "teach" })}>
                    查看解析
                  </button>
                </div>
              ) : null}
              <button type="submit" className="send-button" disabled={isAnswering || !answer.trim()}>
                ↑
              </button>
            </div>
          </form>
        </aside>
      </section>
    </main>
  );
}
