import { wrapFetchWithPayment, x402Client, x402HTTPClient } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { identityFor, withAgentIdentity, withCredits } from "aleo-x402-buyer";

const ENDPOINT = process.env.HAIKU_URL ?? "http://localhost:4021/haiku";

const signer = privateKeyToAccount(process.env.BUYER_PRIVATE_KEY as `0x${string}`);
const client = new x402Client().register("eip155:*", new ExactEvmScheme(signer));
const httpClient = new x402HTTPClient(client);

// Calls spend prepaid credits, signed by this agent's identity account for the service
// (CREDITS_AUTH=token uses a bearer token instead). Only when they run out does the server answer
// 402; the paying fetch then signs a USDC top-up (EIP-3009, no gas for the buyer) and retries.
const identity = identityFor(new URL(ENDPOINT).host, ".agent-identity-base.json");
const creditsFetch =
  process.env.CREDITS_AUTH === "token" ? withCredits(fetch, ".credits-token-base") : withAgentIdentity(fetch, identity);
const paidFetch = wrapFetchWithPayment(creditsFetch, client);
const response = await paidFetch(ENDPOINT);
const result = await httpClient.processResponse(response);

if (result.status !== 200) {
  console.log(`GET -> ${result.status} (${result.paymentStatus})`);
  console.log(JSON.stringify(result.header ?? result.body, null, 2));
  process.exit(1);
}

const { haiku, credits } = result.body as { haiku: string[]; credits: { remaining: number } };
console.log(`\n  ${haiku.join("\n  ")}\n`);
if (result.paymentStatus === "settled" && result.header && "transaction" in result.header) {
  console.log(`Out of credits, so ${signer.address} paid a top-up: https://sepolia.basescan.org/tx/${result.header.transaction}`);
}
const owner = process.env.CREDITS_AUTH === "token" ? "bearer token" : `identity ${identity.address().to_string().slice(0, 14)}…`;
console.log(`${credits.remaining} credits left (${owner})`);
