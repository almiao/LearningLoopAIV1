import test from "node:test";
import assert from "node:assert/strict";
import { postJson, withSplitServices } from "../../helpers/split-services.js";

test("simple login creates a reusable user profile and aggregates target progress", async () => {
  await withSplitServices(null, async ({ bffBaseUrl }) => {
    const handle = `lee_backend_${Date.now()}`;

    const firstLogin = await postJson(`${bffBaseUrl}/api/auth/login`, {
      handle,
      pin: "1234"
    });

    assert.equal(firstLogin.profile.user.handle, handle);
    assert.equal(firstLogin.profile.summary.totalTargets, 0);

    const session = await postJson(`${bffBaseUrl}/api/interview/start-target`, {
      targetBaselineId: "bigtech-java-backend",
      interactionPreference: "balanced",
      userId: firstLogin.profile.user.id
    });

    const answered = await postJson(`${bffBaseUrl}/api/interview/answer`, {
      sessionId: session.sessionId,
      answer:
        "AQS 不是具体锁，它把获取失败后的排队、阻塞和唤醒逻辑抽成了同步器底座，ReentrantLock 是在这个框架上实现独占获取释放的。",
      burdenSignal: "normal",
      interactionPreference: "balanced"
    });

    assert.ok(answered.targetMatch.percentage > 0);

    const profileResponse = await fetch(`${bffBaseUrl}/api/profile/${firstLogin.profile.user.id}`);
    const profile = await profileResponse.json();
    assert.equal(profile.summary.totalTargets, 1);
    assert.ok(profile.summary.sessionsStarted >= 1);
    assert.equal(profile.targets[0].targetBaselineId, "bigtech-java-backend");
    assert.ok(profile.targets[0].completionPercentage >= 0);
    assert.ok(profile.targets[0].domains.length >= 1);
    assert.ok(profile.targets[0].domains[0].items.length >= 1);

    const secondLogin = await postJson(`${bffBaseUrl}/api/auth/login`, {
      handle,
      pin: "1234"
    });

    assert.equal(secondLogin.created, false);
    assert.equal(secondLogin.profile.user.id, firstLogin.profile.user.id);
    assert.equal(secondLogin.profile.targets[0].targetBaselineId, "bigtech-java-backend");
  });
});
