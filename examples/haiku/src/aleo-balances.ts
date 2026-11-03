import { get, USDCX } from "aleo-x402-core";
import { loadRecords, recordValue } from "aleo-x402-buyer";

// Public balances live in program mappings anyone can read. Private balances exist only as
// records, so the buyer's come from .aleo-records.json (refresh it with `npm run aleo:records`).
const accounts = {
  buyer: process.env.ALEO_BUYER_ADDRESS,
  seller: process.env.ALEO_SELLER_ADDRESS,
  facilitator: process.env.ALEO_FACILITATOR_ADDRESS,
};
const units = (value: string | null) => (value ? parseInt(value) / 1e6 : 0);

for (const [name, address] of Object.entries(accounts)) {
  const aleo = await get(`/program/credits.aleo/mapping/account/${address}`);
  const usdcx = await get(`/program/${USDCX}/mapping/balances/${address}`);
  console.log(`${name.padEnd(11)} public:  ${units(aleo)} ALEO, ${units(usdcx)} USDCx`);
}

const total = (program: string) =>
  loadRecords().filter((r) => r.program === program).reduce((sum, r) => sum + recordValue(r), 0n);
console.log(`buyer       private: ${Number(total("credits.aleo")) / 1e6} ALEO, ${Number(total(USDCX)) / 1e6} USDCx`);
