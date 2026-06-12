"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch, postEventStream, postJson } from "../lib/api";
import {
  getLoopAssistRescueDocument,
  getLoopAssistRescuePlaylist,
  markLoopAssistRescueItemLearned,
} from "../lib/loopassist-api";
import { buildReentryPlan, isReadingAction, isTrainingAction } from "../lib/reentry-actions";
import { readHeading, renderMarkdownContent, slugifyHeading } from "../lib/render-markdown-content";
import { getDocumentOutline, getReaderRenderer } from "../lib/document-reader-renderers";
import { TrainingGenerationPanel } from "./training-generation-panel";
import {
  getStoredUserId,
  setStoredUserId,
} from "../lib/user-session";
import { buildChatTimeline } from "../../src/view/chat-transcript";
import { buildVisibleSessionView } from "../../src/view/visible-session-view";
import { ReadingAssistantBubble, ReadingDocumentContent, ReadingSelectionPopover, buildReadingBlocks, buildReadingResumeContext, getDocumentTextForReading, normalizeAssistantMarkdown } from "./learn/reading-content";
import { MiniIcon } from "./learn/shared";
import { RescuePlaylistStrip, TrainingWorkspace, appendCompletedStep, buildTrainingExchanges, buildTrainingStats, buildTrainingStatus, createTrainingWaitState, getCurrentTrainingQuestion, getNextTrainingWaitStep, hasTeachExplanationForCurrentQuestion, normalizeTrainingWaitStepKey, trainingWaitStepKeys } from "./learn/training-session";
import { TrainingCompletionSummaryPage, buildTrainingCompletionSummary } from "./learn/training-summary";

const profileDirtyStorageKey = "learning-loop-profile-dirty-at";
const learnPanelLayoutStorageKey = "learning-loop-learn-panel-layout-v1";
const readerZoomStorageKey = "learning-loop-reader-zoom-v1";
const minQaPanelPercent = 30;
const maxQaPanelPercent = 58;
const minReaderZoom = 70;
const maxReaderZoom = 200;
const readerZoomStep = 10;
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

