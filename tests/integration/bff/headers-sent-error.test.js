import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

test("BFF stays alive when a stream handler fails after headers are sent", async () => {
  const aiServer = http.createServer((request, response) => {
    if (request.url === "/api/interview/answer-stream") {
      response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      response.end("event: turn_result\ndata: {not-json}\n\n");
      return;
    }

    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: true }));
  });

  const aiBaseUrl = await listen(aiServer);
  process.env.NODE_ENV = "test";
  process.env.AI_SERVICE_URL = aiBaseUrl;

  const { server } = await import("../../../bff/src/server.js");
  const bffBaseUrl = await listen(server);

  try {
    const streamResponse = await fetch(`${bffBaseUrl}/api/interview/answer-stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "stream-regression" }),
    });
    assert.equal(streamResponse.status, 200);
    await streamResponse.text();

    const healthResponse = await fetch(`${bffBaseUrl}/api/health`);
    assert.equal(healthResponse.status, 200);
    assert.deepEqual(await healthResponse.json(), { ok: true, aiServiceUrl: aiBaseUrl });
  } finally {
    await close(server);
    await close(aiServer);
  }
});
