import test from "node:test";
import assert from "node:assert/strict";

import { buildApiError, postEventStream } from "../../../frontend/lib/api.js";

test("buildApiError prefers structured backend metadata when present", () => {
  const error = buildApiError({
    error: "raw provider text",
    errorMeta: {
      code: "llm_provider_http_error",
      message: "AI 训练服务当前不可用，请检查模型服务配置或配额后重试。",
      retryable: false,
      statusCode: 503,
      source: "llm-provider",
    },
  });

  assert.equal(error.message, "AI 训练服务当前不可用，请检查模型服务配置或配额后重试。");
  assert.equal(error.code, "llm_provider_http_error");
  assert.equal(error.retryable, false);
  assert.equal(error.statusCode, 503);
  assert.equal(error.source, "llm-provider");
});

test("postEventStream turns SSE error events into structured thrown errors", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(
    'event: trace\ndata: {"traceId":"t1"}\n\nevent: error\ndata: {"error":{"code":"llm_provider_http_error","message":"AI 训练服务当前不可用，请检查模型服务配置或配额后重试。","retryable":false,"statusCode":503,"source":"llm-provider"}}\n\n',
    {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
      },
    }
  );

  try {
    await assert.rejects(
      () => postEventStream("/api/interview/answer-stream", { sessionId: "s1" }, async () => {}),
      (error) => {
        assert.equal(error.message, "AI 训练服务当前不可用，请检查模型服务配置或配额后重试。");
        assert.equal(error.code, "llm_provider_http_error");
        assert.equal(error.retryable, false);
        assert.equal(error.statusCode, 503);
        return true;
      }
    );
  } finally {
    global.fetch = originalFetch;
  }
});
