export function parseWorkspaceHash(hash = "") {
  const normalized = String(hash || "").replace(/^#/, "").trim();
  const params = new URLSearchParams(normalized);

  return {
    page: params.get("page") || "overview",
    sessionId: params.get("session") || "",
    domainId: params.get("domain") || "",
    conceptId: params.get("concept") || "",
    entryMode: params.get("mode") || "test-first"
  };
}

export function buildWorkspaceHash({
  page = "overview",
  sessionId = "",
  domainId = "",
  conceptId = "",
  entryMode = "test-first"
} = {}) {
  const params = new URLSearchParams();
  params.set("page", page);
  if (sessionId) {
    params.set("session", sessionId);
  }
  if (domainId) {
    params.set("domain", domainId);
  }
  if (conceptId) {
    params.set("concept", conceptId);
  }
  if (entryMode && entryMode !== "test-first") {
    params.set("mode", entryMode);
  }

  return `#${params.toString()}`;
}
