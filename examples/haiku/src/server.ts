import http from "node:http";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { PaymentOption } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ALEO_NETWORK } from "aleo-x402-core";
import {
  ExactAleoFacilitatorScheme,
  ExactAleoServerScheme,
  localFacilitatorClient,
  verifyAgent,
  CreditsStore,
  paymentKey,
} from "aleo-x402-seller";
import { randomHaiku } from "./haiku.js";

const PORT = Number(process.env.PORT ?? 4021);
const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`;
const NETWORK = "eip155:84532"; // Base Sepolia, as a CAIP-2 id

// Each x402 payment buys a block of credits; one credit is one haiku.
const TOPUP_PRICE = process.env.TOPUP_PRICE ?? "$1";
const CREDITS_PER_TOPUP = Number(process.env.CREDITS_PER_TOPUP ?? 1000);
const credits = new CreditsStore(".credits.json");

const aleoPayTo = process.env.ALEO_SELLER_ADDRESS;
if (!aleoPayTo) throw new Error("ALEO_SELLER_ADDRESS not set; run `npm run aleo:keygen` first");
// Optional: Base Sepolia USDC is offered too when SELLER_ADDRESS is set (by `npm run keygen`).
const payTo = process.env.SELLER_ADDRESS;

// No public facilitator supports Aleo, so this server runs its own in-process. It reads private
// payments with the seller's view key, and pays each payment's fee so buyers need no ALEO.
const aleoFacilitator = new ExactAleoFacilitatorScheme({
  privateKey: process.env.ALEO_FACILITATOR_PRIVATE_KEY!,
  sellerViewKey: process.env.ALEO_SELLER_VIEW_KEY!,
  feeAuthorizationUrl: `${PUBLIC_URL}/aleo/fee-authorization`,
  minAmount: 1_000n,
  dryRun: process.env.ALEO_SETTLE === "dry-run",
});

// For Base, x402.org's facilitator verifies the buyer's signed payment and submits it on-chain
// (paying the gas), so this server never touches a node or holds a private key.
const resourceServer = new x402ResourceServer([
  ...(payTo ? [new HTTPFacilitatorClient({ url: "https://x402.org/facilitator" })] : []),
  localFacilitatorClient(aleoFacilitator),
]);
if (payTo) resourceServer.register(NETWORK, new ExactEvmScheme());
resourceServer
  .register(ALEO_NETWORK, new ExactAleoServerScheme())
  // A top-up's credits only count once its payment has settled on-chain.
  .onAfterSettle(async ({ paymentPayload }) => credits.commit(paymentKey(paymentPayload.payload)))
  .onSettleFailure(async ({ paymentPayload }) => credits.cancel(paymentKey(paymentPayload.payload)))
  .onVerifiedPaymentCanceled(async ({ paymentPayload }) => credits.cancel(paymentKey(paymentPayload.payload)));

// The caller's credits account: an agent identity proven by signature, else a bearer token.
function caller(req: express.Request): { account?: string; error?: string } {
  const signed = verifyAgent({
    headers: req.headers as Record<string, string | undefined>,
    host: req.get("host") ?? "",
    method: req.method,
    path: req.originalUrl,
    body: Buffer.isBuffer(req.body) ? req.body : new Uint8Array(),
  });
  if (signed) return "error" in signed ? { error: signed.error } : { account: signed.address };
  return { account: req.get("authorization")?.match(/^Bearer (\S+)$/)?.[1] };
}

const app = express();

// Aleo buyers call this between signing and proving, to get their payment's fee sponsored.
app.post("/aleo/fee-authorization", express.json({ limit: "1mb" }), async (req, res) => {
  try {
    res.json({ feeAuthorization: await aleoFacilitator.authorizeFee(req.body) });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

// Calls that still have credits are served straight away; everything else falls through to x402.
// A badly signed request is refused outright rather than offered a payment.
app.get("/haiku", express.raw({ type: () => true }), (req, res, next) => {
  const { account, error } = caller(req);
  if (error) return void res.status(401).json({ error });
  res.locals.account = account;
  if (!credits.spend(account)) return next();
  res.json({ haiku: randomHaiku(), credits: { remaining: credits.balance(account!) } });
});

app.use(
  paymentMiddleware(
    {
      "GET /haiku": {
        accepts: [
          ...(payTo ? [{ scheme: "exact", price: TOPUP_PRICE, network: NETWORK, payTo } satisfies PaymentOption] : []),
          { scheme: "exact", price: TOPUP_PRICE, network: ALEO_NETWORK, payTo: aleoPayTo },
        ],
        description: `${CREDITS_PER_TOPUP} haiku credits; this request uses one`,
        mimeType: "application/json",
      },
    },
    resourceServer,
  ),
);

// Only reached with a verified payment, and the credits are added only once it settles. Signed
// agents are credited under their identity address; everyone else under their token, or a new one.
// A new token goes in the body, not a header: the middleware discards the body if settlement fails,
// but headers set here would still reach the client on the failure response.
app.get("/haiku", (req, res) => {
  const header = req.get("payment-signature") ?? req.get("x-payment")!;
  const { payload } = JSON.parse(Buffer.from(header, "base64").toString());
  const known: string | undefined = res.locals.account;
  const signed = req.get("x-agent-signature") !== undefined;
  const account = known && (signed || credits.has(known)) ? known : credits.newToken();
  credits.reserve(paymentKey(payload), account, CREDITS_PER_TOPUP - 1);
  const remaining = credits.balance(account) + CREDITS_PER_TOPUP - 1;
  res.json({ haiku: randomHaiku(), credits: signed ? { remaining } : { token: account, remaining } });
});

// An Aleo payment is a whole proven transaction, ~16 KB as an x402 header: over Node's 16 KB default.
const server = http.createServer({ maxHeaderSize: 64 * 1024 }, app);
// Aleo buyers go quiet for up to a minute or two while they authorize and prove, and that work
// blocks their event loop, so their HTTP client can't drop idle connections in time. Keeping
// connections open longer stops their next request landing on a socket this server just closed.
server.keepAliveTimeout = 120_000;
server.headersTimeout = 125_000;
server.listen(PORT, () => {
  console.log(`Haiku server on http://localhost:${PORT}/haiku (${TOPUP_PRICE} buys ${CREDITS_PER_TOPUP} credits)`);
  console.log(`  Aleo USDCx        -> ${aleoPayTo} (fees paid by ${aleoFacilitator.address})`);
  if (payTo) console.log(`  Base Sepolia USDC -> ${payTo}`);
  if (process.env.ALEO_SETTLE === "dry-run") console.log("  Aleo DRY RUN: payments are verified but never broadcast");
});
