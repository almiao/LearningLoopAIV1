"use client";

import Link from "next/link";
import { Room, RoomEvent } from "livekit-client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ackFirstScreenRendered,
  createLivekitTransport,
  createRealtimeSession,
  getInterviewAssistBaseUrl,
  getLivekitRoomDebug,
  uploadVoiceDemo,
} from "../lib/interview-assist-api";

const statusLabels = {
  idle: "待开始",
  connecting: "连接中",
  listening: "实时识别中",
  paused: "已暂停",
  generating_skeleton: "框架生成中",
  first_screen_ready: "框架已就绪",
  error: "异常",
};

const starterQuestions = [
  "AQS 是什么？",
  "你项目里如何做限流？",
  "高并发下接口超时怎么排查？",
  "介绍一下你最近做的项目。",
];

const roleLabels = {
  candidate: "我在回答",
  interviewer: "我在提问",
};

const assistModeLabels = {
  assist_candidate: "辅导候选人",
  assist_interviewer: "辅助面试官",
};

function isPermissionDeniedError(error) {
  const text = String(error?.message || error || "").toLowerCase();
  return text.includes("permission denied") || text.includes("notallowederror");
}

function describeRealtimeStartError(error) {
  if (isPermissionDeniedError(error)) {
    return {
      message: "麦克风权限被拒绝。请先在浏览器中允许麦克风访问，然后重试；如果只是先验证回答链路，可以直接使用下方“手动输入（开发兜底）”。",
      debug: "浏览器拒绝了麦克风权限，请允许麦克风后再试，或改用手动输入继续全流程。",
    };
  }
  return {
    message: error?.message || "启动实时识别失败。",
    debug: `启动失败：${error?.message || "unknown"}`,
  };
}

