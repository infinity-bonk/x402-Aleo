# x402 haiku

A hello world for [x402](https://x402.org): `GET /haiku` returns a haiku for one prepaid credit. When a caller has no credits left, it gets a 402 and buys more (by default $1 for 1,000 credits), payable two ways:

- **Base Sepolia USDC** (testnet, optional): public, through the x402.org facilitator. Offered only when Base wallets are set up.
- **USDCx on Aleo mainnet**: private. Payer, payee and amount are encrypted on-chain, through a facilitator this server runs itself.

> [!WARNING]
> Experimental and unaudited. The Aleo option moves real funds on mainnet. Use small amounts. See [known limits](#known-limits).

It's built on the packages in [`packages/`](../../packages). Run the `npm run …` commands below from the repository root or from this folder; either way, the example's state (`.env`, wallets, records, credits, proving keys in `.aleo/`) lives in this folder.

## Prepaid credits

A private Aleo payment costs the buyer about a minute of proving, so paying per call doesn't work. Instead, one x402 payment buys a block of credits, and calls spend them until they run out:

1. A call with no credits gets the normal x402 `402`.
2. The client pays. The server holds the response until the payment settles, then adds the credits (minus one for this call) and returns the haiku plus `credits: { remaining }`. A failed payment adds no credits.
3. Later calls are served straight away from the balance, without touching x402 or the chain.
4. When the balance reaches zero, step 1 happens again and the top-up lands on the same balance.

**Who owns a balance.** By default each client signs every request with an *identity account*: a fresh Aleo account per service that holds no funds and is kept apart from the account that pays. The balance belongs to that account's address. Each request carries `X-Agent-Address`, `X-Agent-Timestamp` and `X-Agent-Signature`, an Aleo signature over:

```
x402-credits/1
<host>
<METHOD> <path>
<timestamp>
<sha256 of the body>
<sha256 of the x402 payment header, or of "" when there isn't one>
```

The server refuses (401) a signature that doesn't match, a timestamp more than 60 s off, or a signed request it has already seen. The host line stops replay against another service, and the payment line stops a payment being moved onto another agent's request. Nothing secret travels with a request, and the identity address never appears on-chain.

Clients that can't sign can use a bearer token instead (`CREDITS_AUTH=token`): the top-up response returns `credits: { token }`, later calls send `Authorization: Bearer <token>`.

The clients keep identity keys in `.agent-identity-base.json` / `.agent-identity-aleo.json` (one per service host) and tokens in `.credits-token-base` / `.credits-token-aleo`. The server keeps balances in `.credits.json`. `TOPUP_PRICE` (default `$1`) and `CREDITS_PER_TOPUP` (default `1000`) set the package, and `PORT` (default 4021) the port. For example: `TOPUP_PRICE='$0.002' CREDITS_PER_TOPUP=2 npm run server`.

## Base Sepolia (public)

```sh
npm install
npm run keygen     # adds testnet buyer + seller wallets to .env, which turns the Base option on
```

Fund the **buyer** address with Base Sepolia USDC at <https://faucet.circle.com>. It needs no ETH.

```sh
npm run server     # terminal 1: http://localhost:4021/haiku
npm run client     # terminal 2: prints a haiku and the credits left; pays a top-up when they run out
npm run balances   # watch the top-up move from buyer to seller (1 USDC at the default price)
```

1. Client `GET /haiku` → `402` with a `PAYMENT-REQUIRED` header (base64 JSON listing scheme, network, asset, amount, `payTo`).
2. The client signs an EIP-3009 `transferWithAuthorization` for the top-up price to `payTo` (1,000,000 units, which is 1 USDC at the default `$1`; USDC has 6 decimals), then retries with it in a `PAYMENT-SIGNATURE` header.
3. The server middleware asks the facilitator to **verify** it, runs the handler while holding back the response, then asks it to **settle**. The facilitator submits the transfer and pays the gas.
4. Only after settlement succeeds does the client get `200`, the haiku, and a `PAYMENT-RESPONSE` header with the transaction hash.

## Aleo USDCx (private)

```sh
npm run aleo:keygen   # adds Aleo buyer, seller and facilitator wallets to .env
```

- Send the **buyer** USDCx as a **private** transfer, at least the top-up price, and send the **facilitator** about 1 ALEO as a **public** balance. Each payment costs it a 0.0046 ALEO fee. The root README's [quickstart](../../README.md#quickstart) covers where to get USDCx.
- `npm run aleo:records` finds the buyer's private records (it scans recent blocks, so run it soon after funding) and saves them to `.aleo-records.json`. You only need it once: after each top-up the client saves its change records to that file. A later scan replaces the file with only what it finds in its window.
- `npm run aleo:balances` shows everyone's public balances and the buyer's private ones.

```sh
npm run server          # terminal 1 (or server:dry-run: verifies payments but never broadcasts)
npm run aleo:client     # terminal 2: spends a credit, or proves and pays a private top-up (~1 min)
```

### How a payment works

1. Client `GET /haiku` → `402`. The Aleo option's `extra` names the facilitator's fee payer and a `feeAuthorizationUrl`.
2. **Authorize** (~3 s): the buyer runs USDCx `transfer_private` locally and signs it, but doesn't prove it yet. It includes a Merkle proof that the buyer isn't on USDCx's freeze list.
3. **Sponsor the fee** (~1 s): the buyer sends only the payment's *public* transition and its execution id to `POST /aleo/fee-authorization`. The facilitator decrypts the output meant for the seller with the seller's **view key**. If it pays the price, isn't spent, and uses a current freeze-list root, the facilitator signs a `fee_public` authorization bound to that execution. The buyer's plaintext record never leaves the buyer.
4. **Prove** (~50 s): the buyer proves the transfer and the sponsored fee into one transaction and retries with it in the x402 header (~14 KB, so the server allows 64 KB headers).
5. **Verify → handler → settle**: the facilitator re-checks the final transaction, the haiku is generated, then the transaction is broadcast. It confirms in a few seconds, and only then is the response sent.

On-chain, an observer sees that a USDCx private transfer happened and that the facilitator paid a 0.0046 ALEO fee. The buyer's address, the seller's address and the amount are all encrypted. USDCx itself also emits an encrypted compliance record readable by the issuer.

### Where the time goes

`npm run aleo:bench` measures this without broadcasting. On a 10-core Mac:

| Step | Cold process | Warm process |
| --- | --- | --- |
| Freeze-list proof + authorize | 4.9 s | 2.7 s |
| Facilitator checks + signs fee | 3.0 s | 0.5 s |
| Prove transfer + sponsored fee | 55 s | 47 s |
| Facilitator verify | 0.3 s | 0.2 s |

The transfer proof alone is ~37 s. A sponsored `fee_public` adds ~10 s, and a buyer-paid `fee_private` would add ~27 s. The first run on a machine also synthesizes USDCx's proving keys (~2 min, then cached in `.aleo/`, 259 MB).

### Known limits

- **Fee-sponsorship binding**: the SDK can only compute an execution id from a full authorization, which the buyer can't share. So the facilitator checks the transition but can't confirm the id belongs to it. A buyer could pair a real payment with another id; each USDCx record can only be sponsored twice, which bounds that to ~0.005 ALEO per fresh record.
- **The fee payer is public**: every payment shows the facilitator's address paying the fee. That reveals how many payments it processed, but not who paid whom or how much.
- **One payment per record at a time**: a record can't be spent again until its transaction confirms. Parallel payments need several records (`split`).
- **Facilitator state is in memory**: sponsorship counts and settled ids reset on restart.

| File | Role |
| --- | --- |
| `src/server.ts` | Express app: credits check, `paymentMiddleware` for both networks, top-ups, fee-authorization endpoint (uses `aleo-x402-seller`) |
| `src/client.ts` / `src/aleo-client.ts` | Paying clients for Base / Aleo (use `aleo-x402-buyer`) |
| `src/aleo-bench.ts` | Timing breakdown, no broadcast |
| `src/aleo-transfer.ts` | Plain buyer → seller private transfer (buyer pays its own fee) |
| `src/aleo-records.ts`, `src/aleo-balances.ts`, `src/*keygen.ts`, `src/balances.ts` | Wallet helpers |
| `src/haiku.ts` | The "product" |
