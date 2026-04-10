import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMemoryProfile } from "./capability-memory.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultProfilesDir = path.resolve(__dirname, "../../.omx/memory-profiles");
const safeProfileIdPattern = /^[a-zA-Z0-9_-]{1,80}$/;

function assertSafeProfileId(profileId) {
  if (!profileId) {
    return;
  }

  if (!safeProfileIdPattern.test(profileId)) {
    throw new Error("Invalid memory profile id.");
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateProfileShape(profile, expectedId = "") {
  if (!isPlainObject(profile)) {
    throw new Error("Memory profile must be an object.");
  }

  assertSafeProfileId(profile.id);
  if (expectedId && profile.id !== expectedId) {
    throw new Error("Memory profile id mismatch.");
  }
  if (typeof profile.sessionsStarted !== "number" || profile.sessionsStarted < 0) {
    throw new Error("Memory profile sessionsStarted is invalid.");
  }
  if (!isPlainObject(profile.abilityItems)) {
    throw new Error("Memory profile abilityItems is invalid.");
  }

  for (const [key, item] of Object.entries(profile.abilityItems)) {
    assertSafeProfileId(key);
    if (!isPlainObject(item)) {
      throw new Error("Memory profile item is invalid.");
    }
    if (item.abilityItemId && item.abilityItemId !== key) {
      throw new Error("Memory profile item id mismatch.");
    }
    if (typeof item.evidenceCount !== "number" || item.evidenceCount < 0) {
      throw new Error("Memory profile evidenceCount is invalid.");
    }
    if (item.state && !["不可判", "weak", "partial", "solid"].includes(item.state)) {
      throw new Error("Memory profile state is invalid.");
    }
    if (item.confidenceLevel && !["high", "medium", "low"].includes(item.confidenceLevel)) {
      throw new Error("Memory profile confidenceLevel is invalid.");
    }
    if (item.derivedPrinciple && typeof item.derivedPrinciple !== "string") {
      throw new Error("Memory profile derivedPrinciple is invalid.");
    }
    if (item.projectedTargets && !Array.isArray(item.projectedTargets)) {
      throw new Error("Memory profile projectedTargets is invalid.");
    }
    if (item.recentStrongEvidence && !Array.isArray(item.recentStrongEvidence)) {
      throw new Error("Memory profile recentStrongEvidence is invalid.");
    }
    if (item.recentConflictingEvidence && !Array.isArray(item.recentConflictingEvidence)) {
      throw new Error("Memory profile recentConflictingEvidence is invalid.");
    }
  }
}

export function createMemoryProfileStore({ profilesDir = defaultProfilesDir } = {}) {
  async function ensureDir() {
    await mkdir(profilesDir, { recursive: true });
  }

  function getProfilePath(profileId) {
    assertSafeProfileId(profileId);
    return path.join(profilesDir, `${profileId}.json`);
  }

  return {
    async getOrCreate(profileId) {
      await ensureDir();

      if (profileId) {
        try {
          const raw = await readFile(getProfilePath(profileId), "utf8");
          const parsed = JSON.parse(raw);
          validateProfileShape(parsed, profileId);
          return parsed;
        } catch (error) {
          if (String(error?.message || "").includes("Invalid memory profile id")) {
            throw error;
          }
          if (error?.code !== "ENOENT") {
            throw new Error(`Failed to load memory profile: ${profileId}`);
          }
        }
      }

      const profile = createMemoryProfile(profileId);
      validateProfileShape(profile, profile.id);
      await writeFile(getProfilePath(profile.id), `${JSON.stringify(profile, null, 2)}\n`, "utf8");
      return profile;
    },

    async save(profile) {
      if (!profile?.id) {
        return;
      }

      await ensureDir();
      validateProfileShape(profile, profile.id);
      await writeFile(getProfilePath(profile.id), `${JSON.stringify(profile, null, 2)}\n`, "utf8");
    }
  };
}
