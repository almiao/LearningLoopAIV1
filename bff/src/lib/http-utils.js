export const port = Number(process.env.PORT || 4000);

export function withCorsHeaders(response, statusCode, extraHeaders = {}) {
  response.writeHead(statusCode, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
    "content-type": "application/json; charset=utf-8",
    ...extraHeaders,
  });
}

export function sendJson(response, statusCode, payload) {
  withCorsHeaders(response, statusCode);
  response.end(JSON.stringify(payload));
}

export function sendErrorJson(response, statusCode, payload) {
  if (response.writableEnded) {
    return;
  }

  if (response.headersSent) {
    response.end();
    return;
  }

  sendJson(response, statusCode, payload);
}

export function sendBuffer(response, statusCode, body, extraHeaders = {}) {
  response.writeHead(statusCode, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
    ...extraHeaders,
  });
  response.end(body);
}

export function buildMissingAssetPlaceholder(assetPath = "") {
  const label = String(assetPath || "knowledge asset")
    .split("/")
    .filter(Boolean)
    .slice(-2)
    .join(" / ")
    .replace(/[<>&"]/g, "");
  return Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" width="960" height="420" viewBox="0 0 960 420" role="img" aria-label="Image unavailable">
  <rect width="960" height="420" fill="#f8fafc"/>
  <rect x="28" y="28" width="904" height="364" rx="18" fill="#ffffff" stroke="#d8dee8" stroke-width="2" stroke-dasharray="10 10"/>
  <text x="480" y="190" text-anchor="middle" font-family="sans-serif" font-size="30" font-weight="700" fill="#475569">Image unavailable</text>
  <text x="480" y="238" text-anchor="middle" font-family="sans-serif" font-size="20" fill="#64748b">${label || "missing source asset"}</text>
</svg>`.trim());
}

export function withStreamHeaders(response, statusCode) {
  response.writeHead(statusCode, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
}

export async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const rawBody = Buffer.concat(chunks).toString("utf8");
  return rawBody ? JSON.parse(rawBody) : {};
}

export async function readRawBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function parseSseEvent(rawEvent) {
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

export function serializeSseEvent(event, payload) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export function buildServiceBaseUrl(request) {
  const host = request.headers.host || `127.0.0.1:${port}`;
  const protocol = String(request.headers["x-forwarded-proto"] || "http").split(",")[0].trim() || "http";
  return `${protocol}://${host}`;
}

export function buildSafeContentDisposition(filename = "original") {
  const raw = String(filename || "original").trim() || "original";
  const asciiFallback = raw
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/["\\]/g, "")
    .replace(/[;]/g, "")
    .trim() || "download";
  const encodedFilename = encodeURIComponent(raw);
  return `inline; filename="${asciiFallback}"; filename*=UTF-8''${encodedFilename}`;
}
