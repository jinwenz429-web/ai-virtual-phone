import assert from "node:assert/strict";
import test from "node:test";

const syncModule = await import("../lib/weixin-cloud-sync.ts");

test("Weixin cloud polling uses a 30-second foreground interval", () => {
  assert.equal(syncModule.WEIXIN_CLOUD_REALTIME_PULL_INTERVAL_MS, 30_000);
});

test("HTTP 402 failures back off for 30 minutes", () => {
  const backoff = syncModule.getWeixinCloudPullBackoffMs?.(new Error("402 Payment Required"), 1);
  assert.equal(backoff, 30 * 60 * 1000);
});

test("ordinary pull failures use progressive backoff capped at 10 minutes", () => {
  const getBackoff = syncModule.getWeixinCloudPullBackoffMs;
  assert.equal(getBackoff?.(new Error("500 upstream"), 1), 60_000);
  assert.equal(getBackoff?.(new Error("500 upstream"), 2), 2 * 60_000);
  assert.equal(getBackoff?.(new Error("500 upstream"), 3), 5 * 60_000);
  assert.equal(getBackoff?.(new Error("500 upstream"), 4), 10 * 60_000);
  assert.equal(getBackoff?.(new Error("500 upstream"), 8), 10 * 60_000);
});
