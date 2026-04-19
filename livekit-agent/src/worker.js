import { fileURLToPath } from "node:url";
import {
  AutoSubscribe,
  ServerOptions,
  WorkerPermissions,
  cli,
  defineAgent,
  inference,
} from "@livekit/agents";
import {
  Agent,
  AgentSession,
  AgentSessionEventTypes,
} from "../node_modules/@livekit/agents/dist/voice/index.js";
import { turnDetector } from "@livekit/agents-plugin-livekit";
import { VAD } from "@livekit/agents-plugin-silero";

const aiServiceUrl = process.env.AI_SERVICE_URL || "http://127.0.0.1:8000";
const livekitWsUrl = process.env.LIVEKIT_WS_URL || process.env.LIVEKIT_URL || "";
const livekitApiKey = process.env.LIVEKIT_API_KEY || "";
const livekitApiSecret = process.env.LIVEKIT_API_SECRET || "";
const livekitAgentName = process.env.LIVEKIT_AGENT_NAME || "interview-assist-agent";
const livekitSttModel = process.env.LIVEKIT_STT_MODEL || "deepgram/nova-3";
const livekitInferenceBaseUrl =
  process.env.LIVEKIT_INFERENCE_BASE_URL || process.env.LIVEKIT_INFERENCE_URL || "";

function toHttpUrl(url) {
  if (!url) {
    return "";
  }
  if (url.startsWith("https://") || url.startsWith("http://")) {
    return url;
  }
  if (url.startsWith("wss://")) {
    return `https://${url.slice("wss://".length)}`;
  }
  if (url.startsWith("ws://")) {
    return `http://${url.slice("ws://".length)}`;
  }
  return `https://${url}`;
}

function logAgent(event, payload = {}) {
  console.log(JSON.stringify({
    event,
    timestamp: Date.now(),
    ...payload,
  }));
}

async function publishEvent(participant, destinationIdentity, event, data, reliable = true) {
  if (!participant || !destinationIdentity) {
    return;
  }
  const payload = new TextEncoder().encode(JSON.stringify({ event, data }));
  await participant.publishData(payload, {
    reliable,
    destination_identities: [destinationIdentity],
    topic: "interview-assist",
  });
}

function parseSseEvent(rawEvent) {
  const lines = String(rawEvent || "").split(/\r?\n/);
  let event = "message";
  const dataLines = [];
  for (const line of lines) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }
  return {
    event,
    dataText: dataLines.join("\n"),
  };
}

async function relayAssistStream({ aiSessionId, questionText, destinationIdentity, room }) {
  const response = await fetch(`${aiServiceUrl}/api/interview-assist/answer-stream`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      sessionId: aiSessionId,
      questionText,
      questionEndedAt: Date.now(),
    }),
  });

  if (!response.ok || !response.body) {
    let data = {};
    try {
      data = await response.json();
    } catch {}
    throw new Error(data.error || data.detail || "Interview assist stream failed.");
  }

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
      const { event, dataText } = parseSseEvent(rawEvent);
      const data = dataText ? JSON.parse(dataText) : {};
      if (event !== "reply_status" && event !== "done") {
        await publishEvent(room.localParticipant, destinationIdentity, event, data);
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
}

