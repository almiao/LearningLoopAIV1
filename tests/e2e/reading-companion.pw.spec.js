import { expect, test } from "@playwright/test";

const bffPort = process.env.E2E_BFF_PORT || "14100";
const bffBaseUrl = `http://127.0.0.1:${bffPort}`;
const agentDocPath = "docs/ai/agent/agent-basis.md";

async function loginForLearnPage(page, request) {
  const handle = `reading_companion_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const response = await request.post(`${bffBaseUrl}/api/auth/login`, {
    data: {
      handle,
      pin: "1234",
    },
  });

  expect(response.ok()).toBeTruthy();
  const payload = await response.json();
  await page.addInitScript((storedUserId) => {
    window.localStorage.setItem("learning-loop-user-id", storedUserId);
  }, payload.profile.user.id);
}

test("reading assistant answers document questions without entering training flow", async ({ page, request }) => {
  await loginForLearnPage(page, request);
  await page.goto(`/learn?doc=${encodeURIComponent(agentDocPath)}`, { waitUntil: "networkidle" });

  await expect(page.getByTestId("document-surface")).toContainText("AI Agent");
  await expect(page.getByTestId("qa-panel")).toContainText("阅读助理");

  await page.getByRole("button", { name: "总结全文" }).click();

  await expect(page.locator(".message-card.learner")).toContainText("请只基于");
  await expect(page.locator(".message-card.assistant").filter({ hasText: /Agent|智能体|Context Engineering/ })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText("下一步生成中")).toHaveCount(0);
  await expect(page.getByText("正在评估你的答案")).toHaveCount(0);
  await expect(page.getByText("训练模式")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("你是在提出请求");
});
