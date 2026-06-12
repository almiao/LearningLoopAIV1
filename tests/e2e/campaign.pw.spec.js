import { expect, test } from "@playwright/test";

// 面试冲刺全路径（立项拆 JD → 话题练习 → 面后回灌 → 归档）。
// LLM 依赖（拆 JD / 出题 / 判分 / 补讲）在前端路由层 mock，BFF 域逻辑由
// tests/unit/campaign-domain.test.js 兜底；这里验证仪表盘的全流程接线。

const topicRedis = { id: "t1", topic: "Redis 缓存一致性", importance: "core", coverage: "uncovered" };
const topicKafka = { id: "t2", topic: "Kafka 消息可靠性", importance: "secondary", coverage: "uncovered" };

function buildCampaign({ topics, gaps, coverageRate = 0 }) {
  return {
    id: "camp-e2e",
    role: "Java 后端",
    deadline: "",
    created_at: "2026-06-10T08:00:00.000Z",
    archived_at: null,
    topics,
    readiness: {
      daysLeft: null,
      coverageRate,
      readinessScore: coverageRate,
      gaps,
    },
  };
}

const campaignCreated = buildCampaign({
  topics: [topicRedis, topicKafka],
  gaps: [
    { topicId: "t1", topic: topicRedis.topic },
    { topicId: "t2", topic: topicKafka.topic },
  ],
});

const campaignAfterMiss = buildCampaign({
  topics: [{ ...topicRedis, coverage: "shaky" }, topicKafka],
  gaps: [
    { topicId: "t2", topic: topicKafka.topic },
    { topicId: "t1", topic: topicRedis.topic },
  ],
  coverageRate: 0.5,
});

const campaignAfterPass = buildCampaign({
  topics: [{ ...topicRedis, coverage: "shaky" }, { ...topicKafka, coverage: "solid" }],
  gaps: [{ topicId: "t1", topic: topicRedis.topic }],
  coverageRate: 1,
});

async function mockCampaignApi(page) {
  const state = { campaigns: [] };

  await page.route("**/api/campaigns", async (route) => {
    if (route.request().method() === "POST") {
      state.campaigns = [campaignCreated];
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ campaign: campaignCreated }),
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ campaigns: state.campaigns }),
    });
  });

  await page.route("**/api/campaigns/camp-e2e/topics/*/practice", async (route) => {
    const url = route.request().url();
    const payload = route.request().postDataJSON();
    const isRedis = url.includes("/topics/t1/");

    if (payload.action === "start") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          question: isRedis
            ? "缓存和数据库双写时，怎么保证一致性？"
            : "Kafka 怎么保证消息不丢？",
        }),
      });
      return;
    }

    if (isRedis) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          question: payload.question,
          passed: false,
          judgment: {
            hits: ["先更新数据库再删缓存"],
            misses: ["删除失败的重试与兜底"],
          },
          rescue: { markdown: "### 删除失败兜底\n用消息队列重试删除，最终一致。" },
          campaign: campaignAfterMiss,
        }),
      });
      return;
    }

    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        question: payload.question,
        passed: true,
        judgment: {
          hits: ["acks=all 加幂等生产者"],
          misses: [],
        },
        campaign: campaignAfterPass,
      }),
    });
  });

  await page.route("**/api/campaigns/camp-e2e/debrief", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        reviewItems: [{ id: "rv-1", handle: "Kafka 重平衡期间消息会怎样" }],
        campaign: campaignAfterPass,
      }),
    });
  });

  await page.route("**/api/campaigns/camp-e2e/archive", async (route) => {
    state.campaigns = [];
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });

  return state;
}

test("campaign dashboard covers the full path: create → practice → debrief → archive", async ({ page }) => {
  await mockCampaignApi(page);
  page.on("dialog", (dialog) => void dialog.accept());

  await page.goto("/campaign", { waitUntil: "networkidle" });

  // 立项：拆 JD 生成待练清单。
  const createForm = page.getByTestId("campaign-create-form");
  await expect(createForm).toBeVisible();
  await createForm.getByLabel("岗位").fill("Java 后端");
  await createForm.getByLabel(/职位描述/).fill("负责订单系统，要求熟悉 Redis 与 Kafka。");
  await createForm.getByRole("button", { name: "生成练习清单" }).click();

  await expect(page.getByTestId("campaign-readiness")).toBeVisible();
  await expect(page.getByTestId("campaign-readiness")).toContainText("已练话题");
  await expect(page.getByTestId("campaign-readiness")).toContainText("0/2");
  const topicList = page.getByTestId("campaign-topic-list");
  await expect(topicList).toContainText("Redis 缓存一致性");
  await expect(topicList).toContainText("Kafka 消息可靠性");

  // 话题练习：答崩 → 进复习计划 + 补讲。
  await topicList.getByRole("button", { name: /Redis 缓存一致性/ }).click();
  const practicePanel = page.getByTestId("campaign-practice-panel");
  await expect(practicePanel).toContainText("缓存和数据库双写时，怎么保证一致性？");
  await practicePanel.getByPlaceholder(/像面试一样作答/).fill("先更新数据库，再删缓存。");
  await practicePanel.getByRole("button", { name: "提交回答" }).click();

  await expect(practicePanel).toContainText("没讲稳 · 已加入复习计划");
  await expect(practicePanel).toContainText("删除失败的重试与兜底");
  await expect(page.getByTestId("campaign-practice-rescue-card")).toContainText("删除失败兜底");

  // 练下一个：按缺口顺序切到 Kafka，这次过线。
  await practicePanel.getByRole("button", { name: "练下一个" }).click();
  await expect(practicePanel).toContainText("Kafka 怎么保证消息不丢？");
  await practicePanel.getByPlaceholder(/像面试一样作答/).fill("acks=all，幂等生产者，副本同步后才算提交。");
  await practicePanel.getByRole("button", { name: "提交回答" }).click();
  await expect(practicePanel).toContainText("过了 · 标记为扎实");

  // 回清单：覆盖状态已更新。
  await practicePanel.getByRole("button", { name: "‹ 待练清单" }).click();
  await expect(page.getByTestId("campaign-readiness")).toContainText("2/2");
  await expect(topicList).toContainText("生疏");
  await expect(topicList).toContainText("扎实");

  // 面后回灌：真实面试被问崩的点转复习项。
  const debrief = page.getByTestId("campaign-debrief");
  await debrief.locator("summary").click();
  await debrief.getByPlaceholder(/一行一个/).fill("Kafka 重平衡期间消息会怎样");
  await debrief.getByRole("button", { name: "加进复习计划" }).click();
  await expect(debrief).toContainText("已加入复习计划，共 1 条。");

  // 归档：清单收起，回到立项表单。
  await page.getByRole("button", { name: "归档这场准备" }).click();
  await expect(page.getByTestId("campaign-create-form")).toBeVisible();
});
