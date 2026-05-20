import { apiFetch, buildApiUrl, postEventStream, postJson } from "./api";

export function getLoopAssistOptions() {
  return apiFetch("/api/loopassist/options");
}

export function previewLoopAssistScope(scope) {
  return postJson("/api/loopassist/preview-scope", { scope });
}

export function startLoopAssist(payload) {
  return postJson("/api/loopassist/start", payload);
}

export function answerLoopAssist(payload) {
  return postJson("/api/loopassist/answer", payload);
}

export function streamLoopAssistAnswer(payload, onEvent, options = {}) {
  return postEventStream("/api/loopassist/answer-stream", payload, onEvent, options);
}

export function reviewLoopAssist(payload) {
  return postJson("/api/loopassist/review", payload);
}

export async function synthesizeLoopAssistSpeech(payload) {
  const response = await fetch(buildApiUrl("/api/loopassist/tts"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
    cache: "no-store",
  });

  if (!response.ok) {
    let data = {};
    try {
      data = await response.json();
    } catch {}
    throw new Error(data.error || data.detail || "面试官语音生成失败。");
  }

  return response.blob();
}
