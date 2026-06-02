import { apiFetch, buildApiUrl, postEventStream, postJson } from "./api";

export function getLoopAssistOptions() {
  return apiFetch("/api/loopassist/options");
}

export function previewLoopAssistScope(scope) {
  return postJson("/api/loopassist/preview-scope", { scope });
}

export function getLoopAssistResumeVersions(userId) {
  return apiFetch(`/api/profile/resume-versions?userId=${encodeURIComponent(userId)}`);
}

export function saveLoopAssistResumeVersion(payload) {
  return postJson("/api/profile/resume-versions", payload);
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

export function reviewLoopAssistQuestion(payload) {
  return postJson("/api/loopassist/review-question", payload);
}

export function reviewLoopAssistSummary(payload) {
  return postJson("/api/loopassist/review-summary", payload);
}

export async function synthesizeLoopAssistSpeech(payload) {
  let response;
  try {
    response = await fetch(buildApiUrl("/api/loopassist/tts"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      cache: "no-store",
    });
  } catch {
    throw new Error("面试官语音暂时不可用，可以继续文字作答；稍后点“重播”再试。");
  }

  if (!response.ok) {
    let data = {};
    try {
      data = await response.json();
    } catch {}
    throw new Error(data.error || data.detail || "面试官语音生成失败。");
  }

  return response.blob();
}
