import { Address, Signature } from "@provablehq/sdk/mainnet.js";
import { SIGNATURE_WINDOW_MS, signedMessage } from "aleo-x402-core";

export type AgentRequest = {
  headers: Record<string, string | undefined>;
  host: string;
  method: string;
  path: string;
  body: Uint8Array;
};

const seen = new Map<string, number>(); // signature -> when it stops being replayable

// The identity address if the request is validly signed, an error if it's signed badly, and
// undefined if it isn't signed at all (so the caller can fall back to a bearer token).
export function verifyAgent(req: AgentRequest): { address: string } | { error: string } | undefined {
  const address = req.headers["x-agent-address"];
  const timestamp = req.headers["x-agent-timestamp"];
  const signature = req.headers["x-agent-signature"];
  if (!address && !timestamp && !signature) return undefined;
  if (!address || !timestamp || !signature) return { error: "incomplete agent signature headers" };

  const now = Date.now();
  if (!(Math.abs(now - Date.parse(timestamp)) <= SIGNATURE_WINDOW_MS)) return { error: "timestamp is missing or more than 60 s off" };
  for (const [sig, expires] of seen) if (expires < now) seen.delete(sig);
  if (seen.has(signature)) return { error: "this signed request was already used" };

  const payment = req.headers["payment-signature"] ?? req.headers["x-payment"] ?? "";
  const message = signedMessage(req.host, req.method, req.path, timestamp, req.body, payment);
  try {
    if (!Signature.from_string(signature).verify(Address.from_string(address), new TextEncoder().encode(message))) {
      return { error: "signature doesn't match this request" };
    }
  } catch {
    return { error: "malformed address or signature" };
  }
  seen.set(signature, now + 2 * SIGNATURE_WINDOW_MS);
  return { address };
}
