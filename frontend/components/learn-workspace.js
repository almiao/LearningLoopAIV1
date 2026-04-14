"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch, postEventStream, postJson } from "../lib/api";
import {
  getStoredTargetBaselineId,
  getStoredUserId,
  setStoredTargetBaselineId,
  setStoredUserId,
} from "../lib/user-session";
import { buildVisibleSessionView } from "../../src/view/visible-session-view";

function splitTextBlocks(value) {
  return String(value || "")
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function slugifyHeading(text) {
  const slug = String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[`*_~[\]()]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "section";
}

function parseMarkdownTarget(rawTarget = "") {
  const trimmed = String(rawTarget || "").trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    return trimmed.slice(1, -1).trim();
  }
  const match = trimmed.match(/^(\S+)/);
  return match ? match[1] : trimmed;
}

function renderInlineMarkdown(text, keyPrefix) {
  return String(text || "")
    .split(/(!\[[^\]]*]\([^)]+\)|\[[^\]]+\]\([^)]+\)|`[^`]+`|\*\*[^*]+\*\*)/g)
    .filter(Boolean)
    .map((part, index) => {
      if (part.startsWith("![") && part.includes("](") && part.endsWith(")")) {
        const imageMatch = part.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
        if (!imageMatch) {
          return <span key={`${keyPrefix}-text-${index}`}>{part}</span>;
        }
        return (
          <img
            key={`${keyPrefix}-image-${index}`}
            alt={imageMatch[1]}
            className="markdown-image"
            loading="lazy"
            src={parseMarkdownTarget(imageMatch[2])}
          />
        );
      }
      if (part.startsWith("[") && part.includes("](") && part.endsWith(")")) {
        const linkMatch = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        if (!linkMatch) {
          return <span key={`${keyPrefix}-text-${index}`}>{part}</span>;
        }
        const href = parseMarkdownTarget(linkMatch[2]);
        const isInternal = href.startsWith("/") || href.startsWith("#");
        return (
          <a
            key={`${keyPrefix}-link-${index}`}
            href={href}
            rel={isInternal ? undefined : "noreferrer"}
            target={isInternal ? undefined : "_blank"}
          >
            {linkMatch[1]}
          </a>
        );
      }
      if (part.startsWith("**") && part.endsWith("**")) {
        return <strong key={`${keyPrefix}-strong-${index}`}>{part.slice(2, -2)}</strong>;
      }
      if (part.startsWith("`") && part.endsWith("`")) {
        return <code key={`${keyPrefix}-code-${index}`}>{part.slice(1, -1)}</code>;
      }
      return <span key={`${keyPrefix}-text-${index}`}>{part}</span>;
    });
}

function readHeading(line) {
  const match = String(line || "").trim().match(/^(#{1,6})\s+(.*)$/);
  if (!match) {
    return null;
  }
  return {
    level: Math.min(match[1].length, 4),
    text: match[2].trim(),
  };
}

function readOrderedItem(line) {
  const match = String(line || "").trim().match(/^\d+\.\s+(.*)$/);
  return match ? match[1].trim() : "";
}

function readBulletItem(line) {
  const match = String(line || "").match(/^\s*[-*]\s+(.*)$/);
  return match ? match[1].trim() : "";
}

function parseTableCells(line) {
  const trimmed = String(line || "").trim().replace(/^\||\|$/g, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function isTableDivider(line) {
  return /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(String(line || ""));
}

function renderMarkdownContent(value, keyPrefix) {
  const normalized = String(value || "").replace(/\r/g, "").trim();
  if (!normalized) {
    return null;
  }

  const lines = normalized.split("\n");
  const nodes = [];
  let index = 0;
  let blockIndex = 0;

  while (index < lines.length) {
    const rawLine = lines[index] || "";
    const trimmedLine = rawLine.trim();

    if (!trimmedLine) {
      index += 1;
      continue;
    }

    if (/^(```|~~~)/.test(trimmedLine)) {
      const fence = trimmedLine.slice(0, 3);
      const language = trimmedLine.slice(3).trim();
      const codeLines = [];
      index += 1;
      while (index < lines.length && !String(lines[index] || "").trim().startsWith(fence)) {
        codeLines.push(lines[index] || "");
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      nodes.push(
        <pre key={`${keyPrefix}-code-${blockIndex}`} className="markdown-pre">
          <code data-language={language || undefined}>{codeLines.join("\n")}</code>
        </pre>
      );
      blockIndex += 1;
      continue;
    }

    const heading = readHeading(trimmedLine);
    if (heading) {
      const HeadingTag = `h${heading.level}`;
      nodes.push(
        <HeadingTag key={`${keyPrefix}-h-${blockIndex}`} id={slugifyHeading(heading.text)}>
          {renderInlineMarkdown(heading.text, `${keyPrefix}-h-${blockIndex}`)}
        </HeadingTag>
      );
      blockIndex += 1;
      index += 1;
      continue;
    }

    if (index + 1 < lines.length && trimmedLine.includes("|") && isTableDivider(lines[index + 1])) {
      const headerCells = parseTableCells(trimmedLine);
      const bodyRows = [];
      index += 2;
      while (index < lines.length && String(lines[index] || "").trim().includes("|")) {
        bodyRows.push(parseTableCells(lines[index]));
        index += 1;
      }
      nodes.push(
        <div key={`${keyPrefix}-table-${blockIndex}`} className="markdown-table-wrap">
          <table className="markdown-table">
            <thead>
              <tr>
                {headerCells.map((cell, cellIndex) => (
                  <th key={`${keyPrefix}-table-${blockIndex}-head-${cellIndex}`}>
                    {renderInlineMarkdown(cell, `${keyPrefix}-table-${blockIndex}-head-${cellIndex}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bodyRows.map((row, rowIndex) => (
                <tr key={`${keyPrefix}-table-${blockIndex}-row-${rowIndex}`}>
                  {row.map((cell, cellIndex) => (
                    <td key={`${keyPrefix}-table-${blockIndex}-cell-${rowIndex}-${cellIndex}`}>
                      {renderInlineMarkdown(cell, `${keyPrefix}-table-${blockIndex}-cell-${rowIndex}-${cellIndex}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      blockIndex += 1;
      continue;
    }

    if (/^\d+\.\s+/.test(trimmedLine)) {
      const items = [];
      while (index < lines.length && /^\d+\.\s+/.test((lines[index] || "").trim())) {
        items.push(lines[index].trim());
        index += 1;
      }
      nodes.push(
        <ol key={`${keyPrefix}-ol-${blockIndex}`}>
          {items.map((line, lineIndex) => (
            <li key={`${keyPrefix}-ol-${blockIndex}-${lineIndex}`}>
              {renderInlineMarkdown(readOrderedItem(line), `${keyPrefix}-ol-${blockIndex}-${lineIndex}`)}
            </li>
          ))}
        </ol>
      );
      blockIndex += 1;
      continue;
    }

    if (/^\s*[-*]\s+/.test(rawLine)) {
      const items = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index] || "")) {
        items.push(lines[index]);
        index += 1;
      }
      nodes.push(
        <ul key={`${keyPrefix}-ul-${blockIndex}`}>
          {items.map((line, lineIndex) => (
            <li key={`${keyPrefix}-ul-${blockIndex}-${lineIndex}`}>
              {renderInlineMarkdown(readBulletItem(line), `${keyPrefix}-ul-${blockIndex}-${lineIndex}`)}
            </li>
          ))}
        </ul>
      );
      blockIndex += 1;
      continue;
    }

    if (/^>/.test(trimmedLine)) {
      const quoteLines = [];
      while (index < lines.length && /^>/.test(String(lines[index] || "").trim())) {
        quoteLines.push(String(lines[index] || "").trim().replace(/^>\s?/, ""));
        index += 1;
      }
      nodes.push(
        <blockquote key={`${keyPrefix}-quote-${blockIndex}`}>
          {renderMarkdownContent(quoteLines.join("\n"), `${keyPrefix}-quote-${blockIndex}`)}
        </blockquote>
      );
      blockIndex += 1;
      continue;
    }

    if (/^---+$/.test(trimmedLine)) {
      nodes.push(<hr key={`${keyPrefix}-hr-${blockIndex}`} />);
      blockIndex += 1;
      index += 1;
      continue;
    }

    const paragraphLines = [];
    while (index < lines.length) {
      const currentLine = lines[index] || "";
      const trimmedCurrentLine = currentLine.trim();
      if (!trimmedCurrentLine) {
        index += 1;
        break;
      }
      if (
        paragraphLines.length &&
        (
          /^(```|~~~)/.test(trimmedCurrentLine) ||
          readHeading(trimmedCurrentLine) ||
          /^\d+\.\s+/.test(trimmedCurrentLine) ||
          /^\s*[-*]\s+/.test(currentLine) ||
          /^>/.test(trimmedCurrentLine) ||
          /^---+$/.test(trimmedCurrentLine) ||
          (trimmedCurrentLine.includes("|") && isTableDivider(lines[index + 1]))
        )
      ) {
        break;
      }
      paragraphLines.push(trimmedCurrentLine);
      index += 1;
    }

    if (paragraphLines.length) {
      nodes.push(
        <p key={`${keyPrefix}-p-${blockIndex}`}>
          {renderInlineMarkdown(paragraphLines.join(" "), `${keyPrefix}-p-${blockIndex}`)}
        </p>
      );
      blockIndex += 1;
    }
  }

  return nodes;
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

const pathSegmentLabels = {
  "high-availability": "高可用",
  "high-performance": "高性能",
  "distributed-system": "分布式",
  "database": "数据库",
  "mysql": "MySQL",
  "redis": "Redis",
  "java": "Java",
  "concurrent": "并发",
  "jvm": "JVM",
  "system-design": "系统设计",
  "framework": "框架",
  "spring": "Spring",
  "cs-basics": "计算机基础",
  "network": "网络",
  "message-queue": "消息队列",
};

function formatPathSegment(segment = "") {
  return pathSegmentLabels[segment] || String(segment || "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function buildKnowledgeTrail({ activeDocPath, knowledgeDoc, currentConcept }) {
  const relativePath = String(activeDocPath || "").replace(/^docs\//, "");
  if (!relativePath) {
    return [];
  }

  const segments = relativePath.split("/");
  const folderLabels = segments
    .slice(0, -1)
    .map((segment) => formatPathSegment(segment))
    .filter(Boolean);
  const docTitle = knowledgeDoc?.title || currentConcept?.javaGuideSources?.[0]?.title || "";
  const conceptTitle = currentConcept?.title || "";
  const trail = [...folderLabels, docTitle];

  if (conceptTitle && conceptTitle !== docTitle) {
    trail.push(conceptTitle);
  }
  return trail.filter(Boolean);
}

function scoreStateForProgress(state = "") {
  if (state === "solid") {
    return 100;
  }
  if (state === "partial") {
    return 55;
  }
  if (state === "weak") {
    return 15;
  }
  return 0;
}

function findBestHeadingAnchor(concept, knowledgeDoc) {
  if (!concept || !knowledgeDoc?.headings?.length) {
    return null;
  }

  const title = String(concept.title || "").toLowerCase();
  const summary = String(concept.summary || concept.excerpt || "").toLowerCase();
  const keywords = (concept.keywords || []).map((item) => String(item || "").toLowerCase()).filter(Boolean);
  const anchors = (concept.sourceAnchors || []).map((item) => String(item || "").toLowerCase()).filter(Boolean);

  let best = null;
  for (const heading of knowledgeDoc.headings) {
    const text = String(heading.text || "").toLowerCase();
    let score = 0;

    if (!text) {
      continue;
    }
    if (title && (title.includes(text) || text.includes(title))) {
      score += 12;
    }
    if (summary && (summary.includes(text) || text.includes(summary))) {
      score += 8;
    }
    score += keywords.filter((keyword) => keyword && text.includes(keyword)).length * 2;
    score += anchors.filter((anchor) => anchor && anchor.includes(text)).length * 2;
    score += heading.level === 2 ? 1.5 : 0.5;

    if (!best || score > best.score) {
      best = { ...heading, score };
    }
  }

  return best?.score > 0 ? best : null;
}

export function LearnWorkspace() {
  const searchParams = useSearchParams();
  const autostartRef = useRef(false);
  const conceptFocusRef = useRef("");
  const qaScrollRef = useRef(null);
  const [profile, setProfile] = useState(null);
  const [baselines, setBaselines] = useState([]);
  const [targetBaselineId, setTargetBaselineId] = useState("");
  const [interactionPreference, setInteractionPreference] = useState("balanced");
  const [session, setSession] = useState(null);
  const [answer, setAnswer] = useState("");
  const [burdenSignal, setBurdenSignal] = useState("normal");
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
  const deferredSession = useDeferredValue(session);
  const visibleView = buildVisibleSessionView(deferredSession || {});
  const chatTimeline = visibleView.chatTimeline || [];

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
  const currentSource = currentConcept?.javaGuideSources?.[0] || session?.summary?.javaGuideSourceClusters?.[0] || null;
  const selectedBaseline = baselines.find((baseline) => baseline.id === targetBaselineId) || baselines[0] || null;
  const activeDocPath = searchParams.get("doc") || currentSource?.path || "";
  const autostart = searchParams.get("autostart") === "1";
  const desiredConceptId = searchParams.get("concept") || "";
  const knowledgeTrail = useMemo(
    () => buildKnowledgeTrail({ activeDocPath, knowledgeDoc, currentConcept }),
    [activeDocPath, knowledgeDoc, currentConcept]
  );
  const docConcepts = useMemo(
    () => (session?.concepts || []).filter((concept) =>
      (concept.javaGuideSources || []).some((source) => source.path === activeDocPath)
    ),
    [session, activeDocPath]
  );
  const docQuestionCount = docConcepts.length;
  const docQuestionIndex = docQuestionCount
    ? Math.max(1, docConcepts.findIndex((concept) => concept.id === currentConcept?.id) + 1 || 1)
    : 0;
  const docCompletedCount = useMemo(
    () => docConcepts.filter((concept) => session?.conceptStates?.[concept.id]?.completed).length,
    [docConcepts, session]
  );
  const docProgressPercent = docQuestionCount
    ? Math.round((docCompletedCount / docQuestionCount) * 100)
    : Math.round(
        average(
          docConcepts.map((concept) => scoreStateForProgress(session?.conceptStates?.[concept.id]?.judge?.state))
        )
      );
  const conceptAnchorMap = useMemo(() => (
    new Map(
      docConcepts
        .map((concept) => [concept.id, findBestHeadingAnchor(concept, knowledgeDoc)])
        .filter((entry) => entry[1])
    )
  ), [docConcepts, knowledgeDoc]);
  const currentDocAnchor = currentConcept ? conceptAnchorMap.get(currentConcept.id) || null : null;

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
    if (workspaceMode !== "training" || !currentDocAnchor?.id) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(currentDocAnchor.id)?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [workspaceMode, currentDocAnchor?.id, currentConcept?.id, session?.currentProbe]);

  async function refreshProfile() {
    if (!profile?.user?.id) {
      return;
    }
    const data = await apiFetch(`/api/profile/${profile.user.id}`);
    setProfile(data);
  }

  function scrollToDocAnchor(anchorId) {
    if (!anchorId) {
      return;
    }
    document.getElementById(anchorId)?.scrollIntoView({ block: "center", behavior: "smooth" });
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
          burdenSignal,
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

  async function focusDomain(domainId) {
    if (!session?.sessionId) {
      return;
    }
    try {
      setError("");
      setOutlineOpen(false);
      const nextSession = await postJson("/api/interview/focus-domain", {
        sessionId: session.sessionId,
        domainId,
      });
      setSession(nextSession);
    } catch (nextError) {
      setError(nextError.message);
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

  if (!profile) {
    return (
      <main className="learn-shell">
        <Link className="floating-back-link" href="/">‹</Link>
        <section className="gate-card">
          <h1>先连接学习档案，再进入学习页。</h1>
          <p>首页会保存你的账号、目标和长期记忆；连接后再回来，这里会直接进入当前路线。</p>
          <Link className="primary-pill" href="/">返回首页</Link>
        </section>
      </main>
    );
  }

  return (
    <main className="learn-shell">
      {error ? <section className="feedback-banner error-banner narrow-banner">{error}</section> : null}

      <section className={`study-main study-mode-${workspaceMode}`}>
        <section className="reader-panel">
          <header className="reader-header">
            <div className="reader-header-main">
              <Link className="back-link header-back-link" href="/">‹</Link>
              <div className="reader-heading">
                <h1>{knowledgeTrail.length ? knowledgeTrail.join(" › ") : (knowledgeDoc?.title || currentSource?.title || selectedBaseline?.title || "开始学习")}</h1>
                <p>
                  {currentDocAnchor?.text
                    ? `当前问题锚定到：${currentDocAnchor.text}`
                    : activeDocPath
                      ? `文档：${activeDocPath.replace(/^docs\//, "")}`
                      : "进入学习后，这里会直接展示当前关联的原始文档。"}
                </p>
              </div>
            </div>
            <div className="reader-tools">
              <div className="workspace-tabs">
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
              <button
                type="button"
                className={outlineOpen ? "reader-tool-button active" : "reader-tool-button"}
                onClick={() => setOutlineOpen((value) => !value)}
                disabled={!knowledgeDoc?.headings?.length}
              >
                知识目录
              </button>
              <span>笔记</span>
              <span>专注</span>
            </div>
          </header>

          <div className="reader-body">
            {knowledgeDoc ? (
              <article className="document-surface document-markdown markdown-content">
                {renderMarkdownContent(knowledgeDoc.markdown, `knowledge-doc:${knowledgeDoc.path}`)}
              </article>
            ) : session ? (
              <article className="document-surface">
                <div className="reader-empty compact-empty">
                  <h2>{docLoading ? "正在载入文档" : "当前题目暂无关联原文"}</h2>
                  <p>{docError || "这一题的文档还没准备好，右侧问答仍然可以继续。"}
                  </p>
                </div>
              </article>
            ) : (
              <article className="reader-empty">
                <h2>{selectedBaseline?.title || "准备开始学习"}</h2>
                <p>{selectedBaseline?.description || "进入学习后，这里会直接展示当前关联的 Markdown 原文。"}
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
                    {isStarting ? "正在进入..." : "开始这一轮学习"}
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
              />
            ) : null}

            <aside className={outlineOpen ? "outline-panel open" : "outline-panel"} aria-hidden={!outlineOpen}>
              <div className="outline-toolbar">
                <div className="outline-title">知识目录</div>
                <button
                  type="button"
                  className="outline-close"
                  aria-label="关闭知识目录"
                  onClick={() => setOutlineOpen(false)}
                >
                  ×
                </button>
              </div>
              <div className="outline-scroll">
                {knowledgeDoc?.headings?.length ? knowledgeDoc.headings.map((heading) => (
                  <section className="outline-group" key={heading.id}>
                    <button
                      type="button"
                      className={heading.level <= 2 ? "outline-domain active" : "outline-item"}
                      onClick={() => {
                        setOutlineOpen(false);
                        document.getElementById(heading.id)?.scrollIntoView({ block: "start", behavior: "smooth" });
                      }}
                    >
                      {heading.text}
                    </button>
                  </section>
                )) : (
                  <p className="empty-copy">
                    {docLoading ? "正在整理文档目录..." : "当前文档还没有可展开的目录。"}
                  </p>
                )}
              </div>
            </aside>
          </div>
        </section>

        <aside className={`qa-panel qa-panel-${workspaceMode}`}>
          <header className="qa-header">
            <div className="qa-title-group">
              <strong>{workspaceMode === "training" ? "训练模式" : "阅读模式"}</strong>
              <span className="qa-subtitle">
                {workspaceMode === "training"
                  ? `本文档共设计 ${docQuestionCount || 0} 道训练题，当前第 ${docQuestionIndex} 题。`
                  : "现在可以直接提问、追问原文细节，读完后再进入训练。"}
              </span>
            </div>
            <span className="qa-header-spacer" />
            <div className="qa-header-controls">
              <select className="qa-header-select" value={burdenSignal} onChange={(event) => setBurdenSignal(event.target.value)}>
                <option value="normal">正常负荷</option>
                <option value="high">高负荷</option>
              </select>
              <div className="progress-cluster">
                <span className="progress-label">训练进度 {docCompletedCount}/{docQuestionCount || 0}</span>
                <div className="training-progress-track" aria-hidden="true">
                  <div className="training-progress-fill" style={{ width: `${Math.max(0, Math.min(100, docProgressPercent || 0))}%` }} />
                </div>
              </div>
            </div>
          </header>

          <div className="qa-scroll" ref={qaScrollRef}>
            <section className="chat-stack">
              {!trainingUnlocked ? (
                <article className="mode-lock-card">
                  <div className="mode-lock-kicker">训练尚未解锁</div>
                  <h3>先把文档读完，再进入题目训练</h3>
                  <p>右侧现在可以随时问我原文里的定义、机制、边界和例子；确认读完后，再切到训练模式集中做题。</p>
                  <button type="button" className="primary-pill lock-cta" disabled={isStarting} onClick={() => unlockTraining()}>
                    {isStarting ? "正在准备训练..." : "我已阅读完成，开始训练"}
                  </button>
                </article>
              ) : workspaceMode === "training" ? (
                <article className="training-hero-card">
                  <div className="training-hero-title">训练已开启</div>
                  <p>本文档共设计 {docQuestionCount || 0} 道训练题。你可以先直接回答，也可以点“查看解析”先拿到引导，再继续作答。</p>
                  {currentDocAnchor?.text ? (
                    <button type="button" className="anchor-pill" onClick={() => scrollToDocAnchor(currentDocAnchor.id)}>
                      对应文档位置：{currentDocAnchor.text}
                    </button>
                  ) : null}
                </article>
              ) : null}

              {chatTimeline.map((entry) => (
                entry.type === "event" ? (
                  <div className="chat-event-row" key={entry.id}>{entry.label}</div>
                ) : (
                  <article className={entry.role === "assistant" ? "message-card assistant" : "message-card learner"} key={entry.id}>
                    {entry.role === "assistant" && conceptAnchorMap.get(entry.conceptId) ? (
                      <button
                        type="button"
                        className="message-anchor"
                        onClick={() => scrollToDocAnchor(conceptAnchorMap.get(entry.conceptId).id)}
                      >
                        锚定文档：{conceptAnchorMap.get(entry.conceptId).text}
                      </button>
                    ) : null}
                    <div className={`message-body ${entry.role === "assistant" ? "markdown-content" : ""}`}>
                      {entry.role === "assistant"
                        ? renderMarkdownContent(
                            (entry.bodyParts?.length ? entry.bodyParts.join("\n\n") : entry.body) || "",
                            `${entry.id}-assistant`
                          )
                        : (entry.bodyParts?.length ? entry.bodyParts : [entry.body]).filter(Boolean).map((block, index) => (
                            <p key={`${entry.id}:${index}`}>{block}</p>
                          ))}
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
                    {currentDocAnchor?.text ? (
                      <button type="button" className="message-anchor" onClick={() => scrollToDocAnchor(currentDocAnchor.id)}>
                        锚定文档：{currentDocAnchor.text}
                      </button>
                    ) : null}
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
              placeholder={session ? "直接提问、回答、追问边界，或者引用文档中的一段内容。" : "开始学习后再输入回答。"}
            />

            <div className="question-input-row">
              <div className="suggested-actions">
                <button type="button" className="secondary-pill" disabled={!session || isAnswering} onClick={() => submitAnswer({ nextAnswer: "查看解析", intent: "teach" })}>
                  查看解析
                </button>
              </div>
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
