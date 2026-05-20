import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultSummariesDir = path.resolve(__dirname, "../../.omx/session-summaries");
const safeUserIdPattern = /^[a-zA-Z0-9_-]{1,80}$/;
const validActions = new Set(["resume_training", "quick_review", "continue_reading", "reference_lookup"]);

function assertSafeUserId(userId = "") {
  if (!safeUserIdPattern.test(userId)) {
    throw new Error("Invalid user id.");
  }
}

function normalizeSummary(summary = {}) {
  const now = new Date().toISOString();
  return {
    sessionId: String(summary.sessionId || "").trim(),
    docPath: String(summary.docPath || "").trim(),
    endedAt: String(summary.endedAt || now),
    practicedCheckpointIds: Array.isArray(summary.practicedCheckpointIds) ? [...new Set(summary.practicedCheckpointIds.filter(Boolean))] : [],
    solidifiedCheckpointIds: Array.isArray(summary.solidifiedCheckpointIds) ? [...new Set(summary.solidifiedCheckpointIds.filter(Boolean))] : [],
    weakCheckpointIds: Array.isArray(summary.weakCheckpointIds) ? [...new Set(summary.weakCheckpointIds.filter(Boolean))] : [],
    oneParagraphSummary: String(summary.oneParagraphSummary || "").trim(),
    recommendedNextCheckpointId: String(summary.recommendedNextCheckpointId || "").trim(),
    recommendedNextAction: validActions.has(summary.recommendedNextAction) ? summary.recommendedNextAction : "quick_review",
  };
}

function validateSummaries(summaries = []) {
  if (!Array.isArray(summaries)) {
    throw new Error("Session summaries must be an array.");
  }
  for (const summary of summaries) {
    if (!summary.sessionId) {
      throw new Error("Session summary sessionId is invalid.");
    }
    if (!validActions.has(summary.recommendedNextAction)) {
      throw new Error("Session summary recommendedNextAction is invalid.");
    }
  }
}

export function createSessionSummariesStore({ summariesDir = defaultSummariesDir } = {}) {
  async function ensureDir() {
    await mkdir(summariesDir, { recursive: true });
  }

  function getSummariesPath(userId) {
    assertSafeUserId(userId);
    return path.join(summariesDir, `${userId}.json`);
  }

  async function writeSummariesAtomically(userId, summaries) {
    const targetPath = getSummariesPath(userId);
    const tempPath = `${targetPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await writeFile(tempPath, `${JSON.stringify(summaries, null, 2)}\n`, "utf8");
      await rename(tempPath, targetPath);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  return {
    async list(userId) {
      assertSafeUserId(userId);
      await ensureDir();
      try {
        const raw = await readFile(getSummariesPath(userId), "utf8");
        const parsed = JSON.parse(raw);
        validateSummaries(parsed);
        return parsed.map(normalizeSummary).sort((left, right) => String(right.endedAt).localeCompare(String(left.endedAt)));
      } catch (error) {
        if (error?.code === "ENOENT") {
          return [];
        }
        throw error;
      }
    },

    async upsert(userId, summary) {
      const existing = await this.list(userId);
      const normalized = normalizeSummary(summary);
      const next = existing.filter((entry) => entry.sessionId !== normalized.sessionId).concat([normalized])
        .sort((left, right) => String(right.endedAt).localeCompare(String(left.endedAt)))
        .slice(0, 24);
      validateSummaries(next);
      await writeSummariesAtomically(userId, next);
      return normalized;
    },
  };
}

