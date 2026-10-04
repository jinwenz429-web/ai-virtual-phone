import assert from "node:assert/strict";
import test from "node:test";

import { buildProviderRequest, nativeToolProtocolForConfig } from "../lib/llm-provider-adapter.ts";

const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=";
const pngUrl = `data:image/png;base64,${pngBase64}`;
const tool = { name: "check_status", description: "Check status", parameters: { type: "object", properties: {} } };
const providers = [
    { provider: "Custom", baseUrl: "https://relay.example/v1" },
    { provider: "Google" },
    { provider: "Anthropic" },
];

function config(provider, enableNativeTools = true) {
    return { ...provider, id: "test", apiKey: "test-key", defaultModel: "test-model", enableNativeTools, enableImageRecognition: true };
}

function messages(url) {
    return [
        { role: "user", content: [{ type: "text", text: "历史图片" }, { type: "image_url", image_url: { url, detail: "low" } }] },
        { role: "assistant", content: "收到" },
        { role: "user", content: "这次只发文字" },
    ];
}

for (const provider of providers) {
    for (const enableNativeTools of [false, true]) {
        test(`${provider.provider}: malformed historical images cannot poison ${enableNativeTools ? "tool streaming" : "ordinary"} requests`, () => {
            for (const badUrl of ["data:", "data:image/png;base64,data:", `data:image/png;base64,${pngUrl}`, "data:image/png;base64,", "data:image/png;base64,AAAA=AAA"]) {
                const history = messages(badUrl);
                const original = structuredClone(history);
                const request = buildProviderRequest(config(provider, enableNativeTools), null, history,
                    enableNativeTools ? { tools: [tool], stream: true } : {});
                assert.doesNotMatch(JSON.stringify(request.body), /"image_url"|"inlineData"|"type":"image"/, badUrl);
                assert.match(JSON.stringify(request.body), /历史图片/);
                assert.match(JSON.stringify(request.body), /这次只发文字/);
                assert.deepEqual(history, original, "request normalization must not edit saved history");
            }
        });
    }

    test(`${provider.provider}: valid pictures retain their image payload and native tools`, () => {
        const request = buildProviderRequest(config(provider), null, messages(pngUrl), { tools: [tool], stream: true });
        assert.match(JSON.stringify(request.body), new RegExp(pngBase64.replace(/[+]/g, "\\+")));
        assert.equal(request.body.tools.length > 0, true);
        for (const equivalentUrl of [
            ` ${pngUrl}\n`,
            `data:image/png;charset=utf-8;base64,${pngBase64}`,
            `DATA:IMAGE/PNG;BASE64,${pngBase64.replace(/=$/, "")}`,
            `data:image/png;base64,${pngBase64.slice(0, 20)}\n${pngBase64.slice(20)}`,
        ]) {
            const wrapped = buildProviderRequest(config(provider), null, messages(equivalentUrl));
            assert.deepEqual(wrapped.body, buildProviderRequest(config(provider), null, messages(pngUrl)).body);
        }
    });
}

test("OpenAI-compatible remote image URLs and details remain unchanged", () => {
    const url = "https://images.example/photo.png?download=1";
    const request = buildProviderRequest(config(providers[0]), null, messages(url));
    assert.deepEqual(request.body.messages[0].content[1], { type: "image_url", image_url: { url, detail: "low" } });
});

test("image recognition switch excludes every image without deleting text or history", () => {
    const request = buildProviderRequest({ ...config(providers[0]), enableImageRecognition: false }, null, messages(pngUrl));
    assert.equal(JSON.stringify(request.body).includes(pngBase64), false);
    assert.equal(request.body.messages[0].content, "历史图片\n[图片]");
});

test("disabled native tools do not select the tool protocol for the active API config", () => {
    assert.equal(nativeToolProtocolForConfig(config(providers[0], false)), null);
    assert.throws(() => buildProviderRequest(config(providers[0], false), null, messages(pngUrl), { tools: [tool] }), /未启用原生工具调用/);
});
