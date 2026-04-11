import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runAutomatedEval } from "../../eval/automated-eval.js";
import { withSplitServices } from "../../helpers/split-services.js";

test("automated eval module writes visible transcript, trace ids, and analysis artifacts", async (t) => {
  const outputDir = path.resolve(process.cwd(), ".omx/test-automated-eval-output");
  fs.rmSync(outputDir, { recursive: true, force: true });

  await withSplitServices(t, async ({ bffBaseUrl }) => {
    const result = await runAutomatedEval({
      bffBaseUrl,
      runs: 1,
      rounds: 4,
      outputDir,
      seed: "ci-seed",
      learnerMode: "heuristic-random"
    });

    assert.equal(result.runs.length, 1);
    const runDir = path.join(outputDir, result.runs[0].runId);
    assert.equal(fs.existsSync(path.join(runDir, "run.json")), true);
    assert.equal(fs.existsSync(path.join(runDir, "visible-transcript.json")), true);
    assert.equal(fs.existsSync(path.join(runDir, "visible-transcript.md")), true);
    assert.equal(fs.existsSync(path.join(runDir, "ui-state-log.json")), true);
    assert.equal(fs.existsSync(path.join(runDir, "analysis.json")), true);
    assert.equal(fs.existsSync(path.join(runDir, "analysis.md")), true);

    const run = JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8"));
    assert.ok(Array.isArray(run.traceIds));
    assert.ok(run.traceIds.length >= 1);
    assert.ok(run.selectedDomain?.id);
    assert.ok(Array.isArray(run.visibleTranscript));
    assert.ok(run.visibleTranscript.length >= 1);
    assert.ok(Array.isArray(run.uiStateLog));
    assert.ok(run.steps.every((step) => step.domainId === run.selectedDomain.id));
    assert.ok(run.analysis?.summary);
    assert.ok(Array.isArray(run.analysis?.suggestions));
  });

  fs.rmSync(outputDir, { recursive: true, force: true });
});
