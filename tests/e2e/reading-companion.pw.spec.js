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
  return payload.profile.user.id;
}

async function getPanelWidths(page) {
  return page.getByTestId("study-main").evaluate((node) => {
    const reader = node.querySelector("[data-testid='reader-panel']");
    const qa = node.querySelector("[data-testid='qa-panel']");
    if (!(reader instanceof HTMLElement) || !(qa instanceof HTMLElement)) {
      return {
        reader: 0,
        qa: 0,
      };
    }
    return {
      reader: reader.getBoundingClientRect().width,
      qa: qa.getBoundingClientRect().width,
    };
  });
}

test("reading assistant answers document questions without entering training flow", async ({ page, request }) => {
  await loginForLearnPage(page, request);
  await page.goto(`/learn?doc=${encodeURIComponent(agentDocPath)}`, { waitUntil: "networkidle" });

  await expect(page.getByTestId("document-surface")).toContainText("AI Agent");
  await expect(page.getByTestId("qa-panel")).toContainText("阅读助理");

  await page.getByRole("button", { name: "总结全文" }).click();
  await expect(page.getByPlaceholder("问任何关于这篇的问题...")).toHaveValue(/总结/);
  await page.getByPlaceholder("问任何关于这篇的问题...").press("Enter");

  await expect(page.locator(".message-card.learner")).toContainText("请基于面试准备目标");
  await expect(page.locator(".message-card.assistant")).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText("下一步生成中")).toHaveCount(0);
  await expect(page.getByText("正在评估你的答案")).toHaveCount(0);
  await expect(page.getByText("训练模式")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("你是在提出请求");
});

test("learn workspace submits composer with Enter", async ({ page, request }) => {
  await loginForLearnPage(page, request);
  await page.goto(`/learn?doc=${encodeURIComponent(agentDocPath)}`, { waitUntil: "networkidle" });

  const composer = page.getByPlaceholder("问任何关于这篇的问题...");
  await composer.fill("Context Engineering 是什么？");
  await composer.press("Enter");

  await expect(page.locator(".message-card.learner")).toContainText("Context Engineering 是什么？");
  await expect(page.locator(".message-card.assistant").filter({ hasText: /Context|上下文|工程|Agent|智能体/ })).toBeVisible({
    timeout: 20_000,
  });
});

test("learn workspace shows training preparation feedback immediately", async ({ page, request }) => {
  await loginForLearnPage(page, request);
  await page.route(`${bffBaseUrl}/api/interview/start-target`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.continue();
  });
  await page.goto(`/learn?doc=${encodeURIComponent(agentDocPath)}`, { waitUntil: "networkidle" });

  const trainingTab = page.getByTestId("qa-panel").getByRole("button", { name: "训练", exact: true });
  await expect(trainingTab).toBeEnabled();
  await trainingTab.click();

  await expect(page.getByTestId("qa-panel")).toContainText("训练");
  await expect(page.getByTestId("training-prep-card")).toContainText("正在准备训练");
  await expect(page.locator(".ll-training-rail")).toContainText("当前进度");
  await expect(page.locator(".ll-training-rail")).toContainText("总进度");
  await expect(page.locator(".ll-training-rail")).toContainText("本训练点表现");
  await expect(page.locator("body")).not.toContainText("当前没有新的题目。");
});

test("learn workspace does not mark a document fully read just by opening it", async ({ page, request }) => {
  const userId = await loginForLearnPage(page, request);
  const progressEvents = [];
  await page.route(`${bffBaseUrl}/api/profile/reading-progress`, async (route) => {
    const postData = route.request().postData();
    if (postData) {
      progressEvents.push(JSON.parse(postData));
    }
    await route.continue();
  });

  await page.goto(`/learn?doc=${encodeURIComponent(agentDocPath)}`, { waitUntil: "networkidle" });
  await page.goto("/", { waitUntil: "networkidle" });

  expect(progressEvents.some((event) => Number(event.scrollRatio || 0) >= 0.9)).toBeFalsy();
  const profileResponse = await request.get(`${bffBaseUrl}/api/profile/${userId}`);
  expect(profileResponse.ok()).toBeTruthy();
  const profile = await profileResponse.json();
  const entry = profile.documentProgress?.docs?.[agentDocPath];
  expect(Number(entry?.progressPercentage || 0)).toBeLessThan(100);
  expect(Number(entry?.maxScrollRatio || 0)).toBeLessThan(0.9);
});

