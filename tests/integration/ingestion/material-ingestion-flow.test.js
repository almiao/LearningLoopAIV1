import test from "node:test";
import assert from "node:assert/strict";
import { postJson, withSplitServices } from "../../helpers/split-services.js";

test("uploaded material flows through document reader and training start", async () => {
  await withSplitServices(null, async ({ bffBaseUrl }) => {
    const login = await postJson(`${bffBaseUrl}/api/auth/login`, {
      handle: `material_user_${Date.now()}`,
      pin: "1234",
    });
    const userId = login.profile.user.id;
    const content = `
Redis persistence has two common approaches. RDB snapshots compact data periodically and are efficient for full backups.
AOF logs append write operations and can reduce data loss windows at the cost of more write amplification.
Replication and failover complement persistence by improving availability when a node fails.
`;

    const uploaded = await postJson(`${bffBaseUrl}/api/materials/upload`, {
      userId,
      filename: "redis-notes.txt",
      mimeType: "text/plain",
      contentBase64: Buffer.from(content).toString("base64"),
    });

    assert.match(uploaded.material.path, /^materials\/[a-f0-9-]{36}$/i);
    assert.equal(uploaded.material.provider, "user-material");
    assert.equal(uploaded.material.sourceRefs[0].path, uploaded.material.path);

    const docResponse = await fetch(`${bffBaseUrl}/api/knowledge/doc?userId=${encodeURIComponent(userId)}&path=${encodeURIComponent(uploaded.material.path)}`);
    const document = await docResponse.json();
    assert.equal(docResponse.ok, true);
    assert.equal(document.path, uploaded.material.path);
    assert.equal(document.primaryFormat, "text");
    assert.equal(document.render.format, "text");
    assert.match(document.learning.text, /RDB snapshots compact data periodically/);
    assert.match(document.markdown, /Redis persistence/);

    const answer = await postJson(`${bffBaseUrl}/api/knowledge/answer`, {
      userId,
      docPath: uploaded.material.path,
      question: "总结全文",
      taskType: "summary",
    });
    assert.match(answer.content, /Redis|persistence|RDB|AOF/i);

    const session = await postJson(`${bffBaseUrl}/api/interview/start-target`, {
      userId,
      docPath: uploaded.material.path,
      interactionPreference: "balanced",
    });
    assert.equal(session.source.metadata.docPath, uploaded.material.path);
    assert.ok((session.trainingPoints || []).length >= 1);
    assert.equal(session.trainingPoints[0].sourceRefs[0].path, uploaded.material.path);
  }, { aiPort: 18110, bffPort: 14110 });
});
