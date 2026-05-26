import { expect, test } from "@playwright/test";

test("LoopAssist remains voice-only when microphone setup fails", async ({ page }) => {
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

  await page.goto("/loopassist");
  await expect(page.getByTestId("loopassist-shell")).not.toContainText("即时回答支架");
  await expect(page.getByTestId("loopassist-shell")).not.toContainText("本轮节奏");
  await expect(page.getByTestId("loopassist-resume-text")).toBeVisible();
  await page.getByTestId("loopassist-resume-text").fill("负责订单系统 Redis 缓存一致性和接口隔离。");
  await page.getByTestId("loopassist-jd-text").fill("Java 后端岗位，要求分布式系统和服务治理经验。");
  await expect(page.getByTestId("loopassist-preview")).toContainText("AQS");
  await page.getByTestId("loopassist-start").click();
  expect(startPayload.scope.resumeText).toContain("Redis 缓存一致性");
  expect(startPayload.scope.jobDescription).toContain("分布式系统");
  await expect(page.getByTestId("loopassist-plan")).toContainText("大纲");
  await expect(page.getByTestId("loopassist-plan")).toContainText("确认候选人能讲清 AQS");
  await expect(page.getByTestId("loopassist-plan")).toContainText("真实面经题源 + JD");
  await expect(page.getByTestId("loopassist-plan")).toContainText("开始面试");
  await page.getByTestId("loopassist-start-interview").click();
  await expect(page.getByTestId("loopassist-transcript")).toContainText("我们先聊 AQS");
  await page.getByTestId("loopassist-start-answer").click();
  await expect(page.getByTestId("loopassist-shell")).toContainText("仅支持语音回答");
  await expect(page.getByTestId("loopassist-retry-mic")).toBeVisible();
  await expect(page.getByTestId("loopassist-shell").locator("textarea")).toHaveCount(0);
  await expect(page.getByTestId("loopassist-transcript")).not.toContainText("seedId");
  await page.getByTestId("loopassist-scope-toggle").click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "结束本轮" }).click();
  await expect(page.getByTestId("loopassist-review")).toContainText("72 / 100");
});
