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
  questionBudget: 8,
};

const prepGoals = [
  "回答先给结论，再补背景和原理，别从定义背起。",
  "每题至少带一个真实项目场景，不只停留在八股表述。",
  "被追问时优先说明取舍、风险和代价，回答更像真实工作经验。",
  "结束后沉淀 3 条可复述版本，方便下一轮快速复练。",
];

const answerScaffold = [
  {
    title: "先讲结论",
    detail: "先给最终判断，告诉面试官你会怎么做，而不是先铺背景。",
  },
  {
    title: "再讲场景",
    detail: "把答案挂到订单、检索、并发或线上排查场景里，证明你不是死记硬背。",
  },
  {
    title: "最后补取舍",
    detail: "点出性能收益、实现成本和副作用，回答会更像真实一面。",
  },
];

const waveHeights = [18, 28, 38, 24, 42, 30, 20, 36, 48, 32, 22, 34, 26, 40, 28, 18];

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

function normalizePreviewTopics(preview, topicOptions, scope) {
  if (preview?.sampleSeeds?.length) {
    return preview.sampleSeeds
      .flatMap((item) => item.topics || [])
      .filter(Boolean)
      .slice(0, 4);
  }

  return topicOptions
    .filter((item) => scope.topics.includes(item.value))
    .map((item) => item.label)
    .slice(0, 4);
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
  const [ttsMessage, setTtsMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const roomRef = useRef(null);
  const audioRef = useRef(null);
  const audioCacheRef = useRef(new Map());
  const answerSegmentsRef = useRef([]);
  const isCapturingRef = useRef(false);
  const latestSessionRef = useRef(null);

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
    for (const url of audioCacheRef.current.values()) {
      URL.revokeObjectURL(url);
    }
    audioCacheRef.current.clear();
  }, []);

  const transcript = session?.transcript || [];
  const topicOptions = useMemo(() => options?.topics?.slice(0, 18) || [], [options]);
  const sampleTopics = useMemo(
    () => normalizePreviewTopics(preview, topicOptions, scope),
    [preview, scope, topicOptions],
  );

  const interviewerTurns = useMemo(
    () => transcript.filter((turn) => turn.role === "interviewer"),
    [transcript],
  );
  const askedCount = interviewerTurns.length;
  const questionBudget = Math.max(Number(scope.questionBudget) || 8, 1);
  const currentQuestion =
    session?.interviewerMessage?.text ||
    lastInterviewerText ||
    interviewerTurns.at(-1)?.text ||
    "从真实面经里锁定第一题，开始一次更接近正式一面的模拟。";
  const latestCandidateTurn = [...transcript].reverse().find((turn) => turn.role === "candidate");
  const answerPreview =
    partialTranscript ||
    capturedAnswer ||
    latestCandidateTurn?.text ||
    "点击“开始回答”后作答，说完再点击“回答完成，发送给面试官”。";
  const stageHeading =
    status === "review"
      ? "这一轮已经结束，复盘结果和下一轮练习方向已经生成。"
      : status === "reviewing"
        ? "正在整理这轮模拟的复盘，请稍等片刻。"
        : status === "starting"
          ? "正在根据真实面经锁定第一题。"
          : status === "interview"
            ? "围绕真实题源连续追问，把这一轮模拟完整做完。"
            : "把真实追问放进一次完整模拟里。";
  const stageSummary =
    status === "review"
      ? review?.summary || "系统会总结这轮回答的优势、短板和下一轮建议。"
      : voiceIssue ||
        ttsMessage ||
        "LoopAssist 不做自动 turn 判断：你点击开始回答，说完后点击回答完成。右侧 Transcript 只保留对话内容。";
  const currentStatusLabel =
    status === "review"
      ? "已复盘"
      : status === "reviewing"
        ? "复盘生成中"
        : status === "interview"
          ? ttsStatus === "loading"
            ? "语音生成中"
            : answerState === "listening"
            ? "正在收音"
            : answerState === "connecting"
              ? "连接麦克风中"
              : isSubmitting
                ? "提交回答中"
                : "等待作答"
          : status === "starting"
            ? "准备进入"
            : "待开始";

  const scopeCards = [
    {
      label: "岗位方向",
      value: scope.role || "等待加载",
    },
    {
      label: "目标轮次",
      value: scope.round || "等待加载",
    },
    {
      label: "公司风格",
      value: scope.companyStyle || "未指定",
    },
    {
      label: "题量预算",
      value: `${questionBudget} 题，先广后深`,
    },
  ];

  const previewCards = preview?.sampleSeeds?.slice(0, 3) || [];
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
    : [
        { title: "这轮最该改什么", items: ["不要把定义背成百科词条，先回答业务为什么这样做，再补底层原理。"] },
        { title: "下一轮准备", items: ["准备一个亲自排查过的慢 SQL 或并发案例。", "把“为什么不是别的方案”练成固定三句。"] },
      ];

  const reviewMetrics = review
    ? [
        {
          label: "准备度",
          value: `${review.readinessScore ?? 0} / 100`,
          width: `${Math.min(Math.max(review.readinessScore ?? 0, 0), 100)}%`,
        },
        {
          label: "优势命中",
          value: String((review.strengths || []).length),
          width: `${Math.min(((review.strengths || []).length / 5) * 100, 100)}%`,
        },
        {
          label: "薄弱项",
          value: String((review.weaknesses || []).length),
          width: `${Math.min(((review.weaknesses || []).length / 5) * 100, 100)}%`,
        },
      ]
    : [
        {
          label: "当前进度",
          value: `${formatCount(askedCount)} / ${formatCount(questionBudget)}`,
          width: `${Math.min((askedCount / questionBudget) * 100, 100)}%`,
        },
        {
          label: "收音状态",
          value: currentStatusLabel,
          width: answerState === "listening" ? "88%" : answerState === "connecting" ? "52%" : "28%",
        },
        {
          label: "题源命中",
          value: `${preview?.matchedCount || 0} 条`,
          width: `${Math.min(((preview?.matchedCount || 0) / Math.max(options?.counts?.seeds || 12, 1)) * 100, 100)}%`,
        },
      ];

  function updateScope(key, value) {
    setScope((current) => ({
      ...current,
      [key]: value,
    }));
  }

  function toggleTopic(topic) {
    setScope((current) => {
      const nextTopics = current.topics.includes(topic)
        ? current.topics.filter((item) => item !== topic)
        : uniqueValues([...current.topics, topic]).slice(0, 6);
      return {
        ...current,
        topics: nextTopics,
      };
    });
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
    setTtsMessage("");
    answerSegmentsRef.current = [];
  }

  async function beginInterview() {
    setError("");
    setVoiceIssue("");
    setReview(null);
    setStatus("starting");
    try {
      const nextSession = await startLoopAssist({
        userId: readStoredUserId(),
        scope,
      });
      setSession(nextSession);
      setStatus("interview");
      const interviewerText = nextSession.interviewerMessage?.text || nextSession.transcript?.at(-1)?.text || "";
      setLastInterviewerText(interviewerText);
      await playInterviewerAudio(interviewerText);
    } catch (nextError) {
      setError(nextError.message);
      setStatus("setup");
    }
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
      setTtsMessage("正在准备面试官语音。首次使用 Qwen3-TTS 会下载并加载本地模型，可能需要等一会儿。");
      let url = audioCacheRef.current.get(line);
      if (!url) {
        const blob = await synthesizeLoopAssistSpeech({ text: line });
        url = URL.createObjectURL(blob);
        audioCacheRef.current.set(line, url);
      }
      setTtsStatus("ready");
      setTtsMessage("面试官语音已准备好。听完后点击开始回答。");
      if (!autoplay) {
        return;
      }
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.addEventListener("playing", () => {
        setTtsStatus("playing");
        setTtsMessage("面试官正在提问。");
      }, { once: true });
      audio.addEventListener("ended", () => {
        setTtsStatus("ready");
        setTtsMessage("听完后点击开始回答。");
      }, { once: true });
      await audio.play();
    } catch (nextError) {
      setTtsStatus("error");
      setTtsMessage("");
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
      setVoiceIssue("还没有识别到你的回答。请点击“开始回答”后再说一遍。");
      setAnswerState("idle");
      return;
    }
    await submitVoiceAnswer(answer);
    setAnswerState("idle");
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
    setStatus("reviewing");
    setError("");
    roomRef.current?.disconnect?.();
    audioRef.current?.pause?.();
    isCapturingRef.current = false;
    try {
      const result = await reviewLoopAssist({ sessionId: session.sessionId });
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

  return (
    <main className="loopassist-shell" data-testid="loopassist-shell">
      <header className="loopassist-topbar">
        <Link href="/" className="loopassist-brand">
          <span className="loopassist-brand-mark" aria-hidden="true">
            L
          </span>
          <span className="loopassist-brand-copy">
            <strong>LoopAssist</strong>
            <span>真实面经模拟面试</span>
          </span>
        </Link>
        <div className="loopassist-topbar-actions">
          <div className="loopassist-status-pill">
            <span className="loopassist-status-dot" aria-hidden="true" />
            <span>{preview?.matchedCount || 0} 条真实面经已匹配</span>
          </div>
          <button type="button" className="loopassist-secondary" onClick={resetWorkspace}>
            重新选题
          </button>
          {status === "interview" || status === "reviewing" ? (
            <button type="button" className="loopassist-primary" onClick={finishAndReview}>
              结束并复盘
            </button>
          ) : (
            <button
              type="button"
              className="loopassist-primary"
              onClick={beginInterview}
              disabled={!options || status === "starting"}
              data-testid="loopassist-start"
            >
              {status === "starting" ? "正在进入面试..." : status === "review" ? "再来一轮" : "开始本轮"}
            </button>
          )}
        </div>
      </header>

      <section className="loopassist-hero">
        <div className="loopassist-hero-card">
          <div className="loopassist-hero-pills">
            <span className="loopassist-hero-pill is-amber">{scope.role || "Java 后端"}</span>
            <span className="loopassist-hero-pill">{scope.round || "一面"}</span>
            <span className="loopassist-hero-pill is-green">{scope.companyStyle || "真实风格"}</span>
            <span className="loopassist-hero-pill is-blue">{questionBudget} 题预算</span>
          </div>
          <p className="loopassist-hero-kicker">Voice-first mock interview</p>
          <h1>{stageHeading}</h1>
          <p className="loopassist-hero-copy">
            同一页完成设定、开场、连续追问、即时答题支架与面后复盘，让 LoopAssist 更像一次真正的技术面试，而不是分散的工具拼盘。
          </p>
          <div className="loopassist-hero-metrics">
            <article>
              <span>本轮题源</span>
              <strong>{sampleTopics.length ? sampleTopics.join(" + ") : "并发 + 索引 + 场景追问"}</strong>
            </article>
            <article>
              <span>面试节奏</span>
              <strong>开场 3 分钟 · 深挖 28 分钟 · 复盘 14 分钟</strong>
            </article>
          </div>
        </div>

        <aside className="loopassist-agenda-card">
          <h2>本轮节奏</h2>
          <ol>
            <li>
              <strong>01</strong>
              <div>
                <h3>先定场</h3>
                <p>根据岗位、轮次和公司风格锁定真实面经组合。</p>
              </div>
            </li>
            <li>
              <strong>02</strong>
              <div>
                <h3>再追问</h3>
                <p>同题连续深挖，尽量贴近真实一面的追问节奏。</p>
              </div>
            </li>
            <li>
              <strong>03</strong>
              <div>
                <h3>最后复盘</h3>
                <p>沉淀可复述答案和下一轮最值得优先补的薄弱点。</p>
              </div>
            </li>
          </ol>
        </aside>
      </section>

      <section className="loopassist-layout">
        <aside className="loopassist-column loopassist-column-left">
          <section className="loopassist-card">
            <div className="loopassist-card-head">
              <h2>本场设定</h2>
              <span>{currentStatusLabel}</span>
            </div>
            <div className="loopassist-config-grid">
              <label>
                岗位
                <select
                  value={scope.role}
                  onChange={(event) => updateScope("role", event.target.value)}
                  data-testid="loopassist-role"
                >
                  {(options?.roles || []).slice(0, 20).map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label} ({item.count})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                轮次
                <select
                  value={scope.round}
                  onChange={(event) => updateScope("round", event.target.value)}
                  data-testid="loopassist-round"
                >
                  {(options?.rounds || []).slice(0, 12).map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label} ({item.count})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                公司风格
                <select
                  value={scope.companyStyle}
                  onChange={(event) => updateScope("companyStyle", event.target.value)}
                  data-testid="loopassist-company"
                >
                  {(options?.companyStyles || []).slice(0, 20).map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label} ({item.count})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                面试风格
                <select
                  value={scope.interviewStyle}
                  onChange={(event) => updateScope("interviewStyle", event.target.value)}
                  data-testid="loopassist-style"
                >
                  {(options?.interviewStyles || []).map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                题量
                <input
                  type="number"
                  min="4"
                  max="12"
                  value={scope.questionBudget}
                  onChange={(event) => updateScope("questionBudget", Number(event.target.value) || 8)}
                  data-testid="loopassist-budget"
                />
              </label>
            </div>
            <div className="loopassist-topic-cloud" data-testid="loopassist-topics">
              {topicOptions.map((item) => (
                <button
                  type="button"
                  key={item.value}
                  className={scope.topics.includes(item.value) ? "is-selected" : ""}
                  onClick={() => toggleTopic(item.value)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <div className="loopassist-config-summary">
              {scopeCards.map((item) => (
                <article key={item.label}>
                  <span>{item.label}</span>
                  <strong>{item.value}</strong>
                </article>
              ))}
            </div>
          </section>

          <section className="loopassist-card">
            <div className="loopassist-card-head">
              <h2>真实题源预览</h2>
              <span>{preview?.matchedCount || 0} 条</span>
            </div>
            <div className="loopassist-preview" data-testid="loopassist-preview">
              <strong>{preview?.matchedCount || 0} 条匹配题源</strong>
              <span>{previewCards[0]?.baseQuestion || "已准备好从真实面经中挑题。"}</span>
              {(preview?.warnings || []).map((warning) => (
                <em key={warning}>{warning}</em>
              ))}
            </div>
            <div className="loopassist-source-list">
              {previewCards.length ? (
                previewCards.map((item) => (
                  <article key={item.seedId || item.baseQuestion}>
                    <span>{(item.topics || []).join(" · ") || "真实面经"}</span>
                    <strong>{item.baseQuestion}</strong>
                  </article>
                ))
              ) : (
                <article>
                  <span>等待题源</span>
                  <strong>选择岗位、轮次和主题后，这里会展示命中的真实面经问题。</strong>
                </article>
              )}
            </div>
          </section>

          <section className="loopassist-card">
            <div className="loopassist-card-head">
              <h2>本轮目标</h2>
            </div>
            <ul className="loopassist-checklist">
              {prepGoals.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>
        </aside>

        <div className="loopassist-column loopassist-column-main">
          <section className="loopassist-card loopassist-interview-card">
            <div className="loopassist-card-head">
              <div>
                <h2>当前模拟面试</h2>
                <p>围绕真实题源连续深挖，保留更接近正式一面的追问节奏。</p>
              </div>
              <div className="loopassist-inline-pills">
                <span>{formatCount(askedCount)} / {formatCount(questionBudget)}</span>
                <span>{status === "review" ? "复盘完成" : currentStatusLabel}</span>
              </div>
            </div>

            <article className="loopassist-live-question">
              <span className="loopassist-turn-label">面试官</span>
              <h3>{currentQuestion}</h3>
              <p>{stageSummary}</p>
            </article>

            <div className="loopassist-chat-list loopassist-stage-list">
              {transcript.length ? (
                transcript.map((turn) => (
                  <article key={turn.turnId} className={`loopassist-chat-turn is-${turn.role}`}>
                    <strong>{turn.role === "interviewer" ? "面试官" : "候选人"}</strong>
                    <p>{turn.text}</p>
                  </article>
                ))
              ) : (
                <article className="loopassist-empty-state">
                  <strong>还没开始本轮模拟</strong>
                  <p>先在左侧确认岗位、轮次和题量，再点击右上角“开始本轮”。</p>
                </article>
              )}
            </div>
          </section>

          <section className="loopassist-card loopassist-answer-card">
            <div className="loopassist-card-head">
              <div>
                <h2>回答采集区</h2>
                <p>仅支持语音作答，识别结果会直接进入当前模拟流程。</p>
              </div>
              <span className="loopassist-answer-mode">仅语音作答</span>
            </div>

            <div className="loopassist-wave">
              {waveHeights.map((height, index) => (
                <span
                  key={`${height}-${index}`}
                  style={{ "--wave-height": `${height}px` }}
                />
              ))}
            </div>

            <div className="loopassist-answer-preview">
              <span>当前识别</span>
              <strong>{answerPreview}</strong>
            </div>

            <div className="loopassist-turn-actions">
              <button
                type="button"
                className="loopassist-answer-start"
                onClick={startAnswering}
                disabled={answerState !== "idle" || isSubmitting || ttsStatus === "loading" || status !== "interview"}
                data-testid="loopassist-start-answer"
              >
                {ttsStatus === "loading" ? "等待面试官语音..." : answerState === "connecting" ? "正在连接麦克风..." : "开始回答"}
              </button>
              <button
                type="button"
                className="loopassist-answer-finish"
                onClick={finishAnswering}
                disabled={answerState !== "listening"}
                data-testid="loopassist-finish-answer"
              >
                回答完成，发送给面试官
              </button>
            </div>

            {lastInterviewerText ? (
              <div className="loopassist-voice-actions">
                <button
                  type="button"
                  onClick={() => playInterviewerAudio(lastInterviewerText)}
                  disabled={isSubmitting || ttsStatus === "loading"}
                  data-testid="loopassist-replay-tts"
                >
                  {ttsStatus === "loading" ? "正在生成面试官语音..." : "播放面试官问题"}
                </button>
              </div>
            ) : null}

            {voiceIssue ? (
              <div className="loopassist-voice-actions">
                <button
                  type="button"
                  onClick={reconnectVoiceRoom}
                  disabled={isSubmitting}
                  data-testid="loopassist-retry-mic"
                >
                  重新连接麦克风
                </button>
              </div>
            ) : null}

            {error ? <p className="loopassist-error">{error}</p> : null}
          </section>
        </div>

        <aside className="loopassist-column loopassist-column-right">
          <aside className="loopassist-card loopassist-transcript" data-testid="loopassist-transcript">
            <div className="loopassist-card-head">
              <h2>Transcript</h2>
              <span>{transcript.length} 条</span>
            </div>
            <div className="loopassist-transcript-body">
              {transcript.length ? (
                transcript.map((turn) => (
                  <article key={`${turn.turnId}-transcript`} className={`loopassist-transcript-line is-${turn.role}`}>
                    <strong>{turn.role === "interviewer" ? "面试官" : "我"}</strong>
                    <p>{turn.text}</p>
                  </article>
                ))
              ) : (
                <article className="loopassist-empty-state">
                  <strong>Transcript 会在这里连续记录</strong>
                  <p>右侧只保留对话内容，不展示题源元数据或提示信息。</p>
                </article>
              )}
            </div>
          </aside>

          <section className="loopassist-card">
            <div className="loopassist-card-head">
              <h2>即时回答支架</h2>
            </div>
            <div className="loopassist-scaffold-list">
              {answerScaffold.map((item, index) => (
                <article key={item.title}>
                  <strong>{String(index + 1).padStart(2, "0")}</strong>
                  <div>
                    <h3>{item.title}</h3>
                    <p>{item.detail}</p>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="loopassist-card">
            <div className="loopassist-card-head">
              <h2>观察维度</h2>
            </div>
            <div className="loopassist-metric-list">
              {reviewMetrics.map((item) => (
                <article key={item.label}>
                  <div>
                    <span>{item.label}</span>
                    <strong>{item.value}</strong>
                  </div>
                  <div className="loopassist-progress-track">
                    <span style={{ width: item.width }} />
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="loopassist-card loopassist-review" data-testid="loopassist-review">
            <div className="loopassist-card-head">
              <h2>面后复盘</h2>
              {review ? <span>{review.readinessScore} / 100</span> : null}
            </div>
            <div className="loopassist-review-grid">
              {reviewPanels.map((panel) => (
                <section key={panel.title}>
                  <h2>{panel.title}</h2>
                  {panel.items.map((item) => (
                    <p key={item}>{item}</p>
                  ))}
                </section>
              ))}
            </div>
            {status === "review" ? (
              <button type="button" className="loopassist-start" onClick={resetWorkspace}>
                再来一轮
              </button>
            ) : null}
          </section>
        </aside>
      </section>
    </main>
  );
}
