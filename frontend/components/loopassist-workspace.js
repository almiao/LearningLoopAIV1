"use client";

import Link from "next/link";
import { Room, RoomEvent } from "livekit-client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createLivekitTransport,
  createRealtimeSession,
} from "../lib/interview-assist-api";
import {
  getLoopAssistOptions,
  previewLoopAssistScope,
  reviewLoopAssist,
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

const waveHeights = [18, 28, 38, 24, 42, 30, 20, 36, 48, 32, 22, 34, 26, 40, 28, 18];
const interviewRecordStorageKey = "loopassist-latest-interview-record";

const helpSteps = [
  "点击右上角的面试信息按钮，先完成岗位、简历和 JD 配置，再生成可编辑的大纲。",
  "确认大纲后进入批次面试，听完问题再点击“开始作答”。",
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

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="9" y="3.5" width="6" height="11" rx="3" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M5.8 11.5a6.2 6.2 0 0 0 12.4 0M12 17.8v2.7M9 20.5h6" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
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

function VoiceOrb({ state = "idle" }) {
  const thinking = state === "thinking";
  return (
    <div
      className={`loopassist-voice-orb is-${state}`}
      data-testid="loopassist-voice-orb"
      aria-hidden="true"
    >
      <span className="loopassist-orb-wave" aria-hidden="true">
        {waveHeights.slice(0, 18).map((height, index) => (
          <i key={`${height}-${index}`} style={{ "--wave-height": `${Math.max(12, height + (index % 2 ? 6 : 0))}px` }} />
        ))}
      </span>
      <span className="loopassist-orb-core" aria-hidden="true">
        <MicIcon />
      </span>
      {thinking ? <span className="loopassist-orb-pulse" aria-hidden="true" /> : null}
    </div>
  );
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

function readStoredUserId() {
  if (typeof window === "undefined") {
    return "";
  }
  return window.localStorage.getItem("learning-loop-user-id") || "";
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

function describeMicError(error) {
  const text = String(error?.message || error || "").toLowerCase();
  if (text.includes("permission") || text.includes("notallowederror")) {
    return "麦克风权限被拒绝。LoopAssist 当前仅支持语音回答，请允许麦克风后重试。";
  }
  if (text.includes("failed to fetch") || text.includes("networkerror") || text.includes("load failed")) {
    return "麦克风服务暂时连接不上，请检查设备后重试。";
  }
  const detail = error?.message ? `（${error.message}）` : "";
  return `实时语音连接失败${detail}。LoopAssist 当前仅支持语音回答，请检查设备后重试。`;
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

function summarizeDocument(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "未上传";
  }
  return `${text.length} 字`;
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
  return stage?.objective || stage?.baseQuestion || stage?.theme || "围绕当前主题继续追问";
}

function formatOutlineReason(interviewPlan, scope) {
  if (interviewPlan?.rationale) {
    return interviewPlan.rationale;
  }
  const parts = [scope.role, scope.round].filter(Boolean);
  return parts.length ? `系统会围绕 ${parts.join(" · ")} 的真实面试路径来安排这轮问题。` : "系统会结合你的目标岗位和材料来安排这轮问题。";
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
  return "开始一轮面试";
}

export function LoopAssistWorkspace() {
  const [options, setOptions] = useState(null);
  const [scope, setScope] = useState(defaultScope);
  const [preview, setPreview] = useState(null);
  const [session, setSession] = useState(null);
  const [review, setReview] = useState(null);
  const [status, setStatus] = useState("setup");
  const [error, setError] = useState("");
  const [voiceIssue, setVoiceIssue] = useState("");
  const [voiceIssueKind, setVoiceIssueKind] = useState("");
  const [partialTranscript, setPartialTranscript] = useState("");
  const [capturedAnswer, setCapturedAnswer] = useState("");
  const [answerInputMode, setAnswerInputMode] = useState("voice");
  const [textAnswer, setTextAnswer] = useState("");
  const [answerState, setAnswerState] = useState("idle");
  const [lastInterviewerText, setLastInterviewerText] = useState("");
  const [ttsStatus, setTtsStatus] = useState("idle");
  const [activePanel, setActivePanel] = useState(null);
  const [resumeFileName, setResumeFileName] = useState("");
  const [jdFileName, setJdFileName] = useState("");
  const [isJdExpanded, setIsJdExpanded] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isInterviewPaused, setIsInterviewPaused] = useState(false);
  const [latestInterviewRecord, setLatestInterviewRecord] = useState(null);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [focusedQuestionIndex, setFocusedQuestionIndex] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const roomRef = useRef(null);
  const audioRef = useRef(null);
  const audioCacheRef = useRef(new Map());
  const answerSegmentsRef = useRef([]);
  const isCapturingRef = useRef(false);
  const latestSessionRef = useRef(null);
  const panelRef = useRef(null);
  const settingsPanelRef = useRef(null);
  const resumeInputRef = useRef(null);
  const jdInputRef = useRef(null);
  const recordingTimerRef = useRef(null);
  const autoOpenedSettingsRef = useRef(false);

  useEffect(() => {
    latestSessionRef.current = session;
  }, [session]);

  useEffect(() => {
    setLatestInterviewRecord(readStoredInterviewRecord());
  }, []);

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
    roomRef.current?.disconnect?.();
    audioRef.current?.pause?.();
    if (recordingTimerRef.current) {
      window.clearInterval(recordingTimerRef.current);
    }
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
    if (answerState !== "listening") {
      setRecordingSeconds(0);
      if (recordingTimerRef.current) {
        window.clearInterval(recordingTimerRef.current);
        recordingTimerRef.current = null;
      }
      return undefined;
    }

    setRecordingSeconds(0);
    recordingTimerRef.current = window.setInterval(() => {
      setRecordingSeconds((current) => current + 1);
    }, 1000);

    return () => {
      if (recordingTimerRef.current) {
        window.clearInterval(recordingTimerRef.current);
        recordingTimerRef.current = null;
      }
    };
  }, [answerState]);

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
  const topicSummary = sampleTopics.length ? sampleTopics.join(" + ") : "项目 + 分布式";
  const isAwaitingFollowup = status === "interview" && isSubmitting && latestTurn?.role === "candidate";
  const questionTitle = isAwaitingFollowup ? "正在生成下一问…" : currentQuestion;
  const questionTone = isAwaitingFollowup
    ? "我已经收到你的回答，正在根据这轮内容组织下一道追问。"
    : voiceIssue
      ? voiceIssue
      : !voiceIssue && error
        ? error
        : "";
  const reviewPanels = review
    ? [
        { title: "优势", items: review.strengths || [] },
        { title: "短板", items: review.weaknesses || [] },
        { title: "高概率追问", items: review.likelyFollowups || [] },
        {
          title: "下一步",
          items: [...(review.practicalNextSteps || []), review.nextRecommendedScope].filter(Boolean),
        },
      ]
    : [];
  const interviewPlan = session?.interviewPlan || null;
  const planStages = interviewPlan?.stages || [];
  const hasGeneratedOutline = hasInterviewPlan(session) || ["outline", "interview", "review", "reviewing"].includes(status);
  const shouldCenterSettings = status === "setup" && !hasGeneratedOutline;
  const reviewScore = Number(review?.readinessScore || 0);
  const reviewVerdict = getReviewVerdict(reviewScore);
  const currentPlanStage = planStages[currentQuestionIndex] || planStages[0] || null;
  const totalEstimatedMinutes = Math.max(
    planStages.reduce((sum, stage) => sum + getStageMinutes(stage), 0) || questionBudget * 4,
    1,
  );
  const reviewStrengthCount = review?.strengths?.length || 0;
  const reviewWeaknessCount = review?.weaknesses?.length || 0;
  const reviewFollowupCount = review?.likelyFollowups?.length || 0;
  const shellTitle = getShellTitle(status);
  const hasResumeContext = Boolean(String(scope.resumeText || "").trim());
  const outlineCtaBadge = hasResumeContext ? "贴合你" : "通用";
  const outlineCtaHint = hasResumeContext
    ? "已检测到简历，题目将围绕你的项目追问"
    : "未贴简历也能生成，会出通用题";
  const questionToneClassName = [
    "loopassist-inline-message",
    voiceIssue ? (voiceIssueKind === "tts" ? "loopassist-inline-note" : "loopassist-inline-error") : "",
    error ? "loopassist-inline-error" : "",
  ].filter(Boolean).join(" ");
  const voiceVisualState = isAwaitingFollowup || answerState === "submitting" || answerState === "connecting"
    ? "thinking"
    : answerState === "listening"
      ? "listening"
      : answerState === "paused" || isInterviewPaused
        ? "paused"
        : "idle";
  const voiceStatusText = voiceVisualState === "listening"
    ? "正在聆听…"
    : voiceVisualState === "paused"
      ? "已暂停"
      : voiceVisualState === "thinking"
        ? "正在思考你的回答…"
        : "点击麦克风开始作答";
  const questionEyebrow = [
    currentPlanStage?.theme || sampleTopics[0] || "综合面试",
    currentPlanStage?.source ? currentPlanStage.source.replace(/^改编自/, "") : null,
  ].filter(Boolean).join(" · ");

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

  function openSettingsPanel() {
    setActivePanel("settings");
  }

  async function handleDocumentUpload(kind, file) {
    if (!file) {
      return;
    }
    const text = await file.text();
    if (kind === "resume") {
      updateScope("resumeText", text);
      setResumeFileName(file.name);
      setActivePanel("settings");
      return;
    }
    updateScope("jobDescription", text);
    setJdFileName(file.name);
    setIsJdExpanded(true);
    setActivePanel("settings");
  }

  function resetWorkspace() {
    setReview(null);
    setSession(null);
    setStatus("setup");
    setError("");
    setVoiceIssue("");
    setVoiceIssueKind("");
    setIsInterviewPaused(false);
    setAnswerInputMode("voice");
    setTextAnswer("");
    setPartialTranscript("");
    setCapturedAnswer("");
    setAnswerState("idle");
    setLastInterviewerText("");
    setTtsStatus("idle");
    setActivePanel(null);
    setIsHistoryOpen(false);
    setRecordingSeconds(0);
    setFocusedQuestionIndex(null);
    answerSegmentsRef.current = [];
    audioRef.current?.pause?.();
  }

  async function beginInterview() {
    setError("");
    setVoiceIssue("");
    setVoiceIssueKind("");
    setReview(null);
    setActivePanel(null);
    setStatus("outlining");
    try {
      const nextSession = await startLoopAssist({
        userId: readStoredUserId(),
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
    setIsInterviewPaused(false);
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

  async function ensureVoiceRoom() {
    setVoiceIssue("");
    setVoiceIssueKind("");
    const currentRoom = roomRef.current;
    if (currentRoom?.state === "connected") {
      return currentRoom;
    }
    currentRoom?.disconnect?.();
    try {
      const realtimeSession = await createRealtimeSession({
        selfRole: "candidate",
        mode: "assist_interviewer",
        resumeText: "",
      });
      const transport = await createLivekitTransport({ sessionId: realtimeSession.sessionId });
      if (!transport.livekitConfigured || !transport.participantToken || !transport.livekitUrl) {
        throw new Error("LiveKit 传输层未配置完成。");
      }
      const room = new Room();
      roomRef.current = room;
      room.on(RoomEvent.DataReceived, (payload, participant, kind, topic) => {
        if (topic !== "interview-assist") {
          return;
        }
        const message = decodeAssistPayload(payload);
        const event = message.event || message.type;
        const data = message.data || {};
        if (event === "transcript_partial") {
          if (isCapturingRef.current) {
            setPartialTranscript(data.transcript || "");
          }
        }
        if (event === "transcript_final") {
          const finalText = data.transcript || "";
          setPartialTranscript("");
          if (isCapturingRef.current && finalText.trim()) {
            answerSegmentsRef.current = [...answerSegmentsRef.current, finalText.trim()];
            setCapturedAnswer(answerSegmentsRef.current.join(" "));
          }
        }
        if (event === "error") {
          setVoiceIssue(data.error || "实时语音识别异常。请检查麦克风后重试。");
          setVoiceIssueKind("mic");
        }
      });
      await room.connect(transport.livekitUrl, transport.participantToken);
      await room.localParticipant.setMicrophoneEnabled(false);
      return room;
    } catch (nextError) {
      setVoiceIssue(describeMicError(nextError));
      setVoiceIssueKind("mic");
      throw nextError;
    }
  }

  async function startAnswering() {
    if (answerState === "listening" || isSubmitting || status !== "interview") {
      return;
    }
    setAnswerState("connecting");
    setIsInterviewPaused(false);
    setCapturedAnswer("");
    setPartialTranscript("");
    answerSegmentsRef.current = [];
    try {
      const room = await ensureVoiceRoom();
      isCapturingRef.current = true;
      await room.localParticipant.setMicrophoneEnabled(true);
      setAnswerState("listening");
    } catch {
      isCapturingRef.current = false;
      setAnswerState("idle");
    }
  }

  async function reconnectVoiceRoom() {
    try {
      await ensureVoiceRoom();
    } catch {}
  }

  async function pauseAnswering() {
    if (answerState !== "listening") {
      return;
    }
    isCapturingRef.current = false;
    try {
      await roomRef.current?.localParticipant?.setMicrophoneEnabled(false);
    } catch {}
    setPartialTranscript("");
    setAnswerState("paused");
    setIsInterviewPaused(true);
  }

  async function resumeAnswering() {
    if (answerState !== "paused") {
      return;
    }
    try {
      const room = await ensureVoiceRoom();
      isCapturingRef.current = true;
      await room.localParticipant.setMicrophoneEnabled(true);
      setAnswerState("listening");
      setIsInterviewPaused(false);
    } catch {
      isCapturingRef.current = false;
      setAnswerState("idle");
    }
  }

  async function toggleMicrophone() {
    if (answerState === "listening") {
      await pauseAnswering();
      return;
    }
    if (answerState === "paused") {
      await resumeAnswering();
      return;
    }
    await startAnswering();
  }

  async function switchAnswerInputMode(nextMode) {
    if (nextMode === answerInputMode) {
      return;
    }
    if (answerState === "listening") {
      await pauseAnswering();
    }
    setAnswerInputMode(nextMode);
    setVoiceIssue("");
    setVoiceIssueKind("");
  }

  async function submitTextAnswer() {
    const answer = textAnswer.trim();
    if (!answer || isSubmitting || status !== "interview") {
      return;
    }
    setTextAnswer("");
    setAnswerState("submitting");
    await submitVoiceAnswer(answer);
    setAnswerState("idle");
  }

  async function finishAnswering() {
    if (answerState !== "listening" && answerState !== "paused") {
      return;
    }
    setAnswerState("submitting");
    isCapturingRef.current = false;
    try {
      await roomRef.current?.localParticipant?.setMicrophoneEnabled(false);
    } catch {}
    const answer = [...answerSegmentsRef.current, partialTranscript]
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .join(" ");
    setPartialTranscript("");
    setCapturedAnswer("");
    answerSegmentsRef.current = [];
    if (!answer) {
      setVoiceIssue("还没有识别到你的回答。请点击“开始作答”后再说一遍。");
      setVoiceIssueKind("mic");
      setAnswerState("idle");
      return;
    }
    await submitVoiceAnswer(answer);
    setAnswerState("idle");
    setIsInterviewPaused(false);
  }

  async function skipQuestion() {
    if (!session?.sessionId || isSubmitting || status !== "interview") {
      return;
    }
    await submitVoiceAnswer("这题我先跳过，请继续下一题。");
  }

  async function submitVoiceAnswer(answerText) {
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

  async function loadReviewForSession(sessionId) {
    if (!sessionId) {
      return;
    }
    setStatus("reviewing");
    setError("");
    roomRef.current?.disconnect?.();
    audioRef.current?.pause?.();
    isCapturingRef.current = false;
    try {
      const result = await reviewLoopAssist({ sessionId });
      const nextTranscript = result.transcript?.length ? result.transcript : latestSessionRef.current?.transcript || [];
      const nextSession = {
        ...(latestSessionRef.current || {}),
        sessionId,
        transcript: nextTranscript,
      };
      const nextRecord = {
        id: sessionId,
        savedAt: Date.now(),
        scope,
        session: nextSession,
        review: result.review,
        transcript: nextTranscript,
        interviewPlan: nextSession.interviewPlan || null,
      };
      setReview(result.review);
      setSession(nextSession);
      setLatestInterviewRecord(nextRecord);
      writeStoredInterviewRecord(nextRecord);
      setStatus("review");
    } catch (nextError) {
      setError(nextError.message);
      setStatus("interview");
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
    setStatus("review");
    setLatestInterviewRecord(record);
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

  const shouldShowPrimaryStart = status === "setup" || status === "starting" || status === "review";
  const primaryActionLabel = shouldShowPrimaryStart
    ? status === "starting"
      ? "正在开始..."
      : "开始面试"
    : answerInputMode === "text"
      ? isAwaitingFollowup || answerState === "submitting"
        ? "等待下一问..."
        : "语音作答"
    : answerState === "listening"
      ? "结束作答"
      : answerState === "paused"
        ? "结束作答"
      : isAwaitingFollowup
        ? "等待下一问..."
      : answerState === "connecting"
        ? "正在连接麦克风..."
        : "开始作答";
  const primaryActionHandler = shouldShowPrimaryStart
    ? status === "review"
      ? resetWorkspace
      : beginInterview
    : answerInputMode === "text"
      ? () => switchAnswerInputMode("voice")
    : answerState === "listening"
      ? finishAnswering
      : answerState === "paused"
        ? finishAnswering
      : startAnswering;
  const primaryActionDisabled = shouldShowPrimaryStart
    ? !options || status === "starting"
    : isSubmitting || status !== "interview" || answerState === "connecting";
  const primaryActionTestId = shouldShowPrimaryStart
    ? "loopassist-start"
    : answerInputMode === "text"
      ? "loopassist-switch-voice"
    : answerState === "listening"
      ? "loopassist-finish-answer"
      : "loopassist-start-answer";
  const primaryActionClassName = `loopassist-primary-action${
    !shouldShowPrimaryStart && isAwaitingFollowup ? " is-busy" : ""
  }`;

  return (
    <main className={`loopassist-shell${isHistoryOpen && status === "interview" ? " is-history-open" : ""}`} data-testid="loopassist-shell">
      <header className="loopassist-nav">
        <Link href="/" className="loopassist-brand">
          <span className="loopassist-brand-mark" aria-hidden="true">L</span>
          <span className="loopassist-brand-copy">
            <strong>LoopAssist</strong>
            <span>{status === "setup" ? "新建面试" : `${scope.role || "目标岗位"} · ${scope.round || "当前轮次"}`}</span>
          </span>
          {status === "review" || status === "reviewing" ? <span className="loopassist-review-verdict-pill">{reviewScore >= 70 ? "建议补强后推进" : "建议补强后再来一轮"}</span> : null}
        </Link>

        <div className="loopassist-nav-meta">
          <strong>{status === "interview" ? "面试中" : shellTitle}</strong>
          {status === "outline" ? <span>{planStages.length || questionBudget} 题 · 预计 {totalEstimatedMinutes} 分钟</span> : null}
          {status === "interview" ? <ProgressDots current={currentQuestionNumber || 1} total={planStages.length || questionBudget} /> : null}
          {status === "review" || status === "reviewing" ? <span>{transcript.length} 条记录</span> : null}
        </div>

        <div className="loopassist-topbar-actions" ref={panelRef}>
          {status === "review" || status === "reviewing" ? (
            <>
              <button type="button" className="loopassist-ghost-button" onClick={() => setStatus("outline")}>← 回到大纲</button>
              <button type="button" className="loopassist-ghost-button">导出 PDF</button>
              <button type="button" className="loopassist-primary-action" onClick={resetWorkspace}>＋ 新建面试</button>
            </>
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

          <input ref={resumeInputRef} type="file" accept=".txt,.md,.markdown,.json,.csv" className="loopassist-file-input" onChange={(event) => handleDocumentUpload("resume", event.target.files?.[0])} data-testid="loopassist-resume-upload" />
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
              <button type="button" onClick={() => { setIsInterviewPaused(true); pauseAnswering(); setActivePanel(null); }}>暂停面试</button>
              <button type="button" onClick={() => { setActivePanel(null); confirmFinishAndReview(); }}>退出本轮</button>
              <button type="button" onClick={() => { setActivePanel(null); reconnectVoiceRoom(); }}>麦克风设置</button>
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
              <h2>{shouldCenterSettings ? "面试信息" : "背景信息"}</h2>
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
              <div className={`loopassist-material-field${scope.resumeText ? " is-filled" : ""}`}>
                <textarea value={scope.resumeText} onChange={(event) => updateScope("resumeText", event.target.value)} placeholder="粘贴简历文本，或点下方上传…" data-testid="loopassist-resume-text" />
                <div className="loopassist-material-actions">
                  <button type="button" className="loopassist-material-upload" onClick={() => resumeInputRef.current?.click()} data-testid="loopassist-resume-toggle">
                    <DocumentIcon />
                    <span>上传简历</span>
                  </button>
                  <span>{resumeFileName || (scope.resumeText ? summarizeDocument(scope.resumeText) : "txt / md / json / csv")}</span>
                </div>
              </div>
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
            <p className={`loopassist-settings-cta-note${hasResumeContext ? " is-tailored" : ""}`}>{outlineCtaHint}</p>
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
          ) : !shouldCenterSettings ? (
            <>
              <button type="button" className="loopassist-primary-action" onClick={openSettingsPanel}>
                填写面试信息
              </button>
            </>
          ) : null}
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
                    {stage.source ? <span className="is-source">真实面经</span> : null}
                    <span>{getStageMinutes(stage)}′</span>
                  </div>
                  <strong>{getStageTitle(stage, index)}</strong>
                  <p>{buildOutlineLine(stage)}</p>
                  {stage.source ? <div className="loopassist-outline-tags"><span>{stage.source}</span></div> : null}
                </div>
                <span className="loopassist-outline-go">进入 →</span>
              </li>
            ))}
          </ol>

          <section className="loopassist-outline-footnote">
            <div className="loopassist-outline-footnote-block">
              <span>为什么这样生成</span>
              <p>{interviewPlan?.sourceExplanation || "系统会优先参考你的目标岗位、简历、JD 和匹配到的真实面经题源。"} </p>
            </div>
            <div className="loopassist-outline-footnote-block">
              <span>这次参考了什么</span>
              <p>{[
                scope.resumeText ? (resumeFileName || "简历") : null,
                scope.jobDescription ? (jdFileName || "岗位 JD") : null,
                topicSummary,
              ].filter(Boolean).join(" · ")}</p>
            </div>
          </section>

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
            <div className="loopassist-stage-status">
              {ttsStatus !== "idle" && answerState !== "listening" ? (
                <button type="button" className="loopassist-ghost-button loopassist-replay-button" onClick={() => playInterviewerAudio(lastInterviewerText || currentQuestion, { autoplay: true })} disabled={ttsStatus === "loading"} data-testid="loopassist-replay-tts">↺ 重播</button>
              ) : null}
            </div>
            <p className="loopassist-question-eyebrow">{questionEyebrow}</p>
            <h1>{questionTitle}</h1>
            {currentPlanStage ? (
              <p className="loopassist-question-hint">{buildOutlineLine(currentPlanStage)}</p>
            ) : null}
          </section>

          {answerInputMode === "text" ? (
            <TextAnswerComposer
              value={textAnswer}
              disabled={isSubmitting || isAwaitingFollowup}
              onChange={setTextAnswer}
              onSubmit={submitTextAnswer}
            />
          ) : (
            <section className={`loopassist-voice-zone is-${voiceVisualState}`}>
              <VoiceOrb state={voiceVisualState} />
              <p>{voiceStatusText}</p>
              {partialTranscript || capturedAnswer ? (
                <span className="loopassist-voice-partial">{partialTranscript || capturedAnswer}</span>
              ) : null}
            </section>
          )}

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
            <button type="button" className="loopassist-mode-weak-button" onClick={() => switchAnswerInputMode(answerInputMode === "voice" ? "text" : "voice")} data-testid="loopassist-toggle-text-mode">
              {answerInputMode === "voice" ? "文字模式" : "语音模式"}
            </button>
            {answerInputMode === "voice" ? (
              <button type="button" className={primaryActionClassName} onClick={primaryActionHandler} disabled={primaryActionDisabled} data-testid={primaryActionTestId}>{primaryActionLabel}</button>
            ) : null}
          </div>
        </section>
      ) : null}

      {status === "interview" && scope.interviewMode === "realtime" ? (
        <section className="loopassist-realtime">
          <div className="loopassist-live-badge">● 实时语音</div>
          <div className="loopassist-wave is-recording">{waveHeights.slice(0, 11).map((height, index) => <span key={`${height}-${index}`} style={{ "--wave-height": `${height}px` }} />)}</div>
          <h1>正在听你说</h1>
          <div className="loopassist-transcript-stream" data-testid="loopassist-transcript">
            {transcript.map((turn) => <p key={turn.turnId} className={turn.role === "candidate" ? "is-me" : ""}>{turn.text}</p>)}
          </div>
          <div className="loopassist-bottom-dock">
            <button type="button" className="loopassist-ghost-button">静音</button>
            <span className="loopassist-topic-pill">● 讨论：{sampleTopics[0] || "综合项目"}</span>
            <button type="button" className="loopassist-danger-primary" onClick={confirmFinishAndReview}>结束面试</button>
          </div>
        </section>
      ) : null}

      {status === "review" || status === "reviewing" ? (
        <section className="loopassist-review-page" data-testid="loopassist-review">
          <div className="loopassist-review-hero">
            <div>
              <p className="loopassist-eyebrow">总结 / 评价 · 第 1 轮</p>
              <h1>{reviewVerdict}</h1>
              <span>总计 {transcript.length} 条记录 · {review ? `${review.readinessScore} / 100` : "生成复盘中"}</span>
            </div>
            <section className="loopassist-scorecard">
              <span>Overall Readiness</span>
              <strong>{review ? review.readinessScore : "…"}</strong>
              <em>/ 100</em>
              <div><i style={{ width: `${Math.min(Math.max(reviewScore, 0), 100)}%` }} /></div>
              <p>一面通过线约 60 分</p>
            </section>
            {review?.summary ? <p className="loopassist-review-summary">{review.summary}</p> : null}
          </div>
          <section className="loopassist-review-stats" aria-label="复盘概览">
            <button type="button">
              <strong>{reviewWeaknessCount}</strong>
              <span>待补强</span>
              <em>短板 / 缺失点</em>
            </button>
            <button type="button">
              <strong>{reviewFollowupCount}</strong>
              <span>高概率追问</span>
              <em>继续深挖</em>
            </button>
            <button type="button">
              <strong>{reviewStrengthCount}</strong>
              <span>已掌握</span>
              <em>可复用表达</em>
            </button>
          </section>
          <div className="loopassist-review-grid">
            {reviewPanels.map((panel) => (
              <section key={panel.title}>
                <h2>{panel.title}</h2>
                {panel.items.slice(0, 3).map((item) => <p key={item}>{item}</p>)}
              </section>
            ))}
          </div>
          <div className="loopassist-review-list">
            {interviewerTurns.map((turn, index) => (
              <details key={turn.turnId} open={index === 0}>
                <summary>{formatCount(index + 1)} · {turn.text}</summary>
                <p>{transcript.find((item, itemIndex) => itemIndex > transcript.indexOf(turn) && item.role === "candidate")?.text || "本题未记录回答。"}</p>
              </details>
            ))}
          </div>
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
    </main>
  );
}
