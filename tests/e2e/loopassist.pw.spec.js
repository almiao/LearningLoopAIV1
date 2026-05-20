import { expect, test } from "@playwright/test";

test("LoopAssist remains voice-only when microphone setup fails", async ({ page }) => {
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
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        sessionId: "loop-e2e",
        scope: {},
        transcript: [{ turnId: "t1", role: "interviewer", text: "我们先聊 AQS 的底层实现原理。", createdAt: Date.now() }],
        interviewerMessage: { text: "我们先聊 AQS 的底层实现原理。", topic: "并发", seedId: "s1" },
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
  await expect(page.getByTestId("loopassist-preview")).toContainText("AQS");
  await page.getByTestId("loopassist-start").click();
  await expect(page.getByTestId("loopassist-transcript")).toContainText("我们先聊 AQS");
  await page.getByTestId("loopassist-start-answer").click();
  await expect(page.getByTestId("loopassist-shell")).toContainText("仅支持语音回答");
  await expect(page.getByTestId("loopassist-retry-mic")).toBeVisible();
  await expect(page.getByTestId("loopassist-shell").locator("textarea")).toHaveCount(0);
  await expect(page.getByTestId("loopassist-transcript")).not.toContainText("seedId");
  await page.getByRole("button", { name: "结束并复盘" }).click();
  await expect(page.getByTestId("loopassist-review")).toContainText("72 / 100");
});
