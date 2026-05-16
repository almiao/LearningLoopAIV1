import { copyFile, mkdir, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { toReadableSourceText } from "../material/material-model.js";
import { sanitizeHtmlForReading } from "../ingestion/url-fetcher.js";
import {
  buildLearningFromMarkdown,
  buildLearningFromText,
  buildRenderDescriptor,
  detectPrimaryFormat,
  normalizeMimeType,
} from "./source-document-format.js";

function normalizeBoolean(value, fallback = false) {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

async function pathExists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function ensureDir(targetPath) {
  await mkdir(targetPath, { recursive: true });
}

function isLegacyMetadata(metadata = {}) {
  return !metadata.primaryFormat || !metadata.source || !metadata.render || !metadata.learning;
}

function buildSourceFromLegacy(metadata = {}, primaryFormat = "unsupported") {
  const originalSource = metadata.originalSource || {};
  const originalStorage = metadata.originalStorage || {};
  return {
    kind: metadata.sourceType === "remote-document" ? "remote-url" : "uploaded-file",
    url: originalSource.url || "",
    mimeType: normalizeMimeType(originalSource.mimeType || "") || "text/plain",
    filename: originalSource.filename || "",
    storedAssetFilename: originalStorage.filename || "",
    snapshotAvailable: Boolean(originalStorage.filename),
  };
}

async function buildRenderSnapshot({
  materialDir,
  source,
  primaryFormat,
}) {
  if (primaryFormat !== "html" || !source.storedAssetFilename) {
    return { html: "", filename: "" };
  }
  const originalPath = path.join(materialDir, source.storedAssetFilename);
  if (!(await pathExists(originalPath))) {
    return { html: "", filename: "" };
  }
  const html = await readFile(originalPath, "utf8");
  return {
    html: sanitizeHtmlForReading(html),
    filename: "rendered.html",
  };
}

function buildLearningFromLegacyMarkdown(markdown = "", title = "") {
  const learning = buildLearningFromMarkdown(markdown, { fallbackTitle: title });
  const normalizedText = learning.text || toReadableSourceText(markdown);
  return {
    text: normalizedText,
    markdown: learning.markdown,
    outline: learning.outline,
    chunkCount: normalizedText
      ? normalizedText.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean).length
      : 0,
    sufficientForQa: normalizedText.length >= 220,
    sufficientForTraining: normalizedText.length >= 220,
    extractionStatus: normalizedText ? "ready" : "failed",
    extractionNotes: normalizedText ? "" : "历史资料回填时未提取到足够文本。",
  };
}

async function backupLegacyMaterial({
  materialDir,
  backupDir,
}) {
  await ensureDir(backupDir);
  for (const filename of ["metadata.json", "document.md"]) {
    const sourcePath = path.join(materialDir, filename);
    if (await pathExists(sourcePath)) {
      await copyFile(sourcePath, path.join(backupDir, filename));
    }
  }
}

export async function inspectLegacyMaterials({
  materialsRoot,
  userId = "",
  materialId = "",
  limit = Infinity,
} = {}) {
  const root = path.resolve(materialsRoot);
  const userDirs = await readdir(root, { withFileTypes: true }).catch(() => []);
  const results = [];
  for (const userEntry of userDirs) {
    if (!userEntry.isDirectory()) {
      continue;
    }
    if (userId && userEntry.name !== userId) {
      continue;
    }
    const userDir = path.join(root, userEntry.name);
    const materialDirs = await readdir(userDir, { withFileTypes: true }).catch(() => []);
    for (const materialEntry of materialDirs) {
      if (!materialEntry.isDirectory()) {
        continue;
      }
      if (materialId && materialEntry.name !== materialId) {
        continue;
      }
      const materialDir = path.join(userDir, materialEntry.name);
      const metadataPath = path.join(materialDir, "metadata.json");
      if (!(await pathExists(metadataPath))) {
        continue;
      }
      const metadata = await readJson(metadataPath);
      const legacy = isLegacyMetadata(metadata) || await pathExists(path.join(materialDir, "document.md"));
      results.push({
        userId: userEntry.name,
        materialId: materialEntry.name,
        materialDir,
        metadata,
        legacy,
      });
      if (results.length >= limit) {
        return results;
      }
    }
  }
  return results;
}

export async function migrateLegacyMaterial({
  materialDir,
  backupRoot = "",
  apply = false,
  deleteLegacyDocument = false,
} = {}) {
  const metadataPath = path.join(materialDir, "metadata.json");
  const metadata = await readJson(metadataPath);
  const legacyDocumentPath = path.join(materialDir, "document.md");
  const hasLegacyDocument = await pathExists(legacyDocumentPath);
  if (!isLegacyMetadata(metadata) && !hasLegacyDocument) {
    return {
      materialDir,
      migrated: false,
      skipped: true,
      reason: "already_migrated",
    };
  }

  const legacyMarkdown = hasLegacyDocument
    ? await readFile(legacyDocumentPath, "utf8")
    : await readFile(path.join(materialDir, metadata.learning?.markdownFilename || "learning.md"), "utf8");
  const primaryFormat = metadata.primaryFormat || detectPrimaryFormat({
    mimeType: metadata.originalSource?.mimeType || "",
    filename: metadata.originalSource?.filename || "",
  });
  const source = buildSourceFromLegacy(metadata, primaryFormat);
  const learning = buildLearningFromLegacyMarkdown(legacyMarkdown, metadata.title || source.filename || "我的资料");
  const renderSnapshot = await buildRenderSnapshot({ materialDir, source, primaryFormat });
  const render = {
    ...buildRenderDescriptor({
      format: primaryFormat,
      hasOriginalPreview: Boolean(source.url || source.storedAssetFilename),
      hasLearningPreview: Boolean(learning.markdown || learning.text),
    }),
    previewable: Boolean(source.url || source.storedAssetFilename),
  };
  const nextMetadata = {
    ...metadata,
    primaryFormat,
    source,
    render,
    learning: {
      markdownFilename: "learning.md",
      textFilename: "learning.txt",
      outlineFilename: "outline.json",
      extractionStatus: learning.extractionStatus,
      sufficientForQa: learning.sufficientForQa,
      sufficientForTraining: learning.sufficientForTraining,
    },
    originalSource: {
      ...(metadata.originalSource || {}),
      previewable: Boolean(render.previewable),
    },
    renderSnapshot: renderSnapshot.filename ? { filename: renderSnapshot.filename } : null,
  };

  if (!apply) {
    return {
      materialDir,
      migrated: true,
      skipped: false,
      primaryFormat,
      deleteLegacyDocument,
      filesToWrite: [
        "learning.md",
        "learning.txt",
        "outline.json",
        "metadata.json",
      ].concat(renderSnapshot.filename ? [renderSnapshot.filename] : []),
    };
  }

  if (backupRoot) {
    const backupDir = path.join(backupRoot, metadata.userId || "unknown-user", metadata.id || path.basename(materialDir));
    await backupLegacyMaterial({ materialDir, backupDir });
  }

  await writeFile(path.join(materialDir, "learning.md"), `${learning.markdown.trim()}\n`, "utf8");
  await writeFile(path.join(materialDir, "learning.txt"), `${learning.text.trim()}\n`, "utf8");
  await writeFile(path.join(materialDir, "outline.json"), `${JSON.stringify(learning.outline, null, 2)}\n`, "utf8");
  if (renderSnapshot.filename) {
    await writeFile(path.join(materialDir, renderSnapshot.filename), renderSnapshot.html, "utf8");
  }
  await writeFile(metadataPath, `${JSON.stringify(nextMetadata, null, 2)}\n`, "utf8");

  if (deleteLegacyDocument && hasLegacyDocument) {
    await unlink(legacyDocumentPath);
  }

  return {
    materialDir,
    migrated: true,
    skipped: false,
    primaryFormat,
    deletedLegacyDocument: deleteLegacyDocument && hasLegacyDocument,
  };
}

export async function migrateLegacyMaterials({
  materialsRoot,
  userId = "",
  materialId = "",
  limit = Infinity,
  apply = false,
  deleteLegacyDocument = false,
  backupRoot = "",
} = {}) {
  const candidates = await inspectLegacyMaterials({ materialsRoot, userId, materialId, limit });
  const legacyCandidates = candidates.filter((item) => item.legacy);
  const results = [];
  for (const candidate of legacyCandidates) {
    results.push(await migrateLegacyMaterial({
      materialDir: candidate.materialDir,
      backupRoot,
      apply,
      deleteLegacyDocument,
    }));
  }
  return {
    scanned: candidates.length,
    legacyCount: legacyCandidates.length,
    migratedCount: results.filter((item) => item.migrated && !item.skipped).length,
    skippedCount: results.filter((item) => item.skipped).length,
    results,
  };
}

export async function resetMigrationBackup(backupRoot = "") {
  if (!backupRoot || !(await pathExists(backupRoot))) {
    return;
  }
  await rm(backupRoot, { recursive: true, force: true });
}

export { normalizeBoolean };

