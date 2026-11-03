import { createPublicClient, erc20Abi, formatUnits, http } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // Base Sepolia USDC

const chain = createPublicClient({ chain: baseSepolia, transport: http() });

const wallets = {
  buyer: privateKeyToAccount(process.env.BUYER_PRIVATE_KEY as `0x${string}`).address,
  seller: process.env.SELLER_ADDRESS as `0x${string}`,
};

for (const [name, address] of Object.entries(wallets)) {
  const balance = await chain.readContract({
    address: USDC,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
  });
  console.log(`${name.padEnd(6)} ${address}  ${formatUnits(balance, 6)} USDC`);
}
