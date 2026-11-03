import { readFileSync, writeFileSync } from "node:fs";
import type { Transaction, ViewKey } from "@provablehq/sdk/mainnet.js";
import { USDCX } from "aleo-x402-core";

// Unspent records found by `npm run aleo:records`, kept current by the scripts that spend them.
export type StoredRecord = { program: string; name: string; plaintext: string };

const RECORDS_FILE = ".aleo-records.json";

export const loadRecords = (): StoredRecord[] => JSON.parse(readFileSync(RECORDS_FILE, "utf8"));

export const saveRecords = (records: StoredRecord[]) =>
  writeFileSync(RECORDS_FILE, JSON.stringify(records, null, 2), { mode: 0o600 });

export const recordValue = (r: StoredRecord) => BigInt(r.plaintext.match(/(?:amount|microcredits): (\d+)u/)![1]);

// The records a transaction created for `viewKey`'s owner (USDCx change, or ALEO fee change).
export function ownedRecords(tx: Transaction, viewKey: ViewKey): StoredRecord[] {
  return tx.ownedRecords(viewKey).map((r: { toString(): string }) => {
    const plaintext = r.toString();
    return plaintext.includes("microcredits")
      ? { program: "credits.aleo", name: "credits", plaintext }
      : { program: USDCX, name: "Token", plaintext };
  });
}
