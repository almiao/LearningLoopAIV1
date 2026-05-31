import { expect, test } from "@playwright/test";

async function mockLoopAssistSetup(page, options = {}) {
  let startPayload = null;
  await page.route("**/api/loopassist/options", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        roles: [{ label: "软件开发 / Java", value: "软件开发 / Java", count: 12 }],
        rounds: [{ label: "一面", value: "一面", count: 12 }],
        topics: [{ label: "并发", value: "并发", count: 8 }, { label: "项目", value: "项目", count: 6 }],
        companyStyles: [{ label: "淘天", value: "淘天", count: 4 }],
        interviewStyles: [{ label: "真实还原", value: "realistic" }],
        counts: { reports: 12, seeds: 24 },
      }),
    });
  });
  await page.route("**/api/loopassist/preview-scope", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        matchedCount: 8,
        warnings: [],
        sampleSeeds: [{ seedId: "s1", baseQuestion: "AQS 的底层实现原理是什么？", topics: ["并发"] }],
      }),
    });
  });
  await page.route("**/api/loopassist/start", async (route) => {
    startPayload = route.request().postDataJSON();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        sessionId: "loop-e2e",
        scope: {},
        transcript: [{ turnId: "t1", role: "interviewer", text: "我们先聊 AQS 的底层实现原理。", createdAt: Date.now() }],
        interviewerMessage: { text: "我们先聊 AQS 的底层实现原理。", topic: "并发", seedId: "s1" },
        interviewPlan: {
          title: "Java 一面并发模拟",
          rationale: "根据候选人简历、目标岗位 JD 和真实面经题源，先验证并发基础再追项目证据。",
          sourceExplanation: "题目来源于用户选择的 Java 一面面经，并结合上传的简历和 JD 调整顺序。",
          stages: [
            {
              step: 1,
              theme: "并发基础",
              objective: "确认候选人能讲清 AQS 的核心机制。",
              source: "真实面经题源 + JD",
            },
          ],
        },
        remainingBudget: 5,
      }),
    });
  });
  await page.route("**/api/loopassist/tts", async (route) => {
    if (options.tts) {
      await options.tts(route);
      return;
    }
    await route.fulfill({
      contentType: "audio/wav",
      body: Buffer.from(
        "UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAABErAAABAAgAZGF0YQAAAAA=",
        "base64",
      ),
    });
  });
  await page.route("**/api/interview-assist/realtime-session", async (route) => {
    await route.abort("failed");
  });
  await page.route("**/api/loopassist/review", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        sessionId: "loop-e2e",
        transcript: [],
        review: {
          readinessScore: 72,
          summary: "回答方向正确，但需要补项目细节。",
          strengths: ["能说出核心机制"],
          weaknesses: ["缺少线上排查细节"],
          likelyFollowups: ["怎么定位线程阻塞？"],
          practicalNextSteps: ["准备一个线程池排查案例"],
          nextRecommendedScope: "并发专项追问",
        },
      }),
    });
  });
  await page.route("**/api/loopassist/answer-stream", async (route) => {
    await route.fulfill({
      contentType: "text/event-stream",
      body: [
        "event: session",
        `data: ${JSON.stringify({
          sessionId: "loop-e2e",
          scope: {},
          transcript: [
            { turnId: "t1", role: "interviewer", text: "我们先聊 AQS 的底层实现原理。", createdAt: Date.now() },
            { turnId: "c1", role: "candidate", text: "AQS 主要通过 state 和 CLH 队列实现同步。", createdAt: Date.now() },
            { turnId: "t2", role: "interviewer", text: "那公平锁和非公平锁有什么区别？", createdAt: Date.now() },
          ],
          interviewerMessage: { text: "那公平锁和非公平锁有什么区别？", topic: "并发", seedId: "s2" },
          interviewPlan: {
            stages: [{ step: 1, theme: "并发基础", objective: "确认候选人能讲清 AQS 的核心机制。", source: "真实面经题源 + JD" }],
          },
          remainingBudget: 4,
        })}`,
        "",
      ].join("\n"),
    });
  });

  return {
    getStartPayload: () => startPayload,
  };
}

async function prepareLoopAssistInterview(page) {
  await page.goto("/loopassist");
  await expect(page.getByTestId("loopassist-shell")).not.toContainText("即时回答支架");
  await expect(page.getByTestId("loopassist-shell")).not.toContainText("本轮节奏");
  await expect(page.getByTestId("loopassist-resume-text")).toBeVisible();
  await expect(page.getByTestId("loopassist-jd-text")).not.toBeVisible();
  await expect(page.getByTestId("loopassist-start")).toContainText("通用");
  await page.getByTestId("loopassist-resume-text").fill("负责订单系统 Redis 缓存一致性和接口隔离。");
  await expect(page.getByTestId("loopassist-start")).toContainText("贴合你");
  await expect(page.getByTestId("loopassist-shell")).toContainText("已检测到简历，题目将围绕你的项目追问");
  await page.getByTestId("loopassist-toggle-jd").click();
  await page.getByTestId("loopassist-jd-text").fill("Java 后端岗位，要求分布式系统和服务治理经验。");
  await expect(page.getByTestId("loopassist-preview")).toContainText("AQS");
  await page.getByTestId("loopassist-start").click();
  await expect(page.getByTestId("loopassist-plan")).toContainText("大纲");
  await expect(page.getByTestId("loopassist-plan")).toContainText("确认候选人能讲清 AQS");
  await expect(page.getByTestId("loopassist-plan")).toContainText("真实面经题源 + JD");
  await expect(page.getByTestId("loopassist-plan")).toContainText("开始面试");
}

