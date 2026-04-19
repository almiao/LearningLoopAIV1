import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const defaultStateDir = path.resolve(process.cwd(), ".omx/state/superapp-service");

async function ensureDir(directory = defaultStateDir) {
  await mkdir(directory, { recursive: true });
}

async function readJson(filePath, fallback) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function createSuperappFileStore({ stateDir = defaultStateDir } = {}) {
  const remindersPath = path.join(stateDir, "reminders.json");
  const conversationsPath = path.join(stateDir, "conversations.json");

  return {
    async load() {
      await ensureDir(stateDir);
      return {
        reminders: await readJson(remindersPath, {}),
        conversations: await readJson(conversationsPath, {}),
      };
    },

    async saveReminders(reminders) {
      await ensureDir(stateDir);
      await writeJson(remindersPath, reminders);
    },

    async saveConversations(conversations) {
      await ensureDir(stateDir);
      await writeJson(conversationsPath, conversations);
    },
  };
}
