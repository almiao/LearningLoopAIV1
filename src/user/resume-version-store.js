import { createHash, randomUUID } from "node:crypto";

const maxResumeVersions = 12;

function normalizeText(value = "") {
  return String(value || "").replace(/\r\n/g, "\n").trim();
}

function normalizeFileName(value = "") {
  return String(value || "").trim();
}

function buildFingerprint(text = "") {
  return createHash("sha256").update(text).digest("hex");
}

function normalizeResumeVersion(version = {}) {
  if (!version || typeof version !== "object" || Array.isArray(version)) {
    return null;
  }
  const text = normalizeText(version.text);
  if (!text) {
    return null;
  }
  const createdAt = String(version.createdAt || version.savedAt || new Date().toISOString()).trim() || new Date().toISOString();
  return {
    id: String(version.id || randomUUID()).trim() || randomUUID(),
    text,
    fileName: normalizeFileName(version.fileName || version.filename),
    createdAt,
    charCount: Math.max(Number(version.charCount) || text.length, text.length),
    fingerprint: String(version.fingerprint || buildFingerprint(text)).trim() || buildFingerprint(text),
  };
}

export function ensureResumeVersionLibrary(library = {}) {
  const versions = Array.isArray(library?.versions)
    ? library.versions
      .map((item) => normalizeResumeVersion(item))
      .filter(Boolean)
      .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")))
      .slice(0, maxResumeVersions)
    : [];
  const latestVersionId = String(library?.latestVersionId || versions[0]?.id || "").trim();
  return {
    latestVersionId: versions.some((item) => item.id === latestVersionId) ? latestVersionId : (versions[0]?.id || ""),
    versions,
  };
}

export function listResumeVersions(library = {}) {
  return ensureResumeVersionLibrary(library).versions;
}

export function getResumeVersionById(library = {}, versionId = "") {
  const normalizedId = String(versionId || "").trim();
  if (!normalizedId) {
    return null;
  }
  return ensureResumeVersionLibrary(library).versions.find((item) => item.id === normalizedId) || null;
}

export function getLatestResumeVersion(library = {}) {
  const normalized = ensureResumeVersionLibrary(library);
  return getResumeVersionById(normalized, normalized.latestVersionId) || normalized.versions[0] || null;
}

export function saveResumeVersion(library = {}, { text = "", fileName = "" } = {}) {
  const normalizedText = normalizeText(text);
  if (!normalizedText) {
    throw new Error("Resume text is required.");
  }

  const nextVersion = normalizeResumeVersion({
    text: normalizedText,
    fileName,
    createdAt: new Date().toISOString(),
  });
  const existing = ensureResumeVersionLibrary(library).versions;
  const versions = [nextVersion, ...existing].slice(0, maxResumeVersions);
  return {
    latestVersionId: nextVersion.id,
    versions,
    savedVersion: nextVersion,
  };
}
