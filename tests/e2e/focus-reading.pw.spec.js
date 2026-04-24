import { expect, test } from "@playwright/test";

const focusDocPath = "docs/java/concurrent/threadlocal.md";
const bffPort = process.env.E2E_BFF_PORT || "14100";
const bffBaseUrl = `http://127.0.0.1:${bffPort}`;

async function loginForLearnPage(request) {
  const handle = `focus_e2e_${Date.now()}`;
  const response = await request.post(`${bffBaseUrl}/api/auth/login`, {
    data: {
      handle,
      pin: "1234",
    },
  });

  expect(response.ok()).toBeTruthy();
  const payload = await response.json();
  return payload.profile.user.id;
}

async function openFocusReadingPage(page, request, { focusMode = false } = {}) {
  const userId = await loginForLearnPage(request);

  await page.addInitScript((storedUserId) => {
    window.localStorage.setItem("learning-loop-user-id", storedUserId);
  }, userId);

  const params = new URLSearchParams({
    doc: focusDocPath,
  });
  if (focusMode) {
    params.set("focus", "1");
  }

  await page.goto(`/learn?${params.toString()}`, { waitUntil: "networkidle" });
  await expect(page.getByTestId("document-surface")).toBeVisible();
  await expect(page.getByTestId("document-surface")).toContainText("前言");
  await expect(page.locator(".markdown-image").first()).toBeVisible();

  const firstImageLoaded = await page.locator(".markdown-image").first().evaluate((node) => (
    node instanceof HTMLImageElement && node.complete && node.naturalWidth > 0
  ));
  expect(firstImageLoaded).toBeTruthy();
}

async function clearReaderToolbarFocus(page) {
  await page.mouse.move(220, 420);
  await page.getByTestId("document-surface").click({
    position: { x: 120, y: 120 },
  });
}

test("focus mode centers reading content and hides the business chrome", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Desktop hover interactions are validated on the desktop project.");
  await openFocusReadingPage(page, request);

  await expect(page.getByTestId("qa-panel")).toBeVisible();
  await page.getByTestId("focus-toggle").click();
  await expect(page.getByTestId("learn-shell")).toHaveAttribute("data-focus-mode", "true");
  await expect(page.getByTestId("qa-panel")).toBeHidden();
  await expect(page.getByTestId("focus-document-header")).toBeVisible();
  await expect(page.getByTestId("focus-document-header")).toContainText("ThreadLocal 详解");

  const focusFlow = await page.getByTestId("focus-reading-flow").boundingBox();
  if (!focusFlow) {
    throw new Error("Focus reading flow box was not available.");
  }
  expect(focusFlow.width).toBeGreaterThan(680);
  expect(focusFlow.width).toBeLessThan(780);
  await clearReaderToolbarFocus(page);

  await expect.poll(async () => page.getByTestId("reader-header").evaluate((node) => (
    Number.parseFloat(window.getComputedStyle(node).opacity)
  ))).toBeLessThan(0.1);

  const hoverZone = await page.getByTestId("focus-hover-zone").boundingBox();
  if (!hoverZone) {
    throw new Error("Focus hover zone box was not available.");
  }
  await page.mouse.move(hoverZone.x + hoverZone.width / 2, hoverZone.y + hoverZone.height / 2);
  await expect.poll(async () => page.getByTestId("reader-header").evaluate((node) => (
    Number.parseFloat(window.getComputedStyle(node).opacity)
  ))).toBeGreaterThan(0.9);

  await page.getByTestId("outline-toggle").click();
  await expect(page.getByTestId("outline-panel")).toBeVisible();
});

test("focus mode matches the reader snapshot", async ({ page, request }) => {
  await openFocusReadingPage(page, request, { focusMode: true });
  await expect(page.getByTestId("learn-shell")).toHaveAttribute("data-focus-mode", "true");
  await clearReaderToolbarFocus(page);

  await expect(page).toHaveScreenshot("focus-reading-page.png");
});

test("focus mode allows natural page scrolling", async ({ page, request }) => {
  await openFocusReadingPage(page, request, { focusMode: true });
  await expect(page.getByTestId("learn-shell")).toHaveAttribute("data-focus-mode", "true");

  const beforeScroll = await page.evaluate(() => window.scrollY);
  await page.mouse.wheel(0, 1200);
  await expect.poll(async () => page.evaluate(() => window.scrollY)).toBeGreaterThan(beforeScroll + 200);
});

test("regular reading mode allows reader panel scrolling", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Reader-panel wheel scrolling is asserted on the desktop project.");
  await openFocusReadingPage(page, request, { focusMode: false });
  await expect(page.getByTestId("learn-shell")).toHaveAttribute("data-focus-mode", "false");

  const beforeScroll = await page.getByTestId("reader-panel").evaluate((node) => {
    const body = node.querySelector(".reader-body");
    return body ? body.scrollTop : -1;
  });

  await page.getByTestId("reader-panel").hover();
  await page.mouse.wheel(0, 1200);

  await expect.poll(async () => page.getByTestId("reader-panel").evaluate((node) => {
    const body = node.querySelector(".reader-body");
    return body ? body.scrollTop : -1;
  })).toBeGreaterThan(beforeScroll + 200);
});
