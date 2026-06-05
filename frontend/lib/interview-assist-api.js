import { apiFetch, buildApiUrl, postJson } from "./api";

async function assistFetch(pathname, options = {}) {
  return apiFetch(pathname, {
    ...options,
    headers: {
      ...(options.headers || {}),
    },
  });
}

export function getInterviewAssistBaseUrl() {
  return buildApiUrl("/api/interview-assist/realtime-session").replace(/\/api\/interview-assist\/realtime-session$/, "");
}

export function getInterviewAssistTransportBaseUrl() {
  return buildApiUrl("/api/interview-assist/livekit-transport").replace(/\/api\/interview-assist\/livekit-transport$/, "");
}

export async function createRealtimeSession(payload) {
  return postJson("/api/interview-assist/realtime-session", payload);
}

export async function uploadVoiceDemo({ sessionId, file }) {
  const formData = new FormData();
  formData.append("file", file);
  return assistFetch(`/api/interview-assist/voice-demo?sessionId=${encodeURIComponent(sessionId)}`, {
    method: "POST",
    body: formData,
  });
}

export async function createLivekitTransport(payload) {
  return postJson("/api/interview-assist/livekit-transport", payload);
}

export async function ackFirstScreenRendered(payload) {
  return postJson("/api/interview-assist/first-screen-rendered", payload);
}
