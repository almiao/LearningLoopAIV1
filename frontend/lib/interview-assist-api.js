const assistBaseUrl =
  process.env.NEXT_PUBLIC_INTERVIEW_ASSIST_API_BASE_URL || "http://127.0.0.1:8000";
const assistTransportBaseUrl =
  process.env.NEXT_PUBLIC_INTERVIEW_ASSIST_TRANSPORT_BASE_URL || "http://127.0.0.1:4200";

async function assistFetch(pathname, options = {}) {
  const response = await fetch(`${assistBaseUrl}${pathname}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
    },
    cache: "no-store",
  });

  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json")
    ? await response.json()
    : {};
  if (!response.ok) {
    throw new Error(data.error || data.detail || "Interview assist request failed");
  }
  return data;
}

export function getInterviewAssistBaseUrl() {
  return assistBaseUrl;
}

export function getInterviewAssistTransportBaseUrl() {
  return assistTransportBaseUrl;
}

export function getInterviewAssistWebSocketUrl(sessionId) {
  const base = assistBaseUrl.replace(/^http/, "ws");
  return `${base}/ws/interview-assist/${encodeURIComponent(sessionId)}`;
}

export async function createRealtimeSession(payload) {
  return assistFetch("/api/interview-assist/realtime-session", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
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
  const response = await fetch(`${assistTransportBaseUrl}/api/interview-assist/livekit-transport`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
    cache: "no-store",
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || data.detail || "Interview assist transport request failed");
  }
  return data;
}

export async function getLivekitRoomDebug(roomName) {
  const response = await fetch(`${assistTransportBaseUrl}/api/interview-assist/livekit-room-debug?roomName=${encodeURIComponent(roomName)}`, {
    method: "GET",
    cache: "no-store",
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || data.detail || "Interview assist room debug request failed");
  }
  return data;
}

export async function ackFirstScreenRendered(payload) {
  return assistFetch("/api/interview-assist/first-screen-rendered", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}
