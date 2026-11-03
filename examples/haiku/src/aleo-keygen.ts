import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { Account } from "@provablehq/sdk/testnet.js";

// Adds whichever Aleo wallets .env doesn't have yet; never touches existing keys.
const env = existsSync(".env") ? readFileSync(".env", "utf8") : "";
let added = "";

if (!env.includes("ALEO_BUYER_PRIVATE_KEY")) {
  const buyer = new Account();
  const seller = new Account();
  added += `
# Aleo wallets from \`npm run aleo:keygen\`. Dev wallets: only small amounts.
ALEO_BUYER_PRIVATE_KEY=${buyer.privateKey()}
ALEO_BUYER_ADDRESS=${buyer.address()}
ALEO_SELLER_ADDRESS=${seller.address()}
# The seller's view key decrypts its incoming USDCx records, which is how it will verify payments.
ALEO_SELLER_VIEW_KEY=${seller.viewKey()}
ALEO_SELLER_PRIVATE_KEY=${seller.privateKey()}
`;
  console.log(`buyer:       ${buyer.address()}\nseller:      ${seller.address()}`);
}

if (!env.includes("ALEO_FACILITATOR_PRIVATE_KEY")) {
  const facilitator = new Account();
  added += `
# The x402 facilitator pays each payment's network fee from this account's public ALEO balance.
ALEO_FACILITATOR_PRIVATE_KEY=${facilitator.privateKey()}
ALEO_FACILITATOR_ADDRESS=${facilitator.address()}
`;
  console.log(`facilitator: ${facilitator.address()}  <- fund with ~1 ALEO (public balance)`);
}

if (!added) {
  console.error(".env already has all Aleo keys; not overwriting them.");
  process.exit(1);
}
appendFileSync(".env", added, { mode: 0o600 });
console.log("Added to .env");
