import { existsSync, readFileSync, writeFileSync } from "node:fs";

// Wraps fetch so every call carries the stored credits token, and keeps the token that a paid
// top-up response returns in its body. The x402 wrapper re-sends a cloned Request, so the header
// goes on the Request.
export function withCredits(fetchImpl: typeof fetch, tokenFile: string): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    if (existsSync(tokenFile)) request.headers.set("authorization", `Bearer ${readFileSync(tokenFile, "utf8").trim()}`);
    const response = await fetchImpl(request);
    const body = response.ok ? await response.clone().json().catch(() => undefined) : undefined;
    if (body?.credits?.token) writeFileSync(tokenFile, body.credits.token, { mode: 0o600 });
    return response;
  };
}
