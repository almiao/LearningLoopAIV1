export const aiServiceUrl = process.env.AI_SERVICE_URL || "http://127.0.0.1:8000";

export const ttsServiceUrl = process.env.TTS_SERVICE_URL || "http://127.0.0.1:4300";

export async function proxyJson(method, pathname, payload) {
  const response = await fetch(`${aiServiceUrl}${pathname}`, {
    method,
    headers: {
      "content-type": "application/json",
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });

  const rawText = await response.text();
  let data;
  try {
    data = rawText ? JSON.parse(rawText) : {};
  } catch {
    data = { error: rawText || "Downstream AI service returned invalid JSON." };
  }
  if (!response.ok) {
    throw new Error(data.detail || data.error || "Downstream AI service request failed.");
  }
  return {
    data,
    traceId: response.headers.get("x-trace-id") || ""
  };
}

export async function proxyJsonToService(baseUrl, method, pathname, payload) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      "content-type": "application/json",
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });

  const rawText = await response.text();
  let data;
  try {
    data = rawText ? JSON.parse(rawText) : {};
  } catch {
    data = { error: rawText || "Downstream service returned invalid JSON." };
  }
  if (!response.ok) {
    throw new Error(data.detail || data.error || "Downstream service request failed.");
  }
  return data;
}

export async function proxyBinary(baseUrl, method, pathname, payload) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      "content-type": "application/json",
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });

  if (!response.ok) {
    const rawText = await response.text();
    let data;
    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch {
      data = { error: rawText || "Downstream AI service request failed." };
    }
    throw new Error(data.detail || data.error || "Downstream AI service request failed.");
  }

  return {
    body: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get("content-type") || "application/octet-stream",
    traceId: response.headers.get("x-trace-id") || "",
    provider: response.headers.get("x-loopassist-tts-provider") || "",
    speaker: response.headers.get("x-loopassist-tts-speaker") || "",
  };
}
