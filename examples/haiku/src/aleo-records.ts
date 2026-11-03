import { writeFileSync } from "node:fs";
import { Account, RecordCiphertext } from "@provablehq/sdk/mainnet.js";

// Private records don't show up in any balance lookup: the only way to find them is to try
// decrypting every record output in recent blocks with the owner's view key.
const API = "https://api.provable.com/v2/mainnet";
const BLOCKS = Number(process.argv[2] ?? 2000);
const CHUNK = 50;

const account = new Account({ privateKey: process.env.ALEO_BUYER_PRIVATE_KEY });
const viewKey = account.viewKey();

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The public API rate-limits hard (Cloudflare 429), so pace requests and back off when refused.
async function request(path: string, attempt = 0): Promise<Response> {
  const res = await fetch(`${API}${path}`);
  if (res.status === 429 && attempt < 8) {
    const delay = Math.min(60_000, 5_000 * 2 ** attempt);
    console.error(`rate limited, retrying in ${delay / 1000}s`);
    await wait(delay);
    return request(path, attempt + 1);
  }
  await wait(750);
  return res;
}

async function get(path: string) {
  const res = await request(path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

// A record ciphertext doesn't say what kind of record it is; the program's function signature does.
const sources = new Map<string, string>();
async function recordName(program: string, fn: string, outputIndex: number): Promise<string> {
  if (!sources.has(program)) sources.set(program, await get(`/program/${program}`));
  const body = sources.get(program)!.split(`\nfunction ${fn}:\n`)[1].split(/\n(?=\S)/)[0];
  const outputs = [...body.matchAll(/^\s+output \S+ as ([\w./]+);/gm)].map((m) => m[1]);
  return outputs[outputIndex].replace(/\.record$/, "");
}

// A record is spent once its serial number appears as an input to some transition.
async function isSpent(serialNumber: string): Promise<boolean> {
  const res = await request(`/find/transitionID/${serialNumber}`);
  return res.ok;
}

const latest: number = await get("/block/height/latest");
const first = latest - BLOCKS + 1;
console.log(`Scanning mainnet blocks ${first}..${latest} for records owned by ${account.address()}`);

const unspent = new Map<string, bigint>();
const unspentRecords: { program: string; name: string; plaintext: string }[] = [];
for (let start = first; start <= latest; start += CHUNK) {
  const blocks = await get(`/blocks?start=${start}&end=${Math.min(start + CHUNK - 1, latest)}`);
  if (start === first) console.log(`(window starts ${new Date(blocks[0].header.metadata.timestamp * 1000).toISOString()})`);

  for (const block of blocks) {
    for (const { transaction: tx } of block.transactions ?? []) {
      const transitions = [...(tx.execution?.transitions ?? []), ...(tx.fee ? [tx.fee.transition] : [])];
      for (const transition of transitions) {
        for (const [index, output] of (transition.outputs ?? []).entries()) {
          if (output.type !== "record") continue;
          const ciphertext = RecordCiphertext.fromString(output.value);
          if (!ciphertext.isOwner(viewKey)) continue;

          const record = ciphertext.decrypt(viewKey);
          const name = await recordName(transition.program, transition.function, index);
          const serialNumber = record.serialNumberString(
            account.privateKey(),
            transition.program,
            name,
            record.recordViewKey(viewKey).toString(),
          );
          const spent = await isSpent(serialNumber);

          console.log(`\nblock ${block.header.metadata.height}  tx ${tx.id}  ${spent ? "SPENT" : "unspent"}`);
          console.log(`${transition.program}/${transition.function} -> ${name} record`);
          console.log(record.toString());

          const value = record.toString().match(/(?:amount|microcredits): (\d+)u/)?.[1];
          if (!spent && value) {
            const key = `${transition.program}/${name}`;
            unspent.set(key, (unspent.get(key) ?? 0n) + BigInt(value));
            unspentRecords.push({ program: transition.program, name, plaintext: record.toString() });
          }
        }
      }
    }
  }
}

console.log("\nUnspent totals (6 decimals for both USDCx and ALEO):");
for (const [key, total] of unspent) console.log(`  ${key}: ${Number(total) / 1e6}`);
if (unspent.size === 0) console.log("  none");

// Spending scripts read records from here instead of rescanning the chain.
writeFileSync(".aleo-records.json", JSON.stringify(unspentRecords, null, 2), { mode: 0o600 });
console.log(`Saved ${unspentRecords.length} unspent record(s) to .aleo-records.json`);
