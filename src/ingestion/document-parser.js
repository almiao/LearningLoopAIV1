import {
  createSource,
  normalizeSourceMarkup,
  normalizeWhitespace,
  toReadableSourceText
} from "../material/material-model.js";

export function parseDocumentInput({ title = "", content = "" }) {
  const normalizedTitle = normalizeWhitespace(title || "Uploaded document");
  const rawContent = normalizeSourceMarkup(content);
  const normalizedContent = toReadableSourceText(content);

  if (!normalizedContent) {
    throw new Error("Document content is required.");
  }

  if (normalizedContent.length < 80) {
    throw new Error("Document content is too short to produce a reliable tutor loop.");
  }

  return createSource({
    kind: "document",
    title: normalizedTitle,
    content: normalizedContent,
    rawContent,
    metadata: {
      sourceFormat: "document"
    }
  });
}
