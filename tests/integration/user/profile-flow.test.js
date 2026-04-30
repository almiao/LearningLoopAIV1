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
    assert.equal(
      profile.summary.assessedAbilityItems,
      profile.summary.solidItems + profile.summary.partialItems + profile.summary.weakItems
    );
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

test("reading progress persists the last-read document and survives target updates", async () => {
  await withSplitServices(null, async ({ bffBaseUrl }) => {
    const handle = `reader_progress_${Date.now()}`;

    const login = await postJson(`${bffBaseUrl}/api/auth/login`, {
      handle,
      pin: "1234"
    });

    const targetBaselineId = "bigtech-java-backend";
    await postJson(`${bffBaseUrl}/api/profile/reading-progress`, {
      userId: login.profile.user.id,
      targetBaselineId,
      domainId: "spring-runtime",
      conceptId: "spring-transaction-boundary",
      docPath: "docs/system-design/framework/spring/spring-transaction.md",
      scrollRatio: 0.42,
      dwellMs: 12_000
    });

    let profileResponse = await fetch(`${bffBaseUrl}/api/profile/${login.profile.user.id}`);
    let profile = await profileResponse.json();
    assert.equal(profile.summary.totalTargets, 1);
    assert.equal(profile.targets[0].currentDomainId, "spring-runtime");
    assert.equal(profile.targets[0].currentDocPath, "docs/system-design/framework/spring/spring-transaction.md");
    assert.ok(profile.targets[0].currentDocTitle.length > 0);
    assert.equal(
      profile.targets[0].readingProgress.docs["docs/system-design/framework/spring/spring-transaction.md"].progressPercentage,
      42
    );
    assert.equal(
      profile.targets[0].readingDomains.find((domain) => domain.id === "spring-runtime")?.docs.find((doc) => doc.path === "docs/system-design/framework/spring/spring-transaction.md")?.progressLabel,
      "阅读中 42%"
    );
    assert.equal(
      profile.targets[0].readingDomains.find((domain) => domain.id === "spring-runtime")?.docs.find((doc) => doc.path === "docs/system-design/framework/spring/spring-transaction.md")?.masteryLabel,
      "未训练"
    );

    await postJson(`${bffBaseUrl}/api/profile/reading-progress`, {
      userId: login.profile.user.id,
      targetBaselineId,
      docPath: "docs/system-design/framework/spring/spring-transaction.md",
      scrollRatio: 0.95,
      dwellMs: 50_000
    });

    profileResponse = await fetch(`${bffBaseUrl}/api/profile/${login.profile.user.id}`);
    profile = await profileResponse.json();
    assert.equal(
      profile.targets[0].readingProgress.docs["docs/system-design/framework/spring/spring-transaction.md"].progressPercentage,
      100
    );
    assert.equal(
      profile.targets[0].readingDomains.find((domain) => domain.id === "spring-runtime")?.completedDocCount,
      1
    );

    const session = await postJson(`${bffBaseUrl}/api/interview/start-target`, {
      targetBaselineId,
      interactionPreference: "balanced",
      userId: login.profile.user.id
    });

    await postJson(`${bffBaseUrl}/api/interview/answer`, {
      sessionId: session.sessionId,
      answer: "事务是否生效，本质上取决于调用有没有经过 Spring 代理边界，自调用通常绕过代理，所以 @Transactional 会失效。",
      burdenSignal: "normal",
      interactionPreference: "balanced"
    });

    profileResponse = await fetch(`${bffBaseUrl}/api/profile/${login.profile.user.id}`);
    profile = await profileResponse.json();
    assert.equal(profile.targets[0].currentDocPath, "docs/system-design/framework/spring/spring-transaction.md");
    assert.ok(profile.targets[0].currentDocTitle.length > 0);
    assert.equal(profile.targets[0].domains.find((domain) => domain.id === "spring-runtime")?.currentDocPath, "docs/system-design/framework/spring/spring-transaction.md");
    assert.equal(
      profile.summary.assessedAbilityItems,
      profile.summary.solidItems + profile.summary.partialItems + profile.summary.weakItems
    );
  });
});

test("reading progress remembers a loaded document even without concept mapping", async () => {
  await withSplitServices(null, async ({ bffBaseUrl }) => {
    const handle = `reader_doc_only_${Date.now()}`;

    const login = await postJson(`${bffBaseUrl}/api/auth/login`, {
      handle,
      pin: "1234"
    });

    const targetBaselineId = "bigtech-java-backend";
    await postJson(`${bffBaseUrl}/api/profile/reading-progress`, {
      userId: login.profile.user.id,
      targetBaselineId,
      docPath: "docs/java/basis/bigdecimal.md",
      docTitle: "BigDecimal 详解"
    });

    const profileResponse = await fetch(`${bffBaseUrl}/api/profile/${login.profile.user.id}`);
    const profile = await profileResponse.json();

    assert.equal(profile.targets[0].currentDocPath, "docs/java/basis/bigdecimal.md");
    assert.equal(profile.targets[0].currentDocTitle, "BigDecimal 详解");
  });
});
