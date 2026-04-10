import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("root package scripts default to split entrypoints and keep legacy aliases explicit", async () => {
  const pkg = JSON.parse(
    await readFile("/Users/lee/IdeaProjects/LearningLoopAIV1/package.json", "utf8")
  );

  assert.equal(pkg.scripts.start, "bash start-services.sh");
  assert.equal(pkg.scripts.dev, "bash start-services.sh");
  assert.match(pkg.scripts.build, /bff\/src\/server\.js/);
  assert.match(pkg.scripts.build, /frontend/);
  assert.match(pkg.scripts.test, /split-services\.spec\.js/);
  assert.match(pkg.scripts.test, /parity-flow\.test\.js/);
  assert.equal(pkg.scripts["legacy:start"], "node src/server.js");
  assert.equal(pkg.scripts["legacy:dev"], "node --watch src/server.js");
  assert.equal(pkg.scripts["legacy:build"], "node scripts/build-check.mjs");
  assert.match(pkg.scripts["legacy:test"], /tests\/integration\/tutor/);
  assert.equal(pkg.scripts["legacy:eval:sessions"], "node scripts/generate-session-dossiers.mjs");
});
