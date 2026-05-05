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

  await expect(page.locator(".message-card.learner")).toContainText("请基于面试准备目标");
  await expect(page.locator(".message-card.assistant").filter({ hasText: /Agent|智能体|Context Engineering/ })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText("下一步生成中")).toHaveCount(0);
  await expect(page.getByText("正在评估你的答案")).toHaveCount(0);
  await expect(page.getByText("训练模式")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("你是在提出请求");
});

test("learn workspace submits composer with Enter", async ({ page, request }) => {
  await loginForLearnPage(page, request);
  await page.goto(`/learn?doc=${encodeURIComponent(agentDocPath)}`, { waitUntil: "networkidle" });

  const composer = page.getByPlaceholder("输入回答、追问，或引用原文段落。");
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

  await page.getByRole("button", { name: "开始训练" }).click();

  await expect(page.getByTestId("qa-panel")).toContainText("训练");
  await expect(page.getByTestId("training-prep-card")).toContainText("正在准备训练");
});

test("learn workspace auto-expands the right panel after interaction and still supports manual resize", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Workspace resizing is only asserted on the desktop layout.");
  await loginForLearnPage(page, request);
  await page.goto(`/learn?doc=${encodeURIComponent(agentDocPath)}`, { waitUntil: "networkidle" });

  await expect(page.getByTestId("study-main")).toHaveAttribute("data-layout-mode", "auto");
  const initialWidths = await getPanelWidths(page);

  await page.getByRole("button", { name: "总结全文" }).click();
  await expect(page.locator(".message-card.assistant").filter({ hasText: /Agent|智能体|Context Engineering/ })).toBeVisible({
    timeout: 20_000,
  });

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
    const targetX = startX - 140;

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
  expect(manualWidths.qa).toBeGreaterThan(autoExpandedWidths.qa + 8);
  expect(manualWidths.reader).toBeLessThan(autoExpandedWidths.reader - 8);

  await divider.dblclick();
  await expect(page.getByTestId("study-main")).toHaveAttribute("data-layout-mode", "auto");
  await expect.poll(() => getPanelWidths(page).then((widths) => Math.abs(widths.qa - autoExpandedWidths.qa))).toBeLessThan(12);
});
