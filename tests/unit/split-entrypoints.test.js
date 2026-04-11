import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("root package scripts default to split entrypoints without legacy aliases", async () => {
  const pkg = JSON.parse(
    await readFile("/Users/lee/IdeaProjects/LearningLoopAIV1/package.json", "utf8")
  );

  assert.equal(pkg.scripts.start, "bash start-services.sh");
  assert.equal(pkg.scripts.dev, "bash start-services.sh");
  assert.match(pkg.scripts.build, /bff\/src\/server\.js/);
  assert.match(pkg.scripts.build, /frontend/);
  assert.match(pkg.scripts.test, /split-services\.spec\.js/);
  assert.match(pkg.scripts.test, /parity-flow\.test\.js/);
  assert.equal("legacy:start" in pkg.scripts, false);
  assert.equal("legacy:dev" in pkg.scripts, false);
  assert.equal("legacy:build" in pkg.scripts, false);
  assert.equal("legacy:test" in pkg.scripts, false);
  assert.equal("legacy:eval:sessions" in pkg.scripts, false);
});
