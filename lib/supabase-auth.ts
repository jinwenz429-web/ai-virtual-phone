/** New API keys are opaque; they must never be sent as a JWT bearer token. */
export function supabaseAuthHeaders(key: string): Record<string, string> {
  return { apikey: key, ...(!key.startsWith("sb_") ? { Authorization: `Bearer ${key}` } : {}) };
}

/** Secret keys cannot call Storage from a browser. The personal gateway validates
 * the same project admin key and forwards only the backup bucket server-side. */
export function personalStorageRequest(url: string, init: RequestInit): { url: string; init: RequestInit } {
  const headers = new Headers(init.headers);
  const key = headers.get("apikey") || "";
  if (!key.startsWith("sb_secret_")) return { url, init };
  const target = new URL(url);
  if (!target.pathname.startsWith("/storage/v1/")) return { url, init };
  const gateway = new URL("/functions/v1/ai-phone-push", target.origin);
  gateway.searchParams.set("action", "storage");
  gateway.searchParams.set("path", target.pathname + target.search);
  headers.delete("apikey");
  headers.delete("Authorization");
  headers.set("x-ai-phone-service-key", key);
  return { url: gateway.toString(), init: { ...init, headers } };
}
