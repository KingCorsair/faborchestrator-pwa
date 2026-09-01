/**
 * The one place an adapter is chosen.
 *
 * Everything else imports `mes` and gets the contract. When
 * `FabOrchestratorMESAdapter` arrives in Tier 4, this switch is the only file
 * that learns about it — if a second file ever has to know which adapter is
 * active, the contract has leaked and that is the bug to fix, not the symptom.
 */

import { MockMESAdapter } from "./mock-adapter";
import type { MESAdapter } from "./types";

function selectAdapter(): MESAdapter {
  switch (process.env.MES_ADAPTER) {
    // case "faborchestrator": return new FabOrchestratorMESAdapter();  // Tier 4
    case "mock":
    case undefined:
    case "":
      return new MockMESAdapter();
    default:
      // Silently falling back to mock data would let a misconfigured
      // deployment show a supervisor invented numbers as though they were live.
      throw new Error(`Unknown MES_ADAPTER "${process.env.MES_ADAPTER}"`);
  }
}

export const mes: MESAdapter = selectAdapter();

export * from "./types";
export * from "./issues";
export * from "./rules-config";
