import { getBaselinePackById } from "../baseline/baseline-packs.js";
import { getJavaGuideDocumentOrder } from "../knowledge/java-guide-order.js";

function normalizeSource(source) {
  if (!source) {
    return null;
  }
  if (typeof source === "string") {
    return {
      path: source,
      title: "",
    };
  }
  return {
    path: source.path || "",
    title: source.title || "",
  };
}

export function buildReadingDomainsForTarget(targetBaselineId = "") {
  if (!targetBaselineId) {
    return [];
  }

  const pack = getBaselinePackById(targetBaselineId);

  return (pack.domains || []).map((domain, domainIndex) => {
    const uniqueDocs = new Map();

    for (const item of domain.items || []) {
      for (const rawSource of item.javaGuideSources || []) {
        const source = normalizeSource(rawSource);
        if (!source?.path) {
          continue;
        }
        if (!uniqueDocs.has(source.path)) {
          uniqueDocs.set(source.path, {
            path: source.path,
            title: source.title || item.title,
          });
        }
      }
    }

    const docs = [...uniqueDocs.values()]
      .sort((left, right) => {
        const leftOrder = getJavaGuideDocumentOrder(left.path);
        const rightOrder = getJavaGuideDocumentOrder(right.path);
        if (leftOrder !== rightOrder) {
          return leftOrder - rightOrder;
        }
        return left.path.localeCompare(right.path);
      })
      .map((doc, index) => ({
        ...doc,
        order: index,
      }));

    return {
      id: domain.id,
      key: domain.id,
      title: domain.title,
      order: domainIndex,
      docs,
    };
  });
}

export function findReadingDomainForDoc(targetBaselineId = "", docPath = "") {
  if (!targetBaselineId || !docPath) {
    return null;
  }

  for (const domain of buildReadingDomainsForTarget(targetBaselineId)) {
    const matchedDoc = domain.docs.find((doc) => doc.path === docPath);
    if (matchedDoc) {
      return {
        domainId: domain.id,
        domainTitle: domain.title,
        doc: matchedDoc,
      };
    }
  }

  return null;
}
