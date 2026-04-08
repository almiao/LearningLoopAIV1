import test from "node:test";
import assert from "node:assert/strict";
import {
  parseWorkspaceHash,
  buildWorkspaceHash
} from "../../../public/workspace-route.js";

test("workspace route parses empty hash into defaults", () => {
  assert.deepEqual(parseWorkspaceHash(""), {
    page: "overview",
    sessionId: "",
    domainId: "",
    conceptId: "",
    entryMode: "test-first"
  });
});

test("workspace route round-trips route state", () => {
  const hash = buildWorkspaceHash({
    page: "assessment",
    sessionId: "session-123",
    domainId: "java-concurrency",
    conceptId: "aqs-acquire-release",
    entryMode: "learn-first"
  });

  assert.equal(
    hash,
    "#page=assessment&session=session-123&domain=java-concurrency&concept=aqs-acquire-release&mode=learn-first"
  );
  assert.deepEqual(parseWorkspaceHash(hash), {
    page: "assessment",
    sessionId: "session-123",
    domainId: "java-concurrency",
    conceptId: "aqs-acquire-release",
    entryMode: "learn-first"
  });
});
