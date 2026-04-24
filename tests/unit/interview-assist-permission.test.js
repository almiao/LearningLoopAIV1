import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("interview assist shows actionable guidance when microphone permission is denied", async () => {
  const workspaceSource = await readFile(`${root}/frontend/components/interview-assist-workspace.js`, "utf8");

  assert.match(workspaceSource, /function isPermissionDeniedError/);
  assert.match(workspaceSource, /revealManualFallback/);
  assert.match(workspaceSource, /麦克风权限被拒绝。请先在浏览器中允许麦克风访问/);
  assert.match(workspaceSource, /manualEntryRef\.current/);
  assert.match(workspaceSource, /assist-manual-entry\" ref=\{manualEntryRef\}/);
});
