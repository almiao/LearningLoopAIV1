import test from "node:test";
import assert from "node:assert/strict";
import { shouldPublishRelayDisconnect } from "../src/bridge.js";

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
