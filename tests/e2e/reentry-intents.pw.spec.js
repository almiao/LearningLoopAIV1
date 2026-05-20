import { expect, test } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

test.describe.configure({ timeout: 90_000 });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..", "..");

const bffPort = process.env.E2E_BFF_PORT || "4000";
const bffBaseUrl = `http://127.0.0.1:${bffPort}`;
const docPath = "docs/ai/agent/mcp.md";
const docTitle = "万字拆解 MCP，附带工程实践";

function userProfilePath(userId) {
  return path.join(root, ".omx", "user-profiles", `${userId}.json`);
}

function memoryProfilePath(memoryProfileId) {
  return path.join(root, ".omx", "memory-profiles", `${memoryProfileId}.json`);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJson(filePath, payload) {
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function loginAndHydrate(page, request) {
  const handle = `reentry_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
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

  return payload.profile.user;
}

async function startTrainingSession(request, userId) {
  const response = await request.post(`${bffBaseUrl}/api/interview/start-target`, {
    data: {
      userId,
      docPath,
      interactionPreference: "balanced",
    },
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function seedReadingProgress(request, userId, scrollRatio = 0.52) {
  const response = await request.post(`${bffBaseUrl}/api/profile/reading-progress`, {
    data: {
      userId,
      docPath,
      docTitle,
      scrollRatio,
      dwellMs: 25_000,
      readingPreview: "Agent = LLM + Planning + Memory + Tools",
      readingChapter: "Agent 基础",
    },
  });
  expect(response.ok()).toBeTruthy();
}

test("intent=ask-document focuses the reading composer", async ({ page, request }) => {
  const user = await loginAndHydrate(page, request);
  await seedReadingProgress(request, user.id, 0.18);

  await page.goto(`/learn?doc=${encodeURIComponent(docPath)}&intent=ask-document`, {
    waitUntil: "networkidle",
  });

  const composer = page.getByPlaceholder("问任何关于这篇的问题...");
  await expect(composer).toBeFocused();
  await expect(page).not.toHaveURL(/intent=ask-document/);
});

test("intent=continue-training resumes the existing active session", async ({ page, request }) => {
  const user = await loginAndHydrate(page, request);
  const session = await startTrainingSession(request, user.id);

  await page.goto(`/learn?doc=${encodeURIComponent(docPath)}&intent=continue-training`, {
    waitUntil: "networkidle",
  });

  await expect(page.getByTestId("training-next-question")).toBeVisible();
  await expect(page).not.toHaveURL(/intent=continue-training/);

  const profileResponse = await request.get(`${bffBaseUrl}/api/profile/${user.id}`);
  expect(profileResponse.ok()).toBeTruthy();
  const profile = await profileResponse.json();
  expect(profile.documentProgress.docs[docPath].activeSessionId).toBe(session.sessionId);
});

test("intent=restart-training replaces the previous active session", async ({ page, request }) => {
  const user = await loginAndHydrate(page, request);
  const previousSession = await startTrainingSession(request, user.id);

  await page.goto(`/learn?doc=${encodeURIComponent(docPath)}&intent=restart-training`, {
    waitUntil: "networkidle",
  });

  await expect(page.getByTestId("training-next-question")).toBeVisible();
  await expect(page).not.toHaveURL(/intent=restart-training/);

  const profileResponse = await request.get(`${bffBaseUrl}/api/profile/${user.id}`);
  expect(profileResponse.ok()).toBeTruthy();
  const profile = await profileResponse.json();
  expect(profile.documentProgress.docs[docPath].activeSessionId).not.toBe(previousSession.sessionId);
});

test("intent=open-document restores the previous reading position", async ({ page, request }) => {
  const user = await loginAndHydrate(page, request);
  await seedReadingProgress(request, user.id, 0.52);

  await page.goto(`/learn?doc=${encodeURIComponent(docPath)}&intent=open-document`, {
    waitUntil: "networkidle",
  });

  await expect(page).not.toHaveURL(/intent=open-document/);
  const scrollTop = (page.viewportSize()?.width || 0) >= 768
    ? await page.locator(".reader-body").evaluate((element) => element.scrollTop)
    : await page.evaluate(() => window.scrollY);
  expect(scrollTop).toBeGreaterThan(0);
});

test("reading re-entry reminder stays lightweight and can be dismissed while remaining in reading mode", async ({ page, request }) => {
  const user = await loginAndHydrate(page, request);
  await startTrainingSession(request, user.id);

  await page.goto(`/learn?doc=${encodeURIComponent(docPath)}`, {
    waitUntil: "networkidle",
  });

  const reminder = page.getByTestId("reading-reentry-card");
  await expect(reminder).toBeVisible();
  await expect(reminder).toContainText("继续上次训练");
  await expect(reminder).toContainText("会恢复到上次中断的位置");
  await expect(reminder.getByTestId("reading-reentry-primary")).toHaveText("继续训练");
  await expect(reminder.getByTestId("reading-reentry-dismiss")).toHaveText("先阅读");

  await reminder.getByTestId("reading-reentry-dismiss").click();

  await expect(reminder).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "问这篇文档" })).toBeVisible();
  await expect(page.getByRole("button", { name: "阅读" })).toHaveClass(/active/);
});

test("intent=quick-review enters training and targets a weak concept from profile memory", async ({ page, request }) => {
  const user = await loginAndHydrate(page, request);
  const session = await startTrainingSession(request, user.id);
  const reviewPoint = (session.trainingPoints || []).find((point) => (
    Array.isArray(point.sourceRefs) && point.sourceRefs.some((source) => source.path === docPath)
  ));
  expect(reviewPoint).toBeTruthy();

  await seedReadingProgress(request, user.id, 1);

  const userProfile = await readJson(userProfilePath(user.id));
  userProfile.documents = userProfile.documents || { docs: {}, ignoredDocs: {} };
  userProfile.documents.currentDocPath = docPath;
  userProfile.documents.currentDocTitle = docTitle;
  userProfile.documents.docs = userProfile.documents.docs || {};
  userProfile.documents.docs[docPath] = {
    ...(userProfile.documents.docs[docPath] || {}),
    docPath,
    docTitle,
    progressPercentage: 100,
    readingPreview: "Agent = LLM + Planning + Memory + Tools",
    readingChapter: "Agent 基础",
    trainingStartedAt: new Date().toISOString(),
    trainingCompletedAt: new Date().toISOString(),
    activeSessionId: "",
    activeSessionSnapshot: null,
  };
  await writeJson(userProfilePath(user.id), userProfile);

  const memoryProfile = await readJson(memoryProfilePath(user.memoryProfileId));
  memoryProfile.checkpointMastery = memoryProfile.checkpointMastery || {};
  memoryProfile.checkpointMastery[reviewPoint.id] = {
    checkpointId: reviewPoint.id,
    evidenceCount: 2,
    state: "partial",
    score: 58,
    derivedPrinciple: reviewPoint.summary || "",
    recentStrongEvidence: [],
    recentConflictingEvidence: ["关键链路没讲完整"],
    lastUpdatedAt: new Date().toISOString(),
  };
  await writeJson(memoryProfilePath(user.memoryProfileId), memoryProfile);

  await page.goto(`/learn?doc=${encodeURIComponent(docPath)}&intent=quick-review`, {
    waitUntil: "networkidle",
  });

  await expect(page.getByTestId("training-next-question")).toBeVisible();
  await expect(page).not.toHaveURL(/intent=quick-review/);
});
