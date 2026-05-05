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

async function seedReadingProgress(request, userId, docPath, docTitle) {
  const response = await request.post(`${bffBaseUrl}/api/profile/reading-progress`, {
    data: {
      userId,
      docPath,
      docTitle,
      scrollRatio: 0.52,
      dwellMs: 25_000,
    },
  });
  expect(response.ok()).toBeTruthy();
}

test("home page lists the full static catalog and opens documents without target hints", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "搜索技术资料或选择入口" })).toBeVisible();
  await expect(page.locator(".catalog-section-tab").first()).toBeVisible();
  await expect(page.locator(".catalog-doc-row").first()).toBeVisible();

  await page.locator(".catalog-doc-row").first().click();
  await page.waitForURL(/\/learn\?/);
  expect(new URL(page.url()).searchParams.has("doc")).toBe(true);
  expect(new URL(page.url()).searchParams.has("target")).toBe(false);
  expect(new URL(page.url()).searchParams.has("autostart")).toBe(false);
});

test("home page exposes reading history as a catalog section", async ({ page, request }) => {
  const userId = await loginAndSeed(page, request);
  await seedReadingProgress(
    request,
    userId,
    "docs/system-design/framework/spring/spring-transaction.md",
    "Spring 事务详解"
  );

  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "搜索技术资料或选择入口" })).toBeVisible();
  await page.getByRole("button", { name: /历史文档/ }).click();
  await expect(page.locator(".catalog-list-head")).toContainText("历史文档");
  await expect(page.locator(".catalog-doc-grid")).toContainText("Spring 事务详解");
  await expect(page.locator(".catalog-doc-grid")).toContainText("上次学习");
  await expect(page.getByText("继续学习（推荐）")).toHaveCount(0);
  await expect(page.getByText("当前章节")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("你上次读到");

  await page.goto("/learn?doc=docs/system-design/framework/spring/spring-transaction.md&autostart=1", {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByTestId("document-surface")).toContainText("Spring");

  await page.getByTestId("outline-toggle").click();
  await expect(page.getByTestId("outline-panel")).toBeVisible();
  await expect(page.getByRole("button", { name: "什么是事务？" })).toBeVisible();
  await page.getByRole("button", { name: /IoC.*AOP/ }).click();
  await expect(page.getByTestId("document-surface")).toContainText("IoC");

  await page.goto("/", { waitUntil: "networkidle" });

  await expect(page.getByRole("heading", { name: "搜索技术资料或选择入口" })).toBeVisible();
  await expect(page.getByText("继续学习（推荐）")).toHaveCount(0);
  await expect(page.getByText("当前章节")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("你上次读到");
});

test("home page lets a signed-in user hide a document permanently from catalog views", async ({ page, request }) => {
  const userId = await loginAndSeed(page, request);
  await seedReadingProgress(
    request,
    userId,
    "docs/system-design/framework/spring/spring-transaction.md",
    "Spring 事务详解"
  );

  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /历史文档/ }).click();
  await expect(page.locator(".catalog-doc-grid")).toContainText("Spring 事务详解");
  await expect(page.getByRole("button", { name: "忽略 Spring 事务详解" })).toHaveCount(0);

  await page.getByRole("button", { name: "管理" }).click();
  await page.getByRole("button", { name: "忽略 Spring 事务详解" }).click();
  await expect(page.locator("body")).not.toContainText("Spring 事务详解");

  await page.getByPlaceholder("筛选当前目录").or(page.getByPlaceholder("筛选历史文档")).fill("Spring 事务详解");
  await expect(page.locator(".catalog-list-head")).toContainText("找到 0 篇匹配");
  await expect(page.locator(".chapter-empty")).toContainText("当前搜索没有匹配到文档");
});
