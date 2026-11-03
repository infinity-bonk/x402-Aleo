import { readFileSync, writeFileSync } from "node:fs";
import {
  Account,
  AleoKeyProvider,
  initThreadPool,
  LocalFileKeyStore,
  ProgramManager,
  SealanceMerkleTree,
  Transaction,
  ViewKey,
} from "@provablehq/sdk/mainnet.js";

// A private USDCx payment from the buyer to the seller on mainnet, timed step by step.
const HOST = "https://api.provable.com/v2";
const API = `${HOST}/mainnet`;
const PROGRAM = "usdcx_stablecoin.aleo";
const FUNCTION = "transfer_private";
const RECORDS_FILE = ".aleo-records.json";
const ZERO_ADDRESS = "aleo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3ljyzc";
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run"); // build, prove and verify, but don't broadcast
const AMOUNT = BigInt(args.find((a) => !a.startsWith("--")) ?? 10_000); // micro-USDCx: 10_000 = 0.01 USDCx

type StoredRecord = { program: string; name: string; plaintext: string };

const buyer = new Account({ privateKey: process.env.ALEO_BUYER_PRIVATE_KEY });
const sellerAddress = process.env.ALEO_SELLER_ADDRESS!;
const sellerViewKey = ViewKey.from_string(process.env.ALEO_SELLER_VIEW_KEY!);

async function get(path: string) {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

const timed = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
  const start = performance.now();
  const result = await work();
  console.log(`${label}: ${((performance.now() - start) / 1000).toFixed(1)}s`);
  return result;
};

// 1. Pick a USDCx record to spend and an ALEO credits record to pay the fee privately.
const records: StoredRecord[] = JSON.parse(readFileSync(RECORDS_FILE, "utf8"));
const value = (r: StoredRecord) => BigInt(r.plaintext.match(/(?:amount|microcredits): (\d+)u/)![1]);
const token = records.find((r) => r.program === PROGRAM && r.name === "Token" && value(r) >= AMOUNT);
const fee = records.find((r) => r.program === "credits.aleo" && r.name === "credits" && value(r) >= 1_000_000n);
if (!token || !fee) throw new Error(`No suitable records in ${RECORDS_FILE}; run \`npm run aleo:records\``);

// 2. Prove the buyer isn't frozen: a Merkle exclusion proof against the on-chain freeze list.
const exclusionProof = await timed("freeze-list proof", async () => {
  const freezelist = "/program/usdcx_freezelist.aleo/mapping";
  const lastIndex = parseInt(await get(`${freezelist}/freeze_list_last_index/true`));
  const frozen: string[] = [];
  for (let i = 0; i <= lastIndex; i++) {
    const address = await get(`${freezelist}/freeze_list_index/${i}u32`);
    if (address && address !== ZERO_ADDRESS) frozen.push(address);
  }

  const sealance = new SealanceMerkleTree();
  const tree = sealance.buildTree(sealance.generateLeaves(frozen));
  const root = await get(`${freezelist}/freeze_list_root/1u8`);
  if (`${tree[tree.length - 1]}field` !== root) throw new Error("Rebuilt freeze-list root doesn't match on-chain root");

  // The contract's MerkleProof holds 16 siblings, so the path depth is 16 (not the SDK example's 15).
  const [left, right] = sealance.getLeafIndices(tree, buyer.address().to_string());
  return sealance.formatMerkleProof([sealance.getSiblingPath(tree, left, 16), sealance.getSiblingPath(tree, right, 16)]);
});

// 3. Build and prove the transaction locally. Nothing is broadcast yet.
//    Proving is single-threaded unless the WASM thread pool is started, and USDCx has no
//    published keys, so the synthesized ones are saved under ./.aleo for the next run.
await initThreadPool();
const keyProvider = new AleoKeyProvider();
keyProvider.useCache(true);
const programManager = new ProgramManager(HOST, keyProvider, undefined, undefined, new LocalFileKeyStore());
programManager.setAccount(buyer);

const tx: Transaction = await timed("build + prove", () =>
  programManager.buildExecutionTransaction({
    programName: PROGRAM,
    functionName: FUNCTION,
    inputs: [sellerAddress, `${AMOUNT}u128`, token.plaintext, exclusionProof],
    priorityFee: 0,
    privateFee: true,
    feeRecord: fee.plaintext,
  }),
);
console.log(`tx ${tx.id()}  fee ${Number(tx.feeAmount()) / 1e6} ALEO`);

// 4. Seller-side check, as an x402 facilitator would do before settling: find the record
//    this transfer creates for the seller and read the amount with the seller's view key.
const transfer = tx.transitions().find((t) => t.programId() === PROGRAM && t.functionName() === FUNCTION);
const received = transfer?.ownedRecords(sellerViewKey).map((r: { toString(): string }) => r.toString()) ?? [];
const paid = received.map((r: string) => BigInt(r.match(/amount: (\d+)u128/)![1])).reduce((a: bigint, b: bigint) => a + b, 0n);
console.log(`seller sees ${Number(paid) / 1e6} USDCx in ${received.length} record(s): ${paid >= AMOUNT ? "OK" : "NOT PAID"}`);
if (paid < AMOUNT) throw new Error("Seller-side verification failed; not broadcasting");
if (DRY_RUN) {
  console.log("dry run: not broadcasting");
  process.exit(0);
}

// 5. Broadcast and wait for the network to accept (or reject) it.
await timed("broadcast + confirm", async () => {
  await programManager.networkClient.submitTransaction(tx);
  await programManager.networkClient.waitForTransactionConfirmation(tx.id(), 3_000, 180_000);
});
console.log(`accepted: https://explorer.provable.com/transaction/${tx.id()}`);

// 6. Replace the two spent records with the buyer's change records from this transaction.
const change: StoredRecord[] = tx.ownedRecords(buyer.viewKey()).map((r: { toString(): string }) => {
  const plaintext = r.toString();
  return plaintext.includes("microcredits")
    ? { program: "credits.aleo", name: "credits", plaintext }
    : { program: PROGRAM, name: "Token", plaintext };
});
const remaining = records.filter((r) => r !== token && r !== fee).concat(change);
writeFileSync(RECORDS_FILE, JSON.stringify(remaining, null, 2), { mode: 0o600 });
console.log(`buyer now holds ${remaining.map((r) => `${Number(value(r)) / 1e6} ${r.program === PROGRAM ? "USDCx" : "ALEO"}`).join(", ")}`);
