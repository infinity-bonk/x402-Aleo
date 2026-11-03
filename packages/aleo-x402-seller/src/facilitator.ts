import { Account, AleoKeyProvider, ProgramManager, Transaction, ViewKey } from "@provablehq/sdk/mainnet.js";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { API_HOST, TRANSFER, USDCX } from "aleo-x402-core";
import { checkTransfer, type TransitionJSON } from "./payment.js";

// What a buyer sends to get its payment's network fee sponsored: the payment's public transition
// (never the authorization itself, which holds the buyer's plaintext record) and its execution id.
export type FeeRequest = {
  payTo: string;
  amount: string;
  asset: string;
  executionId: string;
  transitions: TransitionJSON[];
};

type Options = {
  privateKey: string; // pays fees from its public ALEO balance
  sellerViewKey: string; // payments are verified by decrypting the seller's incoming record
  feeAuthorizationUrl: string;
  minAmount: bigint; // smallest payment worth sponsoring a fee for
  dryRun?: boolean; // verify everything but never broadcast
};

// Fee authorizations issued per record serial number, so one record can't farm unlimited fees.
const MAX_SPONSORSHIPS_PER_RECORD = 2;

export class ExactAleoFacilitatorScheme implements SchemeNetworkFacilitator {
  readonly scheme = "exact";
  readonly caipFamily = "aleo:*";
  readonly address: string;
  private readonly account: Account;
  private readonly seller: string;
  private readonly sellerViewKey: ViewKey;
  private readonly programManager: ProgramManager;
  private readonly sponsored = new Map<string, number>();
  private readonly settled = new Set<string>();
  private baseFee?: bigint;

  constructor(private readonly options: Options) {
    this.account = new Account({ privateKey: options.privateKey });
    this.address = this.account.address().to_string();
    this.sellerViewKey = ViewKey.from_string(options.sellerViewKey);
    this.seller = this.sellerViewKey.to_address().to_string();
    const keyProvider = new AleoKeyProvider();
    keyProvider.useCache(true);
    this.programManager = new ProgramManager(API_HOST, keyProvider);
  }

  getExtra(_network: Network) {
    return { feePayer: this.address, feeAuthorizationUrl: this.options.feeAuthorizationUrl };
  }

  getSigners(_network: string) {
    return [this.address];
  }

  // Signs a fee for the buyer's execution once its public transition shows it pays the seller.
  // The id can't be recomputed from the transition here (the SDK only derives it from a full
  // authorization), so a buyer could pair a real payment with another id; the per-record cap
  // bounds that to one ~0.005 ALEO fee per fresh USDCx record. verify() re-checks the final
  // transaction, so an unpaid request never gets the resource.
  async authorizeFee(request: FeeRequest): Promise<string> {
    if (request.payTo !== this.seller) throw new Error("payTo isn't this facilitator's seller");
    if (request.asset !== USDCX) throw new Error(`only ${USDCX} is sponsored`);
    const amount = BigInt(request.amount);
    if (amount < this.options.minAmount) throw new Error(`payments under ${this.options.minAmount} aren't sponsored`);

    const check = await checkTransfer(request.transitions, request.asset, this.sellerViewKey, amount);
    if (!check.ok) throw new Error(check.reason);
    if (check.serialNumbers.some((sn) => (this.sponsored.get(sn) ?? 0) >= MAX_SPONSORSHIPS_PER_RECORD)) {
      throw new Error("this record already had its fee sponsored");
    }
    for (const sn of check.serialNumbers) this.sponsored.set(sn, (this.sponsored.get(sn) ?? 0) + 1);

    this.baseFee ??= await this.programManager.estimateExecutionFee({ programName: USDCX, functionName: TRANSFER });
    const feeAuthorization = await this.programManager.buildFeeAuthorization({
      deploymentOrExecutionId: request.executionId,
      baseFeeCredits: Number(this.baseFee) / 1e6,
      priorityFeeCredits: 0,
      privateKey: this.account.privateKey(),
    });
    return feeAuthorization.toString();
  }

  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    try {
      await this.check(payload, requirements);
      return { isValid: true };
    } catch (error) {
      return { isValid: false, invalidReason: "invalid_aleo_payment", invalidMessage: (error as Error).message };
    }
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    const network = requirements.network;
    let tx: Transaction;
    try {
      tx = await this.check(payload, requirements);
    } catch (error) {
      return { success: false, errorReason: "invalid_aleo_payment", errorMessage: (error as Error).message, transaction: "", network };
    }

    const id = tx.id();
    if (this.options.dryRun) {
      console.log(`DRY RUN: ${id} is valid but was not broadcast`);
      return { success: false, errorReason: "dry_run", errorMessage: "facilitator is in dry-run mode", transaction: id, network };
    }

    const client = this.programManager.networkClient;
    try {
      await client.submitTransaction(tx);
    } catch (error) {
      // The SDK retries failed posts, and a retry of a post that actually landed reports the
      // transaction's own inputs as "already exists". Confirmation below settles which it was.
      console.error(`broadcast of ${id} reported: ${(error as Error).message}`);
    }
    try {
      await client.waitForTransactionConfirmation(id, 2_000, 120_000);
    } catch (error) {
      return { success: false, errorReason: "settlement_failed", errorMessage: (error as Error).message, transaction: id, network };
    }
    this.settled.add(id);
    return { success: true, transaction: id, network };
  }

  private async check(payload: PaymentPayload, requirements: PaymentRequirements): Promise<Transaction> {
    const serialized = payload.payload.transaction;
    if (typeof serialized !== "string") throw new Error("payload has no transaction");
    if (requirements.payTo !== this.seller) throw new Error("payTo isn't this facilitator's seller");

    const tx = Transaction.fromString(serialized); // rejects malformed transactions and mismatched ids
    if (this.settled.has(tx.id())) throw new Error("transaction was already settled");
    const json = JSON.parse(serialized);
    if (json.type !== "execute") throw new Error("not an execute transaction");

    const check = await checkTransfer(json.execution.transitions, requirements.asset, this.sellerViewKey, BigInt(requirements.amount));
    if (!check.ok) throw new Error(check.reason);
    return tx;
  }
}
