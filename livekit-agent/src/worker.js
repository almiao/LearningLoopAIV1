import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { AutoSubscribe, ServerOptions, WorkerPermissions, cli, defineAgent } from "@livekit/agents";
import { AudioStream, RoomEvent, TrackKind } from "@livekit/rtc-node";

const aiServiceUrl = process.env.AI_SERVICE_URL || "http://127.0.0.1:8000";
const livekitWsUrl = process.env.LIVEKIT_WS_URL || process.env.LIVEKIT_URL || "";
const livekitApiKey = process.env.LIVEKIT_API_KEY || "";
const livekitApiSecret = process.env.LIVEKIT_API_SECRET || "";
const livekitAgentName = process.env.LIVEKIT_AGENT_NAME || "interview-assist-agent";
const capturedAudioDir = process.env.INTERVIEW_ASSIST_CAPTURE_DIR || ".omx/interview-assist/captured-audio";

function logAgent(event, payload = {}) {
  console.log(JSON.stringify({
    event,
    timestamp: Date.now(),
    ...payload,
  }));
}

function audioFrameStats(int16Samples) {
  if (!int16Samples?.length) {
    return {
      sampleCount: 0,
      peak: 0,
      rms: 0,
      nonZero: 0,
    };
  }

  let peak = 0;
  let sumSquares = 0;
  let nonZero = 0;
  for (let index = 0; index < int16Samples.length; index += 1) {
    const value = int16Samples[index] || 0;
    const absValue = Math.abs(value);
    if (absValue > 0) {
      nonZero += 1;
    }
    if (absValue > peak) {
      peak = absValue;
    }
    sumSquares += value * value;
  }

  return {
    sampleCount: int16Samples.length,
    peak,
    rms: Math.round(Math.sqrt(sumSquares / int16Samples.length)),
    nonZero,
  };
}

function int16ToLittleEndianBuffer(int16Samples) {
  const buffer = Buffer.allocUnsafe(int16Samples.length * 2);
  for (let index = 0; index < int16Samples.length; index += 1) {
    buffer.writeInt16LE(int16Samples[index] || 0, index * 2);
  }
  return buffer;
}

function wavHeader({ dataSize, sampleRate, channels, bitsPerSample }) {
  const header = Buffer.alloc(44);
  const blockAlign = channels * bitsPerSample / 8;
  const byteRate = sampleRate * blockAlign;
  header.write("RIFF", 0, 4, "ascii");
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8, 4, "ascii");
  header.write("fmt ", 12, 4, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, 4, "ascii");
  header.writeUInt32LE(dataSize, 40);
  return header;
}

async function persistCapturedAudioCase({ sessionId, pcmChunks }) {
  if (!pcmChunks.length) {
    return null;
  }
  await mkdir(capturedAudioDir, { recursive: true });
  const pcmBuffer = Buffer.concat(pcmChunks);
  const pcmPath = path.join(capturedAudioDir, `${sessionId}.pcm`);
  const wavPath = path.join(capturedAudioDir, `${sessionId}.wav`);
  const metaPath = path.join(capturedAudioDir, `${sessionId}.json`);
  const wavBuffer = Buffer.concat([
    wavHeader({
      dataSize: pcmBuffer.byteLength,
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
    }),
    pcmBuffer,
  ]);

  await Promise.all([
    writeFile(pcmPath, pcmBuffer),
    writeFile(wavPath, wavBuffer),
    writeFile(metaPath, JSON.stringify({
      sessionId,
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
      bytes: pcmBuffer.byteLength,
      createdAt: new Date().toISOString(),
    }, null, 2)),
  ]);

  return {
    pcmPath,
    wavPath,
    metaPath,
    bytes: pcmBuffer.byteLength,
  };
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

function parseParticipantMetadata(participant) {
  try {
    return participant?.metadata ? JSON.parse(participant.metadata) : {};
  } catch {
    return {};
  }
}

function aiRealtimeWsUrl(sessionId) {
  return `${aiServiceUrl.replace(/^http/, "ws")}/ws/interview-assist/${encodeURIComponent(sessionId)}`;
}

function decodeEventData(raw) {
  if (typeof raw === "string") {
    return raw;
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw).toString("utf8");
  }
  if (ArrayBuffer.isView(raw)) {
    return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("utf8");
  }
  if (raw instanceof Blob) {
    return raw.text();
  }
  return String(raw || "");
}

