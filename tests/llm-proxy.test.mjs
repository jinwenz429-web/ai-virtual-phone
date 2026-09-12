import assert from "node:assert/strict";
import test from "node:test";

import {
    fetchLlmRequest,
    shouldProxyLlmConfig,
} from "../lib/llm-http.ts";
import * as llmProxyPolicy from "../lib/server/llm-proxy-policy.ts";

const {
    buildLlmProxyRequest,
    buildLlmProxyResponse,
    validateLlmProxyUrl,
} = llmProxyPolicy;

test("only user-configured API base URLs use the same-origin proxy", () => {
    assert.equal(shouldProxyLlmConfig({ provider: "Custom", baseUrl: "https://wawapii.com/v1" }), true);
    assert.equal(shouldProxyLlmConfig({ provider: "Custom", baseUrl: "https://api.sora.example/v1" }), false);
    assert.equal(shouldProxyLlmConfig({ provider: "OpenAI" }), false);
});

test("proxy access requires a valid gate cookie tied to the account session", async () => {
    assert.equal(typeof llmProxyPolicy.isAuthorizedLlmProxySession, "function");
    const { isAuthorizedLlmProxySession } = llmProxyPolicy;
    const verify = async (gateCookie, sessionToken) => (
        gateCookie === "valid-gate" && sessionToken === "valid-session"
    );

    assert.equal(await isAuthorizedLlmProxySession("", "", verify), false);
    assert.equal(await isAuthorizedLlmProxySession("valid-session", "wrong-gate", verify), false);
    assert.equal(await isAuthorizedLlmProxySession("valid-session", "valid-gate", verify), true);
});

test("self-hosted proxy access does not require account cookies", async () => {
    const verify = async () => false;

    assert.equal(await llmProxyPolicy.isAuthorizedLlmProxySession("", "", verify, true), true);
});

test("client proxy wrapper sends one same-origin request and keeps the upstream method", async () => {
    const calls = [];
    const originalFetch = globalThis.fetch;
    const originalWindow = globalThis.window;
    globalThis.window = {};
    globalThis.fetch = async (...args) => {
        calls.push(args);
        return new Response("ok");
    };

    try {
        await fetchLlmRequest(
            "https://wawapii.com/v1/models",
            { method: "GET", headers: { Authorization: "Bearer secret" } },
            { serverProxy: true },
        );
    } finally {
        globalThis.fetch = originalFetch;
        if (originalWindow === undefined) delete globalThis.window;
        else globalThis.window = originalWindow;
    }

    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "/api/llm-proxy");
    const request = JSON.parse(calls[0][1].body);
    assert.deepEqual(request, {
        url: "https://wawapii.com/v1/models",
        method: "GET",
        headers: { authorization: "Bearer secret" },
    });
});

test("proxy URL policy permits WawAPI endpoints and rejects SSRF-shaped URLs", () => {
    assert.equal(validateLlmProxyUrl("https://wawapii.com/v1/chat/completions").pathname, "/v1/chat/completions");
    assert.equal(validateLlmProxyUrl("https://wawapii.com/v1/models").pathname, "/v1/models");

    for (const url of [
        "http://wawapii.com/v1/chat/completions",
        "https://user:pass@wawapii.com/v1/chat/completions",
        "https://localhost/v1/chat/completions",
        "https://127.0.0.1/v1/chat/completions",
        "https://169.254.169.254/v1/models",
        "https://wawapii.com.attacker.example/v1/models",
        "https://wawapii.com/admin",
    ]) {
        assert.throws(() => validateLlmProxyUrl(url));
    }
});

test("server request builder strips unsafe headers and never follows redirects", () => {
    const request = buildLlmProxyRequest({
        url: "https://wawapii.com/v1/chat/completions",
        method: "POST",
        headers: {
            Authorization: "Bearer secret",
            "Content-Type": "application/json",
            Cookie: "session=private",
            Host: "attacker.invalid",
        },
        body: "{\"stream\":true}",
    });

    assert.equal(request.url, "https://wawapii.com/v1/chat/completions");
    assert.deepEqual(request.init, {
        method: "POST",
        headers: {
            authorization: "Bearer secret",
            "content-type": "application/json",
        },
        body: "{\"stream\":true}",
        redirect: "manual",
    });
});

test("proxy response preserves an SSE stream and upstream status", async () => {
    const upstream = new Response('data: {"delta":"ok"}\n\n', {
        status: 206,
        headers: {
            "Content-Type": "text/event-stream",
            "X-Request-Id": "request-123",
            "Set-Cookie": "must-not-leak=true",
        },
    });

    const response = buildLlmProxyResponse(upstream);
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.equal(response.headers.get("x-request-id"), "request-123");
    assert.equal(response.headers.has("set-cookie"), false);
    assert.equal(await response.text(), 'data: {"delta":"ok"}\n\n');
});
