import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("root package scripts default to split entrypoints without legacy aliases", async () => {
  const pkg = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8")
  );
  const projectToolsSource = await readFile(
    path.join(root, "scripts", "project-tools.mjs"),
    "utf8"
  );

  assert.equal(pkg.scripts.start, "bash start-services.sh");
  assert.equal(pkg.scripts.dev, "bash start-services.sh");
  assert.equal(pkg.scripts.build, "node scripts/project-tools.mjs build");
  assert.equal(pkg.scripts.test, "node scripts/project-tools.mjs test");
  assert.equal(pkg.scripts["eval:auto"], "node scripts/project-tools.mjs eval:auto");
  assert.equal(pkg.scripts["validate:cases"], "node scripts/project-tools.mjs validate:cases");
  assert.equal(pkg.scripts["smoke:split"], "node scripts/project-tools.mjs smoke:split");
  assert.equal(pkg.scripts["dev:superapp"], "npm run dev --prefix superapp-service");
  assert.match(projectToolsSource, /bff\/src\/server\.js/);
  assert.match(projectToolsSource, /superapp-service\/src\/server\.js/);
  assert.match(projectToolsSource, /split-services\.spec\.js/);
  assert.match(projectToolsSource, /parity-flow\.test\.js/);
  assert.match(projectToolsSource, /runAutomatedEval/);
  assert.equal("legacy:start" in pkg.scripts, false);
  assert.equal("legacy:dev" in pkg.scripts, false);
  assert.equal("legacy:build" in pkg.scripts, false);
  assert.equal("legacy:test" in pkg.scripts, false);
  assert.equal("legacy:eval:sessions" in pkg.scripts, false);
  assert.equal("eval:sessions" in pkg.scripts, false);
  assert.doesNotMatch(projectToolsSource, /runSessionReviewBatch/);
  assert.doesNotMatch(projectToolsSource, /LLAI_ENABLE_JS_HEURISTIC_TEST_DOUBLE/);
});
