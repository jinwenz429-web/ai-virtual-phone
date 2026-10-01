import assert from "node:assert/strict";
import test from "node:test";

const { splitLocalReplyText } = await import("../tools/weixin-local-assistant/assistant-core.mjs");

test("Weixin reply segmentation preserves AI Phone bubble boundaries", () => {
  assert.deepEqual(splitLocalReplyText("第一条\n\n第二条"), ["第一条", "第二条"]);
});

test("one long bubble does not merge neighboring bubbles", () => {
  const long = "长".repeat(200);
  assert.deepEqual(splitLocalReplyText(`前一条\n\n${long}\n\n后一条`), ["前一条", long, "后一条"]);
});