async function openAiRelay({ sessionId, room, destinationIdentity, relayState }) {
  const ws = new WebSocket(aiRealtimeWsUrl(sessionId));
  relayState.ws = ws;

  ws.binaryType = "arraybuffer";

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out connecting to AI realtime websocket.")), 10000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("Failed to connect to AI realtime websocket."));
    };
  });

  ws.onmessage = async (message) => {
    try {
      const raw = await decodeEventData(message.data);
      const parsed = JSON.parse(raw);
      logAgent("agent_ai_event", {
        sessionId,
        relayEvent: parsed.event,
      });
      if (parsed.event === "error") {
        relayState.stopped = true;
      }
      await publishEvent(
        room.localParticipant,
        destinationIdentity,
        parsed.event,
        parsed.data || {},
        parsed.event !== "transcript_partial",
      );
    } catch (error) {
      logAgent("agent_ai_event_parse_error", {
        sessionId,
        error: error.message || String(error),
      });
    }
  };

  ws.onclose = async () => {
    relayState.closed = true;
    logAgent("agent_ai_ws_closed", { sessionId });
  };

  ws.onerror = async () => {
    logAgent("agent_ai_ws_error", { sessionId });
    await publishEvent(room.localParticipant, destinationIdentity, "error", {
      error: "AI realtime relay websocket disconnected.",
    });
  };

  return ws;
}

async function stopAiRelay(relayState) {
  relayState.stopped = true;
  if (relayState.reader) {
    try {
      await relayState.reader.cancel();
    } catch {}
    relayState.reader = null;
  }
  if (relayState.ws && relayState.ws.readyState === WebSocket.OPEN) {
    try {
      relayState.ws.send(JSON.stringify({ event: "stop" }));
    } catch {}
    relayState.ws.close();
  }
  relayState.ws = null;
}

async function bridgeTrackToAi({ track, room, sessionId, destinationIdentity, relayState }) {
  if (relayState.started) {
    return;
  }
  relayState.started = true;
  relayState.stopped = false;
  const capturedPcmChunks = [];

  logAgent("agent_audio_bridge_started", {
    sessionId,
    trackSid: track.sid,
  });

  try {
    const ws = await openAiRelay({ sessionId, room, destinationIdentity, relayState });
    const stream = new AudioStream(track, {
      sampleRate: 16000,
      numChannels: 1,
      frameSizeMs: 20,
    });
    const reader = stream.getReader();
    relayState.reader = reader;

    let frameIndex = 0;
    let pendingChunks = [];
    let pendingFrameCount = 0;
    let batchIndex = 0;

    const flushPending = (force = false) => {
      if (!pendingChunks.length) {
        return null;
      }
      const totalBytes = pendingChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      if (!force && totalBytes < 1024) {
        return null;
      }
      const payload = Buffer.concat(pendingChunks, totalBytes);
      pendingChunks = [];
      pendingFrameCount = 0;
      return payload;
    };

    while (!relayState.stopped) {
      const { done, value } = await reader.read();
      if (done || !value) {
        break;
      }
      if (ws.readyState !== WebSocket.OPEN || relayState.stopped) {
        break;
      }

      const pcmBytes = int16ToLittleEndianBuffer(value.data);
      if (!pcmBytes.byteLength) {
        continue;
      }
      frameIndex += 1;
      pendingChunks.push(pcmBytes);
      pendingFrameCount += 1;
      if (frameIndex <= 5 || frameIndex % 50 === 0) {
        const stats = audioFrameStats(value.data);
        logAgent("agent_audio_frame_forwarded", {
          sessionId,
          frameIndex,
          bytes: pcmBytes.byteLength,
          sampleRate: value.sampleRate,
          channels: value.channels,
          samplesPerChannel: value.samplesPerChannel,
          peak: stats.peak,
          rms: stats.rms,
          nonZero: stats.nonZero,
        });
      }
      if (pendingFrameCount >= 5) {
        const payload = flushPending();
        if (payload) {
          batchIndex += 1;
          capturedPcmChunks.push(payload);
          logAgent("agent_audio_batch_sent", {
            sessionId,
            batchIndex,
            bytes: payload.byteLength,
            frameCount: 5,
          });
          ws.send(payload);
        }
      }
    }

    const finalPayload = flushPending(true);
    if (finalPayload && ws.readyState === WebSocket.OPEN && !relayState.stopped) {
      batchIndex += 1;
      capturedPcmChunks.push(finalPayload);
      logAgent("agent_audio_batch_sent", {
        sessionId,
        batchIndex,
        bytes: finalPayload.byteLength,
        frameCount: pendingFrameCount || undefined,
        final: true,
      });
      ws.send(finalPayload);
    }

    const persistedCase = await persistCapturedAudioCase({
      sessionId,
      pcmChunks: capturedPcmChunks,
    });
    if (persistedCase) {
      logAgent("agent_audio_case_saved", {
        sessionId,
        pcmPath: persistedCase.pcmPath,
        wavPath: persistedCase.wavPath,
        bytes: persistedCase.bytes,
      });
    }
  } catch (error) {
      logAgent("agent_audio_bridge_error", {
        sessionId,
        error: error.message || String(error),
      });
    await publishEvent(room.localParticipant, destinationIdentity, "error", {
      error: error.message || "LiveKit audio relay failed.",
    });
  } finally {
    const persistedCase = await persistCapturedAudioCase({
      sessionId,
      pcmChunks: capturedPcmChunks,
    }).catch((error) => {
      logAgent("agent_audio_case_save_error", {
        sessionId,
        error: error.message || String(error),
      });
      return null;
    });
    if (persistedCase) {
      logAgent("agent_audio_case_saved", {
        sessionId,
        pcmPath: persistedCase.pcmPath,
        wavPath: persistedCase.wavPath,
        bytes: persistedCase.bytes,
      });
    }
    await stopAiRelay(relayState);
  }
}

