import test from "node:test";
import assert from "node:assert/strict";
import {
  markRelayAiEvent,
  shouldPublishRelayDisconnect,
  shouldStopAfterSilence,
  shouldWaitForRelayCompletion,
  waitForRelayCompletion,
} from "../src/bridge.js";

test("shouldPublishRelayDisconnect ignores expected shutdown states", () => {
  assert.equal(
    shouldPublishRelayDisconnect({ stopped: true, closed: false }, { readyState: WebSocket.OPEN }),
    false,
  );
  assert.equal(
    shouldPublishRelayDisconnect({ stopped: false, closed: true }, { readyState: WebSocket.OPEN }),
    false,
  );
  assert.equal(
    shouldPublishRelayDisconnect({ stopped: false, closed: false }, { readyState: WebSocket.CLOSING }),
    false,
  );
  assert.equal(
    shouldPublishRelayDisconnect({ stopped: false, closed: false }, { readyState: WebSocket.CLOSED }),
    false,
  );
});

test("shouldPublishRelayDisconnect flags unexpected open-socket errors", () => {
  assert.equal(
    shouldPublishRelayDisconnect({ stopped: false, closed: false }, { readyState: WebSocket.OPEN }),
    true,
  );
});

test("relay waits for answer completion after realtime transcript events", async () => {
  const relayState = {
    closed: false,
    answerDone: false,
    transcriptSeen: false,
    turnCommittedSeen: false,
    completionWaiters: [],
  };

  markRelayAiEvent(relayState, "transcript_final");
  assert.equal(shouldWaitForRelayCompletion(relayState), true);

  const wait = waitForRelayCompletion(relayState, { timeoutMs: 1000 });
  markRelayAiEvent(relayState, "answer_ready");
  await wait;

  assert.equal(relayState.answerDone, true);
  assert.equal(shouldWaitForRelayCompletion(relayState), false);
  assert.equal(relayState.completionWaiters.length, 0);
});

test("relay does not wait when no ASR transcript has arrived", () => {
  assert.equal(
    shouldWaitForRelayCompletion({
      closed: false,
      answerDone: false,
      transcriptSeen: false,
      turnCommittedSeen: false,
      completionWaiters: [],
    }),
    false,
  );
});

test("silence auto-stop is disabled unless a positive threshold is configured", () => {
  assert.equal(shouldStopAfterSilence({ speechDetected: true, silenceFrameCount: 100, threshold: 0 }), false);
  assert.equal(shouldStopAfterSilence({ speechDetected: false, silenceFrameCount: 100, threshold: 40 }), false);
  assert.equal(shouldStopAfterSilence({ speechDetected: true, silenceFrameCount: 39, threshold: 40 }), false);
  assert.equal(shouldStopAfterSilence({ speechDetected: true, silenceFrameCount: 40, threshold: 40 }), true);
});
