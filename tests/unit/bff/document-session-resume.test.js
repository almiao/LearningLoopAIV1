import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
const { isResumableDocumentSession } = await import("../../../bff/src/server.js");

const matchingSession = {
  sessionId: "session-1",
  userId: "user-1",
  source: {
    metadata: {
      docPath: "docs/java/example.md",
    },
  },
};

test("document training resumes only sessions with an open probe", () => {
  assert.equal(
    isResumableDocumentSession(
      {
        ...matchingSession,
        currentProbe: "继续回答这一题。",
        turns: [],
      },
      { userId: "user-1", docPath: "docs/java/example.md" },
    ),
    true,
  );
});

test("document training does not resume completed sessions", () => {
  assert.equal(
    isResumableDocumentSession(
      {
        ...matchingSession,
        currentProbe: "",
        turns: [
          {
            role: "tutor",
            kind: "feedback",
            action: "complete",
            content: "本轮训练结束。",
          },
        ],
      },
      { userId: "user-1", docPath: "docs/java/example.md" },
    ),
    false,
  );
});
