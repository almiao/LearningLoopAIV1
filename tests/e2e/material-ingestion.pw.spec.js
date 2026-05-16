import { expect, test } from "@playwright/test";

const bffPort = process.env.E2E_BFF_PORT || "14100";
const bffBaseUrl = `http://127.0.0.1:${bffPort}`;

async function login(request) {
  const response = await request.post(`${bffBaseUrl}/api/auth/login`, {
    data: {
      handle: `material_e2e_${Date.now()}`,
      pin: "1234",
    },
  });
  expect(response.ok()).toBeTruthy();
  const payload = await response.json();
  return payload.profile.user.id;
}

test("material upload creates a learnable document and opens it in the reader", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Material upload is covered once on desktop.");
  const userId = await login(request);
  await page.addInitScript((storedUserId) => {
    window.localStorage.setItem("learning-loop-user-id", storedUserId);
  }, userId);

  await page.goto("/materials", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "上传资料" })).toBeVisible();
  await expect(page.getByLabel("资料预览")).toContainText("上传后在这里阅读");
  await expect(page.getByRole("button", { name: "生成预览" })).toHaveCount(0);

  await page.locator('input[type="file"]').setInputFiles({
    name: "redis-notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(`
Redis persistence uses RDB snapshots and AOF logs. RDB is compact and good for backups, while AOF records writes for smaller data-loss windows.
Replication improves availability by copying data to followers. Sentinel and cluster modes coordinate failover and distribution when nodes fail.
Interview answers should compare durability, recovery time, write overhead, and operational complexity.
`),
  });

  await expect(page.getByLabel("资料来源信息")).toContainText("redis-notes");
  await expect(page.getByLabel("资料来源信息")).toContainText("本地文件");
  await expect(page.getByLabel("资料来源信息")).toContainText("redis-notes.txt");
  await expect(page.getByLabel("资料预览")).toContainText("Redis persistence uses RDB snapshots and AOF logs");
  await expect(page.getByRole("button", { name: "学习版" })).toHaveCount(0);
  await page.getByRole("link", { name: "开始阅读" }).click();
  await expect(page).toHaveURL(/\/learn\?doc=materials%2F/);
  await expect(page.getByTestId("original-source-surface")).toBeVisible();
  await page.getByRole("button", { name: "学习版" }).click();
  await expect(page.getByTestId("document-surface")).toContainText("Redis persistence");
  await page.getByRole("button", { name: "原文" }).click();
  await expect(page.getByTestId("original-source-surface")).toBeVisible();
});
