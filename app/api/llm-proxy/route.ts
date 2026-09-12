import { NextRequest, NextResponse } from "next/server";

import { proxyFetch } from "@/lib/proxy-fetch";
import {
    buildLlmProxyRequest,
    buildLlmProxyResponse,
    type LlmProxyInput,
} from "@/lib/server/llm-proxy-policy";

export const maxDuration = 120;

export async function POST(request: NextRequest): Promise<Response> {
    let input: LlmProxyInput;
    try {
        input = await request.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    let upstreamRequest: ReturnType<typeof buildLlmProxyRequest>;
    try {
        upstreamRequest = buildLlmProxyRequest(input);
    } catch (error) {
        const message = error instanceof Error ? error.message : "Invalid proxy request";
        return NextResponse.json({ error: message }, { status: 400 });
    }

    try {
        const upstream = await proxyFetch(upstreamRequest.url, upstreamRequest.init);
        if (upstream.status >= 300 && upstream.status < 400) {
            return NextResponse.json({ error: "Upstream redirect is not allowed" }, { status: 502 });
        }

        return buildLlmProxyResponse(upstream);
    } catch {
        return NextResponse.json({ error: "WawAPI request failed" }, { status: 502 });
    }
}
