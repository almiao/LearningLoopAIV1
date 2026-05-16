import test from "node:test";
import assert from "node:assert/strict";
import { postJson, withSplitServices } from "../../helpers/split-services.js";

test("materials original endpoint serves non-ascii filenames without invalid header errors", async () => {
  await withSplitServices(null, async ({ bffBaseUrl }) => {
    const login = await postJson(`${bffBaseUrl}/api/auth/login`, {
      handle: `material_header_${Date.now()}`,
      pin: "1234",
    });
    const userId = login.profile.user.id;

    const uploaded = await postJson(`${bffBaseUrl}/api/materials/upload`, {
      userId,
      filename: "唐乐_高级Java.txt",
      mimeType: "text/plain",
      contentBase64: Buffer.from("这是一段足够长的中文测试文本，用来验证中文文件名在 original endpoint 中不会触发 invalid header content 错误。").toString("base64"),
    });

    const response = await fetch(`${bffBaseUrl}/api/materials/original?userId=${encodeURIComponent(userId)}&path=${encodeURIComponent(uploaded.material.path)}`);
    assert.equal(response.ok, true);
    const contentDisposition = response.headers.get("content-disposition") || "";
    assert.match(contentDisposition, /filename=/i);
    assert.match(contentDisposition, /filename\*=UTF-8''/i);
  }, { aiPort: 18120, bffPort: 14120 });
});
