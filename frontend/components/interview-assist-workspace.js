"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { createLocalAudioTrack, Room, RoomEvent } from "livekit-client";
import {
  ackFirstScreenRendered,
  createAssistSession,
  streamAssistAnswer,
} from "../lib/interview-assist-api";

const starterQuestions = [
  "AQS 是什么？",
  "你项目里如何做限流？",
  "高并发下接口超时怎么排查？",
  "介绍一下你最近做的项目。",
];

const statusLabels = {
  idle: "待开始",
  connecting: "连接中",
  listening: "正在监听",
  paused: "已暂停",
  generating_skeleton: "框架生成中",
  first_screen_ready: "框架已就绪",
  error: "异常",
};

function formatDuration(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function buildAnswerSections(answer) {
  const frameworkPoints = answer?.frameworkPoints || [];
  const detailBlocks = answer?.detailBlocks || [];
  if (!frameworkPoints.length) {
    return [];
  }

  return frameworkPoints.map((point, index) => ({
    title: `${String(index + 1).padStart(2, "0")} | ${point}`,
    detail: detailBlocks[index] || "框架已到位，细节正在继续展开。",
  }));
}

function createEmptyAnswer(questionText = "", sessionId = "") {
  return {
    sessionId,
    turnId: "",
    questionText,
    frameworkPoints: [],
    detailBlocks: [],
  };
}

export function InterviewAssistWorkspace() {
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");
  const [questionText, setQuestionText] = useState("");
  const [transcriptPreview, setTranscriptPreview] = useState("");
  const [session, setSession] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [currentAnswer, setCurrentAnswer] = useState(null);
  const [history, setHistory] = useState([]);
  const [transportState, setTransportState] = useState("mock");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [isExpanding, setIsExpanding] = useState(false);
  const [roomConnected, setRoomConnected] = useState(false);
  const [micActive, setMicActive] = useState(false);

  const roomRef = useRef(null);
  const roomConnectPromiseRef = useRef(null);
  const localAudioTrackRef = useRef(null);
  const ackedTurnRef = useRef("");

  useEffect(() => {
    return () => {
      const track = localAudioTrackRef.current;
      localAudioTrackRef.current = null;
      track?.stop?.();
      roomRef.current?.disconnect?.();
      roomRef.current = null;
      roomConnectPromiseRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!currentAnswer?.turnId || !(currentAnswer.frameworkPoints || []).length) {
      return undefined;
    }
    if (ackedTurnRef.current === currentAnswer.turnId) {
      return undefined;
    }

    const frameId = window.requestAnimationFrame(() => {
      ackFirstScreenRendered({
        sessionId: currentAnswer.sessionId,
        turnId: currentAnswer.turnId,
        renderedAt: Date.now(),
      })
        .then(() => {
          ackedTurnRef.current = currentAnswer.turnId;
        })
        .catch(() => {});
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [currentAnswer]);

  useEffect(() => {
    if (!session?.sessionId || status === "idle" || status === "paused" || status === "error") {
      return undefined;
    }

    const timerId = window.setInterval(() => {
      setElapsedSeconds((value) => value + 1);
    }, 1000);

    return () => window.clearInterval(timerId);
  }, [session?.sessionId, status]);

  async function ensureSession({ restart = false } = {}) {
    if (!restart && session?.sessionId) {
      return session;
    }

    if (restart && roomRef.current) {
      roomRef.current.disconnect();
      roomRef.current = null;
      roomConnectPromiseRef.current = null;
      setRoomConnected(false);
      setMicActive(false);
    }

    setError("");
    setStatus("connecting");
    const nextSession = await createAssistSession({
      targetRole: "java-backend",
      sessionMode: "realtime_interview_assist",
    });
    setSession(nextSession);
    setTransportState(nextSession.transportMode || "mock");
    setElapsedSeconds(0);
    setStatus("paused");
    return nextSession;
  }

  function applyFrameworkDone(data) {
    setCurrentAnswer((prev) => ({
      ...(prev || createEmptyAnswer(data.questionText, data.sessionId)),
      ...data,
      detailBlocks: prev?.detailBlocks || new Array((data.frameworkPoints || []).length).fill(""),
    }));
    setStatus("first_screen_ready");
  }

  function applyAssistEvent(event, data, fallbackQuestion, fallbackSessionId) {
    if (event === "transcript_partial" || event === "transcript_final") {
      setTranscriptPreview(data.transcript || "");
      return;
    }

    if (event === "turn_committed") {
      ackedTurnRef.current = "";
      setCurrentAnswer(createEmptyAnswer(data.questionText || fallbackQuestion, fallbackSessionId));
      setStatus("generating_skeleton");
      setIsExpanding(false);
      return;
    }

    if (event === "framework_delta") {
      setCurrentAnswer((prev) => {
        const base = prev || createEmptyAnswer(fallbackQuestion, fallbackSessionId);
        const frameworkPoints = [...(base.frameworkPoints || [])];
        frameworkPoints[data.index] = data.point;
        const detailBlocks = [...(base.detailBlocks || [])];
        while (detailBlocks.length < frameworkPoints.length) {
          detailBlocks.push("");
        }
        return {
          ...base,
          questionText: data.questionText || base.questionText,
          frameworkPoints,
          detailBlocks,
        };
      });
      return;
    }

    if (event === "framework_done") {
      applyFrameworkDone(data);
      return;
    }

    if (event === "detail_start") {
      setIsExpanding(true);
      return;
    }

    if (event === "detail_delta") {
      setCurrentAnswer((prev) => {
        const base = prev || createEmptyAnswer(fallbackQuestion, fallbackSessionId);
        const detailBlocks = [...(base.detailBlocks || [])];
        detailBlocks[data.index] = `${detailBlocks[data.index] || ""}${data.delta || ""}`;
        return {
          ...base,
          detailBlocks,
        };
      });
      return;
    }

    if (event === "detail_done") {
      setCurrentAnswer((prev) => {
        const base = prev || createEmptyAnswer(fallbackQuestion, fallbackSessionId);
        const detailBlocks = [...(base.detailBlocks || [])];
        detailBlocks[data.index] = data.detail || detailBlocks[data.index] || "";
        return {
          ...base,
          detailBlocks,
        };
      });
      return;
    }

    if (event === "answer_ready") {
      setCurrentAnswer(data);
      setHistory((items) => [data, ...items].slice(0, 3));
      setIsExpanding(false);
      return;
    }

    if (event === "agent_ready") {
      setError("");
      setTranscriptPreview("Agent 已就绪，等待服务端 STT 返回识别文本。");
      return;
    }

    if (event === "error") {
      setError(data.error || "LiveKit Agent 运行错误。");
      setStatus("error");
      setIsExpanding(false);
    }
  }

  function bindRoomEvents(room, activeSession) {
    room.on(RoomEvent.DataReceived, (payload) => {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(payload));
        if (!parsed?.event) {
          return;
        }
        applyAssistEvent(parsed.event, parsed.data || {}, transcriptPreview, activeSession.sessionId);
      } catch {}
    });

    room.on(RoomEvent.Disconnected, () => {
      setRoomConnected(false);
      setMicActive(false);
    });
  }

  async function ensureLiveKitRoom(activeSession) {
    if (!activeSession?.livekitConfigured || !activeSession?.participantToken || !activeSession?.livekitUrl) {
      throw new Error("LiveKit Agents 尚未配置，当前环境不能直接走产品级实时语音链路。");
    }

    if (roomRef.current) {
      return roomRef.current;
    }
    if (roomConnectPromiseRef.current) {
      return roomConnectPromiseRef.current;
    }

    const room = new Room();
    roomRef.current = room;
    bindRoomEvents(room, activeSession);
    setTransportState("livekit");

    roomConnectPromiseRef.current = room
      .connect(activeSession.livekitUrl, activeSession.participantToken)
      .then(() => {
        setRoomConnected(true);
        return room;
      })
      .catch((nextError) => {
        roomRef.current = null;
        setRoomConnected(false);
        throw nextError;
      })
      .finally(() => {
        roomConnectPromiseRef.current = null;
      });

    return roomConnectPromiseRef.current;
  }

  async function runAssistStream(nextQuestion = questionText, activeSession = session) {
    const trimmedQuestion = String(nextQuestion || "").trim();
    if (!trimmedQuestion) {
      setError("请先输入问题。");
      return;
    }

    try {
      setError("");
      setIsSubmitting(true);
      setIsExpanding(false);
      const readySession = activeSession?.sessionId ? activeSession : await ensureSession();
      ackedTurnRef.current = "";
      setCurrentAnswer(createEmptyAnswer(trimmedQuestion, readySession.sessionId));
      setStatus("generating_skeleton");

      await streamAssistAnswer(
        {
          sessionId: readySession.sessionId,
          questionText: trimmedQuestion,
          questionEndedAt: Date.now(),
        },
        async (event, data) => {
          if (event === "error") {
            throw new Error(data.error || "面试辅助流式生成失败。");
          }
          applyAssistEvent(event, data, trimmedQuestion, readySession.sessionId);
        }
      );

      setQuestionText("");
      setTranscriptPreview(trimmedQuestion);
    } catch (nextError) {
      setError(nextError.message);
      setStatus("error");
      setIsExpanding(false);
    } finally {
      setIsSubmitting(false);
    }
  }

  async function startListening() {
    try {
      const activeSession = await ensureSession();
      const room = await ensureLiveKitRoom(activeSession);

      if (localAudioTrackRef.current) {
        setMicActive(true);
        setStatus("listening");
        return;
      }

      const track = await createLocalAudioTrack();
      await room.localParticipant.publishTrack(track);
      localAudioTrackRef.current = track;
      setMicActive(true);
      setStatus("listening");
      setError("");
    } catch (nextError) {
      setError(nextError.message || "LiveKit 连接失败。");
      setStatus("error");
      setMicActive(false);
    }
  }

  async function pauseListening() {
    const track = localAudioTrackRef.current;
    localAudioTrackRef.current = null;
    if (track && roomRef.current?.localParticipant) {
      try {
        await roomRef.current.localParticipant.unpublishTrack(track);
      } catch {}
      track.stop();
    }
    setMicActive(false);
    setStatus("paused");
  }

  const answerSections = buildAnswerSections(currentAnswer);
  const statusLabel = statusLabels[status] || status;
  const questionLabel =
    currentAnswer?.questionText || transcriptPreview || questionText || "等待完整问题后展示当前问题。";
  const frameworkSummary = currentAnswer?.frameworkPoints?.length
    ? currentAnswer.frameworkPoints.join("；")
    : "等待 LiveKit Agent 判定完整问题后开始生成回答框架。";
  const detailStatusText = currentAnswer?.frameworkPoints?.length
    ? (isExpanding ? "框架已完整，正在逐点展开细节。" : "框架已就绪，可先按这 3 个点组织口头回答。")
    : "现在由 LiveKit Agents 在服务端做 STT 和 turn detection，不再依赖浏览器本地识别。";
  const voiceReady = Boolean(session?.livekitConfigured);

  return (
    <main className="interview-assist-shell">
      <header className="interview-assist-topbar">
        <div className="assist-brand-block">
          <Link className="assist-brand-title" href="/">LoopAssist</Link>
          <p>LiveKit Agents 负责服务端转写、turn detection 和实时事件回传</p>
        </div>

        <Link className="assist-page-name" href="/learn">最佳真实面试辅助</Link>

        <div className="assist-header-actions">
          <div className="assist-status-pill" aria-live="polite">
            <span className={`assist-dot assist-dot-${status}`} />
            <span>{statusLabel}</span>
          </div>
          <div className="assist-status-pill">
            <span className="assist-dot assist-dot-voice" />
            <span>{transportState}</span>
          </div>
        </div>
      </header>

      {error ? <section className="feedback-banner error-banner assist-error-banner">{error}</section> : null}

      <section className="assist-answer-panel">
        <div className="assist-question-context">
          <p>问题</p>
          <h1>{questionLabel}</h1>
        </div>

        <div className="assist-answer-heading">
          <h2>AI 回答</h2>
          <span className="assist-mini-pill">
            <span className={`assist-dot assist-dot-${isExpanding ? "connecting" : status}`} />
            {isExpanding ? "展开中" : statusLabel}
          </span>
        </div>

        <p className="assist-opening-line">{frameworkSummary}</p>
        <p className="assist-key-summary">{detailStatusText}</p>

        <div className="assist-section-list">
          {answerSections.length ? (
            answerSections.map((section) => (
              <article className="assist-answer-section" key={section.title}>
                <h3>{section.title}</h3>
                <p>{section.detail}</p>
              </article>
            ))
          ) : (
            <>
              <article className="assist-answer-section">
                <h3>01 | 服务端收尾</h3>
                <p>现在由 LiveKit Agent 在服务端监听音频、做 turn detection，再决定什么时候提交给大模型。</p>
              </article>
              <article className="assist-answer-section">
                <h3>02 | 先框架后展开</h3>
                <p>Agent 收到完整问句后，先回完整框架，再逐点把细节流式填充出来。</p>
              </article>
            </>
          )}
        </div>
      </section>

      <section className="assist-recognition-panel">
        <div className="assist-recognition-header">
          <h2>实时识别</h2>
          <div className="assist-recognition-badges">
            <span className="assist-mini-pill">
              <span className={`assist-dot assist-dot-${voiceReady ? "listening" : "error"}`} />
              {voiceReady ? (roomConnected ? "房间已连接" : "等待入房") : "未配置 LiveKit"}
            </span>
            <span className="assist-mini-pill">
              <span className="assist-dot assist-dot-voice" />
              {micActive ? "麦克风已发布" : "麦克风未开启"}
            </span>
          </div>
        </div>

        <div className="assist-transcript-stream">
          <p>面试官：{transcriptPreview || currentAnswer?.questionText || "等待 LiveKit Agent 回传识别文本。"}</p>
          <p>我：{frameworkSummary}</p>
          {history[1]?.questionText ? <p>上一题：{history[1].questionText}</p> : null}
        </div>

        <details className="assist-manual-entry">
          <summary>手动输入（开发兜底）</summary>
          <div className="assist-manual-body">
            <textarea
              value={questionText}
              onChange={(event) => setQuestionText(event.target.value)}
              placeholder="调试时可直接粘贴面试官问题。"
            />
            <div className="assist-chip-row">
              {starterQuestions.map((item) => (
                <button key={item} type="button" className="topic-chip" onClick={() => setQuestionText(item)}>
                  {item}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="assist-control-button is-primary"
              disabled={isSubmitting}
              onClick={() => runAssistStream(questionText)}
            >
              {isSubmitting ? "生成中" : "手动生成"}
            </button>
          </div>
        </details>
      </section>

      <section className="assist-bottom-controls" aria-label="面试辅助控制">
        <button type="button" className="assist-control-button is-listen" onClick={startListening}>
          <span className="assist-control-icon" aria-hidden="true" />
          开始入房监听
        </button>
        <button type="button" className="assist-control-button" onClick={pauseListening}>
          暂停麦克风
        </button>
        <button type="button" className="assist-control-button" onClick={pauseListening}>
          停止推流
        </button>
        <div className="assist-timer">
          <span>稳定</span>
          <span className="assist-dot assist-dot-resume" />
          <strong>{formatDuration(elapsedSeconds)} / 02:00</strong>
        </div>
      </section>
    </main>
  );
}
