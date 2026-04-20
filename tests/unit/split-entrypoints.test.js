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

  assert.equal(pkg.scripts.start, "bash start-services.sh");
  assert.equal(pkg.scripts.dev, "bash start-services.sh");
  assert.match(pkg.scripts.build, /bff\/src\/server\.js/);
  assert.match(pkg.scripts.build, /superapp-service\/src\/server\.js/);
  assert.match(pkg.scripts.build, /frontend/);
  assert.equal(pkg.scripts["dev:superapp"], "npm run dev --prefix superapp-service");
  assert.match(pkg.scripts.test, /split-services\.spec\.js/);
  assert.match(pkg.scripts.test, /parity-flow\.test\.js/);
  assert.equal("legacy:start" in pkg.scripts, false);
  assert.equal("legacy:dev" in pkg.scripts, false);
  assert.equal("legacy:build" in pkg.scripts, false);
  assert.equal("legacy:test" in pkg.scripts, false);
  assert.equal("legacy:eval:sessions" in pkg.scripts, false);
});