function resolveInteractionPreferenceFromRules(rules = []) {
  const preferred = (rules || []).find((rule) => rule.id === "preferred-interaction-style");
  if (!preferred) {
    return "";
  }
  if (String(preferred.text || "").includes("先解释")) {
    return "explain-first";
  }
  if (String(preferred.text || "").includes("快问快答")) {
    return "probe-heavy";
  }
  return "balanced";
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
  if (options.intent) {
    params.set("intent", options.intent);
  }
  if (options.autostart) {
    params.set("autostart", "1");
  }
  if (options.focusComposer) {
    params.set("composer", "1");
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

function formatCheckpointProgressLabel(label = "") {
  const value = String(label || "").trim();
  if (!value) {
    return "";
  }
  return value.replace(/\s*\/\s*/g, " / ");
}

function buildReadingReentrySummary(plan, checkpointProgressLabel = "") {
  const primaryKind = plan?.primaryAction?.kind || "";
  const progressText = formatCheckpointProgressLabel(checkpointProgressLabel);

  if (primaryKind === "continue-training") {
    return {
      title: "继续上次训练",
      description: progressText
        ? `你上次练到训练点 ${progressText}，直接续上会更省力。`
        : "你上次有一轮训练没完成，直接续上会更省力。",
      note: "会恢复到上次中断的位置",
      primaryLabel: "继续训练",
      secondaryLabel: "先阅读",
    };
  }

  if (primaryKind === "start-training") {
    return {
      title: "开始这轮训练",
      description: "正文已经读完，趁上下文还热着练一轮最划算。",
      note: "会直接进入当前文档训练",
      primaryLabel: "开始训练",
      secondaryLabel: "先阅读",
    };
  }

  if (primaryKind === "restart-training") {
    return {
      title: "补上这轮训练",
      description: "你上次按仅阅读收尾了；如果这篇现在变重要，直接开练会比重看更快。",
      note: "会重新开始当前文档训练",
      primaryLabel: "重新训练",
      secondaryLabel: "先阅读",
    };
  }

  if (primaryKind === "quick-review") {
    return {
      title: "来一轮快速复习",
      description: "这篇你之前已经练过，先把薄弱点拉回来会更有效。",
      note: "会优先回到当前最需要复习的点",
      primaryLabel: "快速复习",
      secondaryLabel: "先阅读",
    };
  }

  return null;
}

function ReadingReentryCard({
  plan,
  checkpointProgressLabel = "",
  disabled = false,
  onPrimaryAction,
  onDismiss,
}) {
  const summary = buildReadingReentrySummary(plan, checkpointProgressLabel);
  if (!plan || !summary) {
    return null;
  }

  return (
    <section className="reading-reentry-card" data-testid="reading-reentry-card">
      <div className="reading-reentry-copy">
        <span className="reading-reentry-kicker">训练提醒</span>
        <strong className="reading-reentry-title">{summary.title}</strong>
        <p className="reading-reentry-reason">{summary.description}</p>
        <p className="reading-reentry-status">{summary.note}</p>
      </div>
      <div className="reading-reentry-actions">
        {plan.primaryAction?.passive ? (
          <span className="reading-reentry-passive">{plan.primaryAction.label}</span>
        ) : (
          <button
            type="button"
            className="reading-reentry-primary"
            data-testid="reading-reentry-primary"
            disabled={disabled}
            onClick={() => onPrimaryAction(plan.primaryAction)}
          >
            {summary.primaryLabel}
          </button>
        )}
        <button
          type="button"
          className="reading-reentry-secondary-button"
          data-testid="reading-reentry-dismiss"
          disabled={disabled}
          onClick={onDismiss}
        >
          {summary.secondaryLabel}
        </button>
      </div>
    </section>
  );
}

function ReviewDrillWorkspace({
  drill,
  answer,
  setAnswer,
  loading,
  error,
  onSubmit,
  onRefreshQuestion,
  onHome,
}) {
  const item = drill?.reviewItem || {};
  const evidence = item.evidence || {};
  const missedAnchors = Array.isArray(evidence.missedAnchors) ? evidence.missedAnchors : [];
  const misses = Array.isArray(drill?.judgment?.misses) ? drill.judgment.misses : [];
  const hits = Array.isArray(drill?.judgment?.hits) ? drill.judgment.hits : [];
  const answered = Boolean(drill?.judgment);
  const passed = Boolean(drill?.passed);
  const stateLabel = item.state === "solid" ? "扎实" : "生疏";

  return (
    <main className="learn-shell ll-review-drill-page" data-testid="review-drill-workspace">
      <header className="ll-training-topbar">
        <div className="ll-training-title">
          <button type="button" className="ll-training-back" onClick={onHome}>‹</button>
          <div>
            <span>今日复习</span>
            <h1>{item.handle || "复习项重练"}</h1>
          </div>
        </div>
        <div className="ll-training-tabs">
          <button type="button" className="active">复练</button>
          <button type="button" onClick={onHome}>回首页</button>
        </div>
      </header>

      {error ? <section className="feedback-banner error-banner narrow-banner">{error}</section> : null}

      <section className="ll-review-drill-main">
        <article className="ll-training-card ll-review-drill-card">
          <div className="ll-training-card-chip-row">
            <span className="ll-training-chip">{`失败账本 · ${stateLabel}`}</span>
            <span className="ll-training-status-label">{drill?.source?.available ? "已带原文上下文" : "无原文也可练"}</span>
          </div>
          <h2>{drill?.question || "正在生成这条复习项的变体题..."}</h2>
          {evidence.question ? (
            <div className="ll-review-drill-evidence">
              <span>上次答崩的问题</span>
              <p>{evidence.question}</p>
            </div>
          ) : null}
          {missedAnchors.length ? (
            <div className="ll-review-drill-anchor-list">
              {missedAnchors.map((anchor) => (
                <span key={anchor}>{anchor}</span>
              ))}
            </div>
          ) : null}

          {!answered ? (
            <form
              className="ll-next-answer-form"
              onSubmit={(event) => {
                event.preventDefault();
                onSubmit();
              }}
            >
              <textarea
                rows="6"
                value={answer}
                onChange={(event) => setAnswer(event.target.value)}
                placeholder="一次性写下你的回答。先结论，再机制、边界和取舍。"
                disabled={loading || !drill?.question}
              />
              <div className="ll-next-answer-actions">
                <button type="button" className="ll-tool-button" onClick={onRefreshQuestion} disabled={loading}>
                  换一道变体
                </button>
                <button type="submit" className="ll-training-primary" disabled={loading || !answer.trim() || !drill?.question}>
                  {loading ? "判分中..." : "提交回答"}
                </button>
              </div>
            </form>
          ) : (
            <section className="ll-review-drill-result">
              <div
                className={`ll-thread-score-summary tone-${passed ? "solid" : "weak"}`}
                style={{
                  "--thread-score-color": passed ? "#1D9E75" : "#E27272",
                }}
              >
                <div className="ll-thread-score-main">
                  <strong>{passed ? "过线，已转扎实" : "还没过线，已安排复练"}</strong>
                  <span>{passed ? "solid" : "shaky"}</span>
                </div>
                <p>{passed ? "这条复习项会被拉长间隔，暂时放你走。" : "这条复习项仍保留在短间隔队列里，先补上漏点。"}</p>
              </div>
              <div className="ll-thread-message user">
                <div className="ll-answer-label">你的回答</div>
                <pre className="ll-answer-snapshot">{drill.answer}</pre>
              </div>
              {hits.length || misses.length ? (
                <div className="ll-thread-support-grid">
                  {hits.length ? (
                    <article className="ll-thread-support-card takeaway">
                      <strong>命中的锚点</strong>
                      <p>{hits.join("；")}</p>
                    </article>
                  ) : null}
                  {misses.length ? (
                    <article className="ll-thread-support-card improve">
                      <strong>漏掉的锚点</strong>
                      <p>{misses.join("；")}</p>
                    </article>
                  ) : null}
                </div>
              ) : null}
              {!passed && drill.rescue?.markdown ? (
                <div className="ll-thread-message assistant explanation">
                  <TrainingGenerationPanel
                    embedded
                    complete
                    markdown={drill.rescue.markdown}
                    testId="review-drill-rescue-card"
                  />
                </div>
              ) : null}
              <div className="ll-next-answer-actions">
                <button type="button" className="ll-tool-button" onClick={onRefreshQuestion} disabled={loading}>
                  再来一道变体
                </button>
                <button type="button" className="ll-training-primary" onClick={onHome}>
                  回今日队列
                </button>
              </div>
            </section>
          )}
        </article>
      </section>
    </main>
  );
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

export function LearnWorkspace() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const searchParamsString = searchParams.toString();
  const focusParamEnabled = searchParams.get("focus") === "1";
  const rescuePlaylistId = searchParams.get("rescuePlaylist") || "";
  const rescueItemIdParam = searchParams.get("rescueItem") || "";
  const reviewItemId = searchParams.get("reviewItem") || "";
  const autostartRef = useRef(false);
  const entryIntentHandledRef = useRef("");
  const resumePositionAppliedRef = useRef("");
  const conceptFocusRef = useRef("");
  const readingProgressRef = useRef("");
  const progressDocumentPathRef = useRef("");
  const trainingAnswerStreamAbortRef = useRef(null);
  const rescueAutoAdvanceRef = useRef("");
  const readerBodyRef = useRef(null);
  const qaScrollRef = useRef(null);
  const studyMainRef = useRef(null);
  const composerInputRef = useRef(null);
  const [profile, setProfile] = useState(null);
  const [knowledgeDocuments, setKnowledgeDocuments] = useState([]);
  const [interactionPreference, setInteractionPreference] = useState("balanced");
  const [session, setSession] = useState(null);
  const [answer, setAnswer] = useState("");
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
  const [dismissedReentrySignature, setDismissedReentrySignature] = useState("");
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
  const [rescuePlaylist, setRescuePlaylist] = useState(null);
  const [rescuePlaylistMenuOpen, setRescuePlaylistMenuOpen] = useState(false);
  const [rescueDocumentPayload, setRescueDocumentPayload] = useState(null);
  const [reviewDrill, setReviewDrill] = useState(null);
  const [reviewDrillAnswer, setReviewDrillAnswer] = useState("");
  const [reviewDrillLoading, setReviewDrillLoading] = useState(false);
  const [reviewDrillError, setReviewDrillError] = useState("");
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
    if (!reviewItemId) {
      setReviewDrill(null);
      setReviewDrillAnswer("");
      setReviewDrillError("");
      setReviewDrillLoading(false);
      return;
    }

    let cancelled = false;
    async function loadReviewDrill() {
      try {
        setReviewDrillLoading(true);
        setReviewDrillError("");
        setReviewDrillAnswer("");
        const data = await postJson(`/api/review/${encodeURIComponent(reviewItemId)}/drill`, {
          action: "start",
          userId: getStoredUserId(),
        });
        if (!cancelled) {
          setReviewDrill(data);
        }
      } catch (nextError) {
        if (!cancelled) {
          setReviewDrillError(nextError.message || "复习题生成失败。");
        }
      } finally {
        if (!cancelled) {
          setReviewDrillLoading(false);
        }
      }
    }

    void loadReviewDrill();
    return () => {
      cancelled = true;
    };
  }, [reviewItemId]);

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
      .then((data) => {
        setProfile(data);
        const preferred = resolveInteractionPreferenceFromRules(data.userRules || []);
        if (preferred) {
          setInteractionPreference(preferred);
        }
      })
      .catch(() => setStoredUserId(""));
  }, []);

  useEffect(() => {
    if (!rescuePlaylistId) {
      setRescuePlaylist(null);
      setRescueDocumentPayload(null);
      setRescuePlaylistMenuOpen(false);
      return;
    }
    let cancelled = false;
    getLoopAssistRescuePlaylist(rescuePlaylistId)
      .then((data) => {
        if (!cancelled) {
          setRescuePlaylist(data?.playlist || null);
        }
      })
      .catch((nextError) => {
        if (!cancelled) {
          setError(nextError.message || "补救清单加载失败。");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [rescuePlaylistId]);

  useEffect(() => {
    if (!rescuePlaylist?.id) {
      return undefined;
    }
    const hasPendingItems = (rescuePlaylist.items || []).some((item) => item?.status === "pending" || item?.status === "gen");
    if (!hasPendingItems) {
      return undefined;
    }
    let cancelled = false;
    const timerId = window.setInterval(() => {
      getLoopAssistRescuePlaylist(rescuePlaylist.id)
        .then((data) => {
          if (!cancelled) {
            setRescuePlaylist(data?.playlist || null);
          }
        })
        .catch(() => {});
    }, 1200);
    return () => {
      cancelled = true;
      window.clearInterval(timerId);
    };
  }, [rescuePlaylist]);

  const currentCheckpoint = useMemo(
    () => (session?.concepts || []).find((concept) => concept.id === session?.currentCheckpointId) || null,
    [session]
  );
  const currentTrainingPoint = useMemo(
    () => (session?.trainingPoints || []).find((point) => point.id === session?.currentTrainingPointId) || null,
    [session]
  );
  const currentSource = getSourceRefs(currentCheckpoint)[0] || getSourceRefs(currentTrainingPoint)[0] || session?.summary?.sourceClusters?.[0] || null;
  const rescueItems = rescuePlaylist?.items || [];
  const rescueActiveItem = useMemo(() => (
    rescueItems.find((item) => item.id === rescueItemIdParam)
    || rescueItems.find((item) => item.id === rescuePlaylist?.firstReadyItemId)
    || rescueItems[0]
    || null
  ), [rescueItemIdParam, rescueItems, rescuePlaylist?.firstReadyItemId]);
  const rescueDocumentPath = rescueDocumentPayload?.documentPath
    || rescueActiveItem?.docPath
    || (rescueActiveItem ? `rescue://${rescuePlaylistId}/${rescueActiveItem.id}` : "");
  const activeDocPath = reviewItemId ? "" : (rescueDocumentPath || searchParams.get("doc") || currentSource?.path || knowledgeDocuments[0]?.path || "");
  const documentTitle = knowledgeDoc?.title || currentSource?.title || "开始学习";
  const autostart = searchParams.get("autostart") === "1";
  const entryIntent = searchParams.get("intent") || "";
  const focusComposerOnLoad = searchParams.get("composer") === "1";
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
  const reentryPlan = useMemo(
    () => buildReentryPlan({
      path: activeDocPath,
      title: documentTitle,
      progressPercentage: visibleReadProgressPercent,
      readingPreview: activeDocumentProgressEntry?.readingPreview || "",
      readingChapter: activeDocumentProgressEntry?.readingChapter || "",
      trainingStarted,
      trainingCompleted,
      trainingSkipped,
      trainingAvailability: activeDocumentProgressEntry?.trainingAvailability || "",
      trainingCheckpointProgressLabel: activeDocumentProgressEntry?.trainingCheckpointProgressLabel || "",
      trainingAnswerCount: activeDocumentProgressEntry?.trainingAnswerCount || 0,
      assessedConceptCount: activeDocumentProgressEntry?.assessedConceptCount || 0,
      lastActivityAt: activeDocumentProgressEntry?.lastActivityAt || "",
      ignored: isDocumentIgnored,
    }),
    [
      activeDocPath,
      documentTitle,
      visibleReadProgressPercent,
      activeDocumentProgressEntry,
      trainingStarted,
      trainingCompleted,
      trainingSkipped,
      isDocumentIgnored,
    ]
  );
  const weakestDocConceptId = useMemo(() => {
    const recommendedSummary = (profile?.sessionSummaries || []).find((entry) => entry.docPath === activeDocPath);
    if (recommendedSummary?.recommendedNextCheckpointId) {
      return recommendedSummary.recommendedNextCheckpointId;
    }
    const allItems = (profile?.targets || []).flatMap((target) => target?.domains || []).flatMap((domain) => domain?.items || []);
    const candidates = allItems
      .filter((item) => item?.primaryDocPath === activeDocPath)
      .sort((left, right) => {
        const leftScore = Number(left?.progressPercentage || 0);
        const rightScore = Number(right?.progressPercentage || 0);
        if (leftScore !== rightScore) {
          return leftScore - rightScore;
        }
        return Number(right?.evidenceCount || 0) - Number(left?.evidenceCount || 0);
      });
    return candidates[0]?.checkpointId || "";
  }, [activeDocPath, profile?.sessionSummaries, profile?.targets]);
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
    }),
    [activeDocPath, docConcepts, documentTitle, session, trainingExchanges]
  );
  const trainingSystemStatus = useMemo(() => buildTrainingStatus({
    isStarting: isPreparingTraining,
    isAnswering,
    liveTurns: liveTrainingTurns,
    error,
    session,
    stats: trainingStats,
  }), [error, isAnswering, isPreparingTraining, liveTrainingTurns, session, trainingStats]);
  const reentrySignature = `${activeDocPath}:${reentryPlan.primaryAction?.kind || ""}:${activeDocumentProgressEntry?.trainingCheckpointProgressLabel || ""}`;
  const shouldShowReadingReentry = activeWorkspaceMode === "reading"
    && Boolean(buildReadingReentrySummary(reentryPlan, activeDocumentProgressEntry?.trainingCheckpointProgressLabel || ""))
    && dismissedReentrySignature !== reentrySignature;

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
    if (!autostart || entryIntent || autostartRef.current || !profile?.user?.id || session) {
      return;
    }
    autostartRef.current = true;
    void startSession({ mode: "reading" });
  }, [autostart, entryIntent, profile, session]);

  useEffect(() => {
    if (!session?.sessionId || !desiredConceptId || session.currentTrainingPointId === desiredConceptId || conceptFocusRef.current === desiredConceptId) {
      return;
    }
    conceptFocusRef.current = desiredConceptId;
    void focusConcept(desiredConceptId);
  }, [desiredConceptId, session]);

  useEffect(() => {
    if (!focusComposerOnLoad) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      composerInputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusComposerOnLoad, activeDocPath]);

  useEffect(() => {
    if (!entryIntent || !profile?.user?.id || !activeDocPath) {
      return;
    }
    const signature = `${activeDocPath}:${entryIntent}`;
    if (entryIntentHandledRef.current === signature) {
      return;
    }
    entryIntentHandledRef.current = signature;

    let cancelled = false;

    async function handleEntryIntent() {
      if (entryIntent === "ask-document") {
        if (cancelled) {
          return;
        }
        focusReadingComposer();
        clearEntryRoutingParams();
        return;
      }

      if (entryIntent === "restart-training") {
        if (cancelled) {
          return;
        }
        await restartTraining();
        if (!cancelled) {
          clearEntryRoutingParams();
        }
        return;
      }

      if (entryIntent === "quick-review") {
        if (cancelled) {
          return;
        }
        await reviewWeakestConcept();
        if (!cancelled) {
          clearEntryRoutingParams();
        }
        return;
      }

      if (entryIntent === "continue-training" || entryIntent === "start-training") {
        if (cancelled) {
          return;
        }
        await unlockTraining();
        if (!cancelled) {
          clearEntryRoutingParams();
        }
        return;
      }

      if (entryIntent === "continue-reading" || entryIntent === "open-document") {
        if (cancelled) {
          return;
        }
        setWorkspaceMode("reading");
        window.setTimeout(() => {
          if (!cancelled) {
            restoreReaderScrollFromProgress();
          }
        }, 150);
        window.setTimeout(() => {
          if (!cancelled) {
            clearEntryRoutingParams();
          }
        }, 320);
      }
    }

    void handleEntryIntent();

    return () => {
      cancelled = true;
    };
  }, [activeDocPath, entryIntent, profile?.user?.id]);

  useEffect(() => {
    const readerBody = readerBodyRef.current;
    if (!readerBody || !knowledgeDoc?.path || storedReadProgressPercent <= 0) {
      return;
    }
    const signature = `${activeDocPath}:${storedReadProgressPercent}:${readerSourceView}`;
    if (resumePositionAppliedRef.current === signature) {
      return;
    }
    let frame = 0;
    let attempts = 0;

    function restoreScrollPosition() {
      attempts += 1;
      const scrollableHeight = readerBody.scrollHeight - readerBody.clientHeight;
      if (scrollableHeight > 8) {
        const targetTop = (storedReadProgressPercent / 100) * scrollableHeight;
        readerBody.scrollTop = targetTop;
        const reachedTarget = Math.abs(readerBody.scrollTop - targetTop) < 2 || readerBody.scrollTop > 0;
        if (reachedTarget) {
          resumePositionAppliedRef.current = signature;
          return;
        }
      }
      if (attempts < 24) {
        frame = window.requestAnimationFrame(restoreScrollPosition);
      }
    }

    frame = window.requestAnimationFrame(restoreScrollPosition);
    return () => window.cancelAnimationFrame(frame);
  }, [activeDocPath, knowledgeDoc?.path, readerSourceView, storedReadProgressPercent]);

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
    if (!rescuePlaylistId) {
      return;
    }
    setSession(null);
    setTrainingUnlocked(false);
    setWorkspaceMode("reading");
    setAnswer("");
    setReadingStreamingTurn(null);
    setLiveTrainingTurns([]);
    setReadingChatTimeline([]);
  }, [rescueActiveItem?.id, rescuePlaylistId]);

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
    if (!rescuePlaylistId || !rescueActiveItem?.id) {
      setRescueDocumentPayload(null);
      return;
    }
    if (rescueActiveItem.docPath) {
      setRescueDocumentPayload({
        item: rescueActiveItem,
        documentPath: rescueActiveItem.docPath,
        document: null,
      });
      return;
    }
    let cancelled = false;
    getLoopAssistRescueDocument({
      playlistId: rescuePlaylistId,
      itemId: rescueActiveItem.id,
    })
      .then((data) => {
        if (!cancelled) {
          setRescueDocumentPayload(data);
        }
      })
      .catch((nextError) => {
        if (!cancelled) {
          setRescueDocumentPayload(null);
          setError(nextError.message || "补救材料暂时还没准备好。");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [rescueActiveItem?.docPath, rescueActiveItem?.id, rescuePlaylistId]);

  useEffect(() => {
    if (!rescuePlaylistId || !rescueActiveItem?.id || !trainingCompletion) {
      return;
    }
    const signature = `${rescuePlaylistId}:${rescueActiveItem.id}`;
    if (rescueAutoAdvanceRef.current === signature) {
      return;
    }
    rescueAutoAdvanceRef.current = signature;
    let cancelled = false;
    markLoopAssistRescueItemLearned({
      playlistId: rescuePlaylistId,
      itemId: rescueActiveItem.id,
    })
      .then((data) => {
        if (cancelled) {
          return;
        }
        const nextPlaylist = data?.playlist || null;
        setRescuePlaylist(nextPlaylist);
        setSummaryDismissed(true);
        setTrainingUnlocked(false);
        setWorkspaceMode("reading");
        const items = nextPlaylist?.items || [];
        const currentIndex = items.findIndex((item) => item.id === rescueActiveItem.id);
        const nextItem = items.find((item, index) => index > currentIndex && (item.status === "ready" || item.status === "learned"));
        if (nextItem) {
          window.setTimeout(() => {
            if (!cancelled) {
              const params = new URLSearchParams(searchParamsString);
              params.set("rescuePlaylist", rescuePlaylistId);
              params.set("rescueItem", nextItem.id);
              router.replace(`/learn?${params.toString()}`, { scroll: false });
            }
          }, 220);
        }
      })
      .catch((nextError) => {
        if (!cancelled) {
          setError(nextError.message || "更新补救进度失败。");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [rescueActiveItem?.id, rescuePlaylistId, router, searchParamsString, trainingCompletion]);

  useEffect(() => {
    if (!rescuePlaylistId || rescueActiveItem?.status !== "learned") {
      return;
    }
    const items = rescuePlaylist?.items || [];
    const currentIndex = items.findIndex((item) => item.id === rescueActiveItem.id);
    const nextItem = items.find((item, index) => index > currentIndex && (item.status === "ready" || item.status === "learned"));
    if (!nextItem || nextItem.id === rescueActiveItem.id) {
      return;
    }
    const params = new URLSearchParams(searchParamsString);
    params.set("rescuePlaylist", rescuePlaylistId);
    params.set("rescueItem", nextItem.id);
    router.replace(`/learn?${params.toString()}`, { scroll: false });
  }, [rescueActiveItem?.id, rescueActiveItem?.status, rescuePlaylist, rescuePlaylistId, router, searchParamsString]);

  useEffect(() => {
    if (!activeDocPath) {
      setKnowledgeDoc(null);
      setDocError("");
      setDocLoading(false);
      return;
    }

    if (rescueDocumentPayload?.document) {
      setKnowledgeDoc(rescueDocumentPayload.document);
      setDocError("");
      setDocLoading(false);
      setReaderSourceView("learning");
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
  }, [activeDocPath, profile?.user?.id, rescueDocumentPayload?.document]);

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
      domainId: conceptForDoc?.domainId || conceptForDoc?.abilityDomainId || "",
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
    const preferred = resolveInteractionPreferenceFromRules(data.userRules || []);
    if (preferred) {
      setInteractionPreference(preferred);
    }
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
    setTrainingUnlocked(true);
    setWorkspaceMode("training");
    let nextSession = sessionBelongsToDocument(session, activeDocPath) ? session : null;
    if (!nextSession) {
      nextSession = await startSession({ mode: "training" });
    }
    if (!nextSession) {
      setTrainingUnlocked(false);
      setWorkspaceMode("reading");
      return;
    }
    setLocallySkippedTrainingPaths((items) => items.filter((item) => item !== activeDocPath));
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

  function focusReadingComposer() {
    setWorkspaceMode("reading");
    window.requestAnimationFrame(() => {
      composerInputRef.current?.focus();
    });
  }

  function clearEntryRoutingParams() {
    const params = new URLSearchParams(searchParamsString);
    params.delete("intent");
    params.delete("composer");
    params.delete("autostart");
    const nextQuery = params.toString();
    router.replace(nextQuery ? `/learn?${nextQuery}` : "/learn", { scroll: false });
  }

  function navigateToRescueItem(itemId, { replace = true } = {}) {
    if (!rescuePlaylistId || !itemId) {
      return;
    }
    const params = new URLSearchParams(searchParamsString);
    params.set("rescuePlaylist", rescuePlaylistId);
    params.set("rescueItem", itemId);
    const nextHref = `/learn?${params.toString()}`;
    if (replace) {
      router.replace(nextHref, { scroll: false });
    } else {
      router.push(nextHref);
    }
    setRescuePlaylistMenuOpen(false);
  }

  function openNextRescueItem() {
    const items = rescuePlaylist?.items || [];
    const currentIndex = items.findIndex((item) => item.id === rescueActiveItem?.id);
    const nextItem = items.find((item, index) => index > currentIndex && (item.status === "ready" || item.status === "learned"));
    if (nextItem) {
      navigateToRescueItem(nextItem.id);
    }
  }

  function restoreReaderScrollFromProgress() {
    if (storedReadProgressPercent <= 0) {
      return;
    }
    const readerBody = readerBodyRef.current;
    const bodyScrollableHeight = readerBody
      ? (readerBody.scrollHeight - readerBody.clientHeight)
      : 0;

    if (readerBody && bodyScrollableHeight > 8) {
      readerBody.scrollTop = (storedReadProgressPercent / 100) * bodyScrollableHeight;
      return;
    }

    const pageScrollableHeight = document.documentElement.scrollHeight - window.innerHeight;
    if (pageScrollableHeight > 8) {
      window.scrollTo({
        top: (storedReadProgressPercent / 100) * pageScrollableHeight,
        behavior: "auto",
      });
    }
  }

  async function reviewWeakestConcept() {
    setTrainingUnlocked(true);
    setWorkspaceMode("training");
    setSummaryDismissed(true);
    setAnswer("");
    const activeSession = await ensureSessionForReading();
    if (!activeSession) {
      return;
    }
    if (weakestDocConceptId) {
      await focusConcept(weakestDocConceptId, activeSession.sessionId);
      return;
    }
    await unlockTraining();
  }

  async function performReentryAction(action) {
    if (!action || isStarting || isAnswering) {
      return;
    }

    if (action.kind === "ask-document") {
      focusReadingComposer();
      return;
    }

    if (action.kind === "restart-training") {
      await restartTraining();
      return;
    }

    if (action.kind === "quick-review") {
      await reviewWeakestConcept();
      return;
    }

    if (action.kind === "weak-point-review") {
      await reviewWeakPoint();
      return;
    }

    if (isTrainingAction(action)) {
      await unlockTraining();
      return;
    }

    if (isReadingAction(action)) {
      setWorkspaceMode("reading");
    }
  }

  function dismissReadingReentry() {
    setDismissedReentrySignature(reentrySignature);
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

  async function refreshReviewDrillQuestion() {
    if (!reviewItemId) {
      return;
    }
    try {
      setReviewDrillLoading(true);
      setReviewDrillError("");
      setReviewDrillAnswer("");
      const data = await postJson(`/api/review/${encodeURIComponent(reviewItemId)}/drill`, {
        action: "start",
        userId: profile?.user?.id || getStoredUserId(),
      });
      setReviewDrill(data);
    } catch (nextError) {
      setReviewDrillError(nextError.message || "复习题生成失败。");
    } finally {
      setReviewDrillLoading(false);
    }
  }

  async function submitReviewDrillAnswer() {
    const submittedAnswer = reviewDrillAnswer.trim();
    if (!reviewItemId || !reviewDrill?.question || !submittedAnswer) {
      return;
    }
    try {
      setReviewDrillLoading(true);
      setReviewDrillError("");
      const data = await postJson(`/api/review/${encodeURIComponent(reviewItemId)}/drill`, {
        action: "answer",
        userId: profile?.user?.id || getStoredUserId(),
        question: reviewDrill.question,
        answer: submittedAnswer,
      });
      setReviewDrill(data);
      setReviewDrillAnswer("");
    } catch (nextError) {
      setReviewDrillError(nextError.message || "复习判分失败。");
    } finally {
      setReviewDrillLoading(false);
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

  async function focusConcept(conceptId, sessionId = session?.sessionId) {
    if (!sessionId) {
      return;
    }
    try {
      setError("");
      setOutlineOpen(false);
      const nextSession = await postJson("/api/interview/focus-concept", {
        sessionId,
        conceptId,
      });
      setSession(nextSession);
      return nextSession;
    } catch (nextError) {
      setError(nextError.message);
      return null;
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
  const rescuePlaylistStrip = rescuePlaylist?.id && rescueActiveItem ? (
    <RescuePlaylistStrip
      playlist={rescuePlaylist}
      activeItemId={rescueActiveItem.id}
      menuOpen={rescuePlaylistMenuOpen}
      onToggleMenu={() => setRescuePlaylistMenuOpen((value) => !value)}
      onSelectItem={(itemId) => navigateToRescueItem(itemId)}
      onNextItem={openNextRescueItem}
    />
  ) : null;

  if (reviewItemId) {
    return (
      <ReviewDrillWorkspace
        drill={reviewDrill}
        answer={reviewDrillAnswer}
        setAnswer={setReviewDrillAnswer}
        loading={reviewDrillLoading}
        error={reviewDrillError}
        onSubmit={submitReviewDrillAnswer}
        onRefreshQuestion={refreshReviewDrillQuestion}
        onHome={() => router.push("/?mode=status&panel=home")}
      />
    );
  }

  if (activeWorkspaceMode === "training" && trainingCompletion && !summaryDismissed && !liveTrainingTimeline.length && !rescuePlaylistId) {
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
        session={session}
        exchanges={trainingExchanges}
        currentQuestion={currentTrainingQuestion}
        stats={trainingStats}
        answer={answer}
        setAnswer={setAnswer}
        isAnswering={isAnswering}
        trainingWaitState={trainingWaitState}
        isPreparingTraining={isPreparingTraining}
        currentQuestionHasTeachExplanation={currentQuestionHasTeachExplanation}
        onSubmit={() => submitAnswer()}
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
        rescuePlaylistStrip={rescuePlaylistStrip}
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
          {rescuePlaylistStrip}
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
              {shouldShowReadingReentry ? (
                <ReadingReentryCard
                  plan={reentryPlan}
                  checkpointProgressLabel={activeDocumentProgressEntry?.trainingCheckpointProgressLabel || ""}
                  disabled={isStarting || isAnswering}
                  onPrimaryAction={performReentryAction}
                  onDismiss={dismissReadingReentry}
                />
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