test("LoopAssist keeps voice focused and offers a weak text fallback", async ({ page }) => {
  const setup = await mockLoopAssistSetup(page);

  await prepareLoopAssistInterview(page);
  expect(setup.getStartPayload().scope.resumeText).toContain("Redis 缓存一致性");
  expect(setup.getStartPayload().scope.jobDescription).toContain("分布式系统");
  await page.getByTestId("loopassist-start-interview").click();
  await expect(page.getByTestId("loopassist-transcript")).toContainText("我们先聊 AQS");
  const historyButton = page.locator(".loopassist-history-button");
  await historyButton.click();
  await expect(historyButton).toHaveClass(/is-active/);
  await expect(page.locator(".loopassist-history-drawer")).toHaveClass(/is-open/);
  const readHistoryLayout = () => page.evaluate(() => {
    const shell = document.querySelector("[data-testid='loopassist-shell']");
    const backdrop = document.querySelector(".loopassist-history-backdrop");
    const drawer = document.querySelector(".loopassist-history-drawer");
    return {
      shellPaddingRight: getComputedStyle(shell).paddingRight,
      backdropDisplay: getComputedStyle(backdrop).display,
      drawerWidth: Math.round(drawer.getBoundingClientRect().width),
      viewportWidth: window.innerWidth,
    };
  });
  const historyLayout = await readHistoryLayout();
  if (historyLayout.viewportWidth >= 900) {
    await expect.poll(async () => (await readHistoryLayout()).shellPaddingRight).toBe("380px");
    expect(historyLayout.backdropDisplay).toBe("none");
    expect(historyLayout.drawerWidth).toBe(380);
    await historyButton.click();
  } else {
    expect(historyLayout.shellPaddingRight).toBe("0px");
    expect(historyLayout.backdropDisplay).toBe("block");
    expect(historyLayout.drawerWidth).toBeLessThanOrEqual(Math.ceil(historyLayout.viewportWidth * 0.92));
    await page.locator(".loopassist-history-backdrop").click({ position: { x: 4, y: 4 } });
  }
  await expect(page.locator(".loopassist-history-drawer.is-open")).toHaveCount(0);
  await page.keyboard.press("h");
  await expect(page.locator(".loopassist-history-drawer")).toHaveClass(/is-open/);
  await page.keyboard.press("Escape");
  await expect(page.locator(".loopassist-history-drawer.is-open")).toHaveCount(0);
  await page.getByTestId("loopassist-start-answer").click();
  await expect(page.getByTestId("loopassist-shell")).toContainText("麦克风服务暂时连接不上");
  await expect(page.getByTestId("loopassist-toggle-text-mode")).toBeVisible();
  await expect(page.getByTestId("loopassist-shell").locator("textarea")).toHaveCount(0);
  await page.getByTestId("loopassist-toggle-text-mode").click();
  await expect(page.getByTestId("loopassist-text-answer")).toBeVisible();
  await expect(page.getByTestId("loopassist-voice-orb")).toHaveCount(0);
  await page.getByTestId("loopassist-text-answer-input").fill("AQS 主要通过 state 和 CLH 队列实现同步。");
  await page.getByTestId("loopassist-submit-text-answer").click();
  await expect(page.getByTestId("loopassist-shell")).toContainText("那公平锁和非公平锁有什么区别？");
  await expect(page.getByTestId("loopassist-transcript")).not.toContainText("seedId");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByTestId("loopassist-more-menu").click();
  await page.getByRole("button", { name: "退出本轮" }).click();
  await expect(page.getByTestId("loopassist-review")).toContainText("72 / 100");
  await page.getByRole("button", { name: "＋ 新建面试" }).click();
  await expect(page.getByTestId("loopassist-interview-record")).toBeEnabled();
  await page.getByTestId("loopassist-interview-record").click();
  await expect(page.getByTestId("loopassist-review")).toContainText("72 / 100");
});

test("LoopAssist keeps TTS network failures user-facing", async ({ page }) => {
  await mockLoopAssistSetup(page, {
    tts: (route) => route.abort("failed"),
  });

  await prepareLoopAssistInterview(page);
  await page.getByTestId("loopassist-start-interview").click();
  await expect(page.getByTestId("loopassist-shell")).toContainText("面试官语音暂时不可用");
  await expect(page.getByTestId("loopassist-shell")).not.toContainText("Failed to fetch");
  await expect(page.getByTestId("loopassist-toggle-text-mode")).toBeVisible();
  await expect(page.getByRole("button", { name: "重试" })).toHaveCount(0);
});
