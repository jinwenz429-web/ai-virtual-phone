import assert from "node:assert/strict";
import test from "node:test";

import { pollOnce } from "../tools/weixin-local-assistant/assistant-core.mjs";

test("disabled auto reply does not download the full runtime", async () => {
  const originalFetch = globalThis.fetch;
  let runtimeDownloads = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith("/weixin-cloud/index.json")) {
      return Response.json({ packages: [{ botId: "bot1", botToken: "test-token", characterId: "char1", sessionId: "session1", path: "weixin-cloud/runtime/bot1.json" }] });
    }
    if (url.endsWith("/weixin-cloud/runtime/bot1.json")) {
      runtimeDownloads += 1;
      return new Response("runtime must stay unloaded", { status: 500 });
    }
    if (url.endsWith("/weixin-cloud/state/pending/bot1.json")) {
      return Response.json({ pending: true });
    }
    if (url.includes("/ilink/bot/getupdates")) return Response.json({ msgs: [] });
    if (init.method === "POST") return new Response("ok");
    return new Response("missing", { status: 404 });
  };

  try {
    const result = await pollOnce({ SUPABASE_URL: "https://example.invalid", SUPABASE_SERVICE_ROLE_KEY: "test-key", WEIXIN_AUTO_REPLY: "false" }, "bot1");
    assert.equal(result.results[0].autoReply.status, "disabled");
    assert.equal(runtimeDownloads, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
