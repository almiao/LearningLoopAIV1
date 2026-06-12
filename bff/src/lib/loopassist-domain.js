import { selectLoopAssistSeeds } from "../../../src/loopassist/corpus.js";
import { getLatestResumeVersion } from "../../../src/user/resume-version-store.js";
import { serializeSseEvent, withStreamHeaders } from "./http-utils.js";
import { getUserProfile } from "./profile-domain.js";
import { aiServiceUrl, proxyJson } from "./service-proxy.js";
import { practicePassthrough } from "./stores.js";

export function recordLoopAssistPracticeRounds(review = {}) {
  const reviews = Array.isArray(review?.questionReviews) ? review.questionReviews : [];
  for (const item of reviews) {
    const question = String(item?.questionText || "").trim();
    const answer = String(item?.answerText || "").trim();
    if (!question || !answer) {
      continue;
    }
    void practicePassthrough({
      handle: String(item.objective || item.topic || "").trim(),
      question,
      answer,
      sourceRef: String(item.sourceLabel || "").trim(),
    });
  }
}

export async function handleLoopAssistStart(body) {
  let scope = body.scope || {};
  if (!String(scope.resumeText || "").trim() && body.userId && body.useLatestStoredResume !== false) {
    const user = await getUserProfile(body.userId);
    const latestResumeVersion = getLatestResumeVersion(user.resumeLibrary);
    if (latestResumeVersion?.text) {
      scope = {
        ...scope,
        resumeText: latestResumeVersion.text,
      };
    }
  }
  const seeds = selectLoopAssistSeeds(scope);
  const { data, traceId } = await proxyJson("POST", "/api/loopassist/start", {
    ...body,
    scope,
    seeds,
  });
  return {
    ...data,
    traceId,
  };
}

export async function handleLoopAssistStream(body, response) {
  const upstream = await fetch(`${aiServiceUrl}/api/loopassist/answer-stream`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!upstream.ok || !upstream.body) {
    const rawText = await upstream.text();
    let data;
    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch {
      data = { error: rawText || "Downstream LoopAssist stream failed." };
    }
    throw new Error(data.detail || data.error || "Downstream LoopAssist stream failed.");
  }

  withStreamHeaders(response, 200);
  const traceId = upstream.headers.get("x-trace-id") || "";
  if (traceId) {
    response.write(serializeSseEvent("trace", { traceId }));
  }

  for await (const chunk of upstream.body) {
    response.write(chunk);
  }
  response.end();
}
