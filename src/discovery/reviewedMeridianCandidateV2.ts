import { meridianArtifacts } from "../capabilities/meridianArtifacts.js";
import {
  CapabilityArtifactV2Schema,
  type CapabilityArtifactV2,
  type StepV2,
} from "../domain/index.js";

function persistentBoundary(artifact: CapabilityArtifactV2): number {
  return artifact.steps.findIndex(
    (step) => step.effect === "reversible_write" || step.effect === "irreversible_commit",
  );
}

function referencedTargetIds(value: unknown, result = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) referencedTargetIds(item, result);
    return result;
  }
  if (!value || typeof value !== "object") return result;
  for (const [key, item] of Object.entries(value)) {
    if (key === "targetId" && typeof item === "string") result.add(item);
    else referencedTargetIds(item, result);
  }
  return result;
}

function targetIdOf(step: StepV2): string | undefined {
  return "targetId" in step.action ? step.action.targetId : undefined;
}

function mergeCheckedLocatorStrategies(
  draft: CapabilityArtifactV2,
  reviewed: CapabilityArtifactV2,
  discoveredStepCount: number,
): CapabilityArtifactV2["targets"] {
  const targets = new Map(draft.targets.map((target) => [target.id, structuredClone(target)]));
  const checkedTargets = new Map(reviewed.targets.map((target) => [target.id, target]));
  for (let index = 0; index < discoveredStepCount; index += 1) {
    const discoveredId = targetIdOf(draft.steps[index]!);
    const checkedId = targetIdOf(reviewed.steps[index]!);
    if (!discoveredId || !checkedId) continue;
    const discovered = targets.get(discoveredId);
    const checked = checkedTargets.get(checkedId);
    if (!discovered || !checked || discovered.framePath.join("/") !== checked.framePath.join("/")) continue;
    const strategies = [...discovered.strategies];
    for (const strategy of checked.strategies) {
      if (!strategies.some((candidate) => JSON.stringify(candidate) === JSON.stringify(strategy))) {
        strategies.push(structuredClone(strategy));
      }
    }
    targets.set(discoveredId, {
      ...discovered,
      strategies,
      sensitive: discovered.sensitive || checked.sensitive,
    });
  }
  return [...targets.values()];
}

/**
 * Complete a trace-derived MERIDIAN draft with the checked, human-reviewed
 * persistent suffix. Discovery owns the live safe prefix and its locators;
 * the model is never allowed to invent a commit, approval, receipt contract,
 * recovery policy, or success checkpoint.
 */
export function integrateReviewedMeridianContractV2(
  draftValue: CapabilityArtifactV2,
): CapabilityArtifactV2 {
  const draft = CapabilityArtifactV2Schema.parse(draftValue);
  if (draft.capability.approval !== "draft" || draft.provenance.source !== "discovery") {
    throw new Error("MERIDIAN review integration requires a trace-derived draft");
  }
  const reviewed = meridianArtifacts.find(
    (artifact) =>
      artifact.capability.id === draft.capability.id &&
      artifact.capability.version === draft.capability.version,
  );
  if (!reviewed) throw new Error(`No checked MERIDIAN contract matches ${draft.capability.id}`);

  const boundary = persistentBoundary(reviewed);
  if (boundary === -1) {
    // Fault-only controls cannot be observed during a successful discovery
    // trace. They remain part of the checked safety contract so a real replay
    // can classify and recover from exceptional pages without model help.
    const runtimeTargetIds = referencedTargetIds(reviewed.runtimeStates);
    const targets = new Map(
      mergeCheckedLocatorStrategies(draft, reviewed, draft.steps.length)
        .map((target) => [target.id, structuredClone(target)]),
    );
    for (const target of reviewed.targets) {
      if (runtimeTargetIds.has(target.id) && !targets.has(target.id)) {
        targets.set(target.id, structuredClone(target));
      }
    }
    return CapabilityArtifactV2Schema.parse({
      ...structuredClone(draft),
      targets: [...targets.values()],
      runtimeStates: structuredClone(reviewed.runtimeStates),
    });
  }
  if (draft.steps.length !== boundary) {
    throw new Error(
      `Discovered ${draft.capability.id} prefix has ${draft.steps.length} steps; expected ${boundary}`,
    );
  }

  // For review→commit transactions, the checked review step owns the opaque
  // hidden-token precondition. Discovery still owns all navigation/form work.
  const reviewedStart =
    boundary > 0 && reviewed.steps[boundary - 1]!.effect === "review"
      ? boundary - 1
      : boundary;
  const discoveredPrefix: StepV2[] = draft.steps.slice(0, reviewedStart);
  const checkedSuffix: StepV2[] = structuredClone(reviewed.steps.slice(reviewedStart));
  const targets = new Map(reviewed.targets.map((target) => [target.id, structuredClone(target)]));
  // A genuinely discovered target ID normally differs from the checked
  // contract ID. If a compiler deliberately preserves an ID, prefer the live
  // observed locator while retaining every suffix-only checked target.
  for (const target of mergeCheckedLocatorStrategies(draft, reviewed, reviewedStart)) {
    targets.set(target.id, structuredClone(target));
  }

  return CapabilityArtifactV2Schema.parse({
    ...structuredClone(reviewed),
    capability: {
      ...reviewed.capability,
      approval: "draft",
      tags: [...new Set([...reviewed.capability.tags, "discovered-v2"])],
    },
    provenance: structuredClone(draft.provenance),
    targets: [...targets.values()],
    steps: [...structuredClone(discoveredPrefix), ...checkedSuffix],
  });
}
