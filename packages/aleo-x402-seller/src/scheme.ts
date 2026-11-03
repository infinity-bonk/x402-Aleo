import type { AssetAmount, Network, PaymentRequirements, Price, SchemeNetworkServer, SupportedKind } from "@x402/core/types";
import { USDCX, USDCX_DECIMALS } from "aleo-x402-core";

export class ExactAleoServerScheme implements SchemeNetworkServer {
  readonly scheme = "exact";
  readonly defaultAssetTransferMethod = "default";
  // Verify before the handler runs, settle after it succeeds (and before the response is sent).
  readonly paymentFlows = { default: { supported: ["authorization"], default: "authorization" } } as const;

  async parsePrice(price: Price, _network: Network): Promise<AssetAmount> {
    if (typeof price === "object") return price;
    return { asset: USDCX, amount: toMicroUnits(String(price)) };
  }

  getAssetDecimals(asset: string) {
    return asset === USDCX ? USDCX_DECIMALS : undefined;
  }

  // Passes the facilitator's fee payer and fee-authorization URL through to the buyer.
  async enhancePaymentRequirements(requirements: PaymentRequirements, supportedKind: SupportedKind): Promise<PaymentRequirements> {
    return { ...requirements, extra: { ...requirements.extra, ...supportedKind.extra } };
  }
}

// "$0.001" -> "1000", without going through floating point.
function toMicroUnits(dollars: string): string {
  const [whole, fraction = ""] = dollars.replace(/^\$/, "").split(".");
  if (fraction.length > USDCX_DECIMALS) throw new Error(`${dollars} has more than ${USDCX_DECIMALS} decimals`);
  return (BigInt(whole || "0") * 10n ** BigInt(USDCX_DECIMALS) + BigInt(fraction.padEnd(USDCX_DECIMALS, "0"))).toString();
}
