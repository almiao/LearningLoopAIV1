import { listBuiltInDocuments, readBuiltInAsset, readBuiltInDocument } from "./built-in-document-provider.js";
import { createCustomMaterialStore, normalizeMaterialPath } from "./custom-material-store.js";

const customMaterialStore = createCustomMaterialStore();

export function normalizeSourceDocumentPath(inputPath = "") {
  const raw = decodeURIComponent(String(inputPath || "").trim()).replace(/^\/+/, "");
  if (!raw) {
    return "";
  }
  if (raw.startsWith("materials/")) {
    return normalizeMaterialPath(raw);
  }
  if (raw.includes("..")) {
    throw new Error("Source document path is invalid.");
  }
  return raw.startsWith("docs/") ? raw : `docs/${raw}`;
}

export function isCustomMaterialPath(inputPath = "") {
  return normalizeSourceDocumentPath(inputPath).startsWith("materials/");
}

export async function listSourceDocuments({ userId = "" } = {}) {
  const builtInDocuments = await listBuiltInDocuments();
  if (!userId) {
    return builtInDocuments;
  }
  const materials = await customMaterialStore.listMaterials(userId);
  return [...materials, ...builtInDocuments];
}

export async function readSourceDocument(docPath, {
  userId = "",
  serviceBaseUrl = "",
} = {}) {
  const normalizedPath = normalizeSourceDocumentPath(docPath);
  if (!normalizedPath) {
    throw new Error("Source document path is required.");
  }
  if (normalizedPath.startsWith("materials/")) {
    if (!userId) {
      throw new Error("userId is required for user material documents.");
    }
    return customMaterialStore.readMaterial(userId, normalizedPath);
  }
  return readBuiltInDocument(normalizedPath, { serviceBaseUrl });
}

export async function readSourceAsset(assetPath) {
  return readBuiltInAsset(assetPath);
}

export async function saveCustomMaterial(input) {
  return customMaterialStore.saveMaterial(input);
}

export async function listCustomMaterials(userId) {
  return customMaterialStore.listMaterials(userId);
}

export async function readCustomMaterialOriginal(userId, materialPath) {
  return customMaterialStore.readOriginal(userId, materialPath);
}

export async function readCustomMaterialRender(userId, materialPath) {
  return customMaterialStore.readRender(userId, materialPath);
}
