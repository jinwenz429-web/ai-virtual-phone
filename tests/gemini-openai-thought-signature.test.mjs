import assert from "node:assert/strict";
import test from "node:test";

import {
    buildProviderRequest,
    parseProviderResponse,
    toLlmRequestMessages,
} from "../lib/llm-provider-adapter.ts";
import { sendLLMToolStreamRequest } from "../lib/chat-engine.ts";
import { assemblePromptPayload } from "../lib/llm-prompt-assembler.ts";

const geminiOpenAiConfig = {
    id: "gemini-openai-compatible",
    provider: "Custom",
    apiKey: "test-key",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    defaultModel: "gemini-3.5-flash-lite",
    enableNativeTools: true,
    enableImageRecognition: false,
    enableImageGeneration: false,
};

const signatureA = "signature-for-loader-call";
const signatureB = "signature-for-second-call";

test("Gemini OpenAI-compatible normal chat keeps its existing request shape", () => {
    const request = buildProviderRequest(geminiOpenAiConfig, null, [
        { role: "user", content: "你好" },
        { role: "assistant", content: "你好，有什么可以帮你？" },
    ]);

    assert.equal(request.providerKind, "openai-compatible");
    assert.deepEqual(request.body.messages, [
        { role: "user", content: "你好" },
        { role: "assistant", content: "你好，有什么可以帮你？" },
    ]);
    assert.equal(JSON.stringify(request.body).includes("extra_content"), false);
});

test("Gemini OpenAI-compatible tool metadata survives response storage and load_mcp_server replay", () => {
    const parsed = parseProviderResponse("openai-compatible", {
        choices: [{
            message: {
                content: null,
                tool_calls: [
                    {
                        id: "loader-call",
                        type: "function",
                        function: {
                            name: "default_api:load_mcp_server_mcp_xiaohongshu",
                            arguments: "{\"server\":\"xiaohongshu\"}",
                        },
                        extra_content: { google: { thought_signature: signatureA } },
                    },
                    {
                        id: "status-call",
                        type: "function",
                        function: {
                            name: "xiaohongshu_login_status",
                            arguments: "{}",
                        },
                        extra_content: { google: { thought_signature: signatureB } },
                    },
                ],
            },
        }],
    });

    // Exercise the same JSON persistence shape and native-tool history assembler used by main chat.
    const storedHistory = JSON.parse(JSON.stringify([
        {
            id: "user-message",
            sessionId: "session",
            role: "user",
            content: "检查小红书登录状态",
            status: "sent",
            createdAt: "2026-09-16T00:00:00.000Z",
        },
        {
            id: "assistant-tool-calls",
            sessionId: "session",
            role: "assistant",
            content: "",
            status: "sent",
            createdAt: "2026-09-16T00:00:01.000Z",
            nativeToolCalls: parsed.toolCalls,
        },
        {
            id: "loader-result",
            sessionId: "session",
            role: "tool",
            content: "小红书动作说明已加载",
            status: "sent",
            createdAt: "2026-09-16T00:00:02.000Z",
            mediaType: "tool_result",
            nativeToolResult: {
                name: "default_api:load_mcp_server_mcp_xiaohongshu",
                toolCallId: "loader-call",
                content: "小红书动作说明已加载",
            },
        },
        {
            id: "status-result",
            sessionId: "session",
            role: "tool",
            content: "已登录",
            status: "sent",
            createdAt: "2026-09-16T00:00:03.000Z",
            mediaType: "tool_result",
            nativeToolResult: {
                name: "xiaohongshu_login_status",
                toolCallId: "status-call",
                content: "已登录",
            },
        },
    ]));
    const assembled = assemblePromptPayload({
        character: {
            id: "character",
            name: "测试角色",
            avatar: null,
            persona: "",
            createdAt: "2026-09-16T00:00:00.000Z",
            updatedAt: "2026-09-16T00:00:00.000Z",
        },
        history: storedHistory,
        preset: null,
        worldBooks: [],
        regexes: [],
        nativeToolHistory: true,
        timeAware: false,
    });
    const replay = buildProviderRequest(
        geminiOpenAiConfig,
        null,
        toLlmRequestMessages(assembled),
        { tools: [{ name: "xiaohongshu_login_status", description: "检查登录状态", parameters: { type: "object" } }] },
    );

    const assistant = replay.body.messages.find((message) => message.role === "assistant" && message.tool_calls);
    assert.deepEqual(assistant.tool_calls[0].extra_content, {
        google: { thought_signature: signatureA },
    });
    assert.deepEqual(assistant.tool_calls[1].extra_content, {
        google: { thought_signature: signatureB },
    });
});