const worker = defineAgent({
  prewarm: async (proc) => {
    logAgent("agent_prewarm_started");
    proc.userData.vad = await VAD.load();
    logAgent("agent_prewarm_completed");
  },
  entry: async (ctx) => {
    logAgent("agent_job_started", {
      jobId: ctx.job?.id,
      roomName: ctx.job?.room?.name,
      workerId: ctx.workerId,
    });
    await ctx.connect(undefined, AutoSubscribe.AUDIO_ONLY);
    logAgent("agent_room_connected", {
      roomName: ctx.room.name,
      localIdentity: ctx.room.localParticipant?.identity,
    });

    const participant = await ctx.waitForParticipant();
    const metadata = (() => {
      try {
        return participant.metadata ? JSON.parse(participant.metadata) : {};
      } catch {
        return {};
      }
    })();
    const aiSessionId = metadata.aiSessionId || "";
    const destinationIdentity = participant.identity;
    const sttBaseURL = livekitInferenceBaseUrl || toHttpUrl(livekitWsUrl);

    logAgent("agent_participant_linked", {
      aiSessionId,
      destinationIdentity,
      participantSid: participant.sid,
      trackPublications: Array.from(participant.trackPublications.values()).map((publication) => ({
        sid: publication.sid,
        kind: publication.kind,
        source: publication.source,
        subscribed: publication.isSubscribed,
        mimeType: publication.mimeType,
      })),
    });

    logAgent("agent_stt_config", {
      provider: "livekit-inference",
      model: livekitSttModel,
      baseURL: sttBaseURL,
      hasApiKey: Boolean(livekitApiKey),
      localLiveKitServer: /^https?:\/\/127\.0\.0\.1|^https?:\/\/localhost/.test(sttBaseURL),
      note: "Local livekit-server provides WebRTC rooms but not cloud STT inference. Configure LIVEKIT_INFERENCE_BASE_URL or a supported STT provider for transcription.",
    });

    const session = new AgentSession({
      vad: ctx.proc.userData.vad,
      stt: new inference.STT({
        model: livekitSttModel,
        baseURL: sttBaseURL,
        apiKey: livekitApiKey,
        apiSecret: livekitApiSecret,
      }),
      turnDetection: new turnDetector.MultilingualModel(),
    });

    let inFlight = false;

    session.on(AgentSessionEventTypes.UserInputTranscribed, async (ev) => {
      logAgent("agent_transcript", {
        aiSessionId,
        isFinal: ev.isFinal,
        transcriptChars: ev.transcript.length,
        language: ev.language,
      });
      await publishEvent(
        ctx.room.localParticipant,
        destinationIdentity,
        ev.isFinal ? "transcript_final" : "transcript_partial",
        {
          transcript: ev.transcript,
          isFinal: ev.isFinal,
          createdAt: ev.createdAt,
        },
        !ev.isFinal
      );
    });

    session.on(AgentSessionEventTypes.ConversationItemAdded, async (ev) => {
      if (ev.item.role !== "user") {
        return;
      }
      const questionText = ev.item.textContent?.trim();
      logAgent("agent_conversation_item_added", {
        aiSessionId,
        role: ev.item.role,
        textChars: questionText?.length || 0,
      });
      if (!questionText || !aiSessionId || inFlight) {
        return;
      }
      inFlight = true;
      try {
        logAgent("agent_turn_committed", {
          aiSessionId,
          questionChars: questionText.length,
        });
        await publishEvent(ctx.room.localParticipant, destinationIdentity, "turn_committed", {
          questionText,
          createdAt: ev.createdAt,
        });
        await relayAssistStream({
          aiSessionId,
          questionText,
          destinationIdentity,
          room: ctx.room,
        });
      } catch (error) {
        logAgent("agent_relay_error", {
          aiSessionId,
          error: error.message || String(error),
        });
        await publishEvent(ctx.room.localParticipant, destinationIdentity, "error", {
          error: error.message || "LiveKit agent relay failed.",
        });
      } finally {
        inFlight = false;
      }
    });

    session.on(AgentSessionEventTypes.Error, async (ev) => {
      const message = ev.error?.message || String(ev.error || "LiveKit Agent session error.");
      logAgent("agent_session_error", {
        aiSessionId,
        source: ev.source?.constructor?.name || "",
        error: message,
      });
      await publishEvent(ctx.room.localParticipant, destinationIdentity, "error", {
        error: `LiveKit Agent STT/turn detection error: ${message}`,
        source: ev.source?.constructor?.name || "",
      });
    });

    const agent = new Agent({
      instructions: "You are a silent voice capture agent. Do not speak. Only detect completed user turns.",
    });

    ctx.addShutdownCallback(async () => {
      await session.close();
    });

    await publishEvent(ctx.room.localParticipant, destinationIdentity, "agent_ready", {
      aiSessionId,
      participantIdentity: destinationIdentity,
      sttModel: livekitSttModel,
    });
    logAgent("agent_ready_published", {
      aiSessionId,
      destinationIdentity,
    });

    await session.start({
      room: ctx.room,
      agent,
      inputOptions: {
        participantIdentity: destinationIdentity,
        audioEnabled: true,
        textEnabled: false,
      },
      outputOptions: {
        audioEnabled: false,
        transcriptionEnabled: false,
      },
    });
  },
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cli.runApp(
    new ServerOptions({
      agent: fileURLToPath(import.meta.url),
      agentName: livekitAgentName,
      wsURL: livekitWsUrl,
      apiKey: livekitApiKey,
      apiSecret: livekitApiSecret,
      permissions: new WorkerPermissions(false, true, true, false),
    })
  );
}

export default worker;
