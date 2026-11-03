import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Account } from "@provablehq/sdk/mainnet.js";
import { signedMessage } from "aleo-x402-core";

// Agents prove which credits balance is theirs by signing each request with an Aleo "identity
// account": one per service, holding no funds, kept apart from the account that pays.

// One identity account per service, created on first use and kept in `file`.
export function identityFor(host: string, file: string): Account {
  const identities: Record<string, string> = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  if (!identities[host]) {
    identities[host] = new Account().privateKey().to_string();
    writeFileSync(file, JSON.stringify(identities, null, 2), { mode: 0o600 });
  }
  return new Account({ privateKey: identities[host] });
}

// Wraps fetch so every request, including the x402 retry that carries the payment, is signed by
// the identity account. The x402 wrapper re-sends a cloned Request, so the headers go on the Request.
export function withAgentIdentity(fetchImpl: typeof fetch, identity: Account): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body = new Uint8Array(await request.clone().arrayBuffer());
    const timestamp = new Date().toISOString();
    const payment = request.headers.get("payment-signature") ?? request.headers.get("x-payment") ?? "";
    const message = signedMessage(url.host, request.method, url.pathname + url.search, timestamp, body, payment);
    request.headers.set("x-agent-address", identity.address().to_string());
    request.headers.set("x-agent-timestamp", timestamp);
    request.headers.set("x-agent-signature", identity.sign(new TextEncoder().encode(message)).to_string());
    return fetchImpl(request);
  };
}
