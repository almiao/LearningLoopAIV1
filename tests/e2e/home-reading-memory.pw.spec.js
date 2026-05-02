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

  await page.addInitScript(({ userId }) => {
    window.localStorage.setItem("learning-loop-user-id", userId);
  }, {
    userId: payload.profile.user.id,
  });

  return payload.profile.user.id;
}

test("home page lists the full static catalog and opens documents without target hints", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.getByText("JavaGuide 全量目录")).toBeVisible();
  await expect(page.getByText("304")).toBeVisible();
  await expect(page.locator(".knowledge-doc-row").first()).toBeVisible();

  await page.locator(".knowledge-doc-row").first().click();
  await page.waitForURL(/\/learn\?/);
  expect(new URL(page.url()).searchParams.has("doc")).toBe(true);
  expect(new URL(page.url()).searchParams.has("target")).toBe(false);
  expect(new URL(page.url()).searchParams.has("autostart")).toBe(false);
});

test("home page does not surface history-driven current or recommendation labels", async ({ page, request }) => {
  await loginAndSeed(page, request);

  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.getByText("JavaGuide 全量目录")).toBeVisible();
  await expect(page.getByText("继续学习（推荐）")).toHaveCount(0);
  await expect(page.getByText("当前章节")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("你上次读到");

  await page.goto("/learn?doc=docs/system-design/framework/spring/spring-transaction.md&autostart=1", {
    waitUntil: "networkidle",
  });
  await expect(page.getByTestId("document-surface")).toContainText("Spring");

  await page.getByTestId("outline-toggle").click();
  await expect(page.getByTestId("outline-panel")).toBeVisible();
  await expect(page.getByRole("button", { name: "什么是事务？" })).toBeVisible();
  await page.getByRole("button", { name: /IoC.*AOP/ }).click();
  await expect(page.getByTestId("document-surface")).toContainText("IoC");

  await page.goto("/", { waitUntil: "networkidle" });

  await expect(page.getByText("JavaGuide 全量目录")).toBeVisible();
  await expect(page.getByText("继续学习（推荐）")).toHaveCount(0);
  await expect(page.getByText("当前章节")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("你上次读到");
});