test("learn workspace lets users complete a read document by skipping training", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Completion card layout is asserted once on desktop.");
  const userId = await loginForLearnPage(page, request);
  const progressResponse = await request.post(`${bffBaseUrl}/api/profile/reading-progress`, {
    data: {
      userId,
      docPath: agentDocPath,
      docTitle: "AI Agent 基础",
      scrollRatio: 0.91,
      dwellMs: 0,
    },
  });
  expect(progressResponse.ok()).toBeTruthy();

  await page.goto(`/learn?doc=${encodeURIComponent(agentDocPath)}`, { waitUntil: "networkidle" });
  // 读完未训练 → 训练提醒卡（已替代旧的「已读完 · 开始训练」横幅）。
  const reminder = page.getByTestId("reading-reentry-card");
  await expect(reminder).toBeVisible();
  await expect(reminder).toContainText("开始这轮训练");
  await page.locator(".reader-body").evaluate((node) => {
    node.scrollTop = node.scrollHeight;
    node.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect(reminder).toContainText("开始这轮训练");
  await expect(page.getByTestId("qa-panel").getByTestId("document-completion-card")).toHaveCount(0);
  await page.getByRole("button", { name: "更多" }).click();
  await page.getByRole("button", { name: "标记为仅阅读完成" }).click();
  // 收尾后提醒变为补练入口。
  await expect(page.getByTestId("qa-panel")).toContainText("补上这轮训练");
});

test("learn workspace auto-expands the right panel after interaction and still supports manual resize", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Workspace resizing is only asserted on the desktop layout.");
  await loginForLearnPage(page, request);
  await page.goto(`/learn?doc=${encodeURIComponent(agentDocPath)}`, { waitUntil: "networkidle" });

  await expect(page.getByTestId("study-main")).toHaveAttribute("data-layout-mode", "auto");
  const initialWidths = await getPanelWidths(page);

  await page.getByRole("button", { name: "总结全文" }).click();
  await page.getByPlaceholder("问任何关于这篇的问题...").press("Enter");
  await expect(page.locator(".message-card.learner")).toContainText("请基于面试准备目标");

  await expect.poll(() => getPanelWidths(page).then((widths) => widths.qa)).toBeGreaterThan(initialWidths.qa + 60);
  const autoExpandedWidths = await getPanelWidths(page);

  const divider = page.getByTestId("workspace-divider");
  await divider.evaluate((node) => {
    if (!(node instanceof HTMLElement)) {
      throw new Error("Workspace divider node was not available.");
    }
    const rect = node.getBoundingClientRect();
    const startX = rect.left + rect.width / 2;
    const pointerY = rect.top + rect.height / 2;
    const targetX = startX + 140;

    node.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true,
      clientX: startX,
      clientY: pointerY,
      pointerId: 1,
      pointerType: "mouse",
    }));
    window.dispatchEvent(new PointerEvent("pointermove", {
      bubbles: true,
      clientX: targetX,
      clientY: pointerY,
      pointerId: 1,
      pointerType: "mouse",
    }));
    window.dispatchEvent(new PointerEvent("pointerup", {
      bubbles: true,
      clientX: targetX,
      clientY: pointerY,
      pointerId: 1,
      pointerType: "mouse",
    }));
  });

  await expect(page.getByTestId("study-main")).toHaveAttribute("data-layout-mode", "manual");
  const manualWidths = await getPanelWidths(page);
  expect(Math.abs(manualWidths.qa - autoExpandedWidths.qa)).toBeGreaterThan(1);
  expect(Math.abs(manualWidths.reader - autoExpandedWidths.reader)).toBeGreaterThan(1);

  await divider.dblclick();
  await expect(page.getByTestId("study-main")).toHaveAttribute("data-layout-mode", "auto");
});