function formatDuration(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function buildAnswerSections(answer) {
  const frameworkPoints = answer?.frameworkPoints || [];
  const detailBlocks = answer?.detailBlocks || [];
  return frameworkPoints.map((point, index) => ({
    title: `${String(index + 1).padStart(2, "0")} | ${point}`,
    detail: detailBlocks[index] || "细节正在继续展开。",
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

function floatTo16BitPCM(float32Array) {
  const pcmBuffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(pcmBuffer);
  let offset = 0;
  for (let index = 0; index < float32Array.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, float32Array[index]));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += 2;
  }
  return pcmBuffer;
}

function downsampleBuffer(buffer, inputSampleRate, outputSampleRate) {
  if (outputSampleRate >= inputSampleRate) {
    return buffer;
  }
  const sampleRateRatio = inputSampleRate / outputSampleRate;
  const newLength = Math.round(buffer.length / sampleRateRatio);
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i += 1) {
      accum += buffer[i];
      count += 1;
    }
    result[offsetResult] = accum / count;
    offsetResult += 1;
    offsetBuffer = nextOffsetBuffer;
  }
  return result;
}

export function InterviewAssistWorkspace() {
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");
  const [session, setSession] = useState(null);
  const [questionText, setQuestionText] = useState("");
  const [transcriptPreview, setTranscriptPreview] = useState("");
  const [currentAnswer, setCurrentAnswer] = useState(null);
  const [history, setHistory] = useState([]);
  const [isExpanding, setIsExpanding] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [selfRole, setSelfRole] = useState("interviewer");
  const [mode, setMode] = useState("assist_candidate");
  const [voiceDemoFile, setVoiceDemoFile] = useState(null);
  const [resumeText, setResumeText] = useState("");
  const [voiceDemoUploaded, setVoiceDemoUploaded] = useState(false);
  const [isUploadingVoiceDemo, setIsUploadingVoiceDemo] = useState(false);
  const [socketConnected, setSocketConnected] = useState(false);
  const [transportState, setTransportState] = useState("idle");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [transportDebug, setTransportDebug] = useState("待开始");
  const [roomDebugSnapshot, setRoomDebugSnapshot] = useState("");
  const [volumeLevel, setVolumeLevel] = useState(0);
  const [recordedAudioUrl, setRecordedAudioUrl] = useState("");
  const [recordingStatus, setRecordingStatus] = useState("未录音");

  const roomRef = useRef(null);
  const ackedTurnRef = useRef("");
  const audioMonitorTimerRef = useRef(null);
  const transcriptSeenRef = useRef(false);
  const settingsPanelRef = useRef(null);
  const monitorStreamRef = useRef(null);
  const monitorAudioContextRef = useRef(null);
  const monitorAnalyserRef = useRef(null);
  const monitorAnimationRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const recordedChunksRef = useRef([]);
  const manualEntryRef = useRef(null);

  function cleanupTransport() {
    if (audioMonitorTimerRef.current) {
      window.clearTimeout(audioMonitorTimerRef.current);
      audioMonitorTimerRef.current = null;
    }
    const room = roomRef.current;
    roomRef.current = null;
    if (room) {
      room.localParticipant?.setMicrophoneEnabled?.(false).catch(() => {});
      room.disconnect();
    }
    if (monitorAnimationRef.current) {
      window.cancelAnimationFrame(monitorAnimationRef.current);
      monitorAnimationRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    mediaRecorderRef.current = null;
    monitorStreamRef.current?.getTracks?.().forEach((track) => track.stop());
    monitorStreamRef.current = null;
    monitorAnalyserRef.current = null;
    monitorAudioContextRef.current?.close?.().catch?.(() => {});
    monitorAudioContextRef.current = null;
    setVolumeLevel(0);
    setTransportState("idle");
    setTransportDebug("传输已清理");
  }

  function revealManualFallback() {
    const details = manualEntryRef.current;
    if (!details) {
      return;
    }
    details.open = true;
    details.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  useEffect(() => {
    return () => {
      cleanupTransport();
      if (recordedAudioUrl) {
        URL.revokeObjectURL(recordedAudioUrl);
      }
    };
  }, [recordedAudioUrl]);

  useEffect(() => {
    if (!isSettingsOpen) {
      return undefined;
    }

    function handlePointerDown(event) {
      if (settingsPanelRef.current?.contains(event.target)) {
        return;
      }
      setIsSettingsOpen(false);
    }

    function handleEscape(event) {
      if (event.key === "Escape") {
        setIsSettingsOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isSettingsOpen]);

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

  const answerSections = useMemo(() => buildAnswerSections(currentAnswer), [currentAnswer]);

  function applyAssistEvent(event, data) {
    if (event === "agent_ready") {
      setTransportState("connected");
      setTransportDebug("服务端音频桥接已就绪");
      setSocketConnected(true);
      setStatus("listening");
      return;
    }
    if (event === "transcript_partial" || event === "transcript_final") {
      transcriptSeenRef.current = true;
      setTranscriptPreview(data.transcript || "");
      return;
    }
    if (event === "turn_committed") {
      ackedTurnRef.current = "";
      setCurrentAnswer(createEmptyAnswer(data.questionText || "", session?.sessionId || ""));
      setStatus("generating_skeleton");
      setIsExpanding(false);
      return;
    }
    if (event === "framework_delta") {
      setCurrentAnswer((prev) => {
        const base = prev || createEmptyAnswer(data.questionText || transcriptPreview, session?.sessionId || "");
        const frameworkPoints = [...(base.frameworkPoints || [])];
        frameworkPoints[data.index] = data.point;
        const detailBlocks = [...(base.detailBlocks || [])];
        while (detailBlocks.length < frameworkPoints.length) {
          detailBlocks.push("");
        }
        return { ...base, questionText: data.questionText || base.questionText, frameworkPoints, detailBlocks };
      });
      return;
    }
    if (event === "framework_done") {
      setCurrentAnswer((prev) => ({
        ...(prev || createEmptyAnswer(data.questionText, data.sessionId)),
        ...data,
        detailBlocks: prev?.detailBlocks || new Array((data.frameworkPoints || []).length).fill(""),
      }));
      setStatus("first_screen_ready");
      return;
    }
    if (event === "detail_start") {
      setIsExpanding(true);
      return;
    }
    if (event === "detail_delta") {
      setCurrentAnswer((prev) => {
        const base = prev || createEmptyAnswer("", session?.sessionId || "");
        const detailBlocks = [...(base.detailBlocks || [])];
        detailBlocks[data.index] = `${detailBlocks[data.index] || ""}${data.delta || ""}`;
        return { ...base, detailBlocks };
      });
      return;
    }
    if (event === "detail_done") {
      setCurrentAnswer((prev) => {
        const base = prev || createEmptyAnswer("", session?.sessionId || "");
        const detailBlocks = [...(base.detailBlocks || [])];
        detailBlocks[data.index] = data.detail || detailBlocks[data.index] || "";
        return { ...base, detailBlocks };
      });
      return;
    }
    if (event === "answer_ready") {
      setCurrentAnswer(data);
      setHistory((items) => [data, ...items].slice(0, 3));
      setIsExpanding(false);
      return;
    }
    if (event === "error") {
      const nextError = data.error || "实时识别失败。";
      setError(nextError);
      setTransportState("error");
      if (String(nextError).includes("NO_VALID_AUDIO_ERROR")) {
        setTransportDebug("LiveKit 音频已经送达，但阿里云判定音频无效，正在继续调格式。");
      } else {
        setTransportDebug(`服务端错误：${nextError}`);
      }
      setStatus("error");
    }
  }

  async function createSessionAndUploadVoiceDemo() {
    setError("");
    const nextSession = await createRealtimeSession({
      selfRole,
      mode,
      resumeText: selfRole === "candidate" ? resumeText : "",
    });
    setSession(nextSession);

    if (voiceDemoFile) {
      setIsUploadingVoiceDemo(true);
      try {
        await uploadVoiceDemo({
          sessionId: nextSession.sessionId,
          file: voiceDemoFile,
        });
        setVoiceDemoUploaded(true);
      } finally {
        setIsUploadingVoiceDemo(false);
      }
    } else {
      setVoiceDemoUploaded(false);
    }
    return nextSession;
  }

  async function startVolumeMonitor() {
    if (monitorStreamRef.current) {
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    const audioContext = new AudioContextCtor();
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }

    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.82;

    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);

    const sampleBuffer = new Uint8Array(analyser.fftSize);
    const updateLevel = () => {
      analyser.getByteTimeDomainData(sampleBuffer);
      let sumSquares = 0;
      for (let index = 0; index < sampleBuffer.length; index += 1) {
        const normalized = (sampleBuffer[index] - 128) / 128;
        sumSquares += normalized * normalized;
      }
      const rms = Math.sqrt(sumSquares / sampleBuffer.length);
      const nextLevel = Math.min(1, rms * 4.5);
      setVolumeLevel(nextLevel);
      monitorAnimationRef.current = window.requestAnimationFrame(updateLevel);
    };

    monitorStreamRef.current = stream;
    monitorAudioContextRef.current = audioContext;
    monitorAnalyserRef.current = analyser;
    monitorAnimationRef.current = window.requestAnimationFrame(updateLevel);

    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported("audio/webm")) {
      recordedChunksRef.current = [];
      if (recordedAudioUrl) {
        URL.revokeObjectURL(recordedAudioUrl);
        setRecordedAudioUrl("");
      }
      const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          recordedChunksRef.current.push(event.data);
        }
      };
      recorder.onstop = () => {
        if (!recordedChunksRef.current.length) {
          setRecordingStatus("未录到有效音频");
          return;
        }
        const blob = new Blob(recordedChunksRef.current, { type: recorder.mimeType || "audio/webm" });
        const nextUrl = URL.createObjectURL(blob);
        setRecordedAudioUrl((previousUrl) => {
          if (previousUrl) {
            URL.revokeObjectURL(previousUrl);
          }
          return nextUrl;
        });
        setRecordingStatus("已生成本地录音，可回放");
      };
      recorder.start(250);
      mediaRecorderRef.current = recorder;
      setRecordingStatus("录音中");
    } else {
      setRecordingStatus("当前环境不支持录音回放");
    }
  }

  async function startListening() {
    try {
      setError("");
      setStatus("connecting");
      setTransportState("connecting");
      setTransportDebug("创建会话");
      await startVolumeMonitor();
      const activeSession = await createSessionAndUploadVoiceDemo();
      setIsSettingsOpen(false);
      setTransportDebug("申请 LiveKit 传输信息");
      const transport = await createLivekitTransport({ sessionId: activeSession.sessionId });
      if (!transport.livekitConfigured || !transport.participantToken || !transport.livekitUrl) {
        throw new Error("LiveKit 传输层未配置完成。");
      }

      const room = new Room();
      roomRef.current = room;
      transcriptSeenRef.current = false;
      setRoomDebugSnapshot("");
      setTransportDebug("准备连接 LiveKit 房间");

      room.on(RoomEvent.DataReceived, (payload, participant, kind, topic) => {
        if (topic !== "interview-assist") {
          return;
        }
        try {
          const parsed = JSON.parse(new TextDecoder().decode(payload));
          if (parsed?.event) {
            applyAssistEvent(parsed.event, parsed.data || {});
          }
        } catch {}
      });

      room.on(RoomEvent.Connected, () => {
        setTransportState("room-connected");
        setTransportDebug("房间已连接，等待麦克风发布");
      });

      room.on(RoomEvent.ConnectionStateChanged, (nextState) => {
        setTransportDebug(`连接状态：${String(nextState)}`);
      });

      room.on(RoomEvent.MediaDevicesError, (nextError) => {
        setError(nextError?.message || "麦克风设备异常。");
        setTransportState("error");
        setTransportDebug(`设备错误：${nextError?.message || "unknown"}`);
        setStatus("error");
      });

      room.on(RoomEvent.LocalTrackPublished, (publication) => {
        setTransportState("track-published");
        setTransportDebug(`本地音轨已发布：${publication?.source || publication?.kind || "audio"}`);
      });

      room.on(RoomEvent.Disconnected, () => {
        setSocketConnected(false);
        cleanupTransport();
        setStatus((current) => (current === "error" ? current : "paused"));
      });

      await room.connect(transport.livekitUrl, transport.participantToken);
      setSocketConnected(true);
      setTransportState("room-connected");
      setTransportDebug("正在打开麦克风");
      await room.localParticipant.setMicrophoneEnabled(true);
      setTransportState("track-published");
      setTransportDebug("麦克风已启用，等待服务端转写");
      setElapsedSeconds(0);
      audioMonitorTimerRef.current = window.setTimeout(() => {
        if (!transcriptSeenRef.current) {
          setError("LiveKit 已连通，但 8 秒内仍未收到转写结果。正在检查服务端音频桥接。");
          setTransportState("stalled");
          setTransportDebug("8 秒内没有收到转写，正在核对房间音轨和 ASR 状态");
          setStatus("error");
          getLivekitRoomDebug(transport.roomName)
            .then((snapshot) => {
              const participants = snapshot.participants || [];
              const summary = participants
                .map((participant) => `${participant.identity}:${(participant.tracks || []).length} tracks`)
                .join(" | ");
              const hasPublishedTrack = participants.some((participant) => (participant.tracks || []).length > 0);
              setRoomDebugSnapshot(
                hasPublishedTrack
                  ? `房间里已经看到了音轨，当前更像是 ASR 侧还没返回文本。${summary ? ` ${summary}` : ""}`.trim()
                  : summary || "房间里还没有可见参与者/音轨。",
              );
            })
            .catch((nextError) => {
              setRoomDebugSnapshot(`拉取房间诊断失败：${nextError.message || "unknown"}`);
            });
        }
      }, 8000);
    } catch (nextError) {
      cleanupTransport();
      const nextState = describeRealtimeStartError(nextError);
      setError(nextState.message);
      setTransportState("error");
      setTransportDebug(nextState.debug);
      setStatus("error");
      if (isPermissionDeniedError(nextError)) {
        revealManualFallback();
      }
    }
  }

  function pauseListening() {
    cleanupTransport();
    setSocketConnected(false);
    setStatus("paused");
  }

  async function runManualAssist() {
    if (!questionText.trim()) {
      setError("请先输入问题。");
      return;
    }
    try {
      setError("");
      setIsSubmitting(true);
      setStatus("generating_skeleton");
      const baseUrl = getInterviewAssistBaseUrl();
      const response = await fetch(`${baseUrl}/api/interview-assist/answer-stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: session?.sessionId || (await createRealtimeSession({ selfRole, mode, resumeText })).sessionId,
          questionText,
          questionEndedAt: Date.now(),
        }),
      });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const rawEvent = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const lines = rawEvent.split(/\r?\n/);
          const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() || "message";
          const dataText = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
          applyAssistEvent(event, dataText ? JSON.parse(dataText) : {});
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch (nextError) {
      setError(nextError.message || "手动生成失败。");
      setStatus("error");
    } finally {
      setIsSubmitting(false);
    }
  }

  const statusLabel = statusLabels[status] || status;
  const frameworkSummary = currentAnswer?.frameworkPoints?.length
    ? currentAnswer.frameworkPoints.join("；")
    : "等待识别到完整问题。";
  const questionLabel =
    currentAnswer?.questionText || transcriptPreview || questionText || "等待实时识别返回文本。";
  const settingsSummary = `${roleLabels[selfRole]} · ${assistModeLabels[mode]}${voiceDemoFile ? " · 有语音样本" : ""}`;
  const transportStateLabel = {
    idle: "音频未连接",
    connecting: "正在连接音频",
    "room-connected": "音频房间已连上",
    "track-published": "麦克风已接入",
    connected: "实时音频已连接",
    stalled: "音频转写超时",
    error: "音频连接失败",
  }[transportState] || "音频未连接";
  const transportStateDot = {
    idle: "connecting",
    connecting: "connecting",
    "room-connected": "connecting",
    "track-published": "connecting",
    connected: "listening",
    stalled: "error",
    error: "error",
  }[transportState] || "connecting";
  const volumePercent = Math.round(volumeLevel * 100);

  return (
    <main className="interview-assist-shell">
      <header className="interview-assist-topbar">
        <div className="assist-brand-block">
          <Link className="assist-brand-title" href="/">LoopAssist</Link>
          <p>实时听题，整理可直接开口的回答提纲。</p>
        </div>

        <Link className="assist-page-name" href="/learn">返回学习页</Link>

        <div className="assist-header-actions">
          <div className="assist-settings-anchor" ref={settingsPanelRef}>
            <button
              type="button"
              className="assist-settings-button"
              onClick={() => setIsSettingsOpen((value) => !value)}
              aria-expanded={isSettingsOpen}
              aria-haspopup="dialog"
            >
              设置
            </button>
            {isSettingsOpen ? (
              <section className="assist-settings-panel" role="dialog" aria-label="会前配置">
                <div className="assist-settings-panel-head">
                  <div>
                    <strong>会前配置</strong>
                    <p>默认按候选人视角给回答建议，语音样本可选。</p>
                  </div>
                  <button
                    type="button"
                    className="assist-settings-close"
                    onClick={() => setIsSettingsOpen(false)}
                    aria-label="关闭设置"
                  >
                    ×
                  </button>
                </div>

                <div className="assist-settings-group">
                  <h3>我的角色</h3>
                  <div className="assist-chip-row">
                    <button type="button" className={selfRole === "candidate" ? "topic-chip topic-chip-dark" : "topic-chip"} onClick={() => setSelfRole("candidate")}>我在回答</button>
                    <button type="button" className={selfRole === "interviewer" ? "topic-chip topic-chip-dark" : "topic-chip"} onClick={() => setSelfRole("interviewer")}>我在提问</button>
                  </div>
                </div>

                <div className="assist-settings-group">
                  <h3>辅导方向</h3>
                  <div className="assist-chip-row">
                    <button type="button" className={mode === "assist_candidate" ? "topic-chip topic-chip-dark" : "topic-chip"} onClick={() => setMode("assist_candidate")}>辅导候选人</button>
                    <button type="button" className={mode === "assist_interviewer" ? "topic-chip topic-chip-dark" : "topic-chip"} onClick={() => setMode("assist_interviewer")}>辅助面试官</button>
                  </div>
                </div>

                <div className="assist-settings-group">
                  <h3>语音样本（可选）</h3>
                  <input
                    type="file"
                    accept="audio/*"
                    onChange={(event) => {
                      setVoiceDemoFile(event.target.files?.[0] || null);
                      setVoiceDemoUploaded(false);
                    }}
                  />
                  <p>{voiceDemoFile ? `已选择：${voiceDemoFile.name}` : "不上传也可以直接开始实时识别。"}</p>
                </div>

                {selfRole === "candidate" ? (
                  <div className="assist-settings-group">
                    <h3>简历文本（可选）</h3>
                    <textarea
                      value={resumeText}
                      onChange={(event) => setResumeText(event.target.value)}
                      placeholder="可直接粘贴简历文本，供回答建议参考。"
                    />
                  </div>
                ) : null}
              </section>
            ) : null}
          </div>

          <div className="assist-status-pill" aria-live="polite">
            <span className={`assist-dot assist-dot-${status}`} />
            <span>{statusLabel}</span>
          </div>
          <div className="assist-status-pill">
            <span className="assist-dot assist-dot-connecting" />
            <span>{settingsSummary}</span>
          </div>
          <div className="assist-status-pill">
            <span className={`assist-dot assist-dot-${transportStateDot}`} />
            <span>{transportStateLabel}</span>
          </div>
        </div>
      </header>

      {error ? <section className="feedback-banner error-banner assist-error-banner">{error}</section> : null}

      <div className="assist-live-workspace">
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
          <p className="assist-key-summary">
            {currentAnswer?.frameworkPoints?.length
              ? (isExpanding ? "框架已完整，正在逐点展开细节。" : "框架已就绪，可先按这 3 个点组织口头回答。")
              : "系统先听清问题，再整理回答提纲。"}
          </p>

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
                  <h3>01 | 实时转写</h3>
                  <p>浏览器持续上传音频片段，云端返回临时和完整转写。</p>
                </article>
                <article className="assist-answer-section">
                  <h3>02 | 完整问题触发分析</h3>
                  <p>一句完整问题出现后，自动触发回答提纲和细节建议。</p>
                </article>
              </>
            )}
          </div>
        </section>

        <aside className="assist-recognition-panel">
          <div className="assist-recognition-header">
            <h2>实时识别</h2>
            <div className="assist-recognition-badges">
              <span className="assist-mini-pill">
                <span className={`assist-dot assist-dot-${voiceDemoUploaded ? "listening" : "connecting"}`} />
                {voiceDemoUploaded ? "样本已上传" : "可加语音样本"}
              </span>
              <span className="assist-mini-pill">
                <span className="assist-dot assist-dot-voice" />
                {socketConnected ? "流式识别中" : "等待连接"}
              </span>
            </div>
          </div>

          <div className="assist-transcript-stream">
            <span>面试官原声转写</span>
            <strong>{transcriptPreview || "等待云端实时 ASR 返回识别内容。"}</strong>
          </div>

          <div className="assist-bottom-controls" aria-label="面试辅助控制">
            <button type="button" className="assist-control-button is-listen" onClick={startListening} disabled={isUploadingVoiceDemo}>
              <span className="assist-control-icon" aria-hidden="true" />
              {isUploadingVoiceDemo ? "上传 demo 中" : "开始实时识别"}
            </button>
            <button type="button" className="assist-control-button" onClick={pauseListening}>
              停止识别
            </button>
            <div className="assist-timer">
              <span>稳定</span>
              <span className="assist-dot assist-dot-resume" />
              <strong>{formatDuration(elapsedSeconds)} / 02:00</strong>
            </div>
          </div>

          <div className="assist-volume-row">
            <span>音量</span>
            <div className="assist-volume-meter" aria-label="实时音量">
              <span style={{ width: `${volumePercent}%` }} />
            </div>
            <strong>{volumePercent}%</strong>
          </div>
          <div className="assist-recording-row">
            <span>录音</span>
            {recordedAudioUrl ? <audio controls src={recordedAudioUrl} /> : <strong>{recordingStatus}</strong>}
          </div>
          <p className="assist-transport-debug">状态：{transportDebug}</p>
          {roomDebugSnapshot ? <p className="assist-transport-debug">诊断：{roomDebugSnapshot}</p> : null}

          <details className="assist-manual-entry" ref={manualEntryRef}>
            <summary>手动输入问题</summary>
            <div className="assist-manual-body">
              <textarea
                value={questionText}
                onChange={(event) => setQuestionText(event.target.value)}
                placeholder="也可以直接粘贴面试官问题。"
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
                onClick={runManualAssist}
              >
                {isSubmitting ? "生成中" : "手动生成"}
              </button>
            </div>
          </details>
          {isPermissionDeniedError(error) ? (
            <p className="assist-transport-debug">
              麦克风权限当前不可用，建议先允许浏览器麦克风，或者直接展开上面的手动输入继续验证整条回答链路。
            </p>
          ) : null}
        </aside>
      </div>
    </main>
  );
}
