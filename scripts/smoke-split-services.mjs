const bffBaseUrl = process.env.BFF_BASE_URL || "http://127.0.0.1:4000";
const frontendBaseUrl = process.env.FRONTEND_BASE_URL || "http://127.0.0.1:3000";

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`${url} -> ${data.error || data.detail || response.status}`);
  }
  return data;
}

const login = await fetchJson(`${bffBaseUrl}/api/auth/login`, {
  method: "POST",
  headers: {
    "content-type": "application/json"
  },
  body: JSON.stringify({
    handle: `smoke_${Date.now()}`,
    pin: "1234"
  })
});

const baselines = await fetchJson(`${bffBaseUrl}/api/baselines`);
const targetBaselineId = baselines.baselines?.[0]?.id;
if (!targetBaselineId) {
  throw new Error("No baseline available for smoke test.");
}

const session = await fetchJson(`${bffBaseUrl}/api/interview/start-target`, {
  method: "POST",
  headers: {
    "content-type": "application/json"
  },
  body: JSON.stringify({
    userId: login.profile.user.id,
    targetBaselineId,
    interactionPreference: "balanced"
  })
});

const answered = await fetchJson(`${bffBaseUrl}/api/interview/answer`, {
  method: "POST",
  headers: {
    "content-type": "application/json"
  },
  body: JSON.stringify({
    sessionId: session.sessionId,
    answer: "AQS 通过同步状态、队列和阻塞唤醒来承接独占获取释放。",
    burdenSignal: "normal",
    interactionPreference: "balanced"
  })
});

const profile = await fetchJson(`${bffBaseUrl}/api/profile/${login.profile.user.id}`);
const frontendHome = await fetch(frontendBaseUrl);
const frontendHtml = await frontendHome.text();
if (!frontendHome.ok) {
  throw new Error(`Frontend smoke failed with status ${frontendHome.status}`);
}
if (!/Learning Loop AI/.test(frontendHtml)) {
  throw new Error("Frontend smoke failed: homepage copy missing.");
}

console.log(JSON.stringify({
  ok: true,
  userId: login.profile.user.id,
  sessionId: session.sessionId,
  currentProbe: answered.currentProbe,
  targetCount: profile.summary.totalTargets,
  frontendTitleMatched: true
}, null, 2));
