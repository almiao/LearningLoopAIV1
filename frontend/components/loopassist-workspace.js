"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { postJson } from "../lib/api";
import { getStoredUserId } from "../lib/user-session";
import {
  getLoopAssistResumeVersions,
  getLoopAssistOptions,
  getLoopAssistRescuePlaylist,
  prepareLoopAssistRescuePlaylist,
  previewLoopAssistScope,
  reviewLoopAssistQuestion,
  reviewLoopAssistSummary,
  saveLoopAssistResumeVersion,
  startLoopAssist,
  streamLoopAssistAnswer,
  synthesizeLoopAssistSpeech,
} from "../lib/loopassist-api";

const defaultScope = {
  role: "",
  round: "",
  topics: [],
  companyStyle: "",
  interviewStyle: "realistic",
  interviewMode: "batch",
  questionBudget: 4,
  resumeText: "",
  jobDescription: "",
};

const interviewRecordStorageKey = "loopassist-latest-interview-record";
const rescueSourceCopy = {
  reuse: "复用已有资料",
  generate: "AI 生成讲解",
  checked: "生成 · 已联网核对",
};

const helpSteps = [
  "点击右上角的面试信息按钮，先完成岗位、简历和 JD 配置，再生成可编辑的大纲。",
  "确认大纲后进入批次面试，听完问题后直接输入回答。",
  "历史记录默认收起，结束面试后再查看完整复盘。",
];

function SettingsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M10 3h4l.6 2.4a7.8 7.8 0 0 1 1.7.7l2.2-1.1 2.8 2.8-1.1 2.2c.3.5.6 1.1.7 1.7L21 14v4l-2.4.6a7.8 7.8 0 0 1-.7 1.7l1.1 2.2-2.8 2.8-2.2-1.1a7.8 7.8 0 0 1-1.7.7L14 29h-4l-.6-2.4a7.8 7.8 0 0 1-1.7-.7l-2.2 1.1-2.8-2.8 1.1-2.2a7.8 7.8 0 0 1-.7-1.7L3 18v-4l2.4-.6a7.8 7.8 0 0 1 .7-1.7L5 9.5 7.8 6.7 10 7.8c.5-.3 1.1-.6 1.7-.7L10 3Z"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
        transform="translate(0 -4)"
      />
      <circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function HelpIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M9.8 9.3a2.5 2.5 0 1 1 4 2c-.9.7-1.8 1.3-1.8 2.7"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
      <circle cx="12" cy="16.8" r="1" fill="currentColor" />
    </svg>
  );
}

function DocumentIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M7 3.5h6.6L18 7.9v12.6H7V3.5Z"
        fill="none"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
      <path d="M13.5 3.5V8H18M9.5 12h5M9.5 15h5M9.5 18h3" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="5" cy="12" r="1.6" fill="currentColor" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" />
      <circle cx="19" cy="12" r="1.6" fill="currentColor" />
    </svg>
  );
}

function HistoryIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 6.5h14M5 12h14M5 17.5h9" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" />
    </svg>
  );
}

function ProgressDots({ current = 1, total = 4 }) {
  const dotCount = Math.min(Math.max(Number(total) || 4, 4), 10);
  const activeIndex = Math.min(Math.max(Number(current) || 1, 1), dotCount) - 1;
  return (
    <div className="loopassist-progress-dots" aria-hidden="true">
      {Array.from({ length: dotCount }, (_, index) => (
        <span key={index} className={index === activeIndex ? "is-active" : ""} />
      ))}
    </div>
  );
}

function formatTurnTime(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result || "");
      resolve(value.includes(",") ? value.split(",").at(-1) : value);
    };
    reader.onerror = () => reject(new Error("文件读取失败。"));
    reader.readAsDataURL(file);
  });
}

function TextAnswerComposer({ value, disabled, onChange, onSubmit }) {
  return (
    <section className="loopassist-text-answer" data-testid="loopassist-text-answer">
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="输入你的回答，尽量像真实面试一样完整表达。"
        disabled={disabled}
        data-testid="loopassist-text-answer-input"
      />
      <button type="button" className="loopassist-primary-action" onClick={onSubmit} disabled={disabled || !value.trim()} data-testid="loopassist-submit-text-answer">
        提交回答
      </button>
    </section>
  );
}

function ConversationHistoryDrawer({ open, turns, currentTurnId, currentTopic, currentQuestionNumber, questionBudget, onClose }) {
  const bodyRef = useRef(null);
  const currentRef = useRef(null);

  useEffect(() => {
    if (!open || !bodyRef.current) {
      return;
    }
    window.requestAnimationFrame(() => {
      if (currentRef.current) {
        currentRef.current.scrollIntoView({ block: "center" });
        return;
      }
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    });
  }, [currentTurnId, open, turns.length]);

  return (
    <>
      <button
        type="button"
        className={`loopassist-history-backdrop${open ? " is-open" : ""}`}
        aria-label="关闭对话记录"
        onClick={onClose}
      />
      <aside className={`loopassist-history-drawer${open ? " is-open" : ""}`} data-testid="loopassist-transcript" aria-hidden={!open}>
        <div className="loopassist-history-head">
          <div>
            <h2>对话记录</h2>
            <p>第 {currentQuestionNumber || 1} / {Math.max(questionBudget || 1, 1)} 题</p>
          </div>
          <button type="button" className="loopassist-icon-button" aria-label="关闭对话记录" onClick={onClose}>×</button>
        </div>
        <div className="loopassist-history-list" ref={bodyRef}>
          {turns.length ? turns.map((turn) => (
            <article
              key={`${turn.turnId}-history`}
              ref={turn.turnId === currentTurnId ? currentRef : null}
              className={`loopassist-history-message is-${turn.role}${turn.turnId === currentTurnId ? " is-current" : ""}`}
            >
              <div className="loopassist-history-message-meta">
                <span>{turn.role === "interviewer" ? "面试官" : "你"} · {formatTurnTime(turn.createdAt)}</span>
                <em>{turn.topic || currentTopic || "综合面试"}</em>
              </div>
              <p>{turn.text}</p>
              {turn.turnId === currentTurnId ? <strong>当前</strong> : null}
            </article>
          )) : (
            <article className="loopassist-empty-state">
              <strong>还没有对话记录</strong>
              <p>开始作答后，本题问答会显示在这里。</p>
            </article>
          )}
        </div>
      </aside>
    </>
  );
}

function readStoredInterviewRecord() {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(interviewRecordStorageKey);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeStoredInterviewRecord(record) {
  if (typeof window === "undefined" || !record) {
    return;
  }
  try {
    window.localStorage.setItem(interviewRecordStorageKey, JSON.stringify(record));
  } catch {}
}

function decodeAssistPayload(payload) {
  if (payload instanceof Uint8Array) {
    return JSON.parse(new TextDecoder().decode(payload));
  }
  if (typeof payload === "string") {
    return JSON.parse(payload);
  }
  return payload || {};
}

function describeTtsError(error) {
  const text = String(error?.message || error || "").toLowerCase();
  if (text.includes("failed to fetch") || text.includes("networkerror") || text.includes("load failed")) {
    return "面试官语音暂时不可用，可以继续文字作答；稍后点“重播”再试。";
  }
  if (text.includes("notallowed") || text.includes("autoplay") || text.includes("play()")) {
    return "浏览器拦截了自动播放，点“重播”即可播放面试官问题。";
  }
  return "面试官语音暂时不可用，可以继续文字作答。";
}

function uniqueValues(values = []) {
  return Array.from(new Set(values.filter(Boolean)));
}

function formatCount(value) {
  return String(Math.max(Number(value) || 0, 0)).padStart(2, "0");
}

function getRescueItemSourceLabel(source = "") {
  return rescueSourceCopy[String(source || "").toLowerCase()] || rescueSourceCopy.generate;
}

function getRescueItemStatusLabel(item = {}) {
  if (item?.status === "learned") {
    return "已学完";
  }
  if (item?.status === "ready") {
    return "已就绪";
  }
  if (item?.source === "reuse") {
    return "读取中…";
  }
  return "生成中…";
}

function pickQuestionLabel(questionNumbers = []) {
  const numbers = Array.from(
    new Set(
      (Array.isArray(questionNumbers) ? questionNumbers : [])
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value > 0)
    )
  ).sort((left, right) => left - right);
  return numbers.length ? `来自第 ${numbers.join("、")} 题` : "来源题目待补充";
}

function summarizeDocument(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "未上传";
  }
  return `${text.length} 字`;
}

