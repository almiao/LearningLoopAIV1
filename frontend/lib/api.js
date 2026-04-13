const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || "http://127.0.0.1:4000";

export async function apiFetch(pathname, options = {}) {
  const response = await fetch(`${apiBaseUrl}${pathname}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    },
    cache: "no-store"
  });
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

export async function postEventStream(pathname, payload, onEvent) {
  const response = await fetch(`${apiBaseUrl}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload),
    cache: "no-store"
  });

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
