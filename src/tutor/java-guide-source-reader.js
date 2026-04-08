import { readFile } from "node:fs/promises";
import path from "node:path";
import { safeSnippet, toReadableSourceText } from "../material/material-model.js";

const defaultJavaGuideRoot = process.env.LLAI_JAVAGUIDE_ROOT || "/Users/lee/IdeaProjects/JavaGuide";

function resolveSourcePath(sourcePath) {
  return path.join(defaultJavaGuideRoot, sourcePath);
}

export async function loadJavaGuideSourceSnippets(sources = [], limit = 2) {
  const selected = sources.slice(0, limit);
  const loaded = await Promise.all(
    selected.map(async (source) => {
      try {
        const raw = await readFile(resolveSourcePath(source.path), "utf8");
        const normalized = toReadableSourceText(raw);
        return {
          path: source.path,
          title: source.title,
          url: source.url,
          snippet: safeSnippet(normalized, 900)
        };
      } catch {
        return {
          path: source.path,
          title: source.title,
          url: source.url,
          snippet: ""
        };
      }
    })
  );

  return loaded.filter((item) => item.title);
}