const worker = defineAgent({
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

    ctx.room.on(RoomEvent.ParticipantConnected, (remoteParticipant) => {
      logAgent("agent_participant_connected", {
        roomName: ctx.room.name,
        participantIdentity: remoteParticipant.identity,
        metadata: remoteParticipant.metadata || "",
        publicationCount: remoteParticipant.trackPublications.size,
      });
    });

    ctx.room.on(RoomEvent.TrackPublished, (publication, remoteParticipant) => {
      logAgent("agent_track_published", {
        participantIdentity: remoteParticipant.identity,
        trackSid: publication?.sid,
        source: publication?.source,
        kind: publication?.kind,
        subscribed: publication?.subscribed,
      });
      if (publication?.kind === TrackKind.KIND_AUDIO && !publication?.subscribed) {
        publication.setSubscribed(true);
        logAgent("agent_track_subscribe_requested", {
          participantIdentity: remoteParticipant.identity,
          trackSid: publication?.sid,
          reason: "track_published",
        });
      }
    });

    ctx.room.on(RoomEvent.TrackSubscribed, (track, publication, remoteParticipant) => {
      logAgent("agent_track_subscribed", {
        participantIdentity: remoteParticipant.identity,
        trackSid: publication?.sid,
        source: publication?.source,
        kind: publication?.kind,
      });
    });

    ctx.room.on(RoomEvent.TrackSubscriptionFailed, (trackSid, remoteParticipant, reason) => {
      logAgent("agent_track_subscription_failed", {
        participantIdentity: remoteParticipant.identity,
        trackSid,
        reason: reason || "",
      });
    });

    const participant = await ctx.waitForParticipant();
    const metadata = parseParticipantMetadata(participant);
    const sessionId = metadata.aiSessionId || "";
    const destinationIdentity = participant.identity;
    logAgent("agent_participant_ready", {
      participantIdentity: participant.identity,
      metadata,
      publicationCount: participant.trackPublications.size,
    });
    const relayState = {
      started: false,
      stopped: false,
      closed: false,
      ws: null,
      reader: null,
    };

    const maybeBridgeTrack = async (track, publication, remoteParticipant) => {
      logAgent("agent_bridge_track_seen", {
        sessionId,
        participantIdentity: remoteParticipant.identity,
        publicationSid: publication?.sid,
        kind: publication?.kind ?? track?.kind,
        source: publication?.source,
        hasTrack: Boolean(track),
      });
      if (remoteParticipant.identity !== destinationIdentity) {
        return;
      }
      const kind = publication?.kind ?? track?.kind;
      if (kind !== TrackKind.KIND_AUDIO) {
        logAgent("agent_bridge_track_skipped_non_audio", {
          sessionId,
          participantIdentity: remoteParticipant.identity,
          kind,
        });
        return;
      }
      await bridgeTrackToAi({
        track,
        room: ctx.room,
        sessionId,
        destinationIdentity,
        relayState,
      });
    };

    ctx.room.on(RoomEvent.TrackSubscribed, maybeBridgeTrack);

    for (const publication of participant.trackPublications.values()) {
      logAgent("agent_existing_publication", {
        participantIdentity: participant.identity,
        publicationSid: publication.sid,
        source: publication.source,
        kind: publication.kind,
        hasTrack: Boolean(publication.track),
      });
      if (publication.kind === TrackKind.KIND_AUDIO && !publication.subscribed) {
        publication.setSubscribed(true);
        logAgent("agent_track_subscribe_requested", {
          participantIdentity: participant.identity,
          trackSid: publication.sid,
          reason: "existing_publication",
        });
      }
      if (publication.track) {
        void maybeBridgeTrack(publication.track, publication, participant);
      }
    }

    let resolveDone;
    const donePromise = new Promise((resolve) => {
      resolveDone = resolve;
    });

    ctx.room.on(RoomEvent.ParticipantDisconnected, (remoteParticipant) => {
      if (remoteParticipant.identity === destinationIdentity) {
        resolveDone();
      }
    });

    ctx.addShutdownCallback(async () => {
      await stopAiRelay(relayState);
      resolveDone();
    });

    await donePromise;
  },
});

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes("start")) {
  cli.runApp(
    new ServerOptions({
      agent: fileURLToPath(import.meta.url),
      agentName: livekitAgentName,
      wsURL: livekitWsUrl,
      apiKey: livekitApiKey,
      apiSecret: livekitApiSecret,
      permissions: new WorkerPermissions(false, true, true, false),
    }),
  );
}

export default worker;
