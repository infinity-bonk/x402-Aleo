import { Transition, ViewKey } from "@provablehq/sdk/mainnet.js";
import { isSpent, TRANSFER, acceptedRoots } from "aleo-x402-core";

// A transition as it appears in transaction JSON: everything here is public on-chain data.
export type TransitionJSON = {
  program: string;
  function: string;
  inputs: { type: string; id: string }[];
  outputs: { type: string; value: string }[];
};

export type TransferCheck =
  | { ok: true; paid: bigint; serialNumbers: string[] }
  | { ok: false; reason: string };

// Checks, from public data and the seller's view key alone, that `transitions` are a USDCx
// private transfer paying the seller at least `required` that the network will still accept.
export async function checkTransfer(
  transitions: TransitionJSON[],
  asset: string,
  sellerViewKey: ViewKey,
  required: bigint,
): Promise<TransferCheck> {
  if (transitions?.length !== 1) return { ok: false, reason: "expected exactly one transition" };
  const [json] = transitions;
  if (json.program !== asset || json.function !== TRANSFER) {
    return { ok: false, reason: `expected ${asset}/${TRANSFER}, got ${json.program}/${json.function}` };
  }

  // Parsing recomputes the transition id, so tampered outputs don't get this far.
  const transition = Transition.fromString(JSON.stringify(json));
  const paid = transition
    .ownedRecords(sellerViewKey)
    .map((r: { toString(): string }) => BigInt(r.toString().match(/amount: (\d+)u128/)![1]))
    .reduce((a: bigint, b: bigint) => a + b, 0n);
  if (paid < required) return { ok: false, reason: `pays the seller ${paid}, needs ${required}` };

  const root = json.outputs.find((o) => o.type === "future")?.value.match(/arguments:\s*\[\s*(\d+field)/)?.[1];
  if (!root || !(await acceptedRoots()).includes(root)) {
    return { ok: false, reason: "proven against a stale freeze-list root" };
  }

  // A record input's id is its serial number; finding it on-chain means it was already spent.
  const serialNumbers = json.inputs.filter((i) => i.type === "record").map((i) => i.id);
  for (const serialNumber of serialNumbers) {
    if (await isSpent(serialNumber)) return { ok: false, reason: "spends a record that's already spent" };
  }
  return { ok: true, paid, serialNumbers };
}
