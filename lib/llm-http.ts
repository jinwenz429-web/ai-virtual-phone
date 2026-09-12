// Unified browser transport for LLM requests.
// Sites that already allow browser CORS keep using direct requests. WawAPI uses
// the same-origin route because its API does not accept browser cross-origin calls.

import type { LlmRequestPayload } from "./llm-provider-adapter";

export type FetchLlmPayloadOptions = {
    signal?: AbortSignal;
};

export type FetchLlmRequestOptions = FetchLlmPayloadOptions & {
    serverProxy?: boolean;
};

export function shouldProxyLlmConfig(config: { baseUrl?: string }): boolean {
    if (!config.baseUrl) return false;
    try {
        const hostname = new URL(config.baseUrl).hostname.toLowerCase();
        return hostname === "wawapii.com" || hostname.endsWith(".wawapii.com");
    } catch {
        return false;
    }
}

export function fetchLlmRequest(
    url: string,
    init: RequestInit,
    options: FetchLlmRequestOptions = {},
): Promise<Response> {
    if (!options.serverProxy || typeof window === "undefined") {
        return fetch(url, { ...init, signal: options.signal });
    }

    const headers = Object.fromEntries(new Headers(init.headers).entries());
    return fetch("/api/llm-proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            url,
            method: init.method || "POST",
            ...(Object.keys(headers).length === 0 ? {} : { headers }),
            ...(init.body === undefined || init.body === null ? {} : { body: String(init.body) }),
        }),
        signal: options.signal,
    });
}

export function fetchLlmPayload(
    payload: LlmRequestPayload,
    options: FetchLlmPayloadOptions = {},
): Promise<Response> {
    return fetchLlmRequest(payload.url, {
        method: "POST",
        headers: payload.headers,
        body: JSON.stringify(payload.body),
    }, { signal: options.signal, serverProxy: payload.serverProxy });
}
