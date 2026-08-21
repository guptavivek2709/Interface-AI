import type { DiscoveryTraceV2 } from "../discoveryTraceV2.js";
import type { ArtifactCompilerV2Recipe } from "../artifactCompilerV2.js";
import { meridianOpenShareRecipeV2 } from "./openShareV2.js";
import { meridianPlaceHoldRecipeV2 } from "./placeHoldV2.js";
import { meridianRecordAndBalancesRecipeV2 } from "./recordAndBalancesV2.js";
import { meridianSearchByLastNameRecipeV2 } from "./searchByLastNameV2.js";
import { meridianSearchByNumberRecipeV2 } from "./searchByNumberV2.js";
import { meridianSignOnRecipeV2 } from "./signOnV2.js";
import { meridianTransferRecipeV2 } from "./transferV2.js";
import { meridianUpdateMemberRecipeV2 } from "./updateMemberV2.js";

export const meridianDiscoveryRecipeFactoriesV2: Readonly<
  Record<string, (trace: DiscoveryTraceV2) => ArtifactCompilerV2Recipe>
> = Object.freeze({
  "session.sign_on": meridianSignOnRecipeV2,
  "member.search_by_number": meridianSearchByNumberRecipeV2,
  "member.search_by_last_name": meridianSearchByLastNameRecipeV2,
  "member.get_record_and_balances": meridianRecordAndBalancesRecipeV2,
  "funds.transfer": meridianTransferRecipeV2,
  "share.open": meridianOpenShareRecipeV2,
  "member.update_information": meridianUpdateMemberRecipeV2,
  "account.place_hold": meridianPlaceHoldRecipeV2,
});

export function meridianDiscoveryRecipeV2(
  capabilityId: string,
  trace: DiscoveryTraceV2,
): ArtifactCompilerV2Recipe {
  const factory = meridianDiscoveryRecipeFactoriesV2[capabilityId];
  if (!factory) throw new Error(`No reviewed MERIDIAN discovery recipe for ${capabilityId}`);
  return factory(trace);
}

export * from "./meridianRecipeFactoryV2.js";
export * from "./openShareV2.js";
export * from "./placeHoldV2.js";
export * from "./recordAndBalancesV2.js";
export * from "./searchByLastNameV2.js";
export * from "./searchByNumberV2.js";
export * from "./signOnV2.js";
export * from "./transferV2.js";
export * from "./updateMemberV2.js";
