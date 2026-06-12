import { expect, test } from "@playwright/test";

async function mockLoopAssistSetup(page, options = {}) {
  let startPayload = null;
  const resumeVersions = options.resumeVersions || [
    {
      id: "resume-v2",
      fileName: "java-resume-v2.md",
      createdAt: "2026-06-02T09:30:00.000Z",
      charCount: 20,
      text: "负责订单系统 Redis 缓存一致性和接口隔离。",
    },
  ];
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
  await page.route("**/api/profile/resume-versions?*", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        latestVersionId: resumeVersions[0]?.id || "",
        versions: resumeVersions,
      }),
    });
  });
  await page.route("**/api/profile/resume-versions", async (route) => {
    const payload = route.request().postDataJSON();
    const savedVersion = {
      id: "resume-uploaded",
      fileName: payload.fileName || "uploaded.md",
      createdAt: "2026-06-02T10:00:00.000Z",
      charCount: String(payload.text || "").trim().length,
      text: payload.text,
    };
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        latestVersionId: savedVersion.id,
        savedVersionId: savedVersion.id,
        versions: [savedVersion, ...resumeVersions],
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
          rationale: "根据候选人简历、目标岗位 JD 和历史面经样本，先验证并发基础再追项目证据。",
          sourceExplanation: "题目来源于用户选择的 Java 一面面经，并结合上传的简历和 JD 调整顺序。",
          stages: [
            {
              step: 1,
              theme: "并发基础",
              objective: "确认候选人能讲清 AQS 的核心机制。",
              source: "历史面经样本 + 用户 JD",
              seedId: "s1",
              baseQuestion: "AQS 的底层实现原理是什么？",
              sourceContexts: [
                {
                  type: "historical_interview",
                  label: "历史面经 s1",
                  excerpt: "原始面经：AQS 的底层实现原理是什么？",
                  reason: "参考真实面试中的并发考法。",
                  contextId: "s1",
                },
                {
                  type: "user_resume",
                  label: "用户简历",
                  excerpt: "负责订单系统 Redis 缓存一致性和接口隔离。",
                  reason: "用于控制项目追问是否贴近用户真实经历。",
                },
                {
                  type: "user_jd",
                  label: "用户 JD",
                  excerpt: "Java 后端岗位，要求分布式系统和服务治理经验。",
                  reason: "用于控制岗位能力要求。",
                },
              ],
              sourcePreview: {
                seedId: "s1",
                baseQuestion: "AQS 的底层实现原理是什么？",
                reportText: "原始面经：AQS 的底层实现原理是什么？",
                followupAngles: ["如果线上出现线程阻塞，你会怎么定位？"],
                strongSignals: ["能讲队列和状态"],
              },
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
  const questionReviews = [
    {
      questionNumber: 1,
      topic: "并发",
      difficulty: "中高",
      status: "good",
      score: 78,
      questionText: "我们先聊 AQS 的底层实现原理。",
      answerText: "AQS 主要通过 state 和 CLH 队列实现同步。",
      performanceSummary: "这题已经有主线，但还能继续补线上排查场景。",
      strengths: ["能讲出 state 和队列两个核心点"],
      misses: ["还没讲到线程阻塞时怎么定位"],
      keyPoints: ["AQS 用 state 表示同步状态", "获取失败后进入等待队列", "唤醒依赖 acquire/release 语义"],
      coachingTip: "补上一个线程池阻塞定位案例，这题就会更稳。",
      likelyFollowups: ["如果线程一直拿不到锁，你怎么排查？"],
    },
    {
      questionNumber: 2,
      topic: "并发",
      difficulty: "中高",
      status: "warn",
      score: 58,
      questionText: "那公平锁和非公平锁有什么区别？",
      answerText: "公平锁会按顺序拿锁，非公平锁可能插队。",
      performanceSummary: "方向对，但没有展开性能差异和适用场景。",
      strengths: ["已经答到公平和插队的核心差异"],
      misses: ["缺少吞吐量与饥饿风险的取舍", "没有结合业务场景说明为什么选型"],
      keyPoints: ["公平锁降低饥饿风险", "非公平锁通常吞吐更高", "选型要看延迟和公平性的权衡"],
      coachingTip: "下次补一个吞吐量和饥饿风险的取舍点，这题就不止及格。",
      likelyFollowups: ["你在线上更倾向用哪种锁，为什么？"],
    },
  ];
  const summaryReview = {
    readinessScore: 72,
    summary: "回答方向正确，但需要补项目细节。",
    capabilityDistribution: [
      {
        topic: "并发",
        score: 74,
        verdict: "基础不错，但线上排查细节还需要更扎实。",
        evidence: "AQS 回答能建立主线，但缺少故障定位细节。",
        questionCount: 2,
      },
      {
        topic: "项目",
        score: 52,
        verdict: "能说到项目方向，但量化结果不够。",
        evidence: "回答里缺少指标和业务结果。",
        questionCount: 1,
      },
    ],
    strengths: ["能说出核心机制"],
    weaknesses: ["缺少线上排查细节", "项目结果不够量化"],
    likelyFollowups: ["怎么定位线程阻塞？"],
    practicalNextSteps: ["准备一个线程池排查案例"],
    nextRecommendedScope: "并发专项追问",
    counts: {
      miss: 0,
      warn: 1,
      good: 1,
      total: 2,
    },
    questionReviews,
  };
  await page.route("**/api/loopassist/review-question", async (route) => {
    const payload = route.request().postDataJSON();
    const matched = questionReviews.find((item) => item.questionNumber === payload.questionNumber);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        sessionId: "loop-e2e",
        questionReview: matched,
      }),
    });
  });
  await page.route("**/api/loopassist/review-summary", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        sessionId: "loop-e2e",
        review: summaryReview,
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
            stages: [{ step: 1, theme: "并发基础", objective: "确认候选人能讲清 AQS 的核心机制。", source: "历史面经样本 + 用户 JD" }],
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
  await page.addInitScript(() => {
    window.localStorage.setItem("learning-loop-user-id", "loopassist-e2e-user");
  });
  await page.goto("/loopassist");
  await expect(page.getByTestId("loopassist-shell")).not.toContainText("即时回答支架");
  await expect(page.getByTestId("loopassist-shell")).not.toContainText("本轮节奏");
  if (!(await page.getByTestId("loopassist-resume-text").isVisible())) {
    await page.getByTestId("loopassist-scope-toggle").click();
  }
  if (!(await page.getByTestId("loopassist-resume-text").isVisible())) {
    await page.getByRole("button", { name: "填写面试信息" }).click();
  }
  await expect(page.getByTestId("loopassist-resume-text")).toBeVisible();
  await expect(page.getByTestId("loopassist-saved-resume-panel")).toBeVisible();
  await expect(page.getByTestId("loopassist-use-saved-resume")).toBeChecked();
  await expect(page.getByTestId("loopassist-resume-version-select")).toBeVisible();
  await expect(page.getByTestId("loopassist-resume-text")).toHaveValue("负责订单系统 Redis 缓存一致性和接口隔离。");
  await expect(page.getByTestId("loopassist-jd-text")).not.toBeVisible();
  await expect(page.getByTestId("loopassist-start")).toContainText("贴合你");
  await page.getByTestId("loopassist-use-saved-resume").uncheck();
  await expect(page.getByTestId("loopassist-resume-text")).toHaveValue("");
  await expect(page.getByTestId("loopassist-start")).toContainText("通用");
  await page.getByTestId("loopassist-use-saved-resume").check();
  await expect(page.getByTestId("loopassist-resume-text")).toHaveValue("负责订单系统 Redis 缓存一致性和接口隔离。");
  await expect(page.getByTestId("loopassist-start")).toContainText("贴合你");
  await expect(page.getByTestId("loopassist-shell")).not.toContainText("已检测到简历，题目将围绕你的项目追问");
  await expect(page.getByTestId("loopassist-shell")).not.toContainText("未贴简历也能生成，会出通用题");
  await page.getByTestId("loopassist-toggle-jd").click();
  await page.getByTestId("loopassist-jd-text").fill("Java 后端岗位，要求分布式系统和服务治理经验。");
  await expect(page.getByTestId("loopassist-preview")).toContainText("AQS");
  await page.getByTestId("loopassist-start").click();
  await expect(page.getByTestId("loopassist-plan")).toContainText("大纲");
  await expect(page.getByTestId("loopassist-plan")).toContainText("确认候选人能讲清 AQS");
  await expect(page.getByTestId("loopassist-plan")).toContainText("参考面经 s1");
  await expect(page.getByTestId("loopassist-plan")).toContainText("生成依据：确认候选人能讲清 AQS");
  await expect(page.getByTestId("loopassist-plan")).toContainText("参考：历史面经 s1 + 用户简历 + 用户 JD");
  await expect(page.getByTestId("loopassist-plan")).not.toContainText("为什么这样生成");
  await expect(page.getByTestId("loopassist-plan")).not.toContainText("这次参考了什么");
  await page.getByRole("button", { name: "参考面经 s1" }).click();
  const sourceDialog = page.getByRole("dialog", { name: "题源预览" });
  await expect(sourceDialog).toContainText("原始面经：AQS");
  await expect(sourceDialog).toContainText("负责订单系统 Redis 缓存一致性");
  await sourceDialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.getByTestId("loopassist-plan")).toContainText("开始面试");
}

