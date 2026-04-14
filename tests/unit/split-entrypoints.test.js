import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("root package scripts default to split entrypoints without legacy aliases", async () => {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(
    await readFile(path.resolve(testDir, "../../package.json"), "utf8")
  );

  assert.equal(pkg.scripts.start, "node scripts/start-services.mjs");
  assert.equal(pkg.scripts.dev, "node scripts/start-services.mjs");
  assert.equal(pkg.scripts.stop, "node scripts/stop-services.mjs");
  assert.equal(pkg.scripts.build, "node scripts/build-project.mjs");
  assert.equal(pkg.scripts.test, "node scripts/test-project.mjs");
  assert.equal("legacy:start" in pkg.scripts, false);
  assert.equal("legacy:dev" in pkg.scripts, false);
  assert.equal("legacy:build" in pkg.scripts, false);
  assert.equal("legacy:test" in pkg.scripts, false);
  assert.equal("legacy:eval:sessions" in pkg.scripts, false);
});
