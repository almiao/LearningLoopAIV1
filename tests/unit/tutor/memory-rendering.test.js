import test from "node:test";
import assert from "node:assert/strict";
import { escapeHtml } from "../../../public/render-utils.js";

test("escapeHtml neutralizes tag-looking learner content", () => {
  assert.equal(
    escapeHtml('<img src=x onerror="alert(1)"> & test'),
    "&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; test"
  );
});
