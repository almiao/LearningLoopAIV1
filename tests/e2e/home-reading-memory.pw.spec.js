import { expect, test } from "@playwright/test";

const bffPort = process.env.E2E_BFF_PORT || "14100";
const bffBaseUrl = `http://127.0.0.1:${bffPort}`;

async function loginAndSeed(page, request) {
  const handle = `home_memory_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const response = await request.post(`${bffBaseUrl}/api/auth/login`, {
    data: {
      handle,
      pin: "1234",
    },
  });
  expect(response.ok()).toBeTruthy();
  const payload = await response.json();

  await page.addInitScript(({ userId, baselineId }) => {
    window.localStorage.setItem("learning-loop-user-id", userId);
    window.localStorage.setItem("learning-loop-target-baseline-id", baselineId);
  }, {
    userId: payload.profile.user.id,
    baselineId: "bigtech-java-backend",
  });

  return payload.profile.user.id;
}

test("home continue-learning card refreshes after reading another document", async ({ page, request }) => {
  await loginAndSeed(page, request);

  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.getByText("继续学习（推荐）")).toBeVisible();

  await page.goto("/learn?target=bigtech-java-backend&doc=docs/system-design/framework/spring/spring-transaction.md&autostart=1", {
    waitUntil: "networkidle",
  });
  await expect(page.getByTestId("document-surface")).toContainText("Spring");

  await page.getByTestId("outline-toggle").click();
  await expect(page.getByTestId("outline-panel")).toBeVisible();
  await expect(page.getByRole("button", { name: "什么是事务？" })).toBeVisible();
  await page.getByRole("button", { name: "IoC & AOP详解（快速搞懂）" }).click();
  await expect(page.getByTestId("document-surface")).toContainText("IoC");

  await page.waitForTimeout(500);
  await page.goBack({ waitUntil: "networkidle" });

  await expect(page.getByText("继续学习（推荐）")).toBeVisible();
  await expect(page.locator("body")).toContainText("你上次读到：IoC & AOP详解（快速搞懂）");
});
