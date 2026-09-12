const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;
const ALLOWED_REQUEST_HEADERS = new Set([
    "accept",
    "anthropic-version",
    "authorization",
    "content-type",
    "http-referer",
    "x-api-key",
    "x-title",
]);

export type LlmProxyInput = {
    url?: unknown;
    method?: unknown;
    headers?: unknown;
    body?: unknown;
};

type GateVerifier = (gateCookie: string, sessionToken: string) => Promise<boolean>;

export async function isAuthorizedLlmProxySession(
    sessionToken: string,
    gateCookie: string,
    verifyGate: GateVerifier,
): Promise<boolean> {
    if (!sessionToken || !gateCookie) return false;
    return verifyGate(gateCookie, sessionToken);
}

export function validateLlmProxyUrl(rawUrl: unknown): URL {
    if (typeof rawUrl !== "string" || rawUrl.length > 2048) {
        throw new Error("Invalid proxy URL");
    }

    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        throw new Error("Invalid proxy URL");
    }

    const hostname = url.hostname.toLowerCase();
    const isWawApi = hostname === "wawapii.com" || hostname.endsWith(".wawapii.com");
    if (
        url.protocol !== "https:"
        || url.username
        || url.password
        || (url.port && url.port !== "443")
        || !isWawApi
    ) {
        throw new Error("Proxy target is not allowed");
    }

    const pathname = url.pathname.replace(/\/+$/, "");
    if (pathname !== "/v1/chat/completions" && pathname !== "/v1/models") {
        throw new Error("Proxy endpoint is not allowed");
    }
    return url;
}

function sanitizeHeaders(input: unknown): Record<string, string> {
    if (!input || typeof input !== "object" || Array.isArray(input)) return {};

    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(input)) {
        const normalizedName = name.toLowerCase();
        if (ALLOWED_REQUEST_HEADERS.has(normalizedName) && typeof value === "string") {
            headers[normalizedName] = value;
        }
    }
    return headers;
}

export function buildLlmProxyRequest(input: LlmProxyInput): { url: string; init: RequestInit } {
    const url = validateLlmProxyUrl(input.url);
    const method = input.method === undefined ? "POST" : String(input.method).toUpperCase();
    if (method !== "GET" && method !== "POST") {
        throw new Error("Proxy method is not allowed");
    }

    const body = input.body === undefined ? undefined : String(input.body);
    if (method === "GET" && body !== undefined) {
        throw new Error("GET proxy request cannot include a body");
    }
    if (body !== undefined && new TextEncoder().encode(body).byteLength > MAX_REQUEST_BODY_BYTES) {
        throw new Error("Proxy request body is too large");
    }

    return {
        url: url.toString(),
        init: {
            method,
            headers: sanitizeHeaders(input.headers),
            ...(body === undefined ? {} : { body }),
            redirect: "manual",
        },
    };
}

export function buildLlmProxyResponse(upstream: Response): Response {
    const headers = new Headers();
    for (const name of ["content-type", "cache-control", "x-request-id"]) {
        const value = upstream.headers.get(name);
        if (value) headers.set(name, value);
    }
    headers.set("x-accel-buffering", "no");

    return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
    });
}
