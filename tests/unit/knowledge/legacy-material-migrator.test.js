import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { createCustomMaterialStore } from "../../../src/knowledge/custom-material-store.js";
import { migrateLegacyMaterial, migrateLegacyMaterials } from "../../../src/knowledge/legacy-material-migrator.js";

async function seedLegacyMaterial({
  root,
  userId,
  materialId,
  title,
  markdown,
  originalFilename,
  originalMimeType,
  originalBody = "",
  sourceType = "uploaded-file",
  originalUrl = "",
} = {}) {
  const materialDir = path.join(root, userId, materialId);
  await rm(materialDir, { recursive: true, force: true });
  await mkdir(materialDir, { recursive: true });
  await writeFile(path.join(materialDir, "document.md"), `${markdown.trim()}\n`, "utf8");
  await writeFile(path.join(materialDir, "metadata.json"), `${JSON.stringify({
    id: materialId,
    userId,
    path: `materials/${materialId}`,
    title,
    sourceType,
    provider: "user-material",
    providerLabel: "我的资料",
    originalSource: {
      kind: sourceType,
      url: originalUrl,
      viewUrl: originalUrl || `/api/materials/original?userId=${encodeURIComponent(userId)}&path=${encodeURIComponent(`materials/${materialId}`)}`,
      filename: originalFilename,
      mimeType: originalMimeType,
      previewable: true,
    },
    originalStorage: originalBody ? { filename: originalFilename } : null,
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
  }, null, 2)}\n`, "utf8");
  if (originalBody) {
    await writeFile(path.join(materialDir, originalFilename), originalBody, "utf8");
  }
  return materialDir;
}

test("legacy text material migrates to learning files and works without document.md", async () => {
  const materialsRoot = await mkdtemp(path.join(tmpdir(), "llai-legacy-migrate-"));
  try {
    const userId = "legacy_user";
    const materialId = "11111111-2222-4333-8444-555555555555";
    const materialDir = await seedLegacyMaterial({
      root: materialsRoot,
      userId,
      materialId,
      title: "redis-notes",
      markdown: `
# redis-notes

Redis persistence has two common approaches. RDB snapshots compact data periodically and are efficient for full backups.

AOF logs append write operations and can reduce data loss windows at the cost of more write amplification.

Replication and failover complement persistence by improving availability when a node fails.
      `,
      originalFilename: "redis-notes.txt",
      originalMimeType: "text/plain",
      originalBody: "Redis original text body",
    });

    const dryRun = await migrateLegacyMaterial({ materialDir, apply: false, deleteLegacyDocument: true });
    assert.equal(dryRun.migrated, true);
    assert.deepEqual(dryRun.filesToWrite.sort(), ["learning.md", "learning.txt", "metadata.json", "outline.json"].sort());

    const backupRoot = path.join(materialsRoot, "_backups");
    const applied = await migrateLegacyMaterial({
      materialDir,
      apply: true,
      deleteLegacyDocument: true,
      backupRoot,
    });
    assert.equal(applied.deletedLegacyDocument, true);

    const store = createCustomMaterialStore({ materialsRoot });
    const document = await store.readMaterial(userId, `materials/${materialId}`);
    assert.equal(document.primaryFormat, "text");
    assert.equal(document.render.format, "text");
    assert.match(document.learning.text, /RDB snapshots compact data periodically/);
    await assert.rejects(() => readFile(path.join(materialDir, "document.md"), "utf8"));
    assert.match(await readFile(path.join(materialDir, "learning.md"), "utf8"), /# redis-notes/);
    assert.match(await readFile(path.join(backupRoot, userId, materialId, "document.md"), "utf8"), /# redis-notes/);
  } finally {
    await rm(materialsRoot, { recursive: true, force: true });
  }
});

test("legacy html material creates rendered html snapshot during migration", async () => {
  const materialsRoot = await mkdtemp(path.join(tmpdir(), "llai-legacy-html-"));
  try {
    const userId = "legacy_html_user";
    const materialId = "66666666-2222-4333-8444-555555555555";
    const materialDir = await seedLegacyMaterial({
      root: materialsRoot,
      userId,
      materialId,
      title: "redis-html",
      markdown: `
# redis-html

Redis uses RDB and AOF.
      `,
      originalFilename: "redis.html",
      originalMimeType: "text/html",
      originalBody: "<html><body><h1>Redis</h1><script>alert(1)</script><p>RDB and AOF</p></body></html>",
    });

    const summary = await migrateLegacyMaterials({
      materialsRoot,
      userId,
      apply: true,
      deleteLegacyDocument: true,
      backupRoot: path.join(materialsRoot, "_backups"),
    });
    assert.equal(summary.migratedCount, 1);

    const metadata = JSON.parse(await readFile(path.join(materialDir, "metadata.json"), "utf8"));
    assert.equal(metadata.primaryFormat, "html");
    assert.equal(metadata.render.format, "html");
    assert.equal(metadata.renderSnapshot.filename, "rendered.html");
    const rendered = await readFile(path.join(materialDir, "rendered.html"), "utf8");
    assert.match(rendered, /<article>/);
    assert.doesNotMatch(rendered, /<script>/);
  } finally {
    await rm(materialsRoot, { recursive: true, force: true });
  }
});
