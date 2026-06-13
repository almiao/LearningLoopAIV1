import { expect, test } from "@playwright/test";

const bffPort = process.env.E2E_BFF_PORT || "14100";
const bffBaseUrl = `http://127.0.0.1:${bffPort}`;
const currentDocPath = "docs/ai/agent/mcp.md";
const currentDocTitle = "万字拆解 MCP，附带工程实践";
const reviewDocPath = "docs/ai/agent/agent-basis.md";
const reviewDocTitle = "一文搞懂 AI Agent 核心概念：Agent Loop、Context Engineering、Tools 注册";
const ignoredDocPath = "docs/ai/agent/prompt-engineering.md";
const ignoredDocTitle = "Prompt Engineering";

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

async function seedReadingProgress(request, userId, docPath, docTitle, scrollRatio) {
  const response = await request.post(`${bffBaseUrl}/api/profile/reading-progress`, {
    data: {
      userId,
      docPath,
      docTitle,
      scrollRatio,
      dwellMs: 25_000,
    },
  });
  expect(response.ok()).toBeTruthy();
}

async function seedSkippedTraining(request, userId, docPath, docTitle) {
  const response = await request.post(`${bffBaseUrl}/api/profile/skipped-training`, {
    data: {
      userId,
      docPath,
      docTitle,
    },
  });
  expect(response.ok()).toBeTruthy();
}

async function seedIgnoredDocument(request, userId, docPath, docTitle, ignored = true) {
  const response = await request.post(`${bffBaseUrl}/api/profile/ignored-document`, {
    data: {
      userId,
      docPath,
      docTitle,
      ignored,
    },
  });
  expect(response.ok()).toBeTruthy();
}

test("home page keeps a single act-led column and the library lives on its own secondary page", async ({ page, request }) => {
  const userId = await loginAndSeed(page, request);
  await seedReadingProgress(request, userId, reviewDocPath, reviewDocTitle, 0.95);
  await seedSkippedTraining(request, userId, reviewDocPath, reviewDocTitle);
  await seedReadingProgress(request, userId, currentDocPath, currentDocTitle, 0.52);
  await seedIgnoredDocument(request, userId, ignoredDocPath, ignoredDocTitle);

  await page.goto("/", { waitUntil: "networkidle" });

  await expect(page.getByText("今天从这里推进")).toBeVisible();
  await expect(page.getByRole("heading", { name: currentDocTitle })).toBeVisible();
  await expect(page.getByRole("link", { name: "开始读这篇 →" })).toBeVisible();
  await expect(page.getByRole("button", { name: "今天先不读这个" })).toBeVisible();
  await expect(page.getByRole("link", { name: "添加新材料" })).toBeVisible();
  // 首页不再承载资料树。
  await expect(page.getByTestId("library-tree")).toHaveCount(0);

  await page.getByRole("link", { name: currentDocTitle }).click();
  await expect(page).toHaveURL(/\/learn\?doc=docs%2Fai%2Fagent%2Fmcp\.md/);
  await expect(page.getByTestId("reader-header")).toContainText(currentDocTitle);
  await page.goBack();
  await expect(page.getByText("今天从这里推进")).toBeVisible();

  // 旧资料库深链跳到二级页。
  await page.goto("/?mode=library&panel=library", { waitUntil: "networkidle" });
  await expect(page).toHaveURL(/\/library/);

  if ((page.viewportSize()?.width || 0) >= 768) {
    await page.goto("/library", { waitUntil: "networkidle" });
    await expect(page.getByTestId("library-tree")).toContainText("JavaGuide");

    // 被忽略的文档默认不进树；包含后重新出现。
    await page.getByPlaceholder("搜索资料...").fill("Prompt Engineering");
    await expect(page.getByTestId("library-tree")).not.toContainText("JavaGuide");
    await page.getByLabel("包含忽略文档").check();
    await expect(page.getByTestId("library-tree")).toContainText("JavaGuide");
    await page.getByPlaceholder("搜索资料...").fill("");
    await page.getByLabel("包含忽略文档").uncheck();

    await expect(page.locator(".ll-library-head")).toContainText("我的资料");
    await expect(page.locator(".ll-library-head-actions").getByLabel("包含忽略文档")).toBeVisible();
    await expect(page.locator(".ll-library-head-actions").getByRole("button", { name: "管理" })).toBeVisible();
    await expect(page.getByTestId("library-folder-card-JavaGuide")).toBeVisible();

    await page.getByTestId("library-folder-card-JavaGuide").click();
    await page.getByTestId("library-folder-card-AI").click();
    await expect(page.locator("[data-testid='library-breadcrumbs']")).toContainText("我的资料");
    await expect(page.locator(".ll-library-head")).toContainText("我的资料 / JavaGuide / AI");
    await expect(page.getByTestId("library-folder-card-Agent")).toBeVisible();

    await page.getByTestId("library-folder-card-Agent").click();
    await expect(page.locator(".ll-library-head")).toContainText("我的资料 / JavaGuide / AI / Agent");
    await expect(page.getByTestId("library-document-card-mcp")).toBeVisible();
    await expect(page.getByTestId("library-document-card-mcp").getByRole("button", { name: "忽略" })).toHaveCount(0);
    await page.getByRole("button", { name: "管理" }).click();
    await page.getByTestId("library-document-card-mcp").getByRole("button", { name: "忽略" }).click();
    await expect(page.getByTestId("library-document-card-mcp")).toHaveCount(0);
    await page.getByRole("button", { name: "完成" }).click();
    await page.getByLabel("包含忽略文档").check();
    await expect(page.getByTestId("library-document-card-mcp")).toBeVisible();
    await expect(page.getByTestId("library-document-card-mcp")).toContainText("默认隐藏");
    await expect(page.getByTestId("library-document-card-mcp").getByRole("button", { name: "取消忽略" })).toHaveCount(0);
    await page.getByRole("button", { name: "管理" }).click();
    await page.getByTestId("library-document-card-mcp").getByRole("button", { name: "取消忽略" }).click();
    await expect(page.getByTestId("library-document-card-mcp")).toBeVisible();
    await page.getByTestId("library-document-card-mcp").click();
    await expect(page).toHaveURL(/\/learn\?doc=docs%2Fai%2Fagent%2Fmcp\.md/);
    await expect(page.getByTestId("reader-header")).toContainText(currentDocTitle);
  }
});

