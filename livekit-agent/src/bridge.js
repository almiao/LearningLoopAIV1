import { AccessToken } from "livekit-server-sdk";
import { AudioStream, Room, RoomEvent, TrackKind } from "@livekit/rtc-node";

const livekitApiKey = process.env.LIVEKIT_API_KEY || "";
const livekitApiSecret = process.env.LIVEKIT_API_SECRET || "";
const speechRmsThreshold = Number(process.env.INTERVIEW_ASSIST_SPEECH_RMS_THRESHOLD || 120);
const speechPeakThreshold = Number(process.env.INTERVIEW_ASSIST_SPEECH_PEAK_THRESHOLD || 900);
const silenceFramesToStop = Number(process.env.INTERVIEW_ASSIST_SILENCE_FRAMES_TO_STOP || 0);
const relayCompletionTimeoutMs = Number(process.env.INTERVIEW_ASSIST_RELAY_COMPLETION_TIMEOUT_MS || 15000);

function logBridge(event, payload = {}) {
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

export function shouldStopAfterSilence({ speechDetected, silenceFrameCount, threshold = silenceFramesToStop }) {
  return threshold > 0 && speechDetected && silenceFrameCount >= threshold;
}

async function publishEvent(room, destinationIdentity, event, data, reliable = true) {
  if (!room?.localParticipant || !destinationIdentity) {
    return;
  }
  const payload = new TextEncoder().encode(JSON.stringify({ event, data }));
  await room.localParticipant.publishData(payload, {
    reliable,
    destination_identities: [destinationIdentity],
    topic: "interview-assist",
  });
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

export function shouldPublishRelayDisconnect(relayState, ws) {
  if (!relayState || relayState.stopped || relayState.closed) {
    return false;
  }
  if (!ws) {
    return true;
  }
  return ws.readyState !== WebSocket.CLOSING && ws.readyState !== WebSocket.CLOSED;
}

function resolveRelayCompletionWaiters(relayState) {
  const waiters = relayState?.completionWaiters || [];
  relayState.completionWaiters = [];
  for (const resolve of waiters) {
    resolve();
  }
}

export function markRelayAiEvent(relayState, event) {
  if (!relayState || !event) {
    return;
  }
  relayState.lastAiEvent = event;
  if (event === "transcript_partial" || event === "transcript_final") {
    relayState.transcriptSeen = true;
  }
  if (event === "turn_committed") {
    relayState.turnCommittedSeen = true;
  }
  if (event === "answer_ready" || event === "error") {
    relayState.answerDone = true;
    resolveRelayCompletionWaiters(relayState);
  }
}

export function shouldWaitForRelayCompletion(relayState) {
  return Boolean(
    relayState
      && !relayState.closed
      && !relayState.answerDone
      && (relayState.transcriptSeen || relayState.turnCommittedSeen),
  );
}

export async function waitForRelayCompletion(relayState, { timeoutMs = relayCompletionTimeoutMs } = {}) {
  if (!shouldWaitForRelayCompletion(relayState)) {
    return;
  }
  await new Promise((resolve) => {
    let waiter;
    const finish = () => {
      relayState.completionWaiters = relayState.completionWaiters.filter((item) => item !== waiter);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    waiter = () => {
      clearTimeout(timer);
      finish();
    };
    relayState.completionWaiters.push(waiter);
  });
}

function aiRealtimeWsUrl(aiServiceUrl, sessionId) {
  return `${aiServiceUrl.replace(/^http/, "ws")}/ws/interview-assist/${encodeURIComponent(sessionId)}`;
}

function createBridgeToken({ roomName, bridgeIdentity, bridgeName }) {
  const token = new AccessToken(livekitApiKey, livekitApiSecret, {
    identity: bridgeIdentity,
    name: bridgeName,
  });
  token.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: false,
    canSubscribe: true,
    canPublishData: true,
  });
  return token.toJwt();
}

const bridges = new Map();

async function openAiRelay({ aiServiceUrl, sessionId, room, destinationIdentity, relayState }) {
  const ws = new WebSocket(aiRealtimeWsUrl(aiServiceUrl, sessionId));
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
      logBridge("bridge_ai_event", {
        sessionId,
        relayEvent: parsed.event,
      });
      markRelayAiEvent(relayState, parsed.event);
      if (parsed.event === "error") {
        relayState.stopped = true;
      }
      await publishEvent(
        room,
        destinationIdentity,
        parsed.event,
        parsed.data || {},
        parsed.event !== "transcript_partial",
      );
    } catch (error) {
      logBridge("bridge_ai_event_parse_error", {
        sessionId,
        error: error.message || String(error),
      });
    }
  };

  ws.onclose = () => {
    relayState.closed = true;
    resolveRelayCompletionWaiters(relayState);
    logBridge("bridge_ai_ws_closed", { sessionId });
  };

  ws.onerror = async () => {
    logBridge("bridge_ai_ws_error", { sessionId });
    if (!shouldPublishRelayDisconnect(relayState, ws)) {
      return;
    }
    await publishEvent(room, destinationIdentity, "error", {
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
    await waitForRelayCompletion(relayState);
  }
  if (relayState.ws && relayState.ws.readyState !== WebSocket.CLOSED) {
    relayState.ws.close();
  }
  relayState.ws = null;
}

async function bridgeTrackToAi({ aiServiceUrl, track, room, sessionId, destinationIdentity, relayState }) {
  if (relayState.started) {
    return;
  }
  relayState.started = true;
  relayState.stopped = false;

  logBridge("bridge_audio_started", {
    sessionId,
    trackSid: track.sid,
  });

  try {
    const ws = await openAiRelay({ aiServiceUrl, sessionId, room, destinationIdentity, relayState });
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
    let speechDetected = false;
    let silenceFrameCount = 0;

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
      const stats = audioFrameStats(value.data);
      const isSpeechFrame = stats.rms >= speechRmsThreshold || stats.peak >= speechPeakThreshold;
      if (isSpeechFrame) {
        speechDetected = true;
        silenceFrameCount = 0;
      } else if (speechDetected) {
        silenceFrameCount += 1;
      }
      if (frameIndex <= 5 || frameIndex % 50 === 0) {
        logBridge("bridge_audio_frame", {
          sessionId,
          frameIndex,
          bytes: pcmBytes.byteLength,
          sampleRate: value.sampleRate,
          channels: value.channels,
          samplesPerChannel: value.samplesPerChannel,
          peak: stats.peak,
          rms: stats.rms,
          nonZero: stats.nonZero,
          silenceFrameCount,
          speechDetected,
        });
      }
      if (pendingFrameCount >= 5) {
        const payload = flushPending();
        if (payload) {
          batchIndex += 1;
          logBridge("bridge_audio_batch_sent", {
            sessionId,
            batchIndex,
            bytes: payload.byteLength,
            frameCount: 5,
          });
          ws.send(payload);
        }
      }

      if (shouldStopAfterSilence({ speechDetected, silenceFrameCount })) {
        logBridge("bridge_silence_stop_triggered", {
          sessionId,
          frameIndex,
          silenceFrameCount,
        });
        relayState.stopped = true;
      }
    }

    const finalPayload = flushPending(true);
    if (finalPayload && ws.readyState === WebSocket.OPEN && !relayState.stopped) {
      batchIndex += 1;
      logBridge("bridge_audio_batch_sent", {
        sessionId,
        batchIndex,
        bytes: finalPayload.byteLength,
        frameCount: pendingFrameCount || undefined,
        final: true,
      });
      ws.send(finalPayload);
    }
  } catch (error) {
    logBridge("bridge_audio_error", {
      sessionId,
      error: error.message || String(error),
    });
    await publishEvent(room, destinationIdentity, "error", {
      error: error.message || "LiveKit audio relay failed.",
    });
  } finally {
    await stopAiRelay(relayState);
  }
}

