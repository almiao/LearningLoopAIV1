import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = resolve(import.meta.dirname, "..");
const srcDir = join(rootDir, "src");

async function listJsFiles(directory) {
  const entries = await readdir(directory, {
    withFileTypes: true
  });

  const files = [];
  for (const entry of entries) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listJsFiles(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(fullPath);
    }
  }
  return files;
}

const files = await listJsFiles(srcDir);
for (const file of files) {
  await import(pathToFileURL(file).href);
}

console.log(`Build check passed for ${files.length} source modules.`);
for (const file of files) {
  console.log(` - ${relative(rootDir, file)}`);
}
