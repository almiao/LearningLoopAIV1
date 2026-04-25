"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch, postEventStream, postJson } from "../lib/api";
import { readHeading, renderMarkdownContent, slugifyHeading } from "../lib/render-markdown-content";
import {
  getStoredTargetBaselineId,
  getStoredUserId,
  setStoredTargetBaselineId,
  setStoredUserId,
} from "../lib/user-session";
import { buildVisibleSessionView } from "../../src/view/visible-session-view";
import { getBaselinePackById } from "../../src/baseline/baseline-packs";

const profileDirtyStorageKey = "learning-loop-profile-dirty-at";

function splitTextBlocks(value) {
  return String(value || "")
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function renderQuestionPhase(meta) {
  switch (meta?.phase) {
    case "teach-back":
      return "讲解后复述";
    case "follow-up":
      return "追问";
    case "revisit":
      return "回访";
    default:
      return "首问";
  }
}

function stateLabel(state) {
  if (state === "solid") {
    return "稳定";
  }
  if (state === "partial") {
    return "进行中";
  }
  if (state === "weak") {
    return "待补强";
  }
  return "未判断";
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

function safeGetBaseline(baselineId = "") {
  if (!baselineId) {
    return null;
  }
  try {
    return getBaselinePackById(baselineId);
  } catch {
    return null;
  }
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

export function LearnWorkspace() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const focusParamEnabled = searchParams.get("focus") === "1";
  const initialTargetBaselineId = searchParams.get("target") || getStoredTargetBaselineId() || "";
  const autostartRef = useRef(false);
  const conceptFocusRef = useRef("");
  const readingProgressRef = useRef("");
  const qaScrollRef = useRef(null);
  const [profile, setProfile] = useState(null);
  const [baselines, setBaselines] = useState([]);
  const [knowledgeDocuments, setKnowledgeDocuments] = useState([]);
  const [targetBaselineId, setTargetBaselineId] = useState(initialTargetBaselineId);
  const [interactionPreference, setInteractionPreference] = useState("balanced");
  const [session, setSession] = useState(null);
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState("");
  const [isStarting, setIsStarting] = useState(false);
  const [isAnswering, setIsAnswering] = useState(false);
  const [streamingTurn, setStreamingTurn] = useState(null);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [knowledgeDoc, setKnowledgeDoc] = useState(null);
  const [docLoading, setDocLoading] = useState(false);
  const [docError, setDocError] = useState("");
  const [workspaceMode, setWorkspaceMode] = useState("reading");
  const [trainingUnlocked, setTrainingUnlocked] = useState(false);
  const [focusMode, setFocusMode] = useState(focusParamEnabled);
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
    apiFetch("/api/baselines")
      .then((data) => {
        const nextBaselines = data.baselines || [];
        setBaselines(nextBaselines);
        const requestedTarget = searchParams.get("target") || getStoredTargetBaselineId() || nextBaselines[0]?.id || "";
        setTargetBaselineId(requestedTarget);
        if (requestedTarget) {
          setStoredTargetBaselineId(requestedTarget);
        }
      })
      .catch((nextError) => setError(nextError.message));
  }, [searchParams]);

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

  const currentConcept = useMemo(
    () => (session?.concepts || []).find((concept) => concept.id === session?.currentConceptId) || null,
    [session]
  );
  const resolvedTargetBaselineId = targetBaselineId || searchParams.get("target") || getStoredTargetBaselineId() || "";
  const currentSource = currentConcept?.javaGuideSources?.[0] || session?.summary?.javaGuideSourceClusters?.[0] || null;
  const selectedBaseline =
    baselines.find((baseline) => baseline.id === resolvedTargetBaselineId) ||
    safeGetBaseline(resolvedTargetBaselineId) ||
    baselines[0] ||
    null;
  const activeDocPath = searchParams.get("doc") || currentSource?.path || knowledgeDocuments[0]?.path || "";
  const autostart = searchParams.get("autostart") === "1";
  const desiredConceptId = searchParams.get("concept") || "";
  const docConcepts = useMemo(
    () => (session?.concepts || []).filter((concept) =>
      (concept.javaGuideSources || []).some((source) => source.path === activeDocPath)
    ),
    [session, activeDocPath]
  );
  const trainingConcept = useMemo(
    () => docConcepts.find((concept) => concept.id === session?.currentConceptId) || docConcepts[0] || null,
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
  const questionProgress = session?.currentQuestionMeta?.progress || null;
  const trainingTakeaway = session?.latestFeedback?.takeaway || "";
  const trainingClosed = workspaceMode === "training" && Boolean(session) && !session?.currentProbe;
  const knowledgeTree = useMemo(() => buildKnowledgeTree(knowledgeDocuments), [knowledgeDocuments]);
  const documentHeadings = useMemo(
    () => buildDocumentHeadings(knowledgeDoc?.markdown || ""),
    [knowledgeDoc?.markdown]
  );
  const outlineAvailable = documentHeadings.length > 0 || knowledgeTree.length > 0;

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
    if (!autostart || autostartRef.current || !profile?.user?.id || !targetBaselineId || session) {
      return;
    }
    autostartRef.current = true;
    void startSession();
  }, [autostart, profile, targetBaselineId, session]);

  useEffect(() => {
    if (!session?.sessionId || !desiredConceptId || session.currentConceptId === desiredConceptId || conceptFocusRef.current === desiredConceptId) {
      return;
    }
    conceptFocusRef.current = desiredConceptId;
    void focusConcept(desiredConceptId);
  }, [desiredConceptId, session]);

  useEffect(() => {
    if (!streamingTurn) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      scrollQaToBottom();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [streamingTurn?.id, streamingTurn?.assistantText, streamingTurn?.replyComplete]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      scrollQaToBottom();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [chatTimeline.length, session?.sessionId]);

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
  }, [activeDocPath]);

  useEffect(() => {
    if (
      workspaceMode !== "training" ||
      !session?.sessionId ||
      !trainingConcept?.id ||
      session.currentConceptId === trainingConcept.id
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
    if (!profile?.user?.id || !targetBaselineId || !activeDocPath) {
      return;
    }

    const conceptForDoc = currentConcept && (currentConcept.javaGuideSources || []).some((source) => source.path === activeDocPath)
      ? currentConcept
      : docConcepts[0] || null;
    const nextSignature = JSON.stringify({
      userId: profile.user.id,
      targetBaselineId,
      domainId: conceptForDoc?.abilityDomainId || conceptForDoc?.domainId || "",
      conceptId: conceptForDoc?.id || "",
      docPath: activeDocPath,
      docTitle: knowledgeDoc?.title || "",
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
  }, [activeDocPath, currentConcept, docConcepts, knowledgeDoc?.title, profile, targetBaselineId]);

  async function refreshProfile() {
    if (!profile?.user?.id) {
      return;
    }
    const data = await apiFetch(`/api/profile/${profile.user.id}`);
    setProfile(data);
  }

  async function startSession() {
    if (!profile?.user?.id || !targetBaselineId) {
      return null;
    }
    try {
      setIsStarting(true);
      setError("");
      const nextSession = await postJson("/api/interview/start-target", {
        userId: profile.user.id,
        targetBaselineId,
        docPath: activeDocPath,
        interactionPreference,
      });
      setSession(nextSession);
      setStoredTargetBaselineId(targetBaselineId);
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
    let nextSession = session;
    if (!nextSession) {
      nextSession = await startSession();
    }
    if (!nextSession) {
      return;
    }
    setTrainingUnlocked(true);
    setWorkspaceMode("training");
  }

  async function submitAnswer({ nextAnswer = answer, intent = "" } = {}) {
    if (!session?.sessionId || !nextAnswer.trim()) {
      return;
    }
    try {
      setError("");
      setIsAnswering(true);
      setStreamingTurn({
        id: `${session.sessionId}:${Date.now()}`,
        answer: nextAnswer,
        intent,
        assistantText: "",
        replyComplete: false,
        decisionPending: false,
      });

      let finalSession = null;
      await postEventStream(
        "/api/interview/answer-stream",
        {
          sessionId: session.sessionId,
          answer: nextAnswer,
          intent,
          burdenSignal: "normal",
          interactionPreference,
        },
        async (event, data) => {
          if (event === "reply_delta") {
            setStreamingTurn((turn) => (
              turn
                ? { ...turn, assistantText: `${turn.assistantText}${data.delta || ""}`, decisionPending: false }
                : turn
            ));
          }
          if (event === "reply_done") {
            setStreamingTurn((turn) => (turn ? { ...turn, replyComplete: true, decisionPending: true } : turn));
          }
          if (event === "turn_result" || event === "session") {
            finalSession = data;
            setSession(data);
            setAnswer("");
            setStreamingTurn(null);
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
    } finally {
      setIsAnswering(false);
      setStreamingTurn(null);
    }
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
    if (targetBaselineId) {
      params.set("target", targetBaselineId);
    }
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
                  className={concept.id === currentConcept?.id ? "outline-item active" : "outline-item"}
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

  const documentTitle = knowledgeDoc?.title || currentSource?.title || selectedBaseline?.title || "开始学习";

  return (
    <main
      className={focusMode ? "learn-shell focus-reader-mode" : "learn-shell"}
      data-focus-mode={focusMode ? "true" : "false"}
      data-testid="learn-shell"
    >
      {error ? <section className="feedback-banner error-banner narrow-banner">{error}</section> : null}

      <section className={focusMode ? `study-main study-mode-${workspaceMode} focus-reader-layout` : `study-main study-mode-${workspaceMode}`}>
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
                  className={workspaceMode === "reading" ? "workspace-tab active" : "workspace-tab"}
                  onClick={() => setWorkspaceMode("reading")}
                >
                  阅读
                </button>
                <button
                  type="button"
                  className={workspaceMode === "training" ? "workspace-tab active" : "workspace-tab locked"}
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

          <div className="reader-body">
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
                <h2>{selectedBaseline?.title || "开始学习"}</h2>
                <p>{selectedBaseline?.description || "选择节奏后直接进入原文。"}
                </p>
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

        <aside className={`qa-panel qa-panel-${workspaceMode}`} data-testid="qa-panel">
          <header className="qa-header">
            <div className="qa-title-group">
              <strong>{workspaceMode === "training" ? "训练" : "阅读"}</strong>
            </div>
            <span className="qa-header-spacer" />
            <div className={`qa-header-controls ${!trainingUnlocked ? "qa-header-controls-locked" : ""}`}>
              {!trainingUnlocked ? (
                <button type="button" className="qa-header-lock" disabled={isStarting} onClick={() => unlockTraining()}>
                  <span>{isStarting ? "准备中..." : "开启训练"}</span>
                </button>
              ) : null}
            </div>
          </header>

          <div className="qa-scroll" ref={qaScrollRef}>
            <section className="chat-stack">
              {workspaceMode === "training" ? (
                <article className="training-hero-card">
                  <div className="training-hero-title">训练模式</div>
                  <p>
                    {docTrainingReady
                      ? "直接作答，或先看解析。"
                      : "继续阅读，或直接围绕原文提问。"}
                  </p>
                  {questionProgress ? (
                    <p className="muted">
                      当前节奏：第 {questionProgress.currentRound} / {questionProgress.maxRounds} 轮 · {renderQuestionPhase(session?.currentQuestionMeta)}
                    </p>
                  ) : null}
                  {trainingClosed && trainingTakeaway ? (
                    <p className="muted">
                      本题已收口：{trainingTakeaway}
                    </p>
                  ) : null}
                </article>
              ) : null}

              {(workspaceMode === "training" ? trainingChatTimeline : visibleChatTimeline).map((entry) => (
                entry.type === "event" ? (
                  <div className="chat-event-row" key={entry.id}>{entry.label}</div>
                ) : (
                  <article className={entry.role === "assistant" ? "message-card assistant" : "message-card learner"} key={entry.id}>
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
                )
              ))}

              {streamingTurn ? (
                <>
                  <article className="message-card learner">
                    <div className="message-body"><p>{streamingTurn.answer}</p></div>
                  </article>
                  <article className="message-card assistant">
                    <div className="message-body markdown-content">
                      {renderMarkdownContent(
                        splitTextBlocks(streamingTurn.assistantText).length
                          ? splitTextBlocks(streamingTurn.assistantText).join("\n\n")
                          : "正在生成回复...",
                        `${streamingTurn.id}-stream`
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
              placeholder={session ? "输入回答、追问，或引用原文段落。" : "进入学习后可输入。"}
            />

            <div className="question-input-row">
              {workspaceMode === "training" ? (
                <div className="suggested-actions">
                  <button type="button" className="secondary-pill" disabled={!session || isAnswering || !docTrainingReady} onClick={() => submitAnswer({ nextAnswer: "查看解析", intent: "teach" })}>
                    查看解析
                  </button>
                  <button type="button" className="secondary-pill" disabled={!session || isAnswering} onClick={() => submitAnswer({ nextAnswer: "总结一下", intent: "summarize" })}>
                    面试总结
                  </button>
                </div>
              ) : <div className="suggested-actions" />}
              <button type="submit" className="send-button" disabled={!session || isAnswering || !answer.trim()}>
                ↑
              </button>
            </div>
          </form>
        </aside>
      </section>
    </main>
  );
}