function formatResumeVersionTime(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) {
    return "刚刚";
  }
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function buildResumeVersionLabel(version, index = 0) {
  const parts = [
    version?.fileName || `简历版本 ${index + 1}`,
    formatResumeVersionTime(version?.createdAt),
    version?.charCount ? `${version.charCount} 字` : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

function normalizePreviewTopics(preview, topicOptions, scope) {
  if (preview?.sampleSeeds?.length) {
    return uniqueValues(preview.sampleSeeds.flatMap((item) => item.topics || [])).slice(0, 4);
  }

  return uniqueValues(
    topicOptions
      .filter((item) => scope.topics.includes(item.value))
      .map((item) => item.label),
  ).slice(0, 4);
}

function hasInterviewPlan(session) {
  return Boolean(session?.interviewPlan?.stages?.length);
}

function getReviewVerdict(score) {
  if (score >= 85) {
    return "可以直接进入下一轮";
  }
  if (score >= 70) {
    return "整体能聊下去，但项目细节还需要更扎实";
  }
  if (score > 0) {
    return "建议先补项目表达和关键追问，再来一轮";
  }
  return "正在整理这轮总结";
}

function buildOutlineLine(stage) {
  return stage?.baseQuestion || stage?.question || stage?.objective || stage?.theme || "围绕当前主题继续追问";
}

function getStageTopic(stage) {
  const raw = String(stage?.theme || stage?.topic || "综合面试");
  return raw.split(/[·/｜|]/)[0]?.trim() || raw;
}

function getStageTitle(stage, index) {
  return stage?.theme || stage?.baseQuestion || `第 ${index + 1} 题`;
}

function getStageMinutes(stage) {
  return Math.max(Number(stage?.estimatedMinutes || stage?.minutes || 4) || 4, 1);
}

function getStageSourceLabel(stage) {
  const contexts = stage?.sourceContexts || stage?.sourcePreview?.sourceContexts || [];
  const historical = contexts.find((context) => context?.type === "historical_interview");
  if (historical?.contextId) {
    return `参考面经 ${historical.contextId}`;
  }
  const preview = stage?.sourcePreview || {};
  if (preview.seedId) {
    return `参考面经 ${preview.seedId}`;
  }
  if (stage?.seedId) {
    return `参考面经 ${stage.seedId}`;
  }
  return "查看参考材料";
}

function getStageReferenceLine(stage, scope) {
  const contexts = stage?.sourceContexts || stage?.sourcePreview?.sourceContexts || [];
  const parts = contexts.map((context) => context?.label).filter(Boolean);
  if (parts.length) {
    return `参考：${parts.slice(0, 3).join(" + ")}`;
  }
  const fallback = [
    stage?.sourcePreview?.baseQuestion ? "历史面经" : null,
    scope?.resumeText ? "用户简历" : null,
    scope?.jobDescription ? "用户 JD" : null,
  ].filter(Boolean);
  return fallback.length ? `参考：${fallback.join(" + ")}` : "参考：所选岗位范围";
}

function getShellTitle(status) {
  if (status === "outline") {
    return "本轮大纲";
  }
  if (status === "interview") {
    return "正在面试";
  }
  if (status === "review" || status === "reviewing") {
    return "面后总结";
  }
  return "开始面试";
}

const reviewStatusMeta = {
  miss: {
    label: "未答出",
    pillClassName: "is-miss",
    sectionClassName: "is-miss",
  },
  warn: {
    label: "待提升",
    pillClassName: "is-warn",
    sectionClassName: "is-warn",
  },
  good: {
    label: "已掌握",
    pillClassName: "is-good",
    sectionClassName: "is-good",
  },
};

function getReviewStatusMeta(status) {
  return reviewStatusMeta[String(status || "").toLowerCase()] || reviewStatusMeta.warn;
}

function normalizeReviewQuestions(review) {
  return Array.isArray(review?.questionReviews) ? review.questionReviews : [];
}

function normalizeCapabilityDistribution(review, reviewQuestions = []) {
  if (Array.isArray(review?.capabilityDistribution) && review.capabilityDistribution.length) {
    return review.capabilityDistribution;
  }
  if (Array.isArray(review?.topicPerformance) && review.topicPerformance.length) {
    return review.topicPerformance.map((item) => ({
      topic: item.topic || "综合",
      score: Number(item.score) || 0,
      verdict: item.verdict || "",
      evidence: item.evidence || "",
      questionCount: Number(item.questionCount) || 0,
    }));
  }
  const grouped = new Map();
  for (const item of reviewQuestions) {
    const topic = String(item?.topic || "综合");
    const current = grouped.get(topic) || { topic, total: 0, count: 0 };
    current.total += Number(item?.score) || 0;
    current.count += 1;
    grouped.set(topic, current);
  }
  return Array.from(grouped.values()).map((item) => ({
    topic: item.topic,
    score: item.count ? Math.round(item.total / item.count) : 0,
    verdict: "",
    evidence: "",
    questionCount: item.count,
  }));
}

function buildReviewStats(review, reviewQuestions = []) {
  const counts = review?.counts || {};
  const miss = Number.isFinite(Number(counts.miss)) ? Number(counts.miss) : reviewQuestions.filter((item) => item?.status === "miss").length;
  const warn = Number.isFinite(Number(counts.warn)) ? Number(counts.warn) : reviewQuestions.filter((item) => item?.status === "warn").length;
  const good = Number.isFinite(Number(counts.good)) ? Number(counts.good) : reviewQuestions.filter((item) => item?.status === "good").length;
  return {
    miss,
    warn,
    good,
    total: Number.isFinite(Number(counts.total)) ? Number(counts.total) : reviewQuestions.length,
  };
}

function shortTopicLabel(topic = "") {
  const raw = String(topic || "综合").split(/[·/｜|]/)[0]?.trim() || "综合";
  return raw.length > 6 ? `${raw.slice(0, 6)}` : raw;
}

function CapabilityRadar({ items = [], passScore = 60 }) {
  const normalizedItems = items.slice(0, 6);
  const size = 280;
  const center = size / 2;
  const radius = 88;
  const levels = [20, 40, 60, 80, 100];
  const angleStep = (Math.PI * 2) / Math.max(normalizedItems.length, 3);

  function pointFor(score, index) {
    const angle = -Math.PI / 2 + angleStep * index;
    const ratio = Math.max(0, Math.min(Number(score) || 0, 100)) / 100;
    const x = center + Math.cos(angle) * radius * ratio;
    const y = center + Math.sin(angle) * radius * ratio;
    return `${x},${y}`;
  }

  function ringPoints(score) {
    return normalizedItems.map((_, index) => pointFor(score, index)).join(" ");
  }

  const polygonPoints = normalizedItems.map((item, index) => pointFor(item?.score, index)).join(" ");
  const passPoints = ringPoints(passScore);

  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="loopassist-radar-chart" aria-hidden="true">
      {levels.map((level) => (
        <polygon key={level} points={ringPoints(level)} className={`loopassist-radar-ring${level === passScore ? " is-pass" : ""}`} />
      ))}
      {normalizedItems.map((item, index) => {
        const angle = -Math.PI / 2 + angleStep * index;
        const labelRadius = radius + 26;
        const labelX = center + Math.cos(angle) * labelRadius;
        const labelY = center + Math.sin(angle) * labelRadius;
        return (
          <g key={`${item?.topic || "topic"}-${index}`}>
            <line
              x1={center}
              y1={center}
              x2={center + Math.cos(angle) * radius}
              y2={center + Math.sin(angle) * radius}
              className="loopassist-radar-axis"
            />
            <text x={labelX} y={labelY} textAnchor="middle" className="loopassist-radar-label">
              {shortTopicLabel(item?.topic)}
            </text>
          </g>
        );
      })}
      <polygon points={passPoints} className="loopassist-radar-pass" />
      <polygon points={polygonPoints} className="loopassist-radar-area" />
      {normalizedItems.map((item, index) => {
        const [x, y] = pointFor(item?.score, index).split(",");
        return <circle key={`point-${index}`} cx={x} cy={y} r="4" className="loopassist-radar-point" />;
      })}
    </svg>
  );
}

function guessReviewDifficulty(questionText = "", topic = "") {
  const text = String(questionText || "");
  const topicText = String(topic || "");
  if (/[原理机制底层源码索引事务并发]/.test(text) || /系统设计|分布式|数据库|并发/.test(topicText)) {
    return "中高";
  }
  if (/[项目介绍负责]/.test(text)) {
    return "中等";
  }
  return "高频";
}

function buildInitialReviewCards(session, transcript = []) {
  const interviewerTurns = (transcript || []).filter((turn) => turn?.role === "interviewer");
  const planStages = session?.interviewPlan?.stages || [];
  return interviewerTurns.map((turn, index) => {
    const stage = planStages[index] || planStages.find((item) => Number(item?.step) === Number(turn?.planStep)) || {};
    return {
      questionNumber: index + 1,
      questionText: turn?.text || stage?.baseQuestion || `第 ${index + 1} 题`,
      topic: turn?.topic || stage?.theme || "综合",
      difficulty: guessReviewDifficulty(turn?.text || stage?.baseQuestion || "", turn?.topic || stage?.theme || ""),
      phase: "pending",
      review: null,
      error: "",
      mastered: false,
    };
  });
}

function buildReviewLiveProgress(cards = []) {
  return cards.reduce((acc, item) => {
    if (item?.phase === "success") {
      acc.resolved += 1;
      if (item?.review?.status === "miss") {
        acc.miss += 1;
      } else if (item?.review?.status === "good") {
        acc.good += 1;
      } else if (item?.review?.status === "warn") {
        acc.warn += 1;
      }
      return acc;
    }
    if (item?.phase === "error") {
      acc.resolved += 1;
    }
    return acc;
  }, {
    resolved: 0,
    miss: 0,
    warn: 0,
    good: 0,
    total: cards.length,
  });
}

export function LoopAssistWorkspace() {
  const router = useRouter();
  const [userId, setUserId] = useState("");
  const [options, setOptions] = useState(null);
  const [scope, setScope] = useState(defaultScope);
  const [preview, setPreview] = useState(null);
  const [session, setSession] = useState(null);
  const [review, setReview] = useState(null);
  const [status, setStatus] = useState("setup");
  const [error, setError] = useState("");
  const [voiceIssue, setVoiceIssue] = useState("");
  const [voiceIssueKind, setVoiceIssueKind] = useState("");
  const [textAnswer, setTextAnswer] = useState("");
  const [lastInterviewerText, setLastInterviewerText] = useState("");
  const [ttsStatus, setTtsStatus] = useState("idle");
  const [activePanel, setActivePanel] = useState(null);
  const [resumeFileName, setResumeFileName] = useState("");
  const [resumeVersions, setResumeVersions] = useState([]);
  const [selectedResumeVersionId, setSelectedResumeVersionId] = useState("");
  const [useSavedResumeVersion, setUseSavedResumeVersion] = useState(false);
  const [resumeLibraryState, setResumeLibraryState] = useState("idle");
  const [resumeLibraryNotice, setResumeLibraryNotice] = useState("");
  const [jdFileName, setJdFileName] = useState("");
  const [isJdExpanded, setIsJdExpanded] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [latestInterviewRecord, setLatestInterviewRecord] = useState(null);
  const [activeSourcePreview, setActiveSourcePreview] = useState(null);
  const [focusedQuestionIndex, setFocusedQuestionIndex] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [reviewFilter, setReviewFilter] = useState("all");
  const [openReviewQuestions, setOpenReviewQuestions] = useState({});
  const [reviewCards, setReviewCards] = useState([]);
  const [reviewSummaryState, setReviewSummaryState] = useState("idle");
  const [isReviewSummaryInView, setIsReviewSummaryInView] = useState(true);
  const [showReviewSummaryToast, setShowReviewSummaryToast] = useState(false);
  const [rescuePlaylist, setRescuePlaylist] = useState(null);
  const [rescueModalOpen, setRescueModalOpen] = useState(false);
  const [rescueModalFocusItemId, setRescueModalFocusItemId] = useState("");
  const [rescuePlaylistState, setRescuePlaylistState] = useState("idle");
  const [rescueError, setRescueError] = useState("");
  const audioRef = useRef(null);
  const audioCacheRef = useRef(new Map());
  const latestSessionRef = useRef(null);
  const panelRef = useRef(null);
  const settingsPanelRef = useRef(null);
  const resumeInputRef = useRef(null);
  const jdInputRef = useRef(null);
  const autoOpenedSettingsRef = useRef(false);
  const reviewQuestionsRef = useRef(null);
  const reviewSummaryRef = useRef(null);
  const reviewRunIdRef = useRef(0);
  const rescuePreparedSessionIdRef = useRef("");

  useEffect(() => {
    latestSessionRef.current = session;
  }, [session]);

  useEffect(() => {
    setUserId(getStoredUserId());
  }, []);

  useEffect(() => {
    setLatestInterviewRecord(readStoredInterviewRecord());
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!userId) {
      setResumeLibraryState("ready");
      return undefined;
    }

    setResumeLibraryState("loading");
    getLoopAssistResumeVersions(userId)
      .then((data) => {
        if (cancelled) {
          return;
        }
        const versions = Array.isArray(data?.versions) ? data.versions : [];
        const latestVersionId = data?.latestVersionId || versions[0]?.id || "";
        setResumeVersions(versions);
        setSelectedResumeVersionId(latestVersionId);
        setUseSavedResumeVersion(Boolean(versions.length));
        setResumeLibraryState("ready");
        if (versions.length) {
          const defaultVersion = versions.find((item) => item.id === latestVersionId) || versions[0];
          setScope((current) => (
            String(current.resumeText || "").trim()
              ? current
              : { ...current, resumeText: defaultVersion.text || "" }
          ));
          setResumeFileName((current) => current || defaultVersion.fileName || "");
        }
      })
      .catch((nextError) => {
        if (cancelled) {
          return;
        }
        setResumeLibraryState("error");
        setResumeLibraryNotice(nextError.message || "简历版本加载失败。");
      });

    return () => {
      cancelled = true;
    };
  }, [userId]);

  useEffect(() => {
    getLoopAssistOptions()
      .then((data) => {
        setOptions(data);
        setScope((current) => ({
          ...current,
          role: data.roles?.[0]?.value || "",
          round: data.rounds?.[0]?.value || "",
          topics: data.topics?.slice(0, 3).map((item) => item.value) || [],
          companyStyle: data.companyStyles?.[0]?.value || "",
        }));
      })
      .catch((nextError) => setError(nextError.message));
  }, []);

  useEffect(() => {
    if (!scope.role && !scope.round) {
      return undefined;
    }
    const controller = new AbortController();
    previewLoopAssistScope(scope)
      .then((data) => {
        if (!controller.signal.aborted) {
          setPreview(data);
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, [scope]);

  useEffect(() => () => {
    audioRef.current?.pause?.();
    for (const url of audioCacheRef.current.values()) {
      URL.revokeObjectURL(url);
    }
    audioCacheRef.current.clear();
  }, []);

  useEffect(() => {
    if (scope.jobDescription) {
      setIsJdExpanded(true);
    }
  }, [scope.jobDescription]);

  useEffect(() => {
    if (!activePanel) {
      return undefined;
    }

    function handlePointerDown(event) {
      if (panelRef.current?.contains(event.target) || settingsPanelRef.current?.contains(event.target)) {
        return;
      }
      setActivePanel(null);
    }

    function handleEscape(event) {
      if (event.key === "Escape") {
        setActivePanel(null);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [activePanel]);

  useEffect(() => {
    if (status !== "interview") {
      return undefined;
    }

    function handleInterviewShortcuts(event) {
      if (event.key === "Escape") {
        setIsHistoryOpen(false);
        setActivePanel(null);
        return;
      }
      if (event.key?.toLowerCase() === "h") {
        const target = event.target;
        if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable) {
          return;
        }
        event.preventDefault();
        setIsHistoryOpen((current) => !current);
      }
    }

    document.addEventListener("keydown", handleInterviewShortcuts);
    return () => document.removeEventListener("keydown", handleInterviewShortcuts);
  }, [status]);

  useEffect(() => {
    const reviewQuestions = normalizeReviewQuestions(review);
    const firstWeakQuestion = reviewQuestions.find((item) => item?.status !== "good") || reviewQuestions[0];
    setReviewFilter("all");
    setOpenReviewQuestions(firstWeakQuestion ? { [String(firstWeakQuestion.questionNumber || 1)]: true } : {});
  }, [review]);

  useEffect(() => {
    if (status !== "review" || reviewSummaryState !== "done" || !review || !session?.sessionId) {
      return;
    }
    if (rescuePreparedSessionIdRef.current === session.sessionId && rescuePlaylist?.id) {
      return;
    }
    let cancelled = false;
    rescuePreparedSessionIdRef.current = session.sessionId;
    setRescuePlaylistState("loading");
    prepareLoopAssistRescuePlaylist({
      sessionId: session.sessionId,
      userId,
      scope,
      review,
    })
      .then((data) => {
        if (cancelled) {
          return;
        }
        setRescuePlaylist(data?.playlist || null);
        setRescuePlaylistState("ready");
        setRescueError("");
      })
      .catch((nextError) => {
        if (cancelled) {
          return;
        }
        setRescuePlaylistState("error");
        setRescueError(nextError.message || "补救清单准备失败。");
      });
    return () => {
      cancelled = true;
    };
  }, [review, reviewSummaryState, scope, session?.sessionId, status, userId]);

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

  useEffect(() => {
    if (!reviewSummaryRef.current || (status !== "review" && status !== "reviewing")) {
      return undefined;
    }
    const observer = new IntersectionObserver(([entry]) => {
      setIsReviewSummaryInView(Boolean(entry?.isIntersecting));
    }, {
      threshold: 0.2,
    });
    observer.observe(reviewSummaryRef.current);
    return () => observer.disconnect();
  }, [status, reviewSummaryState]);

  useEffect(() => {
    if (reviewSummaryState !== "done") {
      setShowReviewSummaryToast(false);
      return;
    }
    if (!isReviewSummaryInView && typeof window !== "undefined" && window.scrollY > 120) {
      setShowReviewSummaryToast(true);
    }
  }, [isReviewSummaryInView, reviewSummaryState]);

  const transcript = session?.transcript || [];
  const topicOptions = useMemo(() => options?.topics?.slice(0, 18) || [], [options]);
  const sampleTopics = useMemo(
    () => normalizePreviewTopics(preview, topicOptions, scope),
    [preview, scope, topicOptions],
  );
  const previewCards = preview?.sampleSeeds?.slice(0, 3) || [];
  const interviewerTurns = useMemo(
    () => transcript.filter((turn) => turn.role === "interviewer"),
    [transcript],
  );
  const selectedResumeVersion = useMemo(
    () => resumeVersions.find((item) => item.id === selectedResumeVersionId) || null,
    [resumeVersions, selectedResumeVersionId],
  );
  const latestResumeVersion = resumeVersions[0] || null;

  useEffect(() => {
    if (!interviewerTurns.length) {
      setFocusedQuestionIndex(null);
      return;
    }
    setFocusedQuestionIndex(interviewerTurns.length - 1);
  }, [interviewerTurns.length]);

  const questionBudget = Math.max(Number(scope.questionBudget) || 8, 1);
  const currentQuestionIndex =
    interviewerTurns.length && focusedQuestionIndex != null
      ? Math.min(Math.max(focusedQuestionIndex, 0), interviewerTurns.length - 1)
      : interviewerTurns.length - 1;
  const currentQuestionTurn = interviewerTurns[currentQuestionIndex] || null;
  const currentQuestionNumber = currentQuestionIndex >= 0 ? currentQuestionIndex + 1 : 0;
  const currentQuestion =
    currentQuestionTurn?.text ||
    session?.interviewerMessage?.text ||
    lastInterviewerText ||
    "第一题会在这里显示。";
  const latestTurn = transcript.at(-1) || null;
  const isAwaitingFollowup = status === "interview" && isSubmitting && latestTurn?.role === "candidate";
  const questionTitle = isAwaitingFollowup ? "正在生成下一问…" : currentQuestion;
  const questionTone = isAwaitingFollowup
    ? "我已经收到你的回答，正在根据这轮内容组织下一道追问。"
    : voiceIssue
      ? voiceIssue
      : !voiceIssue && error
        ? error
        : "";
  const reviewQuestions = useMemo(() => normalizeReviewQuestions(review), [review]);
  const reviewLiveProgress = useMemo(() => buildReviewLiveProgress(reviewCards), [reviewCards]);
  const capabilityDistribution = useMemo(
    () => normalizeCapabilityDistribution(review, reviewQuestions),
    [review, reviewQuestions],
  );
  const reviewStats = useMemo(
    () => buildReviewStats(review, reviewQuestions),
    [review, reviewQuestions],
  );
  const filteredReviewQuestions = useMemo(
    () => (reviewFilter === "all"
      ? reviewQuestions
      : reviewQuestions.filter((item) => item?.status === reviewFilter)),
    [reviewFilter, reviewQuestions],
  );
  const filteredReviewCards = useMemo(
    () => (reviewFilter === "all"
      ? reviewCards
      : reviewCards.filter((item) => item?.review?.status === reviewFilter)),
    [reviewCards, reviewFilter],
  );
  const firstWeakReviewQuestion = useMemo(
    () => reviewQuestions.find((item) => item?.status !== "good") || reviewQuestions[0] || null,
    [reviewQuestions],
  );
  const displayedReviewCards = reviewSummaryState === "done" ? filteredReviewCards : reviewCards;
  const reviewFilterCounts = reviewSummaryState === "done"
    ? { all: reviewStats.total, miss: reviewStats.miss, warn: reviewStats.warn, good: reviewStats.good }
    : { all: reviewCards.length, miss: reviewLiveProgress.miss, warn: reviewLiveProgress.warn, good: reviewLiveProgress.good };
  const interviewPlan = session?.interviewPlan || null;
  const planStages = interviewPlan?.stages || [];
  const hasGeneratedOutline = hasInterviewPlan(session) || ["outline", "interview", "review", "reviewing"].includes(status);
  const shouldCenterSettings = true;
  const reviewScore = Number(review?.readinessScore || 0);
  const reviewVerdict = getReviewVerdict(reviewScore);
  const currentPlanStage = planStages[currentQuestionIndex] || planStages[0] || null;
  const totalEstimatedMinutes = Math.max(
    planStages.reduce((sum, stage) => sum + getStageMinutes(stage), 0) || questionBudget * 4,
    1,
  );
  const reviewStrengthCount = reviewStats.good;
  const reviewWeaknessCount = reviewStats.miss + reviewStats.warn;
  const reviewFollowupCount = review?.likelyFollowups?.length || 0;
  const reviewScoreGap = Math.max(60 - reviewScore, 0);
  const weakestCapability = capabilityDistribution.slice().sort((left, right) => (Number(left?.score) || 0) - (Number(right?.score) || 0))[0] || null;
  const rescueItems = rescuePlaylist?.items || [];
  const rescueReadyCount = Number(rescuePlaylist?.readyCount || 0);
  const rescueRemainingCount = Number(rescuePlaylist?.remainingCount || 0);
  const rescueTotalCount = Number(rescuePlaylist?.totalCount || rescueItems.length || 0);
  const rescueCompleted = Boolean(rescuePlaylist?.completed);
  const rescueFirstReadyItem = rescueItems.find((item) => item?.status === "ready" || item?.status === "learned") || null;
  const rescueFocusItem = rescueModalFocusItemId
    ? rescueItems.find((item) => item?.id === rescueModalFocusItemId) || null
    : null;
  const shellTitle = getShellTitle(status);
  const hasResumeContext = Boolean(String(scope.resumeText || "").trim());
  const outlineCtaBadge = hasResumeContext ? "贴合你" : "通用";
  const questionToneClassName = [
    "loopassist-inline-message",
    voiceIssue ? (voiceIssueKind === "tts" ? "loopassist-inline-note" : "loopassist-inline-error") : "",
    error ? "loopassist-inline-error" : "",
  ].filter(Boolean).join(" ");
  const questionEyebrow = currentPlanStage?.theme || sampleTopics[0] || "综合面试";
  const canReplayInterviewer = ttsStatus !== "idle" && Boolean(lastInterviewerText || currentQuestion);

  useEffect(() => {
    if (autoOpenedSettingsRef.current || !options || hasGeneratedOutline || status !== "setup") {
      return;
    }
    autoOpenedSettingsRef.current = true;
    setActivePanel("settings");
  }, [hasGeneratedOutline, options, status]);

  function updateScope(key, value) {
    setScope((current) => ({
      ...current,
      [key]: value,
    }));
  }

  function applySavedResumeVersion(version, { keepSelection = true, clearNotice = true } = {}) {
    if (!version) {
      return;
    }
    setScope((current) => ({
      ...current,
      resumeText: version.text || "",
    }));
    setResumeFileName(version.fileName || "");
    setUseSavedResumeVersion(true);
    if (keepSelection) {
      setSelectedResumeVersionId(version.id || "");
    }
    if (clearNotice) {
      setResumeLibraryNotice("");
    }
  }

  function handleResumeTextChange(value) {
    setUseSavedResumeVersion(false);
    setResumeFileName("");
    updateScope("resumeText", value);
  }

  function handleSavedResumeToggle(checked) {
    if (!checked) {
      setUseSavedResumeVersion(false);
      setResumeFileName("");
      updateScope("resumeText", "");
      return;
    }
    const nextVersion = selectedResumeVersion || latestResumeVersion;
    if (nextVersion) {
      applySavedResumeVersion(nextVersion);
    }
  }

  function handleResumeVersionSelection(versionId) {
    const nextVersion = resumeVersions.find((item) => item.id === versionId);
    setSelectedResumeVersionId(versionId);
    if (nextVersion) {
      applySavedResumeVersion(nextVersion, { keepSelection: false });
    }
  }

  function toggleReviewQuestion(questionNumber) {
    const key = String(questionNumber || "");
    if (!key) {
      return;
    }
    setOpenReviewQuestions((current) => ({
      ...current,
      [key]: !current[key],
    }));
  }

  function focusRescueQuestions(nextFilter = "miss") {
    setReviewFilter(nextFilter);
    const candidateQuestion = reviewQuestions.find((item) => item?.status === nextFilter)
      || firstWeakReviewQuestion;
    if (candidateQuestion) {
      setOpenReviewQuestions({ [String(candidateQuestion.questionNumber || 1)]: true });
    }
    window.requestAnimationFrame(() => {
      reviewQuestionsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  async function ensureRescuePlaylistLoaded() {
    if (rescuePlaylist?.id) {
      const latest = await getLoopAssistRescuePlaylist(rescuePlaylist.id).catch(() => rescuePlaylist);
      const nextPlaylist = latest?.playlist || latest;
      if (nextPlaylist) {
        setRescuePlaylist(nextPlaylist);
        return nextPlaylist;
      }
    }
    if (!session?.sessionId || !review) {
      throw new Error("复盘结果还没准备好。");
    }
    const data = await prepareLoopAssistRescuePlaylist({
      sessionId: session.sessionId,
      userId,
      scope,
      review,
    });
    setRescuePlaylist(data?.playlist || null);
    return data?.playlist || null;
  }

  async function openRescuePlaylistModal({ questionNumber = null } = {}) {
    try {
      setRescuePlaylistState("loading");
      const playlist = await ensureRescuePlaylistLoaded();
      const focusItemId = questionNumber
        ? (playlist?.questionItemMap?.[String(questionNumber)] || [])[0] || ""
        : "";
      setRescueModalFocusItemId(focusItemId);
      setRescueModalOpen(true);
      setRescuePlaylistState("ready");
      setRescueError("");
    } catch (nextError) {
      setRescueError(nextError.message || "补救清单准备失败。");
      setRescuePlaylistState("error");
    }
  }

  function closeRescuePlaylistModal() {
    setRescueModalOpen(false);
    setRescueModalFocusItemId("");
  }

  function enterRescueLearning(itemId = "") {
    const targetItem = (itemId ? rescueItems.find((item) => item?.id === itemId) : null)
      || (rescueFocusItem?.status === "ready" || rescueFocusItem?.status === "learned" ? rescueFocusItem : null)
      || rescueFirstReadyItem;
    if (!rescuePlaylist?.id || !targetItem) {
      return;
    }
    closeRescuePlaylistModal();
    router.push(`/learn?rescuePlaylist=${encodeURIComponent(rescuePlaylist.id)}&rescueItem=${encodeURIComponent(targetItem.id)}`);
  }

  function openSettingsPanel() {
    setActivePanel("settings");
  }

  async function handleDocumentUpload(kind, file) {
    if (!file) {
      return;
    }
    let text = "";
    const isPdf = (file.type || "").toLowerCase() === "application/pdf" || /\.pdf$/i.test(file.name || "");
    if (isPdf) {
      if (!userId) {
        setResumeLibraryState("error");
        setResumeLibraryNotice("请先登录后再上传 PDF 文件。");
        if (resumeInputRef.current) {
          resumeInputRef.current.value = "";
        }
        return;
      }
      const data = await postJson("/api/materials/upload", {
        userId,
        filename: file.name,
        mimeType: file.type || "application/pdf",
        contentBase64: await readFileAsBase64(file),
      });
      text = String(
        data?.material?.learning?.text
        || data?.material?.learning?.markdown
        || data?.material?.markdown
        || "",
      ).trim();
      if (!text) {
        throw new Error("PDF 暂未提取出足够文本，请检查文件内容后重试。");
      }
    } else {
      text = await file.text();
    }
    if (kind === "resume") {
      setResumeLibraryNotice("");
      if (!userId) {
        setUseSavedResumeVersion(false);
        updateScope("resumeText", text);
        setResumeFileName(file.name);
        setActivePanel("settings");
        if (resumeInputRef.current) {
          resumeInputRef.current.value = "";
        }
        return;
      }
      try {
        setResumeLibraryState("saving");
        const nextLibrary = await saveLoopAssistResumeVersion({
          userId,
          text,
          fileName: file.name,
        });
        const versions = Array.isArray(nextLibrary?.versions) ? nextLibrary.versions : [];
        const savedVersion = versions.find((item) => item.id === nextLibrary.savedVersionId) || versions[0] || null;
        setResumeVersions(versions);
        setSelectedResumeVersionId(nextLibrary.savedVersionId || savedVersion?.id || "");
        setResumeLibraryState("ready");
        if (savedVersion) {
          applySavedResumeVersion(savedVersion, { keepSelection: false, clearNotice: false });
        } else {
          setUseSavedResumeVersion(false);
          updateScope("resumeText", text);
          setResumeFileName(file.name);
        }
      } catch (nextError) {
        setResumeLibraryState("error");
        setUseSavedResumeVersion(false);
        updateScope("resumeText", text);
        setResumeFileName(file.name);
        setResumeLibraryNotice(nextError.message || "简历版本保存失败，本次先使用当前上传内容。");
      }
      setActivePanel("settings");
      if (resumeInputRef.current) {
        resumeInputRef.current.value = "";
      }
      return;
    }
    updateScope("jobDescription", text);
    setJdFileName(file.name);
    setIsJdExpanded(true);
    setActivePanel("settings");
    if (jdInputRef.current) {
      jdInputRef.current.value = "";
    }
  }

  function resetWorkspace() {
    setReview(null);
    setSession(null);
    setStatus("setup");
    setError("");
    setVoiceIssue("");
    setVoiceIssueKind("");
    setTextAnswer("");
    setLastInterviewerText("");
    setTtsStatus("idle");
    setActivePanel(null);
    setIsHistoryOpen(false);
    setActiveSourcePreview(null);
    setFocusedQuestionIndex(null);
    setReviewCards([]);
    setReviewSummaryState("idle");
    setShowReviewSummaryToast(false);
    setRescuePlaylist(null);
    setRescueModalOpen(false);
    setRescueModalFocusItemId("");
    setRescuePlaylistState("idle");
    setRescueError("");
    rescuePreparedSessionIdRef.current = "";
    audioRef.current?.pause?.();
  }

  async function beginInterview() {
    setError("");
    setVoiceIssue("");
    setVoiceIssueKind("");
    setReview(null);
    setRescuePlaylist(null);
    setRescueModalOpen(false);
    setRescueModalFocusItemId("");
    setRescuePlaylistState("idle");
    setRescueError("");
    rescuePreparedSessionIdRef.current = "";
    setActivePanel(null);
    setStatus("outlining");
    try {
      const nextSession = await startLoopAssist({
        userId,
        useLatestStoredResume: useSavedResumeVersion,
        scope,
      });
      setSession(nextSession);
      setStatus("outline");
      const interviewerText = nextSession.interviewerMessage?.text || nextSession.transcript?.at(-1)?.text || "";
      setLastInterviewerText(interviewerText);
    } catch (nextError) {
      setError(nextError.message);
      setStatus("setup");
    }
  }

  async function startInterviewFromOutline() {
    setStatus("interview");
    setIsHistoryOpen(false);
    setActivePanel(null);
    const interviewerText = session?.interviewerMessage?.text || session?.transcript?.at(-1)?.text || lastInterviewerText || "";
    setLastInterviewerText(interviewerText);
    await playInterviewerAudio(interviewerText);
  }

  async function playInterviewerAudio(text, options = {}) {
    const { autoplay = true } = options;
    const line = String(text || "").trim();
    if (typeof window === "undefined" || !line) {
      return;
    }
    audioRef.current?.pause?.();
    try {
      setTtsStatus("loading");
      let url = audioCacheRef.current.get(line);
      if (!url) {
        const blob = await synthesizeLoopAssistSpeech({ text: line });
        url = URL.createObjectURL(blob);
        audioCacheRef.current.set(line, url);
      }
      setTtsStatus("ready");
      if (!autoplay) {
        return;
      }
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.addEventListener(
        "playing",
        () => {
          setTtsStatus("playing");
        },
        { once: true },
      );
      audio.addEventListener(
        "ended",
        () => {
          setTtsStatus("ready");
        },
        { once: true },
      );
      await audio.play();
    } catch (nextError) {
      setTtsStatus("error");
      setVoiceIssue(describeTtsError(nextError));
      setVoiceIssueKind("tts");
    }
  }

  async function submitTextAnswer() {
    const answer = textAnswer.trim();
    if (!answer || isSubmitting || status !== "interview") {
      return;
    }
    setTextAnswer("");
    await submitCandidateAnswer(answer);
  }

  async function skipQuestion() {
    if (!session?.sessionId || isSubmitting || status !== "interview") {
      return;
    }
    await submitCandidateAnswer("这题我先跳过，请继续下一题。");
  }

  async function submitCandidateAnswer(answerText) {
    const answer = String(answerText || "").trim();
    const activeSession = latestSessionRef.current;
    if (!answer || !activeSession?.sessionId || isSubmitting) {
      return;
    }
    setIsSubmitting(true);
    const candidateTurn = {
      turnId: `local_candidate_${Date.now()}`,
      role: "candidate",
      text: answer,
      createdAt: Date.now(),
    };
    setSession((current) => ({
      ...current,
      transcript: [...(current?.transcript || []), candidateTurn],
    }));
    let streamedText = "";
    try {
      await streamLoopAssistAnswer(
        {
          sessionId: activeSession.sessionId,
          answer,
        },
        (event, data) => {
          if (event === "reply_delta") {
            streamedText += data.delta || "";
          }
          if (event === "session") {
            setSession(data);
            if (data.completed) {
              setLastInterviewerText("");
              loadReviewForSession(data.sessionId);
              return;
            }
            const interviewerText = data.interviewerMessage?.text || streamedText;
            setLastInterviewerText(interviewerText);
            playInterviewerAudio(interviewerText);
          }
        },
      );
    } catch (nextError) {
      setVoiceIssue(nextError.message);
      setVoiceIssueKind("network");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function finishAndReview() {
    if (!session?.sessionId) {
      return;
    }
    await loadReviewForSession(session.sessionId);
  }

  function persistLatestInterviewReview({ sessionId, nextSession, nextReview }) {
    const nextRecord = {
      id: sessionId,
      savedAt: Date.now(),
      scope,
      session: nextSession,
      review: nextReview,
      transcript: nextSession.transcript || [],
      interviewPlan: nextSession.interviewPlan || null,
    };
    setLatestInterviewRecord(nextRecord);
    writeStoredInterviewRecord(nextRecord);
  }

  async function runSingleQuestionReview(sessionId, questionNumber) {
    const result = await reviewLoopAssistQuestion({ sessionId, questionNumber });
    return result?.questionReview || null;
  }

  async function retryReviewQuestion(questionNumber) {
    const activeSession = latestSessionRef.current;
    if (!activeSession?.sessionId) {
      return;
    }
    setReviewCards((current) => current.map((item) => (
      item.questionNumber === questionNumber
        ? { ...item, phase: "running", error: "" }
        : item
    )));
    try {
      const questionReview = await runSingleQuestionReview(activeSession.sessionId, questionNumber);
      setReviewCards((current) => current.map((item) => (
        item.questionNumber === questionNumber
          ? { ...item, phase: "success", review: questionReview, error: "" }
          : item
      )));
    } catch (nextError) {
      setReviewCards((current) => current.map((item) => (
        item.questionNumber === questionNumber
          ? { ...item, phase: "error", error: nextError.message || "诊断失败，请重试。" }
          : item
      )));
    }
  }

  function markReviewQuestionMastered(questionNumber) {
    setReviewCards((current) => current.map((item) => (
      item.questionNumber === questionNumber
        ? { ...item, mastered: !item.mastered }
        : item
    )));
  }

  function scrollToReviewSummary() {
    reviewSummaryRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    setShowReviewSummaryToast(false);
  }

  async function loadReviewForSession(sessionId) {
    if (!sessionId) {
      return;
    }
    setStatus("reviewing");
    setError("");
    setReview(null);
    setReviewSummaryState("progress");
    setShowReviewSummaryToast(false);
    audioRef.current?.pause?.();
    try {
      const runId = Date.now();
      reviewRunIdRef.current = runId;
      const nextTranscript = latestSessionRef.current?.transcript || [];
      const nextSession = {
        ...(latestSessionRef.current || {}),
        sessionId,
        transcript: nextTranscript,
      };
      setSession(nextSession);
      const initialCards = buildInitialReviewCards(nextSession, nextTranscript);
      setReviewCards(initialCards);

      const results = new Array(initialCards.length).fill(null);
      let cursor = 0;
      const concurrency = Math.min(5, Math.max(initialCards.length, 1));

      async function worker() {
        while (cursor < initialCards.length) {
          const currentIndex = cursor;
          cursor += 1;
          const currentCard = initialCards[currentIndex];
          if (!currentCard) {
            continue;
          }
          if (reviewRunIdRef.current !== runId) {
            return;
          }
          setReviewCards((current) => current.map((item) => (
            item.questionNumber === currentCard.questionNumber
              ? { ...item, phase: "running", error: "" }
              : item
          )));
          try {
            const questionReview = await Promise.race([
              runSingleQuestionReview(sessionId, currentCard.questionNumber),
              new Promise((_, reject) => {
                window.setTimeout(() => reject(new Error("诊断超时，请重试。")), 20000);
              }),
            ]);
            results[currentIndex] = questionReview;
            if (reviewRunIdRef.current !== runId) {
              return;
            }
            setReviewCards((current) => current.map((item) => (
              item.questionNumber === currentCard.questionNumber
                ? { ...item, phase: "success", review: questionReview, error: "" }
                : item
            )));
          } catch (nextError) {
            if (reviewRunIdRef.current !== runId) {
              return;
            }
            setReviewCards((current) => current.map((item) => (
              item.questionNumber === currentCard.questionNumber
                ? { ...item, phase: "error", error: nextError.message || "诊断失败，请重试。" }
                : item
            )));
          }
        }
      }

      await Promise.all(Array.from({ length: concurrency }, () => worker()));
      if (reviewRunIdRef.current !== runId) {
        return;
      }
      setReviewSummaryState("summarizing");
      await new Promise((resolve) => window.setTimeout(resolve, 900));
      const resolvedQuestionReviews = results.filter(Boolean);
      const summaryResult = await reviewLoopAssistSummary({
        sessionId,
        questionReviews: resolvedQuestionReviews,
      });
      if (reviewRunIdRef.current !== runId) {
        return;
      }
      setReview(summaryResult.review);
      setReviewCards((current) => current.map((item) => {
        const matched = summaryResult.review?.questionReviews?.find((reviewItem) => Number(reviewItem?.questionNumber) === Number(item.questionNumber));
        return matched
          ? { ...item, phase: "success", review: matched, error: item.error || "", mastered: item.mastered }
          : item;
      }));
      setReviewSummaryState("done");
      persistLatestInterviewReview({
        sessionId,
        nextSession,
        nextReview: summaryResult.review,
      });
      setStatus("review");
    } catch (nextError) {
      setError(nextError.message);
      setStatus("interview");
      setReviewSummaryState("idle");
    }
  }

  function openLatestInterviewRecord() {
    const record = latestInterviewRecord || readStoredInterviewRecord();
    if (!record?.review) {
      setError("暂无面试记录。完成一轮面试后，这里会直接打开结果页。");
      return;
    }
    setActivePanel(null);
    setIsHistoryOpen(false);
    setScope((current) => ({
      ...current,
      ...(record.scope || {}),
    }));
    setSession({
      ...(record.session || {}),
      interviewPlan: record.interviewPlan || record.session?.interviewPlan || null,
      transcript: record.transcript || record.session?.transcript || [],
    });
    setReview(record.review);
    setReviewCards((record.review?.questionReviews || []).map((item) => ({
      questionNumber: item.questionNumber,
      questionText: item.questionText,
      topic: item.topic,
      difficulty: item.difficulty,
      phase: "success",
      review: item,
      error: "",
      mastered: false,
    })));
    setReviewSummaryState("done");
    setShowReviewSummaryToast(false);
    setStatus("review");
    setLatestInterviewRecord(record);
    setRescuePlaylist(null);
    setRescueModalOpen(false);
    setRescueModalFocusItemId("");
    setRescuePlaylistState("idle");
    setRescueError("");
    rescuePreparedSessionIdRef.current = "";
  }

  async function confirmResetWorkspace() {
    if (!window.confirm("确认重置当前大纲和会话状态吗？已填写的面试信息会保留。")) {
      return;
    }
    resetWorkspace();
    setActivePanel("settings");
  }

  async function confirmFinishAndReview() {
    if (!window.confirm("确认结束本轮并生成复盘吗？")) {
      return;
    }
    await finishAndReview();
  }

  return (
    <main className={`loopassist-shell${isHistoryOpen && status === "interview" ? " is-history-open" : ""}`} data-testid="loopassist-shell">
      <header className="loopassist-nav">
        <Link href="/" className="loopassist-brand">
          <span className="loopassist-brand-mark" aria-hidden="true">L</span>
          <span className="loopassist-brand-copy">
            <strong>LoopAssist</strong>
            <span>{status === "setup" ? "新建面试" : `${scope.role || "目标岗位"} · ${scope.round || "当前轮次"}`}</span>
          </span>
          {((status === "review" || status === "reviewing") && reviewSummaryState === "done") ? (
            <span className="loopassist-review-verdict-pill">
              {reviewScore >= 70 ? "建议补强后推进" : "建议补强后再来一轮"}
            </span>
          ) : null}
        </Link>

        <div className="loopassist-nav-meta">
          <strong>{status === "interview" ? "面试中" : shellTitle}</strong>
          {status === "outline" ? <span>{planStages.length || questionBudget} 题 · 预计 {totalEstimatedMinutes} 分钟</span> : null}
          {status === "interview" ? <ProgressDots current={currentQuestionNumber || 1} total={planStages.length || questionBudget} /> : null}
          {status === "review" || status === "reviewing" ? <span>{transcript.length} 条记录</span> : null}
        </div>

        <div className="loopassist-topbar-actions" ref={panelRef}>
          {status === "review" || status === "reviewing" ? (
            <button type="button" className="loopassist-primary-action" onClick={resetWorkspace}>＋ 新建面试</button>
          ) : status === "interview" ? (
            <button
              type="button"
              className={`loopassist-more-trigger${activePanel === "more" ? " is-active" : ""}`}
              aria-label="更多操作"
              onClick={() => setActivePanel((current) => (current === "more" ? null : "more"))}
              data-testid="loopassist-more-menu"
            >
              <MoreIcon />
            </button>
          ) : (
            <>
              <button type="button" className="loopassist-icon-button" aria-label="帮助" onClick={() => setActivePanel((current) => (current === "help" ? null : "help"))}>
                <HelpIcon />
              </button>
              <button
                type="button"
                className="loopassist-record-trigger"
                onClick={openLatestInterviewRecord}
                disabled={!latestInterviewRecord}
                data-testid="loopassist-interview-record"
                title={latestInterviewRecord ? "查看最近一次面试结果" : "完成一轮面试后可查看记录"}
              >
                <HistoryIcon />
                <span>面试记录</span>
              </button>
              <button
                type="button"
                className={`loopassist-settings-trigger${activePanel === "settings" ? " is-active" : ""}`}
                aria-label="面试信息"
                onClick={() => setActivePanel((current) => (current === "settings" ? null : "settings"))}
                data-testid="loopassist-scope-toggle"
              >
                <SettingsIcon />
                <span>面试信息</span>
              </button>
            </>
          )}

          <input ref={resumeInputRef} type="file" accept=".txt,.md,.markdown,.json,.csv,.pdf,application/pdf" className="loopassist-file-input" onChange={(event) => handleDocumentUpload("resume", event.target.files?.[0])} data-testid="loopassist-resume-upload" />
          <input ref={jdInputRef} type="file" accept=".txt,.md,.markdown,.json,.csv" className="loopassist-file-input" onChange={(event) => handleDocumentUpload("jd", event.target.files?.[0])} data-testid="loopassist-jd-upload" />

          {activePanel === "help" ? (
            <section className="loopassist-popover loopassist-help-popover">
              <div className="loopassist-popover-head">
                <h2>帮助</h2>
                <button type="button" className="loopassist-popover-close" onClick={() => setActivePanel(null)}>关闭</button>
              </div>
              <ol className="loopassist-help-list">
                {helpSteps.map((item) => <li key={item}>{item}</li>)}
              </ol>
            </section>
          ) : null}

          {activePanel === "more" ? (
            <section className="loopassist-popover loopassist-more-menu" role="menu">
              <button type="button" onClick={() => setActivePanel(null)}>暂停面试</button>
              <button type="button" onClick={() => { setActivePanel(null); confirmFinishAndReview(); }}>退出本轮</button>
            </section>
          ) : null}

        </div>
      </header>

      {activePanel === "settings" ? (
        <button
          type="button"
          className="loopassist-settings-backdrop"
          aria-label="关闭面试信息面板"
          onClick={() => setActivePanel(null)}
        />
      ) : null}

      {activePanel === "settings" ? (
        <section
          ref={settingsPanelRef}
          className={`loopassist-popover loopassist-settings-popover loopassist-scope-popover${shouldCenterSettings ? " is-centered" : ""}`}
          role="dialog"
          aria-modal="true"
        >
          <div className="loopassist-popover-head loopassist-new-modal-head">
            <div>
              <p className="loopassist-new-modal-eyebrow">新建面试</p>
              <h2>面试信息</h2>
            </div>
            <button type="button" className="loopassist-popover-close" onClick={() => setActivePanel(null)}>关闭</button>
          </div>
          <div className="loopassist-new-modal-body">
            <div className="loopassist-new-modal-row">
              <label className="loopassist-role-field">
                <span className="loopassist-field-label">
                  <strong>岗位</strong>
                  <em>必填</em>
                </span>
                <select value={scope.role} onChange={(event) => updateScope("role", event.target.value)} data-testid="loopassist-role">
                  {(options?.roles || []).slice(0, 20).map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select>
              </label>
              <div className="loopassist-count-field">
                <span className="loopassist-field-label">
                  <strong>题量</strong>
                  <small>默认 4</small>
                </span>
                <div className="loopassist-count-toggle" data-testid="loopassist-budget" aria-label="题量">
                  {[4, 6, 8, 10].map((count) => (
                    <button key={count} type="button" className={Number(scope.questionBudget) === count ? "is-selected" : ""} onClick={() => updateScope("questionBudget", count)}>
                      {count}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <section className="loopassist-personalize-card">
              <div className="loopassist-personalize-head">
                <strong>个性化</strong>
                <em>可选 · 强烈推荐</em>
              </div>
              <p>围绕你的项目、技术栈追问，而不是通用八股</p>
              {userId && resumeVersions.length ? (
                <div className="loopassist-saved-resume-panel" data-testid="loopassist-saved-resume-panel">
                  <label className="loopassist-saved-resume-toggle">
                    <input
                      type="checkbox"
                      checked={useSavedResumeVersion}
                      onChange={(event) => handleSavedResumeToggle(event.target.checked)}
                      data-testid="loopassist-use-saved-resume"
                    />
                    <span>默认使用最近上传简历</span>
                  </label>
                  <select
                    value={selectedResumeVersionId}
                    onChange={(event) => handleResumeVersionSelection(event.target.value)}
                    disabled={!resumeVersions.length}
                    data-testid="loopassist-resume-version-select"
                  >
                    {resumeVersions.map((item, index) => (
                      <option key={item.id} value={item.id}>
                        {buildResumeVersionLabel(item, index)}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              <div className={`loopassist-material-field${scope.resumeText ? " is-filled" : ""}`}>
                <textarea
                  value={scope.resumeText}
                  onChange={(event) => handleResumeTextChange(event.target.value)}
                  placeholder="粘贴简历文本，或点下方上传…"
                  data-testid="loopassist-resume-text"
                />
                <div className="loopassist-material-actions">
                  <button type="button" className="loopassist-material-upload" onClick={() => resumeInputRef.current?.click()} data-testid="loopassist-resume-toggle">
                    <DocumentIcon />
                    <span>上传简历</span>
                  </button>
                  <span>{resumeFileName || (scope.resumeText ? summarizeDocument(scope.resumeText) : "txt / md / json / csv / pdf")}</span>
                </div>
              </div>
              {(resumeLibraryState === "error" && resumeLibraryNotice) ? <p className="loopassist-inline-note">{resumeLibraryNotice}</p> : null}
              <button type="button" className="loopassist-add-jd-button" onClick={() => setIsJdExpanded((current) => !current)} data-testid="loopassist-toggle-jd">
                {isJdExpanded ? "－ 收起 JD" : "＋ 添加目标岗位 JD（可选）"}
              </button>
              <div className={`loopassist-jd-panel${isJdExpanded ? " is-open" : ""}`}>
                {isJdExpanded ? (
                  <div className={`loopassist-material-field loopassist-jd-field${scope.jobDescription ? " is-filled" : ""}`}>
                    <textarea value={scope.jobDescription} onChange={(event) => updateScope("jobDescription", event.target.value)} placeholder="粘贴 JD 文本或岗位 URL…" data-testid="loopassist-jd-text" />
                    <div className="loopassist-material-actions">
                      <button type="button" className="loopassist-material-upload" onClick={() => jdInputRef.current?.click()} data-testid="loopassist-jd-toggle">
                        <DocumentIcon />
                        <span>上传 JD</span>
                      </button>
                      <span>{jdFileName || (scope.jobDescription ? summarizeDocument(scope.jobDescription) : "txt / md / json / csv / url")}</span>
                    </div>
                  </div>
                ) : null}
              </div>
            </section>
          </div>
          {error ? <p className="loopassist-inline-error">{error}</p> : null}
          <div className="loopassist-settings-footer">
            <div className="loopassist-settings-footer-actions">
              {hasGeneratedOutline ? <button type="button" className="loopassist-ghost-button" onClick={confirmResetWorkspace}>重置</button> : null}
              <button type="button" className="loopassist-primary-action loopassist-outline-cta" onClick={beginInterview} disabled={!options || status === "outlining" || !scope.role} data-testid="loopassist-start">
                <span>{status === "outlining" ? "正在生成..." : hasGeneratedOutline ? "重新生成大纲" : "生成大纲"}</span>
                <em>{outlineCtaBadge}</em>
              </button>
            </div>
          </div>
        </section>
      ) : null}

      <div className="loopassist-test-preview" data-testid="loopassist-preview">
        <strong>{preview?.matchedCount || 0} 条匹配题源</strong>
        <span>{previewCards[0]?.baseQuestion || "已准备好从真实面经中挑题。"}</span>
      </div>

      {status === "setup" || status === "outlining" ? (
        <section className={`loopassist-idle-stage${status === "outlining" ? " is-generating" : ""}`}>
          {error ? <p className="loopassist-inline-error">{error}</p> : null}
          {status === "outlining" ? (
            <div className="loopassist-generating-card" role="status" aria-live="polite">
              <div className="loopassist-generating-mark" aria-hidden="true">
                <span />
              </div>
              <div>
                <h1>正在生成大纲</h1>
                <p>{scope.role || "目标岗位"} · {scope.questionBudget || questionBudget} 题</p>
              </div>
            </div>
          ) : (
            <>
              <button type="button" className="loopassist-primary-action" onClick={openSettingsPanel}>
                填写面试信息
              </button>
            </>
          )}
        </section>
      ) : null}

      {status === "outline" ? (
        <section className="loopassist-outline" data-testid="loopassist-plan">
          <div className="loopassist-page-title loopassist-outline-hero">
            <div className="loopassist-eyebrow">面试大纲 · OUTLINE</div>
            <h1>本轮大纲</h1>
            <p>{interviewPlan?.title || `${scope.role || "目标岗位"}${scope.round ? ` ${scope.round}` : ""}模拟面试 · 覆盖项目表达、基础知识与真实追问`}</p>
            <div className="loopassist-source-row">
              <span>{planStages.length || questionBudget} 题</span>
              <span>预计 {totalEstimatedMinutes} 分钟</span>
              <span>难度 中高</span>
              {scope.resumeText || scope.jobDescription ? <span>已结合背景信息</span> : <span>通用题源</span>}
            </div>
          </div>

          <div className="loopassist-outline-divider">题目清单</div>
          <ol className="loopassist-outline-list loopassist-outline-plain">
            {planStages.map((stage, index) => (
              <li key={`${stage.step || index}-${stage.theme || stage.baseQuestion}`} className="loopassist-outline-item">
                <span className="loopassist-outline-index">{formatCount(index + 1)}</span>
                <div>
                  <div className="loopassist-outline-tags">
                    <span className="is-topic">{getStageTopic(stage)}</span>
                    <button type="button" className="is-source" onClick={() => setActiveSourcePreview({ stage, index })}>{getStageSourceLabel(stage)}</button>
                    <span>{getStageMinutes(stage)}′</span>
                  </div>
                  <strong>{getStageTitle(stage, index)}</strong>
                  <p>{buildOutlineLine(stage)}</p>
                  <div className="loopassist-outline-evidence">
                    <span>生成依据：{stage.objective || "基于 sample source context 生成本题。"}</span>
                    <span>{getStageReferenceLine(stage, scope)}</span>
                  </div>
                </div>
                <span className="loopassist-outline-go">进入 →</span>
              </li>
            ))}
          </ol>

          <div className="loopassist-bottom-dock">
            <button type="button" className="loopassist-ghost-button" onClick={openSettingsPanel}>返回修改背景</button>
            <button type="button" className="loopassist-ghost-button" onClick={beginInterview}>重新生成大纲</button>
            <button type="button" className="loopassist-primary-action" onClick={startInterviewFromOutline} data-testid="loopassist-start-interview">开始面试 →</button>
          </div>
        </section>
      ) : null}

      {status === "interview" && scope.interviewMode === "batch" ? (
        <section className="loopassist-interview">
          <section className="loopassist-question-stage">
            <p className="loopassist-question-eyebrow">{questionEyebrow}</p>
            <h1>{questionTitle}</h1>
          </section>

          <TextAnswerComposer
            value={textAnswer}
            disabled={isSubmitting || isAwaitingFollowup}
            onChange={setTextAnswer}
            onSubmit={submitTextAnswer}
          />

          {questionTone ? <p className={questionToneClassName}>{questionTone}</p> : null}

          <div className="loopassist-bottom-dock">
            <button
              type="button"
              className={`loopassist-history-button${isHistoryOpen ? " is-active" : ""}`}
              aria-expanded={isHistoryOpen}
              onClick={() => setIsHistoryOpen((current) => !current)}
            >
              <HistoryIcon />
              <span>对话记录</span>
            </button>
            {canReplayInterviewer ? (
              <button type="button" className="loopassist-mode-weak-button loopassist-replay-button" onClick={() => playInterviewerAudio(lastInterviewerText || currentQuestion, { autoplay: true })} disabled={ttsStatus === "loading"} data-testid="loopassist-replay-tts">
                ↺ 重播
              </button>
            ) : null}
          </div>
        </section>
      ) : null}

      {status === "review" || status === "reviewing" ? (
        <section className="loopassist-review-page" data-testid="loopassist-review">
          <section ref={reviewSummaryRef} className={`summary${reviewSummaryState === "done" ? " done" : ""}`}>
            <div className="eyebrow sum-eyebrow">总结 / 评价 · 第 1 轮</div>
            {reviewSummaryState !== "done" ? (
              <div className="strip">
                <div className="strip-top">
                  <span className={`strip-spin${reviewSummaryState === "summarizing" ? " is-dim" : ""}`} />
                  <span className="strip-title">{reviewSummaryState === "summarizing" ? "整体诊断 · 汇总中" : "整体诊断 · 进行中"}</span>
                  <span className="strip-count">{reviewLiveProgress.resolved}/{reviewLiveProgress.total || reviewCards.length}</span>
                </div>
                <div className="strip-bar">
                  <i style={{ width: `${(reviewLiveProgress.total ? (reviewLiveProgress.resolved / reviewLiveProgress.total) * 100 : 0)}%` }} />
                </div>
                <div className="strip-live">
                  <span className="live m"><b>{reviewLiveProgress.miss}</b> 未答出</span>
                  <span className="live w"><b>{reviewLiveProgress.warn}</b> 待提升</span>
                  <span className="live g"><b>{reviewLiveProgress.good}</b> 已掌握</span>
                </div>
                <div className="strip-stage">
                  {reviewSummaryState === "summarizing"
                    ? `汇总 ${reviewLiveProgress.total || reviewCards.length} 道结果，生成整体结论…`
                    : "完成一道更新一道 · 全部就绪后在此生成整体结论与能力分布"}
                </div>
              </div>
            ) : (
              <div className="full">
                <h1>{reviewVerdict}</h1>
                <p className="sub">{review?.summary || `本轮共 ${reviewStats.total || interviewerTurns.length} 道核心题，逐题结果已经整理完毕。`}</p>
                <div className="hero-grid">
                  <div className="scorecard">
                    <div className="label">Overall Readiness</div>
                    <div className="score-row">
                      <span className="big">{review ? review.readinessScore : "…"}</span>
                      <span className="denom">/ 100</span>
                    </div>
                    <div className="score-note">一面通过线约 60 分</div>
                    <div className="progress-track"><div className="progress-fill" style={{ width: `${Math.min(Math.max(reviewScore, 0), 100)}%` }} /></div>
                    <div className="score-note">
                      {reviewScoreGap > 0
                        ? <>距通过线还差 <b style={{ color: "#f0834f" }}>{reviewScoreGap} 分</b>{weakestCapability?.topic ? ` · 主要丢在 ${weakestCapability.topic}` : ""}</>
                        : <>已经达到通过线以上，可以继续做下一轮强化。</>}
                    </div>
                  </div>
                  <div className="stats">
                    <button type="button" className="stat miss" onClick={() => focusRescueQuestions("miss")}>
                      <span className="num">{reviewStats.miss}</span>
                      <div className="meta">
                        <div className="t">未答出</div>
                        <div className="d">明显失分题</div>
                      </div>
                      <span className="arrow">查看 →</span>
                    </button>
                    <button type="button" className="stat warn" onClick={() => setReviewFilter("warn")}>
                      <span className="num">{reviewStats.warn}</span>
                      <div className="meta">
                        <div className="t">待提升</div>
                        <div className="d">有方向但不完整</div>
                      </div>
                      <span className="arrow">查看 →</span>
                    </button>
                    <button type="button" className="stat good" onClick={() => setReviewFilter("good")}>
                      <span className="num">{reviewStats.good}</span>
                      <div className="meta">
                        <div className="t">已掌握</div>
                        <div className="d">可以复用表达</div>
                      </div>
                      <span className="arrow">查看 →</span>
                    </button>
                  </div>
                </div>
                <section className="loopassist-review-rescue-handoff">
                  <div className="loopassist-review-rescue-mark">↯</div>
                  <div className="loopassist-review-rescue-copy">
                    <span>立即补救</span>
                    <h2>
                      {rescueCompleted
                        ? "这轮补救已经全部完成"
                        : rescueRemainingCount > 0 && rescuePlaylist?.id
                          ? `缺口已拆成 ${rescueTotalCount || "N"} 篇材料，并按重要性排好`
                          : "把这次答错的，顺着补完一遍"}
                    </h2>
                    <p>
                      {rescueCompleted
                        ? "已排入后续复习，下轮面试会优先回问这些薄弱点。"
                        : rescuePlaylist?.id
                          ? `已就绪 ${rescueReadyCount}/${rescueTotalCount} · 还剩 ${rescueRemainingCount} 篇未学完。第一篇就绪即可进入，不必等整份清单。`
                          : rescuePlaylistState === "loading"
                            ? "正在整理补救清单，复用已有资料的会先秒开，需生成的材料稍后补上。"
                            : "系统会把缺口拆成多份材料，复盘页和学习页之间都通过同一份 playlist 串起来。"}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="loopassist-review-rescue-button"
                    onClick={() => openRescuePlaylistModal()}
                    disabled={reviewSummaryState !== "done" || rescuePlaylistState === "loading"}
                  >
                    {rescueCompleted ? "查看补救清单" : rescuePlaylist?.id && rescueRemainingCount < rescueTotalCount ? "继续补救" : "开始补救"}
                  </button>
                </section>
                <div className="section-head">
                  <div className="eyebrow">能力分布</div>
                  <h2>哪一块最薄弱，一眼看清</h2>
                </div>
                <section className="cap">
                  <div className="radar-wrap">
                    <CapabilityRadar items={capabilityDistribution} />
                    <div className="radar-cap">按本轮各知识域的作答表现估算，虚线为 <b>通过线 60</b>，橙色越往里越薄弱。</div>
                  </div>
                  <div className="dom-list">
                    {capabilityDistribution.map((item) => {
                      const meta = getReviewStatusMeta(
                        Number(item?.score) >= 75 ? "good" : Number(item?.score) >= 45 ? "warn" : "miss",
                      );
                      return (
                        <div key={`${item?.topic || "topic"}-${item?.score || 0}`} className="dom">
                          <span className={`st st-${meta.pillClassName.replace("is-", "")}`}>{meta.label}</span>
                            <div className="dn">
                              <div className="nm">{item?.topic || "综合"}</div>
                              <div className="qc">本轮 {item?.questionCount || 0} 题</div>
                            </div>
                          <div className="mb"><i style={{ width: `${Math.min(Math.max(Number(item?.score) || 0, 0), 100)}%` }} /></div>
                          <span className="vv">{Number(item?.score) || 0}</span>
                        </div>
                      );
                    })}
                  </div>
                </section>
              </div>
            )}
          </section>
          <section className="loopassist-review-questions-section" ref={reviewQuestionsRef}>
            <div className="section-head">
              <div className="eyebrow">逐题复盘</div>
              <h2>每道题：好在哪 · 差在哪 · 怎么补</h2>
            </div>
            <div className={`filters${reviewSummaryState === "done" ? " is-ready" : ""}`} role="tablist" aria-label="复盘筛选">
              {[
                { key: "all", label: "全部", count: reviewFilterCounts.all },
                { key: "miss", label: "未答出", count: reviewFilterCounts.miss },
                { key: "warn", label: "待提升", count: reviewFilterCounts.warn },
                { key: "good", label: "已掌握", count: reviewFilterCounts.good },
              ].map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={`tab${reviewFilter === item.key ? " active" : ""}`}
                  onClick={() => setReviewFilter(item.key)}
                  disabled={reviewSummaryState !== "done"}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <div className="qlist" data-testid="loopassist-review-questions">
              {displayedReviewCards.length ? displayedReviewCards.map((card) => {
                const item = card?.review || null;
                const meta = getReviewStatusMeta(item?.status);
                const isOpen = Boolean(openReviewQuestions[String(card?.questionNumber || "")]);
                if (card?.phase === "pending" || card?.phase === "running") {
                  return (
                    <article key={`review-card-${card?.questionNumber || 0}`} className="qcard loading" data-status={card?.review?.status || "loading"}>
                      <div className="qhead skelhead">
                        <div className="qnum">{formatCount(card?.questionNumber || 0)}</div>
                        <div className="qbody-head">
                          <div className="qtags">
                            <span className="diag"><span className="spin" />诊断中…</span>
                            <span className="chip chip-topic">{card?.topic || "综合"}</span>
                            <span className="chip chip-diff">{card?.difficulty || "高频"}</span>
                          </div>
                          <div className="qtitle">{card?.questionText || "正在准备题目…"}</div>
                        </div>
                      </div>
                    </article>
                  );
                }
                if (card?.phase === "error") {
                  return (
                    <article key={`review-card-${card?.questionNumber || 0}`} className="qcard errored" data-status={card?.review?.status || "error"}>
                      <div className="qhead">
                        <div className="qnum">{formatCount(card?.questionNumber || 0)}</div>
                        <div className="qbody-head">
                          <div className="qtags">
                            <span className="diag err"><i className="x">!</i>诊断失败</span>
                            <span className="chip chip-topic">{card?.topic || "综合"}</span>
                            <span className="chip chip-diff">{card?.difficulty || "高频"}</span>
                          </div>
                          <div className="qtitle">{card?.questionText || "未记录题目"}</div>
                        </div>
                        <button type="button" className="retry" onClick={() => retryReviewQuestion(card?.questionNumber)}>↺ 重试</button>
                      </div>
                    </article>
                  );
                }
                return (
                  <article
                    key={`${card?.questionNumber || 0}-${item?.questionText || "question"}`}
                    className={`qcard ready show${isOpen ? " open" : ""}${card?.mastered ? " is-mastered" : ""}`}
                    data-status={item?.status || "warn"}
                  >
                    <button type="button" className="qhead" onClick={() => toggleReviewQuestion(card?.questionNumber)}>
                      <div className="qnum">{formatCount(card?.questionNumber || 0)}</div>
                      <div className="qbody-head">
                        <div className="qtags">
                          <span className={`status ${item?.status || "warn"}`}>{meta.label}</span>
                          <span className="chip chip-topic">{item?.topic || card?.topic || "综合"}</span>
                          <span className="chip chip-diff">{item?.difficulty || card?.difficulty || "高频"}</span>
                        </div>
                        <div className="qtitle">{item?.questionText || card?.questionText || "未记录题目"}</div>
                      </div>
                      <div className="qchevron">⌄</div>
                    </button>
                    {isOpen ? (
                      <div className="qdetail" style={{ maxHeight: isOpen ? "2000px" : "0" }}>
                        <div className="qdetail-inner">
                          <div className="perf">📋 你的表现：{item?.performanceSummary || "正在整理本题复盘。"}</div>
                          {(item?.strengths || []).length ? (
                            <div className="block">
                              <div className="block-label lbl-good"><span className="ic">✓</span>答得好的地方</div>
                              <ul className="pts good">
                                {(item?.strengths || []).map((point) => <li key={point}>{point}</li>)}
                              </ul>
                            </div>
                          ) : null}
                          <div className="block">
                            <div className="block-label lbl-miss"><span className="ic">!</span>失分 / 缺失点</div>
                            <ul className="pts miss">
                              {(item?.misses || []).map((point) => <li key={point}>{point}</li>)}
                            </ul>
                          </div>
                          <div className="block">
                            <div className="block-label lbl-key"><span className="ic">★</span>参考答案 · 核心要点</div>
                            <div className="keybox">
                              {(item?.keyPoints || []).map((point) => <p key={point}>{point}</p>)}
                            </div>
                          </div>
                          {item?.coachingTip ? (
                            <div className="block">
                              <div className="block-label lbl-tip"><span className="ic">↑</span>优化建议</div>
                              <div className="tipbox">{item.coachingTip}</div>
                            </div>
                          ) : null}
                          {(item?.likelyFollowups || []).length ? (
                            <div className="block">
                              <div className="block-label lbl-ask"><span className="ic">?</span>高概率追问</div>
                              <ul className="pts ask">
                                {(item?.likelyFollowups || []).map((point) => <li key={point}>{point}</li>)}
                              </ul>
                            </div>
                          ) : null}
                          <div className="qactions">
                            <button
                              type="button"
                              className="qa qa-learn"
                              onClick={(event) => {
                                event.stopPropagation();
                                void openRescuePlaylistModal({ questionNumber: card?.questionNumber });
                              }}
                            >
                              ⚡ 深入学习这块
                            </button>
                            <button type="button" className="qa qa-master" onClick={(event) => { event.stopPropagation(); markReviewQuestionMastered(card?.questionNumber); }}>
                              {card?.mastered ? "✓ 已掌握" : "✓ 标记已掌握"}
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </article>
                );
              }) : (
                <div className="loopassist-review-empty foot">
                  当前筛选下没有题目。
                </div>
              )}
            </div>
            <div className="foot">LOOPASSIST · 进度条原地展开为总结 · 非侵入到达提示 · 不自动滚动</div>
          </section>
        </section>
      ) : null}

      {showReviewSummaryToast ? (
        <div className="toast show" data-testid="loopassist-review-toast">
          <span className="tmsg"><b>✓ 整体结论已就绪</b> —— 在页面顶部</span>
          <button type="button" className="tgo" onClick={scrollToReviewSummary}>查看 ↑</button>
          <button type="button" className="tx" aria-label="关闭到达提示" onClick={() => setShowReviewSummaryToast(false)}>✕</button>
        </div>
      ) : null}

      {rescueModalOpen ? (
        <section className="loopassist-rescue-modal" role="dialog" aria-modal="true" aria-label="立即补救">
          <button type="button" className="loopassist-rescue-modal-backdrop" aria-label="关闭立即补救" onClick={closeRescuePlaylistModal} />
          <article className="loopassist-rescue-modal-card">
            <div className="loopassist-rescue-modal-head">
              <div>
                <p>立即补救</p>
                <h2>正在为你的缺口准备材料</h2>
                <span>复用已有的秒就绪，需生成或核对的会继续在后台完成。</span>
              </div>
              <strong>{rescueReadyCount}/{rescueTotalCount || rescueItems.length} 就绪</strong>
            </div>
            <div className="loopassist-rescue-modal-list">
              {rescueItems.map((item, index) => (
                <div
                  key={item.id}
                  className={`loopassist-rescue-modal-row${item.id === rescueModalFocusItemId ? " is-focus" : ""}${item.status === "gen" || item.status === "pending" ? " is-loading" : ""}`}
                >
                  <div className={item.status === "ready" || item.status === "learned" ? "loopassist-rescue-modal-icon is-ready" : "loopassist-rescue-modal-icon is-spinning"}>
                    {item.status === "ready" || item.status === "learned" ? "✓" : ""}
                  </div>
                  <div className="loopassist-rescue-modal-copy">
                    <strong>{`${index + 1}. ${item.title}`}</strong>
                    <p>{pickQuestionLabel(item.questionNumbers)}</p>
                    <span>{`${getRescueItemSourceLabel(item.source)} · ${getRescueItemStatusLabel(item)}`}</span>
                  </div>
                </div>
              ))}
            </div>
            <div className="loopassist-rescue-modal-foot">
              {(() => {
                const targetItem = (rescueFocusItem?.status === "ready" || rescueFocusItem?.status === "learned")
                  ? rescueFocusItem
                  : rescueFirstReadyItem;
                return (
                  <button
                    type="button"
                    className="loopassist-rescue-modal-go"
                    disabled={!targetItem}
                    onClick={() => enterRescueLearning(rescueModalFocusItemId)}
                  >
                    {targetItem
                      ? `开始学习 · 第 ${Math.max(1, rescueItems.findIndex((item) => item.id === targetItem.id) + 1)} 篇已就绪`
                      : "正在准备第一篇…"}
                  </button>
                );
              })()}
              <p>弹窗只负责生成进度和跳板，真正的学习与训练会在已有页面里继续。</p>
            </div>
          </article>
        </section>
      ) : null}

      <ConversationHistoryDrawer
        open={isHistoryOpen}
        turns={transcript}
        currentTurnId={currentQuestionTurn?.turnId}
        currentTopic={currentPlanStage?.theme || sampleTopics[0] || "综合面试"}
        currentQuestionNumber={currentQuestionNumber || 1}
        questionBudget={planStages.length || questionBudget}
        onClose={() => setIsHistoryOpen(false)}
      />
      {activeSourcePreview ? (
        <section className="loopassist-source-preview" role="dialog" aria-modal="true" aria-label="题源预览">
          <button type="button" className="loopassist-source-preview-backdrop" aria-label="关闭题源预览" onClick={() => setActiveSourcePreview(null)} />
          <article className="loopassist-source-preview-card">
            <div className="loopassist-source-preview-head">
              <div>
                <p>第 {formatCount(activeSourcePreview.index + 1)} 题来源</p>
                <h2>{getStageSourceLabel(activeSourcePreview.stage)}</h2>
              </div>
              <button type="button" className="loopassist-popover-close" onClick={() => setActiveSourcePreview(null)}>关闭</button>
            </div>
            <div className="loopassist-source-preview-body">
              {(activeSourcePreview.stage.sourceContexts || activeSourcePreview.stage.sourcePreview?.sourceContexts || []).map((context, contextIndex) => (
                <section key={`${context?.type || "context"}-${contextIndex}`} className={`is-${context?.type || "context"}`}>
                  <span>{context?.label || `参考材料 ${contextIndex + 1}`}</span>
                  <p>{context?.excerpt || "暂无片段。"}</p>
                  {context?.reason ? <em>{context.reason}</em> : null}
                </section>
              ))}
              {!(activeSourcePreview.stage.sourceContexts || activeSourcePreview.stage.sourcePreview?.sourceContexts || []).length ? (
                <section>
                  <span>历史面经样本</span>
                  <p>{activeSourcePreview.stage.sourcePreview?.baseQuestion || activeSourcePreview.stage.baseQuestion || "暂无片段。"}</p>
                </section>
              ) : null}
              <section>
                <span>生成依据</span>
                <p>{activeSourcePreview.stage.objective || "基于 sample source context 生成本题。"}</p>
              </section>
              {activeSourcePreview.stage.sourcePreview?.reportText ? (
                <section>
                  <span>历史面经原文</span>
                  <p>{activeSourcePreview.stage.sourcePreview.reportText}</p>
                </section>
              ) : null}
              {activeSourcePreview.stage.sourcePreview?.followupAngles?.length ? (
                <section>
                  <span>可能追问</span>
                  <p>{activeSourcePreview.stage.sourcePreview.followupAngles.join("；")}</p>
                </section>
              ) : null}
              {activeSourcePreview.stage.sourcePreview?.strongSignals?.length ? (
                <section>
                  <span>强回答信号</span>
                  <p>{activeSourcePreview.stage.sourcePreview.strongSignals.join("；")}</p>
                </section>
              ) : null}
              {activeSourcePreview.stage.sourcePreview?.url ? (
                <a href={activeSourcePreview.stage.sourcePreview.url} target="_blank" rel="noreferrer">打开牛客原帖 ↗</a>
              ) : null}
            </div>
          </article>
        </section>
      ) : null}
    </main>
  );
}
