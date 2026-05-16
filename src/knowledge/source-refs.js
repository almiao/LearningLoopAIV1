export function normalizeSourceRef(source = {}) {
  if (typeof source === "string") {
    return {
      path: source,
      title: "",
      sourceType: source.startsWith("materials/") ? "user-material" : "built-in-document",
      provider: source.startsWith("materials/") ? "user-material" : "built-in-corpus",
    };
  }

  const path = String(source?.path || source?.docPath || "").trim();
  if (!path) {
    return null;
  }

  const isMaterial = path.startsWith("materials/");
  return {
    path,
    title: String(source.title || source.docTitle || path).trim(),
    sourceType: source.sourceType || (isMaterial ? "user-material" : "built-in-document"),
    provider: source.provider || (isMaterial ? "user-material" : "built-in-corpus"),
    ...(source.providerLabel ? { providerLabel: source.providerLabel } : {}),
    ...(source.originalUrl ? { originalUrl: source.originalUrl } : {}),
    ...(source.originalMimeType ? { originalMimeType: source.originalMimeType } : {}),
    ...(source.originalFilename ? { originalFilename: source.originalFilename } : {}),
  };
}

export function normalizeSourceRefs(...groups) {
  const refs = [];
  const seen = new Set();
  for (const group of groups) {
    const items = Array.isArray(group) ? group : (group ? [group] : []);
    for (const item of items) {
      const ref = normalizeSourceRef(item);
      if (!ref || seen.has(ref.path)) {
        continue;
      }
      seen.add(ref.path);
      refs.push(ref);
    }
  }
  return refs;
}

export function getSourceRefs(entity = {}) {
  return normalizeSourceRefs(
    entity.sourceRefs,
    entity.documentSources,
    entity.javaGuideSources
  );
}

export function buildSelfSourceRef(document = {}) {
  return normalizeSourceRef({
    path: document.path,
    title: document.title,
    sourceType: document.sourceType,
    provider: document.provider,
    providerLabel: document.providerLabel,
    originalUrl: document.originalSource?.url,
    originalMimeType: document.originalSource?.mimeType,
    originalFilename: document.originalSource?.filename,
  });
}

export function withSourceRefs(entity = {}, refs = []) {
  return {
    ...entity,
    sourceRefs: normalizeSourceRefs(refs, entity.sourceRefs, entity.documentSources, entity.javaGuideSources),
  };
}
