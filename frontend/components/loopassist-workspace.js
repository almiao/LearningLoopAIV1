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
  questionBudget: 8,
  resumeText: "",
  jobDescription: "",
};

const waveHeights = [18, 28, 38, 24, 42, 30, 20, 36, 48, 32, 22, 34, 26, 40, 28, 18];

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

function readStoredUserId() {
  if (typeof window === "undefined") {
    return "";
  }
  return window.localStorage.getItem("learning-loop-user-id") || "";
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
  const detail = error?.message ? `（${error.message}）` : "";
  return `实时语音连接失败${detail}。LoopAssist 当前仅支持语音回答，请检查设备后重试。`;
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
  const [partialTranscript, setPartialTranscript] = useState("");
  const [capturedAnswer, setCapturedAnswer] = useState("");
  const [answerState, setAnswerState] = useState("idle");
  const [lastInterviewerText, setLastInterviewerText] = useState("");
  const [ttsStatus, setTtsStatus] = useState("idle");
  const [activePanel, setActivePanel] = useState(null);
  const [resumeFileName, setResumeFileName] = useState("");
  const [jdFileName, setJdFileName] = useState("");
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
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
  const resumeInputRef = useRef(null);
  const jdInputRef = useRef(null);
  const recordingTimerRef = useRef(null);
  const autoOpenedSettingsRef = useRef(false);

  useEffect(() => {
    latestSessionRef.current = session;
  }, [session]);

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
    if (!activePanel) {
      return undefined;
    }

    function handlePointerDown(event) {
      if (panelRef.current?.contains(event.target)) {
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
  const shellTitle = getShellTitle(status);
  const settingsSummary = [
    scope.role || "未选岗位",
    scope.questionBudget ? `${scope.questionBudget} 题` : "未设题量",
  ];

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
    setActivePanel("settings");
  }

  function resetWorkspace() {
    setReview(null);
    setSession(null);
    setStatus("setup");
    setError("");
    setVoiceIssue("");
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
      setVoiceIssue(`面试官语音播放失败（${nextError.message}）。如果音频已生成，请点击“播放面试官问题”。`);
    }
  }

  async function ensureVoiceRoom() {
    setVoiceIssue("");
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
        }
      });
      await room.connect(transport.livekitUrl, transport.participantToken);
      await room.localParticipant.setMicrophoneEnabled(false);
      return room;
    } catch (nextError) {
      setVoiceIssue(describeMicError(nextError));
      throw nextError;
    }
  }

  async function startAnswering() {
    if (answerState === "listening" || isSubmitting || status !== "interview") {
      return;
    }
    setAnswerState("connecting");
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

  async function finishAnswering() {
    if (answerState !== "listening") {
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
      setAnswerState("idle");
      return;
    }
    await submitVoiceAnswer(answer);
    setAnswerState("idle");
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
      setReview(result.review);
      setSession((current) => ({
        ...current,
        transcript: result.transcript || current?.transcript || [],
      }));
      setStatus("review");
    } catch (nextError) {
      setError(nextError.message);
      setStatus("interview");
    }
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
    : answerState === "listening"
      ? "结束作答"
      : isAwaitingFollowup
        ? "等待下一问..."
      : answerState === "connecting"
        ? "正在连接麦克风..."
        : "● 开始作答";
  const primaryActionHandler = shouldShowPrimaryStart
    ? status === "review"
      ? resetWorkspace
      : beginInterview
    : answerState === "listening"
      ? finishAnswering
      : startAnswering;
  const primaryActionDisabled = shouldShowPrimaryStart
    ? !options || status === "starting"
    : isSubmitting || status !== "interview" || answerState === "connecting";
  const primaryActionTestId = shouldShowPrimaryStart
    ? "loopassist-start"
    : answerState === "listening"
      ? "loopassist-finish-answer"
      : "loopassist-start-answer";
  const primaryActionClassName = `loopassist-primary-action${
    !shouldShowPrimaryStart && isAwaitingFollowup ? " is-busy" : ""
  }`;

  return (
    <main className="loopassist-shell" data-testid="loopassist-shell">
      <header className="loopassist-nav">
        <Link href="/" className="loopassist-brand">
          <span className="loopassist-brand-mark" aria-hidden="true">L</span>
          <span className="loopassist-brand-copy">
            <strong>LoopAssist</strong>
            <span>{status === "setup" ? "新建面试" : `${scope.role || "目标岗位"} · ${scope.round || "当前轮次"}`}</span>
          </span>
        </Link>

        <div className="loopassist-nav-meta">
          <strong>{shellTitle}</strong>
          {status === "outline" ? <span>{planStages.length || questionBudget} 题 · 预计 {Math.max(planStages.length || questionBudget, 1) * 4} 分钟</span> : null}
          {status === "interview" ? <span>第 {currentQuestionNumber || 1} / {Math.max(questionBudget, 1)} 题</span> : null}
          {status === "review" || status === "reviewing" ? <span>{transcript.length} 条记录</span> : null}
        </div>

        <div className="loopassist-topbar-actions" ref={panelRef}>
          <button type="button" className="loopassist-icon-button" aria-label="帮助" onClick={() => setActivePanel((current) => (current === "help" ? null : "help"))}>
            <HelpIcon />
          </button>
          <button
            type="button"
            className={`loopassist-settings-trigger${activePanel === "settings" ? " is-active" : ""}`}
            aria-label="面试信息"
            onClick={() => setActivePanel((current) => (current === "settings" ? null : "settings"))}
            data-testid="loopassist-scope-toggle"
          >
            <SettingsIcon />
            <span>{status === "interview" ? "背景" : "面试信息"}</span>
          </button>

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
              className={`loopassist-popover loopassist-settings-popover loopassist-scope-popover${shouldCenterSettings ? " is-centered" : ""}`}
              role="dialog"
              aria-modal="true"
            >
              <div className="loopassist-popover-head">
                <div>
                  <h2>{shouldCenterSettings ? "开始一轮面试" : "背景信息"}</h2>
                  <p className="loopassist-settings-subtitle">{settingsSummary.join(" · ")}</p>
                </div>
                <button type="button" className="loopassist-popover-close" onClick={() => setActivePanel(null)}>关闭</button>
              </div>
              <div className="loopassist-config-grid">
                <label>岗位<select value={scope.role} onChange={(event) => updateScope("role", event.target.value)} data-testid="loopassist-role">{(options?.roles || []).slice(0, 20).map((item) => <option key={item.value} value={item.value}>{item.label} ({item.count})</option>)}</select></label>
                <label>题量<input type="number" min="4" max="12" value={scope.questionBudget} onChange={(event) => updateScope("questionBudget", Number(event.target.value) || 8)} data-testid="loopassist-budget" /></label>
              </div>
              <div className="loopassist-settings-docs">
                <div className="loopassist-setup-group">
                  <p className="loopassist-section-label">简历</p>
                  <button type="button" className={`loopassist-upload-zone${scope.resumeText ? " is-filled" : ""}`} onClick={() => resumeInputRef.current?.click()} data-testid="loopassist-resume-toggle">
                    <DocumentIcon />
                    <strong>{resumeFileName || (scope.resumeText ? "已填写" : "上传文件")}</strong>
                    <span>{scope.resumeText ? summarizeDocument(scope.resumeText) : "txt / md / json / csv"}</span>
                  </button>
                  <textarea value={scope.resumeText} onChange={(event) => updateScope("resumeText", event.target.value)} placeholder="粘贴简历文本" data-testid="loopassist-resume-text" />
                </div>

                <div className="loopassist-setup-group">
                  <p className="loopassist-section-label">JD</p>
                  <button type="button" className={`loopassist-upload-zone${scope.jobDescription ? " is-filled" : ""}`} onClick={() => jdInputRef.current?.click()} data-testid="loopassist-jd-toggle">
                    <DocumentIcon />
                    <strong>{jdFileName || (scope.jobDescription ? "已填写" : "上传文件")}</strong>
                    <span>{scope.jobDescription ? summarizeDocument(scope.jobDescription) : "txt / md / json / csv"}</span>
                  </button>
                  <textarea value={scope.jobDescription} onChange={(event) => updateScope("jobDescription", event.target.value)} placeholder="粘贴 JD 或岗位 URL" data-testid="loopassist-jd-text" />
                </div>
              </div>
              <section className="loopassist-mode-panel">
                <p className="loopassist-section-label">模式</p>
                <div className="loopassist-mode-toggle" aria-label="模式切换">
                  <button type="button" className={scope.interviewMode === "batch" ? "is-selected" : ""} onClick={() => updateScope("interviewMode", "batch")}>
                    文本模式
                  </button>
                  <button type="button" className={scope.interviewMode === "realtime" ? "is-selected" : ""} onClick={() => updateScope("interviewMode", "realtime")}>
                    实时语音
                  </button>
                </div>
              </section>
              <div className="loopassist-preview loopassist-preview-inline">
                <strong>参考题源 {preview?.matchedCount || 0} 条</strong>
                <span>{previewCards[0]?.baseQuestion || "已准备好从真实面经中挑题。"}</span>
              </div>
              {error ? <p className="loopassist-inline-error">{error}</p> : null}
              <div className="loopassist-settings-footer">
                {session?.sessionId ? (
                  <button type="button" className="loopassist-danger-button" onClick={confirmFinishAndReview}>结束本轮</button>
                ) : <span className="loopassist-settings-footer-spacer" aria-hidden="true" />}
                <div className="loopassist-settings-footer-actions">
                  {hasGeneratedOutline ? <button type="button" className="loopassist-ghost-button" onClick={confirmResetWorkspace}>重置</button> : null}
                  <button type="button" className="loopassist-primary-action" onClick={beginInterview} disabled={!options || status === "outlining" || !scope.role || !scope.round} data-testid="loopassist-start">
                    {status === "outlining" ? "正在生成..." : hasGeneratedOutline ? "重新生成大纲" : "生成大纲"}
                  </button>
                </div>
              </div>
            </section>
          ) : null}
        </div>
      </header>

      <div className="loopassist-test-preview" data-testid="loopassist-preview">
        <strong>{preview?.matchedCount || 0} 条匹配题源</strong>
        <span>{previewCards[0]?.baseQuestion || "已准备好从真实面经中挑题。"}</span>
      </div>

      {status === "setup" || status === "outlining" ? (
        <section className="loopassist-idle-stage">
          {error ? <p className="loopassist-inline-error">{error}</p> : null}
          {!shouldCenterSettings ? (
            <>
              <button type="button" className="loopassist-primary-action" onClick={openSettingsPanel}>
                {status === "outlining" ? "正在生成大纲..." : "填写面试信息"}
              </button>
            </>
          ) : null}
        </section>
      ) : null}

      {status === "outline" ? (
        <section className="loopassist-outline" data-testid="loopassist-plan">
          <div className="loopassist-page-title">
            <h1>本轮大纲</h1>
            <p>{interviewPlan?.title || "先看清方向，再开始面试。"}</p>
            <div className="loopassist-source-row">
              <span>{planStages.length || questionBudget} 题</span>
              <span>预计 {Math.max(planStages.length || questionBudget, 1) * 4} 分钟</span>
              {scope.resumeText || scope.jobDescription ? <span>已结合背景信息</span> : <span>通用题源</span>}
            </div>
          </div>

          <ol className="loopassist-outline-list loopassist-outline-plain">
            {planStages.map((stage, index) => (
              <li key={`${stage.step || index}-${stage.theme || stage.baseQuestion}`} className="loopassist-outline-item">
                <span className="loopassist-outline-index">{formatCount(index + 1)}</span>
                <div>
                  <strong>{stage.theme || `第 ${index + 1} 题`}</strong>
                  <p>{buildOutlineLine(stage)}</p>
                  {stage.source ? <div className="loopassist-outline-tags"><span className="is-source">{stage.source}</span></div> : null}
                </div>
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
              <span />
              <p>第 {currentQuestionNumber || 1} / {Math.max(questionBudget, 1)} 题</p>
              {ttsStatus !== "idle" && answerState !== "listening" ? (
                <button type="button" className="loopassist-ghost-button" onClick={() => playInterviewerAudio(lastInterviewerText || currentQuestion, { autoplay: true })} disabled={ttsStatus === "loading"} data-testid="loopassist-replay-tts">重播</button>
              ) : null}
            </div>
            <h1>{questionTitle}</h1>
            {currentPlanStage ? (
              <p className="loopassist-question-hint">{currentPlanStage.theme || "当前考察点"} · {buildOutlineLine(currentPlanStage)}</p>
            ) : null}
          </section>

          {answerState === "listening" || answerState === "submitting" || isAwaitingFollowup ? (
            <section className="loopassist-transcript-stream loopassist-recognition-strip">
              <strong>实时识别</strong>
              <p>{partialTranscript || capturedAnswer || "正在听你说..."}</p>
              <span />
            </section>
          ) : null}

          {questionTone ? <p className={`loopassist-inline-message${voiceIssue || error ? " loopassist-inline-error" : ""}`}>{questionTone}</p> : null}

          <div className="loopassist-bottom-dock">
            <button type="button" className="loopassist-ghost-button" onClick={() => setIsHistoryOpen(true)}>历史 · {transcript.length}</button>
            <div className="loopassist-dock-spacer" />
            {answerState === "listening" ? <div className="loopassist-wave is-recording">{waveHeights.slice(0, 11).map((height, index) => <span key={`${height}-${index}`} style={{ "--wave-height": `${height}px` }} />)}</div> : null}
            {answerState !== "listening" ? <button type="button" className="loopassist-ghost-button" onClick={skipQuestion} disabled={isSubmitting}>跳过本题</button> : null}
            {voiceIssue ? <button type="button" className="loopassist-ghost-button" onClick={reconnectVoiceRoom} data-testid="loopassist-retry-mic">重试</button> : null}
            <button type="button" className={primaryActionClassName} onClick={primaryActionHandler} disabled={primaryActionDisabled} data-testid={primaryActionTestId}>{primaryActionLabel}</button>
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
              <p className="loopassist-section-label">总结 / 评价</p>
              <h1>{reviewVerdict}</h1>
              <span>总计 {transcript.length} 条记录 · {review ? `${review.readinessScore} / 100` : "生成复盘中"}</span>
            </div>
            {review?.summary ? <p className="loopassist-review-summary">{review.summary}</p> : null}
          </div>
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
          <div className="loopassist-bottom-dock">
            <button type="button" className="loopassist-ghost-button" onClick={() => setStatus("outline")}>回到大纲</button>
            <button type="button" className="loopassist-ghost-button">导出 PDF</button>
            <button type="button" className="loopassist-primary-action" onClick={resetWorkspace}>新建面试</button>
          </div>
        </section>
      ) : null}

      <aside className={`loopassist-history-drawer${isHistoryOpen ? " is-open" : ""}`} data-testid="loopassist-transcript">
        <div className="loopassist-transcript-head">
          <h2>历史记录</h2>
          <button type="button" className="loopassist-icon-button" onClick={() => setIsHistoryOpen(false)}>×</button>
        </div>
        <div className="loopassist-transcript-body">
          {transcript.length ? transcript.map((turn) => (
            <article key={`${turn.turnId}-history`} className={`loopassist-transcript-line is-${turn.role}`}>
              <strong>{turn.role === "interviewer" ? "面试官" : "我"}</strong>
              <p>{turn.text}</p>
            </article>
          )) : (
            <article className="loopassist-empty-state">
              <strong>本轮考察重点</strong>
              <p>{planStages[0]?.objective || "开始后会在这里记录完整问答。"}</p>
            </article>
          )}
        </div>
      </aside>
    </main>
  );
}
