import { SealanceMerkleTree } from "@provablehq/sdk/mainnet.js";
import { get } from "./chain.js";

const FREEZELIST = "/program/usdcx_freezelist.aleo/mapping";
const ZERO_ADDRESS = "aleo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3ljyzc";

// Merkle exclusion proof that `address` isn't on the USDCx freeze list, as transfer_private expects.
export async function exclusionProof(address: string): Promise<string> {
  const lastIndex = parseInt((await get(`${FREEZELIST}/freeze_list_last_index/true`)) ?? "0u32");
  const frozen: string[] = [];
  for (let i = 0; i <= lastIndex; i++) {
    const entry = await get(`${FREEZELIST}/freeze_list_index/${i}u32`);
    if (entry && entry !== ZERO_ADDRESS) frozen.push(entry); // zero address marks an empty slot
  }

  const sealance = new SealanceMerkleTree();
  const tree = sealance.buildTree(sealance.generateLeaves(frozen));
  const [current] = await acceptedRoots();
  if (`${tree[tree.length - 1]}field` !== current) throw new Error("Rebuilt freeze-list root doesn't match on-chain root");

  // The contract's MerkleProof holds 16 siblings, so the path depth is 16 (not the SDK example's 15).
  const [left, right] = sealance.getLeafIndices(tree, address);
  return sealance.formatMerkleProof([sealance.getSiblingPath(tree, left, 16), sealance.getSiblingPath(tree, right, 16)]);
}

// USDCx's finalize accepts a transfer proven against the current freeze-list root, or against the
// previous root for `block_height_window` blocks after an update. Anything else is rejected on-chain.
export async function acceptedRoots(): Promise<string[]> {
  const [current, previous, updatedAt, window, height] = await Promise.all([
    get(`${FREEZELIST}/freeze_list_root/1u8`),
    get(`${FREEZELIST}/freeze_list_root/2u8`),
    get(`${FREEZELIST}/root_updated_height/true`),
    get(`${FREEZELIST}/block_height_window/true`),
    get("/block/height/latest"),
  ]);
  const previousStillValid = previous && updatedAt && height < parseInt(updatedAt) + parseInt(window);
  return previousStillValid ? [current, previous] : [current];
}
