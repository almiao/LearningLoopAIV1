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

test("BFF preserves structured upstream stream-start errors before headers are sent", async () => {
  const aiServer = http.createServer((request, response) => {
    if (request.url === "/api/interview/answer-stream") {
      response.writeHead(503, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({
        error: "AI 训练服务当前不可用，请检查模型服务配置或配额后重试。",
        errorMeta: {
          code: "llm_provider_http_error",
          message: "AI 训练服务当前不可用，请检查模型服务配置或配额后重试。",
          retryable: false,
          statusCode: 503,
          source: "llm-provider",
        },
      }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: true }));
  });

  const aiBaseUrl = await listen(aiServer);
  process.env.NODE_ENV = "test";
  process.env.AI_SERVICE_URL = aiBaseUrl;

  const { server } = await import(`../../../bff/src/server.js?test=structured-error-${Date.now()}`);
  const bffBaseUrl = await listen(server);

  try {
    const streamResponse = await fetch(`${bffBaseUrl}/api/interview/answer-stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "stream-structured-error" }),
    });
    assert.equal(streamResponse.status, 503);
    const data = await streamResponse.json();
    assert.equal(data.error, "AI 训练服务当前不可用，请检查模型服务配置或配额后重试。");
    assert.equal(data.errorMeta?.code, "llm_provider_http_error");
    assert.equal(data.errorMeta?.retryable, false);
  } finally {
    await close(server);
    await close(aiServer);
  }
});
