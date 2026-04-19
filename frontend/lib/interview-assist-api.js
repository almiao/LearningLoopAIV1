const assistBaseUrl =
  process.env.NEXT_PUBLIC_INTERVIEW_ASSIST_API_BASE_URL || "http://127.0.0.1:4200";

async function assistFetch(pathname, options = {}) {
  const response = await fetch(`${assistBaseUrl}${pathname}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
    cache: "no-store",
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || data.detail || "Interview assist request failed");
  }
  return data;
}

export function getInterviewAssistBaseUrl() {
  return assistBaseUrl;
}

export async function createAssistSession(payload) {
  return assistFetch("/api/interview-assist/session", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function ackFirstScreenRendered(payload) {
  return assistFetch("/api/interview-assist/first-screen-rendered", {
    method: "POST",
    body: JSON.stringify(payload),
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
    dataText: dataLines.join("\n"),
  };
}

export async function streamAssistAnswer(payload, onEvent) {
  const response = await fetch(`${assistBaseUrl}/api/interview-assist/answer-stream`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
    cache: "no-store",
  });

  if (!response.ok || !response.body) {
    let data = {};
    try {
      data = await response.json();
    } catch {}
    throw new Error(data.error || data.detail || "Interview assist stream failed");
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
