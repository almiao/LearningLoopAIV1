import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createUserProfileStore } from "../../../src/user/user-profile-store.js";

test("loginOrCreate skips corrupted user profiles instead of blocking all logins", async () => {
  const usersDir = await mkdtemp(path.join(os.tmpdir(), "llai-user-store-"));
  await writeFile(
    path.join(usersDir, "broken-user.json"),
    '{\n  "id": "broken-user",\n  "handle": "broken",\n  "handleKey": "broken"\n}\nnot-json\n',
    "utf8"
  );

  const store = createUserProfileStore({ usersDir });
  const { user, created } = await store.loginOrCreate({
    handle: "healthy_user",
    pin: "1234",
  });

  assert.equal(created, true);
  assert.equal(user.handle, "healthy_user");
});

test("save writes user profiles atomically under concurrent updates", async () => {
  const usersDir = await mkdtemp(path.join(os.tmpdir(), "llai-user-store-"));
  const store = createUserProfileStore({ usersDir });
  const { user } = await store.loginOrCreate({
    handle: "concurrent_user",
    pin: "1234",
  });

  await Promise.all(Array.from({ length: 12 }, async (_, index) => {
    await store.save({
      ...user,
      lastActiveAt: `2026-05-13T00:00:${String(index).padStart(2, "0")}.000Z`,
      targets: {
        [`target-${index}`]: {
          targetBaselineId: "bigtech-java-backend",
        },
      },
    });
  }));

  const raw = await readFile(path.join(usersDir, `${user.id}.json`), "utf8");
  const parsed = JSON.parse(raw);
  assert.equal(parsed.id, user.id);
  assert.equal(Object.keys(parsed.targets).length, 1);
  assert.deepEqual((await readdir(usersDir)).filter((entry) => entry.endsWith(".tmp")), []);
});
