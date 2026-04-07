import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMemoryProfileStore } from "../../../src/tutor/memory-profile-store.js";

test("memory profile store rejects unsafe profile ids", async () => {
  const profilesDir = await mkdtemp(path.join(os.tmpdir(), "llai-memory-store-"));
  const store = createMemoryProfileStore({ profilesDir });

  await assert.rejects(
    () => store.getOrCreate("../evil"),
    /Invalid memory profile id/
  );
});

test("memory profile store fails loudly on corrupted profile files", async () => {
  const profilesDir = await mkdtemp(path.join(os.tmpdir(), "llai-memory-store-"));
  await writeFile(path.join(profilesDir, "broken-profile.json"), "{not-json}\n", "utf8");
  const store = createMemoryProfileStore({ profilesDir });

  await assert.rejects(
    () => store.getOrCreate("broken-profile"),
    /Failed to load memory profile/
  );
});

test("memory profile store rejects malformed but valid json profiles", async () => {
  const profilesDir = await mkdtemp(path.join(os.tmpdir(), "llai-memory-store-"));
  await writeFile(
    path.join(profilesDir, "shape-broken.json"),
    `${JSON.stringify({ id: "shape-broken", sessionsStarted: "oops", abilityItems: [] })}\n`,
    "utf8"
  );
  const store = createMemoryProfileStore({ profilesDir });

  await assert.rejects(
    () => store.getOrCreate("shape-broken"),
    /Failed to load memory profile/
  );
});