function createBridgeState({ aiServiceUrl, wsUrl, roomName, sessionId, participantIdentity }) {
  const room = new Room();
  const bridgeIdentity = `bridge_${sessionId.slice(-8)}`;
  const relayState = {
    started: false,
    stopped: false,
    closed: false,
    transcriptSeen: false,
    turnCommittedSeen: false,
    answerDone: false,
    lastAiEvent: "",
    completionWaiters: [],
    ws: null,
    reader: null,
  };
  return {
    aiServiceUrl,
    wsUrl,
    roomName,
    sessionId,
    participantIdentity,
    bridgeIdentity,
    status: "initializing",
    lastError: "",
    room,
    relayState,
    startPromise: null,
  };
}

async function maybeBridgePublication(bridge, participant, publication) {
  if (!participant || participant.identity !== bridge.participantIdentity) {
    return;
  }
  if (publication?.kind === TrackKind.KIND_AUDIO && !publication?.subscribed) {
    publication.setSubscribed(true);
    logBridge("bridge_track_subscribe_requested", {
      sessionId: bridge.sessionId,
      participantIdentity: participant.identity,
      trackSid: publication.sid,
      reason: "publication_seen",
    });
  }
  if (publication?.track) {
    await bridgeTrackToAi({
      aiServiceUrl: bridge.aiServiceUrl,
      track: publication.track,
      room: bridge.room,
      sessionId: bridge.sessionId,
      destinationIdentity: bridge.participantIdentity,
      relayState: bridge.relayState,
    });
  }
}

