import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// Adds Base Sepolia wallets to .env (creating it if needed), which also turns on the server's Base
// option. Never touches existing keys.
if (existsSync(".env") && /^BUYER_PRIVATE_KEY=/m.test(readFileSync(".env", "utf8"))) {
  console.error(".env already has Base Sepolia keys; not overwriting them.");
  process.exit(1);
}

const buyerKey = generatePrivateKey();
const sellerKey = generatePrivateKey();
const buyer = privateKeyToAccount(buyerKey);
const seller = privateKeyToAccount(sellerKey);

appendFileSync(
  ".env",
  `
# Testnet-only wallets from \`npm run keygen\`. Never send real funds to these.
BUYER_PRIVATE_KEY=${buyerKey}
BUYER_ADDRESS=${buyer.address}
SELLER_ADDRESS=${seller.address}
# The server only needs SELLER_ADDRESS; keep this to move the seller's testnet USDC later.
SELLER_PRIVATE_KEY=${sellerKey}
`,
  { mode: 0o600 },
);

console.log(`Added Base Sepolia wallets to .env
  buyer:  ${buyer.address}
  seller: ${seller.address}

Fund the buyer with Base Sepolia USDC at https://faucet.circle.com`);
