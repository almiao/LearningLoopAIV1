import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("interview assist realtime panel only presents ASR transcript content", async () => {
  const workspaceSource = await readFile(`${root}/frontend/components/interview-assist-workspace.js`, "utf8");

  assert.match(workspaceSource, /assist-live-workspace/);
  assert.match(workspaceSource, /面试官原声转写/);
  assert.match(workspaceSource, /最近两轮上下文/);
  assert.match(workspaceSource, /开始识别后，这里显示实时转写/);
  assert.doesNotMatch(workspaceSource, /我：\{.*Summary\}/);
});

test("interview assist keeps realtime recognition visible on single-screen layouts", async () => {
  const cssSource = await readFile(`${root}/frontend/app/globals.css`, "utf8");

  assert.match(cssSource, /\.assist-live-workspace\s*\{/);
  assert.match(cssSource, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(340px,\s*390px\)/);
  assert.match(cssSource, /\.assist-recognition-panel\s*\{[\s\S]*position:\s*sticky/);
  assert.match(cssSource, /@media\s*\(max-width:\s*1180px\)\s*\{[\s\S]*\.assist-recognition-panel\s*\{[\s\S]*order:\s*-1/);
  assert.doesNotMatch(cssSource, /\.assist-manual-entry\s*\{[\s\S]{0,120}position:\s*absolute/);
});