async function startBridge(bridge) {
  bridge.status = "connecting";
  const token = await createBridgeToken({
    roomName: bridge.roomName,
    bridgeIdentity: bridge.bridgeIdentity,
    bridgeName: "Interview Assist Bridge",
  });

  bridge.room.on(RoomEvent.Connected, () => {
    bridge.status = "room-connected";
    logBridge("bridge_room_connected", {
      sessionId: bridge.sessionId,
      roomName: bridge.roomName,
      localIdentity: bridge.bridgeIdentity,
    });
  });

  bridge.room.on(RoomEvent.ParticipantConnected, (participant) => {
    logBridge("bridge_participant_connected", {
      sessionId: bridge.sessionId,
      participantIdentity: participant.identity,
      publicationCount: participant.trackPublications.size,
    });
    for (const publication of participant.trackPublications.values()) {
      void maybeBridgePublication(bridge, participant, publication);
    }
  });

  bridge.room.on(RoomEvent.TrackPublished, (publication, participant) => {
    logBridge("bridge_track_published", {
      sessionId: bridge.sessionId,
      participantIdentity: participant.identity,
      trackSid: publication?.sid,
      source: publication?.source,
      kind: publication?.kind,
      subscribed: publication?.subscribed,
    });
    void maybeBridgePublication(bridge, participant, publication);
  });

  bridge.room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
    logBridge("bridge_track_subscribed", {
      sessionId: bridge.sessionId,
      participantIdentity: participant.identity,
      trackSid: publication?.sid,
      source: publication?.source,
      kind: publication?.kind,
    });
    void bridgeTrackToAi({
      aiServiceUrl: bridge.aiServiceUrl,
      track,
      room: bridge.room,
      sessionId: bridge.sessionId,
      destinationIdentity: bridge.participantIdentity,
      relayState: bridge.relayState,
    });
  });

  bridge.room.on(RoomEvent.TrackSubscriptionFailed, (trackSid, participant, reason) => {
    bridge.lastError = reason || "subscription failed";
    logBridge("bridge_track_subscription_failed", {
      sessionId: bridge.sessionId,
      participantIdentity: participant.identity,
      trackSid,
      reason: reason || "",
    });
  });

  bridge.room.on(RoomEvent.ParticipantDisconnected, (participant) => {
    if (participant.identity === bridge.participantIdentity) {
      bridge.status = "participant-disconnected";
      void closeBridge(bridge.roomName);
    }
  });

  bridge.room.on(RoomEvent.Disconnected, () => {
    bridge.status = "disconnected";
    bridges.delete(bridge.roomName);
  });

  await bridge.room.connect(bridge.wsUrl, token, {
    autoSubscribe: true,
    dynacast: false,
  });

  for (const participant of bridge.room.remoteParticipants.values()) {
    if (participant.identity === bridge.participantIdentity) {
      for (const publication of participant.trackPublications.values()) {
        await maybeBridgePublication(bridge, participant, publication);
      }
    }
  }

  bridge.status = "ready";
}

export async function ensureBridge({ aiServiceUrl, wsUrl, roomName, sessionId, participantIdentity }) {
  let bridge = bridges.get(roomName);
  if (bridge) {
    return bridge;
  }
  bridge = createBridgeState({ aiServiceUrl, wsUrl, roomName, sessionId, participantIdentity });
  bridges.set(roomName, bridge);
  bridge.startPromise = startBridge(bridge).catch((error) => {
    bridge.status = "error";
    bridge.lastError = error.message || String(error);
    logBridge("bridge_start_error", {
      sessionId,
      roomName,
      error: bridge.lastError,
    });
    return bridge;
  });
  await bridge.startPromise;
  return bridge;
}

export async function closeBridge(roomName) {
  const bridge = bridges.get(roomName);
  if (!bridge) {
    return;
  }
  bridges.delete(roomName);
  try {
    await stopAiRelay(bridge.relayState);
  } catch {}
  try {
    await bridge.room.disconnect();
  } catch {}
}
