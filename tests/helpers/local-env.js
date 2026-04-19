import fs from "node:fs";
import path from "node:path";

export function loadLocalEnv(repoRoot = process.cwd()) {
  const envFile = path.join(repoRoot, ".env.local");
  if (!fs.existsSync(envFile)) {
    return {};
  }

  const content = fs.readFileSync(envFile, "utf8");
  const result = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const equalsIndex = line.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }
    const key = line.slice(0, equalsIndex).trim();
    const value = line.slice(equalsIndex + 1).trim();
    result[key] = value;
  }
  return result;
}
