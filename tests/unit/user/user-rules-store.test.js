import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import {
  createUserRulesStore,
  interactionPreferenceRule,
  resolveInteractionPreferenceFromRules,
} from "../../../src/user/user-rules-store.js";

test("user rules store upserts interaction preference rules", async () => {
  const rulesDir = await mkdtemp(path.join(os.tmpdir(), "llai-user-rules-"));
  const store = createUserRulesStore({ rulesDir });

  await store.upsert("user_1", interactionPreferenceRule("explain-first"));
  const rules = await store.list("user_1");

  assert.equal(rules.length, 1);
  assert.equal(rules[0].id, "preferred-interaction-style");
  assert.equal(resolveInteractionPreferenceFromRules(rules), "explain-first");
});

test("user rules store replaces the previous interaction preference with the latest one", async () => {
  const rulesDir = await mkdtemp(path.join(os.tmpdir(), "llai-user-rules-"));
  const store = createUserRulesStore({ rulesDir });

  await store.upsert("user_1", interactionPreferenceRule("probe-heavy"));
  await store.upsert("user_1", interactionPreferenceRule("balanced"));

  const rules = await store.list("user_1");
  assert.equal(rules.length, 1);
  assert.equal(resolveInteractionPreferenceFromRules(rules), "balanced");
});

