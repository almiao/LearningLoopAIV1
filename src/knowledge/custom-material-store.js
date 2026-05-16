import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { toReadableSourceText } from "../material/material-model.js";
import { buildSelfSourceRef } from "./source-refs.js";
import { buildRenderDescriptor, detectPrimaryFormat, normalizeMimeType } from "./source-document-format.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultMaterialsRoot = path.resolve(__dirname, "../../.omx/user-materials");
const safeUserIdPattern = /^[a-zA-Z0-9_-]{1,80}$/;
const safeMaterialIdPattern = /^[a-f0-9-]{36}$/i;
function normalizeSlashes(value = "") {
  return String(value || "").replace(/\\/g, "/");
}

function assertSafeUserId(userId = "") {
  if (!safeUserIdPattern.test(String(userId || ""))) {
    throw new Error("Invalid user id.");
  }
}

function assertSafeMaterialId(materialId = "") {
  if (!safeMaterialIdPattern.test(String(materialId || ""))) {
    throw new Error("Invalid material id.");
  }
}

export function normalizeMaterialPath(inputPath = "") {
  const raw = normalizeSlashes(inputPath).trim().replace(/^\/+/, "");
  const decoded = decodeURIComponent(raw);
  const normalized = path.posix.normalize(decoded);
  if (!normalized.startsWith("materials/")) {
    throw new Error("Material path must start with materials/.");
  }
  if (normalized === "materials" || normalized === "materials/" || normalized.includes("..")) {
    throw new Error("Material path is invalid.");
  }
  const materialId = normalized.slice("materials/".length).split("/")[0];
  assertSafeMaterialId(materialId);
  return `materials/${materialId}`;
}

function sanitizeFilename(filename = "") {
  const base = path.basename(normalizeSlashes(filename).replace(/\0/g, "")) || "original";
  return base.replace(/[^\p{Letter}\p{Number}._ -]/gu, "_").slice(0, 160) || "original";
}

function materialIdFromPath(materialPath = "") {
  return normalizeMaterialPath(materialPath).slice("materials/".length);
}

