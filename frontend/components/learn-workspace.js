"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch, postEventStream, postJson } from "../lib/api";
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

function normalizeKnowledgeSource(rawSource) {
  if (!rawSource) {
    return null;
  }
  if (typeof rawSource === "string") {
    return {
      path: rawSource,
      title: "",
    };
  }
  return {
    path: rawSource.path || "",
    title: rawSource.title || "",
  };
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
  const knowledgeTitleMap = useMemo(
    () => new Map(knowledgeDocuments.map((doc) => [doc.path, doc.title])),
    [knowledgeDocuments]
  );
  const routeDomains = useMemo(() => (
    (selectedBaseline?.domains || []).map((domain) => {
      const docsByPath = new Map();
      for (const item of domain.items || []) {
        for (const rawSource of item.javaGuideSources || []) {
          const source = normalizeKnowledgeSource(rawSource);
          if (!source?.path || docsByPath.has(source.path)) {
            continue;
          }
          docsByPath.set(source.path, {
            path: source.path,
            title: knowledgeTitleMap.get(source.path) || source.title || item.title,
          });
        }
      }
      return {
        id: domain.id,
        title: domain.title,
        docs: [...docsByPath.values()],
      };
    }).filter((domain) => domain.docs.length > 0)
  ), [knowledgeTitleMap, selectedBaseline]);
  const activeRouteDomain = useMemo(
    () => routeDomains.find((domain) => (domain.docs || []).some((doc) => doc.path === activeDocPath)) || routeDomains[0] || null,
    [activeDocPath, routeDomains]
  );
  const routeDocuments = useMemo(
    () => (activeRouteDomain?.docs || []).map((doc) => ({
      ...doc,
      domainId: activeRouteDomain.id,
      domainTitle: activeRouteDomain.title,
    })),
    [activeRouteDomain]
  );
  const documentHeadings = useMemo(
    () => buildDocumentHeadings(knowledgeDoc?.markdown || ""),
    [knowledgeDoc?.markdown]
  );
  const outlineAvailable = documentHeadings.length > 0 || routeDocuments.length > 0;

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
          <p>首页会保存你的账号、目标和长期记忆；连接后再回来，这里会直接进入当前路线。</p>
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
                disabled={!outlineAvailable}
                data-testid="outline-toggle"
              >
                知识目录
              </button>
              <span>笔记</span>
              <button
                type="button"
                className={focusMode ? "reader-tool-button active" : "reader-tool-button"}
                onClick={() => setFocusMode((value) => !value)}
                data-testid="focus-toggle"
              >
                {focusMode ? "退出专注" : "专注"}
              </button>
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
                {routeDocuments.length ? (
                  <section className="outline-section">
                    <div className="outline-section-title">{activeRouteDomain?.title || "当前路线"}</div>
                    <div className="outline-items">
                      {routeDocuments.map((doc) => (
                        <button
                          type="button"
                          key={doc.path}
                          className={doc.path === activeDocPath ? "outline-domain active" : "outline-domain"}
                          onClick={() => openDocumentFromCatalog(doc.path)}
                        >
                          {doc.title}
                        </button>
                      ))}
                    </div>
                  </section>
                ) : !documentHeadings.length ? (
                  <p className="empty-copy">
                    {docLoading ? "正在整理知识目录..." : "当前路线还没有可展开的文档目录。"}
                  </p>
                ) : null}
              </div>
            </aside>
          </div>
        </section>

        <aside className={`qa-panel qa-panel-${workspaceMode}`} data-testid="qa-panel">
          <header className="qa-header">
            <div className="qa-title-group">
              <strong>{workspaceMode === "training" ? "训练模式" : "阅读模式"}</strong>
              <span className="qa-subtitle">
                {workspaceMode === "training"
                  ? (docTrainingReady
                      ? "训练题会根据你当前文档位置、历史回答和掌握状态实时生成。"
                      : "当前文档还没有固定训练题，先继续阅读，或直接围绕文档内容提问。")
                  : "现在可以直接提问、追问原文细节，读完后再进入训练。"}
              </span>
            </div>
            <span className="qa-header-spacer" />
            <div className={`qa-header-controls ${!trainingUnlocked ? "qa-header-controls-locked" : ""}`}>
              <select className="qa-header-select" value={burdenSignal} onChange={(event) => setBurdenSignal(event.target.value)}>
                <option value="normal">正常负荷</option>
                <option value="high">高负荷</option>
              </select>
              {!trainingUnlocked ? (
                <button type="button" className="qa-header-lock" disabled={isStarting} onClick={() => unlockTraining()}>
                  <span className="qa-header-lock-icon" aria-hidden="true">🔒</span>
                  <span>{isStarting ? "准备中..." : "阅读完成后解锁训练"}</span>
                </button>
              ) : null}
            </div>
          </header>

          <div className="qa-scroll" ref={qaScrollRef}>
            <section className="chat-stack">
              {workspaceMode === "training" ? (
                <article className="training-hero-card">
                  <div className="training-hero-title">训练已开启</div>
                  <p>
                    {docTrainingReady
                      ? "当前训练问题会跟着你这篇文档的阅读位置和历史回答实时调整。你可以直接作答，也可以先点“查看解析”拿到引导。"
                      : "当前文档没有固定训练题。你可以先继续阅读，或者直接围绕文档内容提问，让系统按当前上下文接着带你练。"}
                  </p>
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
              placeholder={session ? "直接提问、回答、追问边界，或者引用文档中的一段内容。" : "开始学习后再输入回答。"}
            />

            <div className="question-input-row">
              {workspaceMode === "training" ? (
                <div className="suggested-actions">
                  <button type="button" className="secondary-pill" disabled={!session || isAnswering || !docTrainingReady} onClick={() => submitAnswer({ nextAnswer: "查看解析", intent: "teach" })}>
                    查看解析
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
