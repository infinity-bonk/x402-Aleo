import { x402Facilitator } from "@x402/core/facilitator";
import type { FacilitatorClient } from "@x402/core/server";
import type { SupportedResponse } from "@x402/core/types";
import { ALEO_NETWORK } from "aleo-x402-core";
import type { ExactAleoFacilitatorScheme } from "./facilitator.js";

// The Aleo facilitator needs the seller's view key, so it runs in the seller's own process. This
// exposes it as the FacilitatorClient that x402ResourceServer expects, with no HTTP hop.
export function localFacilitatorClient(scheme: ExactAleoFacilitatorScheme): FacilitatorClient {
  const facilitator = new x402Facilitator().register(ALEO_NETWORK, scheme);
  return {
    verify: (payload, requirements) => facilitator.verify(payload, requirements),
    settle: (payload, requirements) => facilitator.settle(payload, requirements),
    getSupported: async () => facilitator.getSupported() as SupportedResponse, // its networks are typed as plain strings
  };
}
