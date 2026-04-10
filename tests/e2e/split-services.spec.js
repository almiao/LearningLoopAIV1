import test from "node:test";
import assert from "node:assert/strict";
import { postJson, withSplitServices } from "../helpers/split-services.js";

test("split BFF -> AI main flow is runnable", async () => {
  await withSplitServices(null, async ({ bffBaseUrl }) => {
    const loginResponse = await fetch(`${bffBaseUrl}/api/auth/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        handle: `split_e2e_${Date.now()}`,
        pin: "1234"
      })
    });
    const login = await loginResponse.json();
    assert.equal(loginResponse.ok, true);

    const baselinesResponse = await fetch(`${bffBaseUrl}/api/baselines`);
    const baselines = await baselinesResponse.json();
    assert.equal(baselinesResponse.ok, true);
    assert.ok(baselines.baselines.length >= 1);

    const session = await postJson(`${bffBaseUrl}/api/interview/start-target`, {
      userId: login.profile.user.id,
      targetBaselineId: baselines.baselines[0].id,
      interactionPreference: "balanced"
    });
    assert.ok(session.sessionId);
    assert.ok(session.currentProbe.length > 0);

    const answered = await postJson(`${bffBaseUrl}/api/interview/answer`, {
      sessionId: session.sessionId,
      answer: "AQS 通过同步状态、队列和阻塞唤醒来承接独占获取释放。",
      burdenSignal: "normal",
      interactionPreference: "balanced"
    });
    assert.ok(answered.targetMatch.percentage > 0);

    const profileResponse = await fetch(`${bffBaseUrl}/api/profile/${login.profile.user.id}`);
    const profile = await profileResponse.json();
    assert.equal(profileResponse.ok, true);
    assert.equal(profile.summary.totalTargets, 1);
  });
});
