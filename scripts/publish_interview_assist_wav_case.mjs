#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import {
  AudioFrame,
  AudioSource,
  LocalAudioTrack,
  Room,
  TrackPublishOptions,
  TrackSource,
} from "../livekit-agent/node_modules/@livekit/rtc-node/dist/index.js";

const aiBaseUrl = process.env.AI_BASE_URL || "http://127.0.0.1:8000";
const transportBaseUrl = process.env.TRANSPORT_BASE_URL || "http://127.0.0.1:4200";

function findChunk(buffer, chunkId) {
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (id === chunkId) {
      return { start, end, size };
    }
    offset = end + (size % 2);
  }
  return null;
}

function parsePcmWav(buffer) {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Expected RIFF/WAVE input.");
  }

  const fmt = findChunk(buffer, "fmt ");
  const data = findChunk(buffer, "data");
  if (!fmt || !data) {
    throw new Error("WAV file is missing fmt/data chunks.");
  }

  const audioFormat = buffer.readUInt16LE(fmt.start + 0);
  const channels = buffer.readUInt16LE(fmt.start + 2);
  const sampleRate = buffer.readUInt32LE(fmt.start + 4);
  const bitsPerSample = buffer.readUInt16LE(fmt.start + 14);

  if (audioFormat !== 1) {
    throw new Error(`Only PCM WAV is supported, got format=${audioFormat}`);
  }
  if (channels !== 1 || bitsPerSample !== 16) {
    throw new Error(`Expected mono 16-bit WAV, got channels=${channels} bits=${bitsPerSample}`);
  }

  const sampleCount = data.size / 2;
  const samples = new Int16Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = buffer.readInt16LE(data.start + index * 2);
  }

  return {
    sampleRate,
    channels,
    samples,
  };
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`${url}: ${data.error || data.detail || response.status}`);
  }
  return data;
}

async function publishWavCase(casePath) {
  const wavBuffer = await fs.readFile(casePath);
  const wav = parsePcmWav(wavBuffer);

  const session = await postJson(`${aiBaseUrl}/api/interview-assist/realtime-session`, {
    selfRole: "interviewer",
    mode: "assist_candidate",
    resumeText: "",
  });
  const transport = await postJson(`${transportBaseUrl}/api/interview-assist/livekit-transport`, {
    sessionId: session.sessionId,
  });

  const room = new Room();
  await room.connect(transport.livekitUrl, transport.participantToken, {
    autoSubscribe: true,
    dynacast: false,
  });

  const source = new AudioSource(wav.sampleRate, wav.channels);
  const track = LocalAudioTrack.createAudioTrack(path.basename(casePath), source);
  const options = new TrackPublishOptions();
  options.source = TrackSource.SOURCE_MICROPHONE;
  await room.localParticipant.publishTrack(track, options);

  const samplesPerFrame = Math.floor(wav.sampleRate / 50);
  for (let offset = 0; offset < wav.samples.length; offset += samplesPerFrame) {
    const frameSamples = wav.samples.slice(offset, offset + samplesPerFrame);
    const frame = AudioFrame.create(wav.sampleRate, wav.channels, frameSamples.length);
    frame.data.set(frameSamples);
    await source.captureFrame(frame);
  }

  await source.waitForPlayout();
  await new Promise((resolve) => setTimeout(resolve, 3000));
  await room.disconnect();

  return {
    sessionId: session.sessionId,
    roomName: transport.roomName,
    transportIdentity: transport.participantIdentity,
  };
}

const casePath = process.argv[2];
if (!casePath) {
  console.error("Usage: node scripts/publish_interview_assist_wav_case.mjs <wav-path>");
  process.exit(1);
}

publishWavCase(casePath)
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
