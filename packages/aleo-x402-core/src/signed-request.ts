import { createHash } from "node:crypto";

// Agents prove which credits balance is theirs by signing each request with an Aleo "identity
// account": one per service, holding no funds, kept apart from the account that pays. Buyers sign
// this message and sellers verify it.

export const SIGNATURE_WINDOW_MS = 60_000;

const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

// What gets signed. The host stops replay against another service; the payment line binds an x402
// payment to this identity, so it can't be lifted onto someone else's request.
export function signedMessage(host: string, method: string, path: string, timestamp: string, body: Uint8Array, payment: string) {
  return ["x402-credits/1", host, `${method} ${path}`, timestamp, sha256(body), sha256(payment)].join("\n");
}
