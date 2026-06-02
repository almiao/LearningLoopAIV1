import test from "node:test";
import assert from "node:assert/strict";
import {
  ensureResumeVersionLibrary,
  getLatestResumeVersion,
  saveResumeVersion,
} from "../../../src/user/resume-version-store.js";

test("saveResumeVersion keeps the newest uploaded resume at the top", () => {
  const first = saveResumeVersion({}, {
    text: "Java 后端简历 v1",
    fileName: "resume-v1.md",
  });
  const second = saveResumeVersion(first, {
    text: "Java 后端简历 v2",
    fileName: "resume-v2.md",
  });

  assert.equal(second.latestVersionId, second.savedVersion.id);
  assert.equal(second.versions[0].fileName, "resume-v2.md");
  assert.match(getLatestResumeVersion(second).text, /v2/);
  assert.equal(second.versions.length, 2);
});

test("saveResumeVersion keeps separate uploads even when the content is the same", () => {
  const first = saveResumeVersion({}, {
    text: "同一份简历内容",
    fileName: "resume-old.txt",
  });
  const second = saveResumeVersion(first, {
    text: "同一份简历内容",
    fileName: "resume-new.txt",
  });

  assert.equal(second.versions.length, 2);
  assert.equal(second.versions[0].fileName, "resume-new.txt");
  assert.equal(second.versions[1].fileName, "resume-old.txt");
  assert.equal(second.latestVersionId, second.versions[0].id);
});

test("ensureResumeVersionLibrary tolerates missing or malformed input", () => {
  const library = ensureResumeVersionLibrary({
    latestVersionId: "missing",
    versions: [
      null,
      { id: "kept", text: "保留这份简历", createdAt: "2026-06-02T00:00:00.000Z" },
      { id: "empty", text: "   " },
    ],
  });

  assert.equal(library.latestVersionId, "kept");
  assert.equal(library.versions.length, 1);
  assert.equal(library.versions[0].id, "kept");
});