export function createCustomMaterialStore({ materialsRoot = defaultMaterialsRoot } = {}) {
  const root = path.resolve(materialsRoot);

  async function ensureUserDir(userId) {
    assertSafeUserId(userId);
    const userDir = path.join(root, userId);
    await mkdir(userDir, { recursive: true });
    return userDir;
  }

  async function getMaterialDir(userId, materialId) {
    const userDir = await ensureUserDir(userId);
    assertSafeMaterialId(materialId);
    return path.join(userDir, materialId);
  }

  async function readMetadata(userId, materialId) {
    const materialDir = await getMaterialDir(userId, materialId);
    const raw = await readFile(path.join(materialDir, "metadata.json"), "utf8");
    const metadata = JSON.parse(raw);
    if (metadata.userId !== userId || metadata.id !== materialId) {
      throw new Error("Material owner mismatch.");
    }
    return metadata;
  }

  function buildSourceViewUrls(metadata) {
    const originalPath = `/api/materials/original?userId=${encodeURIComponent(metadata.userId)}&path=${encodeURIComponent(metadata.path)}`;
    const renderPath = `/api/materials/render?userId=${encodeURIComponent(metadata.userId)}&path=${encodeURIComponent(metadata.path)}`;
    const format = metadata.primaryFormat;
    if (format === "html" && metadata.renderSnapshot?.filename) {
      return {
        viewUrl: renderPath,
        fallbackUrl: originalPath,
      };
    }
    if (metadata.source?.url && !metadata.originalStorage?.filename) {
      return {
        viewUrl: metadata.source.url,
        fallbackUrl: metadata.source.url,
      };
    }
    return {
      viewUrl: originalPath,
      fallbackUrl: metadata.source?.url || originalPath,
    };
  }

  function projectDocument(metadata, learning) {
    const { viewUrl, fallbackUrl } = buildSourceViewUrls(metadata);
    const format = metadata.primaryFormat;
    const render = {
      ...buildRenderDescriptor({
        format,
        hasOriginalPreview: Boolean(metadata.render?.previewable),
        hasLearningPreview: Boolean(learning?.markdown || learning?.text),
      }),
      ...(metadata.render || {}),
      viewUrl,
      fallbackUrl,
    };
    const document = {
      path: metadata.path,
      title: metadata.title,
      markdown: learning?.markdown || "",
      primaryFormat: format,
      sourceType: metadata.sourceType,
      provider: "user-material",
      providerLabel: "我的资料",
      source: metadata.source,
      render,
      learning,
      originalSource: {
        ...(metadata.originalSource || {}),
        viewUrl,
      },
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
    };
    const selfRef = buildSelfSourceRef(document);
    return {
      ...document,
      sourceRefs: selfRef ? [selfRef] : [],
    };
  }

  return {
    async saveMaterial({
      userId,
      title,
      markdown,
      primaryFormat = "",
      render = null,
      learning = null,
      renderSnapshotHtml = "",
      sourceType,
      originalUrl = "",
      originalFilename = "",
      originalMimeType = "",
      originalBytes = null,
    }) {
      assertSafeUserId(userId);
      const normalizedMimeType = normalizeMimeType(originalMimeType || "");
      const normalizedPrimaryFormat = primaryFormat || detectPrimaryFormat({
        mimeType: normalizedMimeType,
        filename: originalFilename,
      });
      const fallbackMarkdown = String(markdown || "").trim();
      const normalizedLearning = {
        text: String(learning?.text || "").trim() || toReadableSourceText(learning?.markdown || fallbackMarkdown),
        markdown: String(learning?.markdown || fallbackMarkdown).trim(),
        outline: Array.isArray(learning?.outline) ? learning.outline : [],
        chunkCount: Number.isFinite(learning?.chunkCount) ? learning.chunkCount : 0,
        sufficientForQa: Boolean(learning?.sufficientForQa ?? (String(learning?.text || "").trim() || toReadableSourceText(learning?.markdown || fallbackMarkdown)).length >= 220),
        sufficientForTraining: Boolean(learning?.sufficientForTraining ?? (String(learning?.text || "").trim() || toReadableSourceText(learning?.markdown || fallbackMarkdown)).length >= 220),
        extractionStatus: learning?.extractionStatus || "ready",
        extractionNotes: String(learning?.extractionNotes || "").trim(),
      };
      if (!normalizedLearning.markdown) {
        throw new Error("Material learning markdown is required.");
      }
      const id = randomUUID();
      const materialDir = await getMaterialDir(userId, id);
      await mkdir(materialDir, { recursive: true });
      const pathValue = `materials/${id}`;
      const filename = sanitizeFilename(originalFilename || `${id}.txt`);
      const originalPath = path.join(materialDir, filename);
      if (originalBytes) {
        await writeFile(originalPath, originalBytes);
      }
      const learningMarkdownFilename = "learning.md";
      const learningTextFilename = "learning.txt";
      const outlineFilename = "outline.json";
      const renderSnapshotFilename = renderSnapshotHtml ? "rendered.html" : "";
      if (renderSnapshotFilename) {
        await writeFile(path.join(materialDir, renderSnapshotFilename), renderSnapshotHtml, "utf8");
      }
      const timestamp = new Date().toISOString();
      const baseRender = render || buildRenderDescriptor({
        format: normalizedPrimaryFormat,
        hasOriginalPreview: Boolean(originalBytes || originalUrl),
        hasLearningPreview: Boolean(normalizedLearning.markdown || normalizedLearning.text),
      });
      const metadata = {
        id,
        userId,
        path: pathValue,
        title: String(title || filename || "我的资料").trim(),
        sourceType,
        primaryFormat: normalizedPrimaryFormat,
        provider: "user-material",
        providerLabel: "我的资料",
        source: {
          kind: sourceType === "remote-document" ? "remote-url" : "uploaded-file",
          url: originalUrl || "",
          mimeType: normalizedMimeType || "text/plain",
          filename,
          storedAssetFilename: originalBytes ? filename : "",
          snapshotAvailable: Boolean(originalBytes),
        },
        render: {
          ...baseRender,
          previewable: Boolean(baseRender.previewable),
        },
        learning: {
          markdownFilename: learningMarkdownFilename,
          textFilename: learningTextFilename,
          outlineFilename,
          extractionStatus: normalizedLearning.extractionStatus,
          sufficientForQa: normalizedLearning.sufficientForQa,
          sufficientForTraining: normalizedLearning.sufficientForTraining,
        },
        originalSource: {
          kind: sourceType,
          url: originalUrl || "",
          filename,
          mimeType: normalizedMimeType || "text/plain",
          previewable: Boolean(baseRender.previewable),
        },
        originalStorage: originalBytes ? { filename } : null,
        renderSnapshot: renderSnapshotFilename ? { filename: renderSnapshotFilename } : null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await writeFile(path.join(materialDir, learningMarkdownFilename), `${normalizedLearning.markdown.trim()}\n`, "utf8");
      await writeFile(path.join(materialDir, learningTextFilename), `${normalizedLearning.text}\n`, "utf8");
      await writeFile(path.join(materialDir, outlineFilename), `${JSON.stringify(normalizedLearning.outline, null, 2)}\n`, "utf8");
      await writeFile(path.join(materialDir, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
      return projectDocument(metadata, normalizedLearning);
    },

    async listMaterials(userId) {
      assertSafeUserId(userId);
      const userDir = await ensureUserDir(userId);
      const entries = await readdir(userDir, { withFileTypes: true });
      const materials = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        try {
          const metadata = await readMetadata(userId, entry.name);
          materials.push({
            path: metadata.path,
            title: metadata.title,
            sourceType: metadata.sourceType,
            primaryFormat: metadata.primaryFormat || metadata.render?.format || "unsupported",
            provider: metadata.provider,
            providerLabel: metadata.providerLabel,
            render: metadata.render,
            learning: {
              extractionStatus: metadata.learning?.extractionStatus || "ready",
              sufficientForQa: Boolean(metadata.learning?.sufficientForQa),
              sufficientForTraining: Boolean(metadata.learning?.sufficientForTraining),
            },
            originalSource: metadata.originalSource,
            createdAt: metadata.createdAt,
            updatedAt: metadata.updatedAt,
          });
        } catch {}
      }
      return materials.sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
    },

    async readMaterial(userId, materialPath) {
      assertSafeUserId(userId);
      const materialId = materialIdFromPath(materialPath);
      const metadata = await readMetadata(userId, materialId);
      const materialDir = await getMaterialDir(userId, materialId);
      const learningMarkdownPath = path.join(materialDir, metadata.learning?.markdownFilename || "learning.md");
      const learningTextPath = path.join(materialDir, metadata.learning?.textFilename || "learning.txt");
      const outlinePath = path.join(materialDir, metadata.learning?.outlineFilename || "outline.json");
      const [markdown, text, outlineRaw] = await Promise.all([
        readFile(learningMarkdownPath, "utf8"),
        readFile(learningTextPath, "utf8").catch(() => ""),
        readFile(outlinePath, "utf8").catch(() => "[]"),
      ]);
      const normalizedMarkdown = String(markdown || "").trim();
      const normalizedText = String(text || "").trim();
      return projectDocument(metadata, {
        text: normalizedText,
        markdown: normalizedMarkdown,
        outline: JSON.parse(outlineRaw || "[]"),
        chunkCount: 0,
        sufficientForQa: Boolean(metadata.learning?.sufficientForQa),
        sufficientForTraining: Boolean(metadata.learning?.sufficientForTraining),
        extractionStatus: metadata.learning?.extractionStatus || "ready",
        extractionNotes: "",
      });
    },

    async readOriginal(userId, materialPath) {
      assertSafeUserId(userId);
      const materialId = materialIdFromPath(materialPath);
      const metadata = await readMetadata(userId, materialId);
      if (!metadata.originalStorage?.filename && metadata.originalSource?.url) {
        return {
          redirectUrl: metadata.originalSource.url,
          mimeType: "text/plain",
          body: Buffer.alloc(0),
          filename: metadata.originalSource.filename || "source",
        };
      }
      if (!metadata.originalStorage?.filename) {
        throw new Error("Original material is not available.");
      }
      const materialDir = await getMaterialDir(userId, materialId);
      const filename = sanitizeFilename(metadata.originalStorage.filename);
      return {
        mimeType: metadata.originalSource?.mimeType || "application/octet-stream",
        filename,
        body: await readFile(path.join(materialDir, filename)),
      };
    },

    async readRender(userId, materialPath) {
      assertSafeUserId(userId);
      const materialId = materialIdFromPath(materialPath);
      const metadata = await readMetadata(userId, materialId);
      if (!metadata.renderSnapshot?.filename) {
        throw new Error("Rendered material is not available.");
      }
      const materialDir = await getMaterialDir(userId, materialId);
      const filename = sanitizeFilename(metadata.renderSnapshot.filename);
      return {
        mimeType: "text/html; charset=utf-8",
        filename,
        body: await readFile(path.join(materialDir, filename)),
      };
    },
  };
}

export { defaultMaterialsRoot };
