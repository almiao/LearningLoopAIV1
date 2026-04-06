import test from "node:test";
import assert from "node:assert/strict";
import { detectControlIntent } from "../../../src/tutor/control-intents.js";

test("detectControlIntent recognizes lightweight control phrases", () => {
  assert.equal(detectControlIntent("下一题"), "advance");
  assert.equal(detectControlIntent("讲一下"), "teach");
  assert.equal(detectControlIntent("总结一下"), "summarize");
  assert.equal(detectControlIntent("正常回答内容"), null);
});
