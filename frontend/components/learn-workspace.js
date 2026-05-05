"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch, postEventStream, postJson } from "../lib/api";
import { readHeading, renderMarkdownContent, slugifyHeading } from "../lib/render-markdown-content";
import {
  getStoredUserId,
  setStoredUserId,
} from "../lib/user-session";
import { buildChatTimeline } from "../../src/view/chat-transcript";
import { buildVisibleSessionView } from "../../src/view/visible-session-view";

const profileDirtyStorageKey = "learning-loop-profile-dirty-at";
const learnPanelLayoutStorageKey = "learning-loop-learn-panel-layout-v1";
const minQaPanelPercent = 30;
const maxQaPanelPercent = 58;

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

function splitTextBlocks(value) {
  return String(value || "")
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean);
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
    (point.javaGuideSources || []).some((source) => source.path === docPath)
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
  const focusParamEnabled = searchParams.get("focus") === "1";
  const autostartRef = useRef(false);
  const conceptFocusRef = useRef("");
  const readingProgressRef = useRef("");
  const readerBodyRef = useRef(null);
  const qaScrollRef = useRef(null);
  const studyMainRef = useRef(null);
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
  const [readingChatTimeline, setReadingChatTimeline] = useState([]);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [knowledgeDoc, setKnowledgeDoc] = useState(null);
  const [docLoading, setDocLoading] = useState(false);
  const [docError, setDocError] = useState("");
  const [workspaceMode, setWorkspaceMode] = useState("reading");
  const [trainingUnlocked, setTrainingUnlocked] = useState(false);
  const [focusMode, setFocusMode] = useState(focusParamEnabled);
  const [panelLayout, setPanelLayout] = useState({
    mode: "auto",
    qaPercent: null,
  });
  const [panelLayoutLoaded, setPanelLayoutLoaded] = useState(false);
  const [isDraggingLayout, setIsDraggingLayout] = useState(false);
  const [isComposerFocused, setIsComposerFocused] = useState(false);
  const [sessionIdCopied, setSessionIdCopied] = useState(false);
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
    setPanelLayoutLoaded(true);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !panelLayoutLoaded) {
      return;
    }
    window.localStorage.setItem(learnPanelLayoutStorageKey, JSON.stringify(panelLayout));
  }, [panelLayout, panelLayoutLoaded]);

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
  const currentSource = currentCheckpoint?.javaGuideSources?.[0] || currentTrainingPoint?.javaGuideSources?.[0] || session?.summary?.javaGuideSourceClusters?.[0] || null;
  const activeDocPath = searchParams.get("doc") || currentSource?.path || knowledgeDocuments[0]?.path || "";
  const autostart = searchParams.get("autostart") === "1";
  const desiredConceptId = searchParams.get("concept") || "";
  const docConcepts = useMemo(
    () => (session?.trainingPoints || []).filter((point) =>
      (point.javaGuideSources || []).some((source) => source.path === activeDocPath)
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
    () => buildDocumentHeadings(knowledgeDoc?.markdown || ""),
    [knowledgeDoc?.markdown]
  );
  const activeDocumentProgressEntry = profile?.documentProgress?.docs?.[activeDocPath] || null;
  const trainingCtaLabel = getTrainingCtaLabel(activeDocumentProgressEntry);
  const visibleSessionId = session?.sessionId || activeDocumentProgressEntry?.activeSessionId || "";
  const outlineAvailable = documentHeadings.length > 0 || knowledgeTree.length > 0;
  const isPreparingTraining = isStarting && sessionStartMode === "training";
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

  function scrollQaToBottom(behavior = "auto") {
    if (!qaScrollRef.current) {
      return;
    }
    qaScrollRef.current.scrollTo({
      top: qaScrollRef.current.scrollHeight,
      behavior,
    });
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
    setStreamingTurn(null);
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

    apiFetch(`/api/knowledge/doc?path=${encodeURIComponent(activeDocPath)}`)
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
  }, [activeDocPath]);

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
  }, [knowledgeDoc?.path, knowledgeDoc?.markdown]);

  useEffect(() => {
    if (!profile?.user?.id || !activeDocPath) {
      return;
    }

    const conceptForDoc = currentTrainingPoint && (currentTrainingPoint.javaGuideSources || []).some((source) => source.path === activeDocPath)
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

    let maxScrollRatio = 0;
    let lastSentAt = 0;
    let timeoutId = null;
    const startedAt = Date.now();

    function calculateScrollRatio() {
      const scrollableHeight = readerBody.scrollHeight - readerBody.clientHeight;
      if (scrollableHeight <= 0) {
        return 1;
      }
      return Math.min(1, Math.max(0, readerBody.scrollTop / scrollableHeight));
    }

    function markProfileDirty() {
      window.localStorage.setItem(profileDirtyStorageKey, String(Date.now()));
    }

    function sendProgress(force = false) {
      maxScrollRatio = Math.max(maxScrollRatio, calculateScrollRatio());
      const dwellMs = Date.now() - startedAt;
      const now = Date.now();

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
        }),
        keepalive: true,
      })
        .then(markProfileDirty)
        .catch(() => {});
    }

    function scheduleProgressSend() {
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

    sendProgress(false);
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
  }, [activeDocPath, knowledgeDoc?.path, knowledgeDoc?.title, profile?.user?.id]);

  async function refreshProfile() {
    if (!profile?.user?.id) {
      return;
    }
    const data = await apiFetch(`/api/profile/${profile.user.id}`);
    setProfile(data);
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
    setTrainingUnlocked(true);
    setWorkspaceMode("training");
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
    await focusConcept(trainingCompletion.reviewPointId);
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
    try {
      setError("");
      setIsAnswering(true);
      setLiveTrainingTurns([]);
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
          }
          if (event === "turn_patch" && data.turnId) {
            setLiveTrainingTurns((items) => patchLiveTurn(items, data));
          }
          if (event === "turn_result" || event === "session") {
            finalSession = data;
            setSession(data);
            setAnswer("");
            setLiveTrainingTurns([]);
          }
          if (event === "error") {
            throw new Error(data.error || "流式回答失败。");
          }
        }
      );

      if (finalSession) {
        await refreshProfile();
      }
    } catch (nextError) {
      setError(nextError.message);
      if (shouldClearComposer) {
        setAnswer(submittedAnswer);
      }
    } finally {
      setIsAnswering(false);
      if (!finalSession) {
        setLiveTrainingTurns([]);
      }
    }
  }

  async function submitReadingQuestion({ nextAnswer = answer, goal = "interview", taskType = "freeform" } = {}) {
    const submittedAnswer = nextAnswer.trim();
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
        answer: submittedAnswer,
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
          body: submittedAnswer,
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

  const documentTitle = knowledgeDoc?.title || currentSource?.title || "开始学习";
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
      label: "生成自测问题",
      taskType: "question_points",
      value: `请基于面试准备目标，把《${documentTitle}》这篇文档的关键点转化为自测问题。`,
    },
  ];
  const studyMainClassName = focusMode
    ? `study-main study-mode-${activeWorkspaceMode} focus-reader-layout`
    : `study-main study-mode-${activeWorkspaceMode}${activeWorkspaceMode === "reading" && !trainingUnlocked ? " pre-training-layout" : ""}`;
  const studyMainStyle = focusMode
    ? undefined
    : {
        "--qa-panel-width": `${qaPanelPercent}%`,
      };

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
          <header className="reader-header" data-testid="reader-header">
            <div className="reader-header-main">
              <Link className="back-link header-back-link" href="/">‹</Link>
              <div className="reader-heading">
                <h1>{documentTitle}</h1>
              </div>
            </div>
            <div className="reader-tools">
              <div className="workspace-tabs" aria-label="学习模式">
                <button
                  type="button"
                  className={activeWorkspaceMode === "reading" ? "workspace-tab active" : "workspace-tab"}
                  onClick={() => setWorkspaceMode("reading")}
                >
                  阅读
                </button>
                <button
                  type="button"
                  className={activeWorkspaceMode === "training" ? "workspace-tab active" : "workspace-tab locked"}
                  onClick={() => trainingUnlocked && setWorkspaceMode("training")}
                  disabled={!trainingUnlocked}
                >
                  训练
                </button>
              </div>
              <div className="reader-action-group" aria-label="阅读工具">
                <button
                  type="button"
                  className={outlineOpen ? "reader-tool-button active" : "reader-tool-button"}
                  onClick={() => setOutlineOpen((value) => !value)}
                  disabled={!outlineAvailable}
                  data-testid="outline-toggle"
                >
                  目录
                </button>
                <button
                  type="button"
                  className={focusMode ? "reader-tool-button active" : "reader-tool-button"}
                  onClick={() => setFocusMode((value) => !value)}
                  data-testid="focus-toggle"
                >
                  {focusMode ? "退出专注" : "专注"}
                </button>
              </div>
            </div>
          </header>

          <div className="reader-body" ref={readerBodyRef}>
            {knowledgeDoc ? (
              <div className={focusMode ? "focus-reading-flow" : undefined} data-testid={focusMode ? "focus-reading-flow" : undefined}>
                {focusMode ? (
                  <header className="focus-document-header" data-testid="focus-document-header">
                    <div className="focus-document-eyebrow">专注阅读</div>
                    <h1>{documentTitle}</h1>
                  </header>
                ) : null}
                <article className="document-surface document-markdown markdown-content" data-testid="document-surface">
                  {renderMarkdownContent(knowledgeDoc.markdown, `knowledge-doc:${knowledgeDoc.path}`)}
                </article>
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

        <aside className={`qa-panel qa-panel-${activeWorkspaceMode}`} data-testid="qa-panel">
          <header className="qa-header">
            <div className="qa-title-group">
              <strong>{activeWorkspaceMode === "training" ? "训练" : "阅读助理"}</strong>
            </div>
            <span className="qa-header-spacer" />
            <div className={`qa-header-controls ${!trainingUnlocked ? "qa-header-controls-locked" : ""}`}>
              {visibleSessionId ? (
                <div className="qa-session-debug">
                  <span className="qa-session-id" title={visibleSessionId}>sessionId {visibleSessionId}</span>
                  <button type="button" className="qa-session-copy" onClick={copySessionId}>
                    {sessionIdCopied ? "已复制" : "复制"}
                  </button>
                </div>
              ) : null}
              {activeWorkspaceMode === "reading" ? (
                <button type="button" className="qa-header-lock" disabled={isStarting} onClick={() => unlockTraining()}>
                  <span>{isStarting ? "准备中" : (trainingUnlocked ? "进入训练" : trainingCtaLabel)}</span>
                </button>
              ) : null}
            </div>
          </header>

          <div className="qa-scroll" ref={qaScrollRef}>
            <section className="chat-stack">
              {activeWorkspaceMode === "reading" ? (
                <article className={readingCompanionHasHistory ? "reading-companion-card compact" : "reading-companion-card"}>
                  <div className="reading-companion-source">参考本文 · {documentTitle}</div>
                  <h3>问这篇文档</h3>
                  <p>默认面向面试准备，实时生成总结、记忆点或自测问题。</p>
                  <div className="reading-companion-actions">
                    {readingStarterPrompts.map((prompt) => (
                      <button
                        key={prompt.label}
                        type="button"
                        className="secondary-pill"
                        disabled={isStarting || isAnswering}
                        onClick={() => submitAnswer({
                          nextAnswer: prompt.value,
                          goal: "interview",
                          taskType: prompt.taskType,
                        })}
                      >
                        {prompt.label}
                      </button>
                    ))}
                  </div>
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
                        splitTextBlocks(readingStreamingTurn.assistantText).length
                          ? splitTextBlocks(readingStreamingTurn.assistantText).join("\n\n")
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
            <textarea
              rows="1"
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              onFocus={() => setIsComposerFocused(true)}
              onBlur={() => setIsComposerFocused(false)}
              placeholder={isAnswering ? "已发送，正在等待下一步..." : "输入回答、追问，或引用原文段落。"}
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
