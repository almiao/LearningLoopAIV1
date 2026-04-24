import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
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
