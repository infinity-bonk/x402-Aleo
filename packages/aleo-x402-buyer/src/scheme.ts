import { Account, Authorization, ProgramManager, Transaction } from "@provablehq/sdk/mainnet.js";
import type { Network, PaymentPayloadResult, PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";
import { timed, TRANSFER, USDCX, USDCX_DECIMALS, exclusionProof } from "aleo-x402-core";
import { recordValue, type StoredRecord } from "./records.js";

export class ExactAleoClientScheme implements SchemeNetworkClient {
  readonly scheme = "exact";
  // The payment awaiting settlement, so the caller can swap the spent record for its change.
  pending?: { transaction: Transaction; spent: StoredRecord };

  constructor(
    private readonly account: Account,
    private readonly programManager: ProgramManager,
    private readonly records: StoredRecord[],
  ) {}

  // Lets the x402 client's default spend controls treat USDCx as a dollar stablecoin ($1 cap).
  findDefaultAsset = (asset: string, network: Network) =>
    asset === USDCX && network.startsWith("aleo:") ? { asset, decimals: USDCX_DECIMALS, symbol: "USDCx" } : undefined;

  async createPaymentPayload(x402Version: number, requirements: PaymentRequirements): Promise<PaymentPayloadResult> {
    const amount = BigInt(requirements.amount);
    const feeAuthorizationUrl = requirements.extra?.feeAuthorizationUrl;
    if (typeof feeAuthorizationUrl !== "string") throw new Error("requirements don't say where to get the fee sponsored");
    const token = this.records.find(
      (r) => r.program === requirements.asset && r.name === "Token" && recordValue(r) >= amount && r !== this.pending?.spent,
    );
    if (!token) throw new Error(`no unspent ${requirements.asset} record covers ${amount}`);

    // 1. Run and sign the transfer locally, without proving it yet.
    const authorization = await timed("authorize", async () =>
      this.programManager.buildAuthorization({
        programName: requirements.asset,
        functionName: TRANSFER,
        privateKey: this.account.privateKey(),
        inputs: [requirements.payTo, `${amount}u128`, token.plaintext, await exclusionProof(this.account.address().to_string())],
      }),
    );

    // 2. Have the facilitator sign a fee for this execution. Only the public transition is sent;
    //    the authorization's request holds the plaintext record and stays here.
    const feeAuthorization = await timed("fee authorization", async () => {
      const res = await fetch(feeAuthorizationUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          payTo: requirements.payTo,
          amount: requirements.amount,
          asset: requirements.asset,
          executionId: authorization.toExecutionId().toString(),
          transitions: JSON.parse(authorization.toString()).transitions,
        }),
      });
      if (!res.ok) throw new Error(`fee sponsorship refused: ${await res.text()}`);
      return Authorization.fromString((await res.json()).feeAuthorization);
    });

    // 3. Prove the transfer and the sponsored fee into a transaction the facilitator can broadcast.
    const transaction = await timed("prove", () =>
      this.programManager.buildTransactionFromAuthorization({ programName: requirements.asset, authorization, feeAuthorization }),
    );
    this.pending = { transaction, spent: token };
    return { x402Version, payload: { transaction: transaction.toString() } };
  }
}
