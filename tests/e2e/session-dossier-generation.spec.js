import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import { sessionReviewScenarios } from "../eval/scenarios.js";
import {
  runSessionReviewScenario,
  writeSessionReviewArtifacts
} from "../eval/session-dossier.js";

test("session review loop produces reviewable artifacts without touching business modules", async () => {
  const scenario = sessionReviewScenarios.find((item) => item.id === "mvcc-rr-boundary");
  const dossier = await runSessionReviewScenario(scenario);

  assert.equal(dossier.scenario.id, "mvcc-rr-boundary");
  assert.ok(dossier.initialSession.currentProbe.length > 0);
  assert.ok(dossier.steps.length >= 2);
  assert.ok(typeof dossier.scorecard.knowledgeClosure === "number");
  assert.ok(Array.isArray(dossier.reviewFlags));

  const outputDir = await mkdtemp(path.join(os.tmpdir(), "llai-session-review-"));
  await writeSessionReviewArtifacts([dossier], { outputDir });

  const markdown = await readFile(path.join(outputDir, "mvcc-rr-boundary.md"), "utf8");
  const json = JSON.parse(await readFile(path.join(outputDir, "mvcc-rr-boundary.json"), "utf8"));

  assert.match(markdown, /MVCC 与 Repeatable Read 边界/);
  assert.match(markdown, /Automatic flags/);
  assert.equal(json.scenario.id, "mvcc-rr-boundary");
  assert.equal(json.steps.length, dossier.steps.length);
});
