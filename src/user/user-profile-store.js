import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultUsersDir = path.resolve(__dirname, "../../.omx/user-profiles");
const handlePattern = /^[\p{Letter}\p{Number}_-]{2,40}$/u;
const pinPattern = /^[0-9]{4,12}$/;
const safeUserIdPattern = /^[a-zA-Z0-9_-]{1,80}$/;

function normalizeHandle(handle = "") {
  return String(handle || "").trim();
}

function normalizeHandleKey(handle = "") {
  return normalizeHandle(handle).toLowerCase();
}

function assertSafeUserId(userId = "") {
  if (!safeUserIdPattern.test(userId)) {
    throw new Error("Invalid user id.");
  }
}

function assertValidHandle(handle = "") {
  if (!handlePattern.test(normalizeHandle(handle))) {
    throw new Error("Handle must be 2-40 chars using letters, numbers, _ or -.");
  }
}

function assertValidPin(pin = "") {
  if (!pinPattern.test(String(pin || "").trim())) {
    throw new Error("PIN must be 4-12 digits.");
  }
}

function hashPin(handleKey, pin) {
  return createHash("sha256").update(`${handleKey}:${String(pin).trim()}`).digest("hex");
}

function createUserProfile({ handle, pin }) {
  const normalizedHandle = normalizeHandle(handle);
  const handleKey = normalizeHandleKey(normalizedHandle);
  return {
    id: randomUUID(),
    handle: normalizedHandle,
    handleKey,
    pinHash: hashPin(handleKey, pin),
    memoryProfileId: `mem_${randomUUID().replace(/-/g, "")}`,
    createdAt: new Date().toISOString(),
    lastLoginAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    targets: {}
  };
}

function validateUserShape(user, expectedId = "") {
  if (!user || typeof user !== "object" || Array.isArray(user)) {
    throw new Error("User profile must be an object.");
  }
  assertSafeUserId(user.id);
  if (expectedId && user.id !== expectedId) {
    throw new Error("User id mismatch.");
  }
  assertValidHandle(user.handle);
  if (normalizeHandleKey(user.handle) !== user.handleKey) {
    throw new Error("User handleKey mismatch.");
  }
  if (typeof user.pinHash !== "string" || user.pinHash.length < 32) {
    throw new Error("User pinHash is invalid.");
  }
  if (typeof user.memoryProfileId !== "string" || !user.memoryProfileId.trim()) {
    throw new Error("User memoryProfileId is invalid.");
  }
  if (!user.targets || typeof user.targets !== "object" || Array.isArray(user.targets)) {
    throw new Error("User targets are invalid.");
  }
  if (user.documents !== undefined) {
    if (!user.documents || typeof user.documents !== "object" || Array.isArray(user.documents)) {
      throw new Error("User documents are invalid.");
    }
    if (user.documents.docs !== undefined && (!user.documents.docs || typeof user.documents.docs !== "object" || Array.isArray(user.documents.docs))) {
      throw new Error("User documents docs are invalid.");
    }
  }
}

export function createUserProfileStore({ usersDir = defaultUsersDir } = {}) {
  async function ensureDir() {
    await mkdir(usersDir, { recursive: true });
  }

  function getUserPath(userId) {
    assertSafeUserId(userId);
    return path.join(usersDir, `${userId}.json`);
  }

  async function listUsers() {
    await ensureDir();
    const entries = await readdir(usersDir, { withFileTypes: true });
    const users = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      try {
        const raw = await readFile(path.join(usersDir, entry.name), "utf8");
        const parsed = JSON.parse(raw);
        validateUserShape(parsed, entry.name.replace(/\.json$/, ""));
        users.push(parsed);
      } catch (error) {
        console.warn(
          `Skipping unreadable user profile ${entry.name}: ${error instanceof Error ? error.message : "unknown error"}`
        );
      }
    }
    return users;
  }

  return {
    async loginOrCreate({ handle, pin }) {
      assertValidHandle(handle);
      assertValidPin(pin);
      const normalizedHandle = normalizeHandle(handle);
      const handleKey = normalizeHandleKey(normalizedHandle);
      const existing = (await listUsers()).find((user) => user.handleKey === handleKey);

      if (existing) {
        if (existing.pinHash !== hashPin(handleKey, pin)) {
          throw new Error("Incorrect PIN.");
        }
        existing.lastLoginAt = new Date().toISOString();
        existing.lastActiveAt = existing.lastLoginAt;
        await this.save(existing);
        return { user: existing, created: false };
      }

      const user = createUserProfile({ handle: normalizedHandle, pin });
      await this.save(user);
      return { user, created: true };
    },

    async getById(userId) {
      assertSafeUserId(userId);
      await ensureDir();
      const raw = await readFile(getUserPath(userId), "utf8");
      const parsed = JSON.parse(raw);
      validateUserShape(parsed, userId);
      return parsed;
    },

    async save(user) {
      validateUserShape(user, user.id);
      await ensureDir();
      await writeFile(getUserPath(user.id), `${JSON.stringify(user, null, 2)}\n`, "utf8");
    }
  };
}