test("LoopAssist keeps text answering focused with transcript tucked away", async ({ page }) => {
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
  await expect(page.getByTestId("loopassist-text-answer")).toBeVisible();
  await expect(page.getByTestId("loopassist-voice-orb")).toHaveCount(0);
  await page.getByTestId("loopassist-text-answer-input").fill("AQS 主要通过 state 和 CLH 队列实现同步。");
  await page.getByTestId("loopassist-submit-text-answer").click();
  await expect(page.getByTestId("loopassist-shell")).toContainText("那公平锁和非公平锁有什么区别？");
  await expect(page.getByTestId("loopassist-transcript")).not.toContainText("seedId");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByTestId("loopassist-more-menu").click();
  await page.getByRole("button", { name: "退出本轮" }).click();
  await expect(page.getByTestId("loopassist-review")).toContainText(/72\s*\/\s*100/);
  await expect(page.getByTestId("loopassist-review")).toContainText("能力分布");
  await expect(page.getByTestId("loopassist-review")).toContainText("逐题复盘");
  await expect(page.getByTestId("loopassist-review")).toContainText("公平锁和非公平锁有什么区别");
  await page.getByRole("button", { name: "＋ 新建面试" }).click();
  await expect(page.getByTestId("loopassist-interview-record")).toBeEnabled();
  await page.getByTestId("loopassist-interview-record").click();
  await expect(page.getByTestId("loopassist-review")).toContainText(/72\s*\/\s*100/);
});

test("LoopAssist keeps TTS network failures user-facing", async ({ page }) => {
  await mockLoopAssistSetup(page, {
    tts: (route) => route.abort("failed"),
  });

  await prepareLoopAssistInterview(page);
  await page.getByTestId("loopassist-start-interview").click();
  await expect(page.getByTestId("loopassist-shell")).toContainText("面试官语音暂时不可用");
  await expect(page.getByTestId("loopassist-shell")).not.toContainText("Failed to fetch");
  await expect(page.getByTestId("loopassist-text-answer")).toBeVisible();
  await expect(page.getByTestId("loopassist-text-answer-input")).toBeVisible();
  await expect(page.getByRole("button", { name: "重试" })).toHaveCount(0);
});
