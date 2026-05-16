#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import { defaultMaterialsRoot } from "../src/knowledge/custom-material-store.js";
import { migrateLegacyMaterials, normalizeBoolean } from "../src/knowledge/legacy-material-migrator.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const args = {};
  for (const item of argv) {
    const normalized = item.replace(/^--/, "");
    const [key, ...rest] = normalized.split("=");
    args[key] = rest.length ? rest.join("=") : "true";
  }
  return args;
}

function printHelp() {
  console.log([
    "Usage: node scripts/migrate-legacy-materials.mjs [options]",
    "",
    "Options:",
    "  --apply=true|false               Apply changes. Default false (dry run).",
    "  --delete-legacy-document=true|false",
    "                                   Delete legacy document.md after migration. Default false.",
    "  --user-id=<userId>               Migrate one user only.",
    "  --material-id=<materialId>       Migrate one material only.",
    "  --limit=<n>                      Limit scanned materials.",
    "  --materials-root=<path>          Override materials root.",
    "  --backup-root=<path>             Override backup directory.",
    "  --help=true                      Show this help.",
  ].join("\n"));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (normalizeBoolean(args.help, false)) {
    printHelp();
    return;
  }

  const materialsRoot = args["materials-root"]
    ? path.resolve(rootDir, args["materials-root"])
    : defaultMaterialsRoot;
  const apply = normalizeBoolean(args.apply, false);
  const deleteLegacyDocument = normalizeBoolean(args["delete-legacy-document"], false);
  const limit = Number.isFinite(Number(args.limit)) ? Number(args.limit) : Number.POSITIVE_INFINITY;
  const backupRoot = args["backup-root"]
    ? path.resolve(rootDir, args["backup-root"])
    : path.resolve(rootDir, ".omx/migrations/material-v2-backups", new Date().toISOString().replace(/[:.]/g, "-"));

  const summary = await migrateLegacyMaterials({
    materialsRoot,
    userId: String(args["user-id"] || "").trim(),
    materialId: String(args["material-id"] || "").trim(),
    limit,
    apply,
    deleteLegacyDocument,
    backupRoot: apply ? backupRoot : "",
  });

  console.log(JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    materialsRoot,
    backupRoot: apply ? backupRoot : "",
    ...summary,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