test("home page can snooze the current recommendation without ignoring the document", async ({ page, request }) => {
  const userId = await loginAndSeed(page, request);
  await seedReadingProgress(request, userId, currentDocPath, currentDocTitle, 1);

  await page.goto("/", { waitUntil: "networkidle" });

  await expect(page.getByRole("heading", { name: currentDocTitle })).toBeVisible();
  await page.getByRole("button", { name: "今天先不练这个" }).click();

  await expect(page.getByRole("heading", { name: currentDocTitle })).toHaveCount(0);

  const profileResponse = await request.get(`${bffBaseUrl}/api/profile/${userId}`);
  expect(profileResponse.ok()).toBeTruthy();
  const profilePayload = await profileResponse.json();
  expect(profilePayload.documentProgress.snoozedRecommendationDocPaths).toContain(currentDocPath);
  expect(profilePayload.documentProgress.ignoredDocPaths).not.toContain(currentDocPath);
});

test("home page auto-connects the local profile and opens the local profile menu", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });

  await page.getByRole("button", { name: "打开本机档案菜单" }).click();
  await expect(page.locator(".ll-avatar-menu")).toContainText("本机档案");
  await expect(page.locator(".ll-avatar-menu")).toContainText("资料库");
});

test("legacy document route redirects to learning page with document actions", async ({ page, request }) => {
  const userId = await loginAndSeed(page, request);

  await page.goto(`/documents/agent-basis?doc=${encodeURIComponent(reviewDocPath)}&title=${encodeURIComponent(reviewDocTitle)}&from=home`, {
    waitUntil: "networkidle",
  });

  await expect(page).toHaveURL(/\/learn\?doc=docs%2Fai%2Fagent%2Fagent-basis\.md/);
  await expect(page.getByTestId("reader-header")).toContainText(reviewDocTitle);
  await page.getByLabel("更多").click();
  await expect(page.getByRole("button", { name: "搁置" })).toHaveCount(0);
  await page.getByRole("button", { name: "标记为忽略" }).click();
  await expect(page).not.toHaveURL(/doc=docs%2Fai%2Fagent%2Fagent-basis\.md/);
  await expect(page.getByTestId("reader-header")).not.toContainText(reviewDocTitle);

  const profileResponse = await request.get(`${bffBaseUrl}/api/profile/${userId}`);
  expect(profileResponse.ok()).toBeTruthy();
  const profilePayload = await profileResponse.json();
  expect(profilePayload.documentProgress.ignoredDocPaths).toContain(reviewDocPath);
});
