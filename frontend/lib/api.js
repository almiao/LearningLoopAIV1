function resolveApiBaseUrl() {
  const configured = String(process.env.NEXT_PUBLIC_API_BASE_URL || "").trim();
  if (configured) {
    return configured;
  }
  if (typeof window !== "undefined" && window.location?.origin) {
    return window.location.origin;
  }
  return "http://127.0.0.1:4000";
}

export const apiBaseUrl = resolveApiBaseUrl();

function isFetchNetworkError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return message.includes("failed to fetch") || message.includes("networkerror") || message.includes("load failed");
}

function createServiceUnavailableError() {
  return new Error("服务暂时连接不上，请确认后端服务正在运行后重试。");
}

export function buildApiUrl(pathname = "") {
  const normalizedPath = String(pathname || "").trim();
  if (!normalizedPath) {
    return apiBaseUrl;
  }
  if (/^https?:\/\//i.test(normalizedPath)) {
    return normalizedPath;
  }
  return `${apiBaseUrl}${normalizedPath.startsWith("/") ? normalizedPath : `/${normalizedPath}`}`;
}

export async function apiFetch(pathname, options = {}) {
  const isFormDataBody = typeof FormData !== "undefined" && options.body instanceof FormData;
  const defaultHeaders = isFormDataBody ? {} : { "content-type": "application/json" };
  let response;
  try {
    response = await fetch(buildApiUrl(pathname), {
      ...options,
      headers: {
        ...defaultHeaders,
        ...(options.headers || {})
      },
      cache: "no-store"
    });
  } catch (error) {
    throw isFetchNetworkError(error) ? createServiceUnavailableError() : error;
  }
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Request failed");
  }
  return data;
}

export async function postJson(pathname, payload) {
  return apiFetch(pathname, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

function parseSseEvent(rawEvent) {
  const lines = String(rawEvent || "").split(/\r?\n/);
  let event = "message";
  const dataLines = [];
  for (const line of lines) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }
  return {
    event,
    dataText: dataLines.join("\n")
  };
}

export async function postEventStream(pathname, payload, onEvent, options = {}) {
  let response;
  try {
    response = await fetch(buildApiUrl(pathname), {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: options.signal,
    });
  } catch (error) {
    throw isFetchNetworkError(error) ? createServiceUnavailableError() : error;
  }

  if (!response.ok || !response.body) {
    let data = {};
    try {
      data = await response.json();
    } catch {}
    throw new Error(data.error || data.detail || "Request failed");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const { event, dataText } = parseSseEvent(rawEvent);
      const data = dataText ? JSON.parse(dataText) : {};
      await onEvent(event, data);
      boundary = buffer.indexOf("\n\n");
    }
  }

  if (buffer.trim()) {
    const { event, dataText } = parseSseEvent(buffer);
    const data = dataText ? JSON.parse(dataText) : {};
    await onEvent(event, data);
  }
}
