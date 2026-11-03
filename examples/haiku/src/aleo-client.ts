import { Account, AleoKeyProvider, initThreadPool, LocalFileKeyStore, ProgramManager } from "@provablehq/sdk/mainnet.js";
import { wrapFetchWithPayment, x402Client, x402HTTPClient } from "@x402/fetch";
import { ExactAleoClientScheme, loadRecords, ownedRecords, saveRecords, identityFor, withAgentIdentity, withCredits } from "aleo-x402-buyer";
import { API_HOST } from "aleo-x402-core";

const ENDPOINT = process.env.HAIKU_URL ?? "http://localhost:4021/haiku";

// Proving uses every core, and the keys synthesized on the first run (saved under ./.aleo).
await initThreadPool();
const buyer = new Account({ privateKey: process.env.ALEO_BUYER_PRIVATE_KEY });
const keyProvider = new AleoKeyProvider();
keyProvider.useCache(true);
const programManager = new ProgramManager(API_HOST, keyProvider, undefined, undefined, new LocalFileKeyStore());

const records = loadRecords();
const aleo = new ExactAleoClientScheme(buyer, programManager, records);
const client = new x402Client().register("aleo:*", aleo);
const httpClient = new x402HTTPClient(client);

// Calls spend prepaid credits, signed by an identity account kept apart from the buyer's payment
// account (CREDITS_AUTH=token uses a bearer token instead). Only when credits run out does this
// prove a private USDCx top-up.
const identity = identityFor(new URL(ENDPOINT).host, ".agent-identity-aleo.json");
const creditsFetch =
  process.env.CREDITS_AUTH === "token" ? withCredits(fetch, ".credits-token-aleo") : withAgentIdentity(fetch, identity);
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
if (result.paymentStatus === "settled" && result.header && "transaction" in result.header && aleo.pending) {
  // The top-up spent one record and returned the change as a new one.
  const { spent, transaction } = aleo.pending;
  saveRecords(records.filter((r) => r !== spent).concat(ownedRecords(transaction, buyer.viewKey())));
  console.log(`Out of credits, so paid a private top-up: https://explorer.provable.com/transaction/${result.header.transaction}`);
}
const owner = process.env.CREDITS_AUTH === "token" ? "bearer token" : `identity ${identity.address().to_string().slice(0, 14)}…`;
console.log(`${credits.remaining} credits left (${owner})`);
process.exit(0); // the proving thread pool would otherwise keep the process alive
