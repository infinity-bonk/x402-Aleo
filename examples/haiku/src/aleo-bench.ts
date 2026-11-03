import {
  Account,
  AleoKeyProvider,
  Authorization,
  initThreadPool,
  LocalFileKeyStore,
  ProgramManager,
  RecordPlaintext,
} from "@provablehq/sdk/mainnet.js";
import type { PaymentRequirements } from "@x402/core/types";
import { timed, ALEO_NETWORK, API_HOST, TRANSFER, USDCX, exclusionProof } from "aleo-x402-core";
import { ExactAleoFacilitatorScheme } from "aleo-x402-seller";
import { loadRecords, recordValue } from "aleo-x402-buyer";

// Where a private x402 payment's time goes. Builds and checks real payments but broadcasts nothing.
const AMOUNT = 1000n; // $0.001, the haiku price

await initThreadPool();
const buyer = new Account({ privateKey: process.env.ALEO_BUYER_PRIVATE_KEY });
const keyProvider = new AleoKeyProvider();
keyProvider.useCache(true);
const programManager = new ProgramManager(API_HOST, keyProvider, undefined, undefined, new LocalFileKeyStore());
const facilitator = new ExactAleoFacilitatorScheme({
  privateKey: process.env.ALEO_FACILITATOR_PRIVATE_KEY!,
  sellerViewKey: process.env.ALEO_SELLER_VIEW_KEY!,
  feeAuthorizationUrl: "(in-process)",
  minAmount: 1n,
  dryRun: true,
});

const records = loadRecords();
const token = records.find((r) => r.name === "Token" && recordValue(r) >= AMOUNT)!;
const credits = records.find((r) => r.name === "credits")!;
const requirements: PaymentRequirements = {
  scheme: "exact",
  network: ALEO_NETWORK,
  asset: USDCX,
  amount: `${AMOUNT}`,
  payTo: process.env.ALEO_SELLER_ADDRESS!,
  maxTimeoutSeconds: 300,
  extra: {},
};

async function authorize() {
  const proof = await timed("  freeze-list proof", () => exclusionProof(buyer.address().to_string()));
  return timed("  authorize (run + sign, no proof)", () =>
    programManager.buildAuthorization({
      programName: USDCX,
      functionName: TRANSFER,
      privateKey: buyer.privateKey(),
      inputs: [requirements.payTo, `${AMOUNT}u128`, token.plaintext, proof],
    }),
  );
}

for (const round of ["cold", "warm"]) {
  console.log(`\nFacilitator pays the fee, ${round} process:`);
  const authorization = await authorize();
  const feeAuthorization = await timed("  facilitator checks payment + signs fee", async () =>
    Authorization.fromString(
      await facilitator.authorizeFee({
        payTo: requirements.payTo,
        amount: requirements.amount,
        asset: USDCX,
        executionId: authorization.toExecutionId().toString(),
        transitions: JSON.parse(authorization.toString()).transitions,
      }),
    ),
  );
  const tx = await timed("  prove transfer + fee_public", () =>
    programManager.buildTransactionFromAuthorization({ programName: USDCX, authorization, feeAuthorization }),
  );
  const verified = await timed("  facilitator verify", () =>
    facilitator.verify({ x402Version: 2, accepted: requirements, payload: { transaction: tx.toString() } }, requirements),
  );
  const headerKB = Math.round((tx.toString().length * 4) / 3 / 1024);
  console.log(`  -> valid: ${verified.isValid}${verified.invalidMessage ? ` (${verified.invalidMessage})` : ""}, x402 header ≈ ${headerKB} KB`);
}

console.log("\nTransfer proof alone, no fee:");
const unpaid = await authorize();
try {
  await timed("  prove transfer only", () => programManager.buildTransactionFromAuthorization({ programName: USDCX, authorization: unpaid }));
} catch (error) {
  console.log(`  not supported: ${(error as Error).message.slice(0, 200)}`);
}

console.log("\nBuyer pays its own fee privately, for comparison:");
const authorization = await authorize();
const baseFee = Number(await programManager.estimateExecutionFee({ programName: USDCX, functionName: TRANSFER })) / 1e6;
const ownFee = await timed("  authorize private fee", () =>
  programManager.buildFeeAuthorization({
    deploymentOrExecutionId: authorization.toExecutionId().toString(),
    baseFeeCredits: baseFee,
    priorityFeeCredits: 0,
    privateKey: buyer.privateKey(),
    feeRecord: RecordPlaintext.fromString(credits.plaintext),
  }),
);
await timed("  prove transfer + fee_private", () =>
  programManager.buildTransactionFromAuthorization({ programName: USDCX, authorization, feeAuthorization: ownFee }),
);
console.log(`\nbase fee: ${baseFee} ALEO`);
process.exit(0);
