import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultRulesDir = path.resolve(__dirname, "../../.omx/user-rules");
const validKinds = new Set(["preference", "constraint"]);
const validPriorities = new Set(["high", "normal"]);
const validScopes = new Set(["global", "document"]);
const safeUserIdPattern = /^[a-zA-Z0-9_-]{1,80}$/;

function assertSafeUserId(userId = "") {
  if (!safeUserIdPattern.test(userId)) {
    throw new Error("Invalid user id.");
  }
}

function normalizeRule(rule = {}) {
  const now = new Date().toISOString();
  return {
    id: String(rule.id || randomUUID()),
    text: String(rule.text || "").trim(),
    kind: validKinds.has(rule.kind) ? rule.kind : "preference",
    priority: validPriorities.has(rule.priority) ? rule.priority : "normal",
    scope: validScopes.has(rule.scope) ? rule.scope : "global",
    docPath: String(rule.docPath || "").trim(),
    source: String(rule.source || "inferred").trim() || "inferred",
    updatedAt: String(rule.updatedAt || now),
  };
}

function validateRules(rules = []) {
  if (!Array.isArray(rules)) {
    throw new Error("User rules must be an array.");
  }
  for (const rule of rules) {
    if (!rule || typeof rule !== "object") {
      throw new Error("User rule is invalid.");
    }
    if (!String(rule.id || "").trim()) {
      throw new Error("User rule id is invalid.");
    }
    if (!String(rule.text || "").trim()) {
      throw new Error("User rule text is invalid.");
    }
    if (!validKinds.has(rule.kind)) {
      throw new Error("User rule kind is invalid.");
    }
    if (!validPriorities.has(rule.priority)) {
      throw new Error("User rule priority is invalid.");
    }
    if (!validScopes.has(rule.scope)) {
      throw new Error("User rule scope is invalid.");
    }
  }
}

export function interactionPreferenceRule(preference = "balanced") {
  const normalized = String(preference || "balanced").trim() || "balanced";
  const textMap = {
    "probe-heavy": "默认先快问快答，再决定是否展开讲解。",
    "balanced": "默认先做一轮平衡式训练，追问和解释都保持适中。",
    "explain-first": "默认先解释，再进入追问和复述。",
  };
  return normalizeRule({
    id: "preferred-interaction-style",
    text: textMap[normalized] || textMap.balanced,
    kind: "preference",
    priority: "high",
    scope: "global",
    source: "user_explicit",
    preferenceValue: normalized,
  });
}

export function resolveInteractionPreferenceFromRules(rules = []) {
  const preferred = (rules || []).find((rule) => rule.id === "preferred-interaction-style");
  if (!preferred) {
    return "";
  }
  if (preferred.text.includes("先解释")) {
    return "explain-first";
  }
  if (preferred.text.includes("快问快答")) {
    return "probe-heavy";
  }
  return "balanced";
}

export function createUserRulesStore({ rulesDir = defaultRulesDir } = {}) {
  async function ensureDir() {
    await mkdir(rulesDir, { recursive: true });
  }

  function getRulesPath(userId) {
    assertSafeUserId(userId);
    return path.join(rulesDir, `${userId}.json`);
  }

  async function writeRulesAtomically(userId, rules) {
    const targetPath = getRulesPath(userId);
    const tempPath = `${targetPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await writeFile(tempPath, `${JSON.stringify(rules, null, 2)}\n`, "utf8");
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
        const raw = await readFile(getRulesPath(userId), "utf8");
        const parsed = JSON.parse(raw);
        validateRules(parsed);
        return parsed.map(normalizeRule);
      } catch (error) {
        if (error?.code === "ENOENT") {
          return [];
        }
        throw error;
      }
    },

    async saveAll(userId, rules) {
      await ensureDir();
      const normalized = rules.map(normalizeRule);
      validateRules(normalized);
      await writeRulesAtomically(userId, normalized);
      return normalized;
    },

    async upsert(userId, rule) {
      const existing = await this.list(userId);
      const normalized = normalizeRule(rule);
      const nextRules = existing.filter((entry) => entry.id !== normalized.id).concat([normalized]);
      await this.saveAll(userId, nextRules);
      return normalized;
    },
  };
}