test("streamed metadata-only chunks stay bound to their own tool-call index", async () => {
    const chunks = [
        {
            choices: [{ delta: { tool_calls: [{
                index: 0,
                id: "loader-call",
                type: "function",
                function: {
                    name: "default_api:load_mcp_server_mcp_xiaohongshu",
                    arguments: "{\"server\":",
                },
            }] } }],
        },
        {
            choices: [{ delta: { tool_calls: [{
                index: 1,
                id: "status-call",
                type: "function",
                function: { name: "xiaohongshu_login_status", arguments: "{}" },
                extra_content: { google: { thought_signature: signatureB } },
            }] } }],
        },
        {
            choices: [{ delta: { tool_calls: [{
                index: 0,
                extra_content: { google: { thought_signature: signatureA } },
            }] } }],
        },
        {
            choices: [{ delta: { tool_calls: [{
                index: 0,
                function: { arguments: "\"xiaohongshu\"}" },
            }] } }],
        },
        // Repeated metadata must remain an idempotent replacement, never a string concatenation.
        {
            choices: [{ delta: { tool_calls: [{
                index: 0,
                extra_content: { google: { thought_signature: signatureA } },
            }] } }],
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ];
    const sse = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
    const originalFetch = globalThis.fetch;
    const originalWarn = console.warn;
    globalThis.fetch = async () => new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
    });
    console.warn = (...args) => {
        if (args[0] !== "[KvDB] put failed:") originalWarn(...args);
    };

    try {
        const result = await sendLLMToolStreamRequest(
            geminiOpenAiConfig,
            null,
            [{ role: "user", content: "检查小红书登录状态" }],
            [{
                name: "default_api:load_mcp_server_mcp_xiaohongshu",
                description: "加载小红书 MCP 动作",
                parameters: { type: "object" },
            }],
            [],
        );

        assert.equal(result.toolCalls.length, 2);
        assert.deepEqual(result.toolCalls[0].args, { server: "xiaohongshu" });
        assert.deepEqual(result.toolCalls[0].extraContent, {
            google: { thought_signature: signatureA },
        });
        assert.deepEqual(result.toolCalls[1].extraContent, {
            google: { thought_signature: signatureB },
        });
    } finally {
        await new Promise((resolve) => setTimeout(resolve, 0));
        globalThis.fetch = originalFetch;
        console.warn = originalWarn;
    }
});

test("other OpenAI-compatible requests do not gain Google extra_content", () => {
    const request = buildProviderRequest({
        ...geminiOpenAiConfig,
        id: "ordinary-openai",
        provider: "OpenAI",
        baseUrl: undefined,
        defaultModel: "gpt-4.1-mini",
    }, null, [
        { role: "user", content: "run it" },
        {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "ordinary-call", name: "ordinary_tool", args: {} }],
        },
        { role: "tool", name: "ordinary_tool", toolCallId: "ordinary-call", content: "ok" },
    ], { tools: [{ name: "ordinary_tool", description: "ordinary", parameters: { type: "object" } }] });

    const assistant = request.body.messages[1];
    assert.equal("extra_content" in assistant.tool_calls[0], false);
});
