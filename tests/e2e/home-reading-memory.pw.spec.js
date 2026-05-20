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

test("home page keeps status view as default and exposes a hierarchical library view", async ({ page, request }) => {
  const userId = await loginAndSeed(page, request);
  await seedReadingProgress(request, userId, reviewDocPath, reviewDocTitle, 0.95);
  await seedSkippedTraining(request, userId, reviewDocPath, reviewDocTitle);
  await seedReadingProgress(request, userId, currentDocPath, currentDocTitle, 0.52);
  await seedIgnoredDocument(request, userId, ignoredDocPath, ignoredDocTitle);

  await page.goto("/", { waitUntil: "networkidle" });

  await expect(page.getByText("今天先做什么")).toBeVisible();
  await expect(page.getByRole("heading", { name: currentDocTitle })).toBeVisible();
  await expect(page.getByRole("link", { name: "开始新的一篇 →" })).toBeVisible();
  await expect(page.getByRole("button", { name: "今天先不读这个" })).toBeVisible();
  await expect(page.locator(".ll-review-grid")).toContainText(reviewDocTitle);
  await expect(page.locator(".ll-group-list")).toContainText("在读");
  await expect(page.locator(".ll-group-list")).toContainText("待复习");
  if ((page.viewportSize()?.width || 0) >= 768) {
    await expect(page.getByLabel("包含忽略文档")).toBeVisible();
    await page.getByPlaceholder("搜索资料...").fill("Prompt Engineering");
    await expect(page.getByTestId("status-doc-row-prompt-engineering")).toHaveCount(0);
    await page.getByLabel("包含忽略文档").check();
    await page.getByRole("button", { name: /未学/ }).click();
    await expect(page.getByTestId("status-doc-row-prompt-engineering")).toBeVisible();
    await expect(page.getByTestId("status-doc-row-prompt-engineering")).toContainText("已忽略");
    await page.getByPlaceholder("搜索资料...").fill("");
    await page.getByLabel("包含忽略文档").uncheck();
  }

  if ((page.viewportSize()?.width || 0) >= 768) {
    await page.getByTestId("status-doc-row-mcp").click();
  } else {
    await page.getByRole("link", { name: "继续阅读 →" }).first().click();
  }
  await expect(page).toHaveURL(/\/learn\?doc=docs%2Fai%2Fagent%2Fmcp\.md/);
  await expect(page.getByTestId("reader-header")).toContainText(currentDocTitle);
  await page.goBack();
  await expect(page.getByText("今天先做什么")).toBeVisible();

  if ((page.viewportSize()?.width || 0) >= 768) {
    await page.getByRole("button", { name: /我的资料/ }).click();
    await expect(page).toHaveURL(/mode=library/);
    await expect(page.getByRole("button", { name: "按状态看" })).toBeVisible();
    await expect(page.getByTestId("library-tree")).toContainText("JavaGuide");
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

test("guest avatar opens a lightweight login dialog on the home page", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });

  await page.getByRole("button", { name: "登录 LearningLoop" }).click();
  await expect(page.getByRole("dialog", { name: "登录 LearningLoop" })).toBeVisible();

  const handle = `home_login_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await page.getByPlaceholder("lee_backend").fill(handle);
  await page.getByPlaceholder("4-12 位数字").fill("1234");
  await page.getByRole("button", { name: "登录 / 创建账号" }).click();

  await expect(page.getByRole("dialog", { name: "登录 LearningLoop" })).toBeHidden();
  await page.getByRole("button", { name: "打开账户菜单" }).click();
  await expect(page.locator(".ll-avatar-menu")).toContainText("个人档案");
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
