import { meridianTransferArtifact } from "../../capabilities/meridianArtifacts.js";
import type { DiscoveryTraceV2 } from "../discoveryTraceV2.js";
import { meridianRecipeFromReviewedArtifactV2 } from "./meridianRecipeFactoryV2.js";

export const meridianTransferRecipeV2 = (trace: DiscoveryTraceV2) =>
  meridianRecipeFromReviewedArtifactV2(meridianTransferArtifact, trace);
