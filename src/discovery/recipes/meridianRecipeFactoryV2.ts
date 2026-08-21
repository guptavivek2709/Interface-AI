import {
  CapabilityArtifactV2Schema,
  type ActionV2,
  type CapabilityArtifactV2,
  type RuntimeStateRuleV2,
} from "../../domain/index.js";
import {
  DiscoveryTraceV2Schema,
  type DiscoveryTraceActionV2,
  type DiscoveryTraceV2,
} from "../discoveryTraceV2.js";
import type { ArtifactCompilerV2Recipe } from "../artifactCompilerV2.js";

class UnmappedTarget extends Error {}

function compatibleAction(trace: DiscoveryTraceActionV2, reviewed: ActionV2): boolean {
  if (trace.kind === "extract" && (reviewed.kind === "extract" || reviewed.kind === "extract_table")) {
    return trace.outputName === reviewed.outputName;
  }
  if (trace.kind !== reviewed.kind) return false;
  if (trace.kind === "fill" || trace.kind === "select") {
    return JSON.stringify(trace.value) === JSON.stringify((reviewed as Extract<ActionV2, { kind: "fill" | "select" }>).value);
  }
  if (trace.kind === "press") {
    return trace.key === (reviewed as Extract<ActionV2, { kind: "press" }>).key;
  }
  return true;
}

function targetIdOf(action: DiscoveryTraceActionV2 | ActionV2): string | undefined {
  return "targetId" in action ? action.targetId : undefined;
}

function remapTargets(value: unknown, aliases: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(value)) return value.map((item) => remapTargets(item, aliases));
  if (!value || typeof value !== "object") return value;
  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of Object.entries(value)) {
    if (key === "targetId" && typeof item === "string") {
      const alias = aliases.get(item);
      if (!alias) throw new UnmappedTarget(item);
      result[key] = alias;
    } else {
      result[key] = remapTargets(item, aliases);
    }
  }
  return result;
}

/**
 * Projects one reviewed MERIDIAN contract into the deliberately narrow
 * annotation-only recipe accepted by the trace compiler. Persistent write
 * actions are never inferred: discovery recipes end at the reviewed prefix.
 */
export function meridianRecipeFromReviewedArtifactV2(
  reviewedValue: CapabilityArtifactV2,
  traceValue: DiscoveryTraceV2,
): ArtifactCompilerV2Recipe {
  const reviewed = CapabilityArtifactV2Schema.parse(reviewedValue);
  const trace = DiscoveryTraceV2Schema.parse(traceValue);
  const writeBoundary = reviewed.steps.findIndex(
    (step) => step.effect === "reversible_write" || step.effect === "irreversible_commit",
  );
  const maximumSafeSteps = writeBoundary === -1 ? reviewed.steps.length : writeBoundary;
  if (trace.steps.length > maximumSafeSteps) {
    throw new Error(
      `Discovery trace for ${reviewed.capability.id} crosses the reviewed persistent-write boundary`,
    );
  }
  if (trace.steps.length === 0) throw new Error("MERIDIAN recipe requires at least one discovered step");

  const reviewedInputNames = [...reviewed.inputs.map((input) => input.name)].sort();
  const traceInputNames = [...trace.inputs.map((input) => input.name)].sort();
  if (JSON.stringify(reviewedInputNames) !== JSON.stringify(traceInputNames)) {
    throw new Error(
      `Discovery inputs do not exactly match the reviewed ${reviewed.capability.id} contract`,
    );
  }

  const targetAliases = new Map<string, string>();
  const stepAliases = new Map<string, string>();
  for (const [index, traceStep] of trace.steps.entries()) {
    const reviewedStep = reviewed.steps[index]!;
    if (!compatibleAction(traceStep.action, reviewedStep.action)) {
      throw new Error(
        `Trace step ${traceStep.id} does not match reviewed ${reviewed.capability.id} annotation slot ${reviewedStep.id}`,
      );
    }
    stepAliases.set(reviewedStep.id, traceStep.id);
    const reviewedTargetId = targetIdOf(reviewedStep.action);
    const traceTargetId = targetIdOf(traceStep.action);
    if (reviewedTargetId || traceTargetId) {
      if (!reviewedTargetId || !traceTargetId) throw new Error("Reviewed and traced target shape differs");
      const existing = targetAliases.get(reviewedTargetId);
      if (existing && existing !== traceTargetId) {
        throw new Error(`Reviewed target ${reviewedTargetId} mapped to multiple discovered targets`);
      }
      targetAliases.set(reviewedTargetId, traceTargetId);
    }
  }

  const stepAnnotations = Object.fromEntries(
    trace.steps.map((traceStep, index) => {
      const reviewedStep = reviewed.steps[index]!;
      if (reviewedStep.approval) {
        throw new Error("A safe-prefix MERIDIAN recipe cannot contain a persistent-write approval");
      }
      const safeRestartStepId = reviewedStep.safeRestartStepId
        ? stepAliases.get(reviewedStep.safeRestartStepId)
        : undefined;
      if (reviewedStep.safeRestartStepId && !safeRestartStepId) {
        throw new Error(`Safe restart step ${reviewedStep.safeRestartStepId} was not observed`);
      }
      return [
        traceStep.id,
        {
          effect: reviewedStep.effect,
          timeoutMs: reviewedStep.timeoutMs,
          retry: reviewedStep.retry,
          ...(safeRestartStepId ? { safeRestartStepId } : {}),
        },
      ];
    }),
  );

  const extractedOutputs = new Set(
    trace.steps
      .filter((step) => step.action.kind === "extract")
      .map((step) => (step.action as Extract<DiscoveryTraceActionV2, { kind: "extract" }>).outputName),
  );
  const outputs = reviewed.outputs.filter((output) => extractedOutputs.has(output.name));
  if (outputs.length !== extractedOutputs.size) {
    throw new Error(`Discovery trace extracts an output absent from ${reviewed.capability.id}`);
  }

  const tableColumns = Object.fromEntries(
    reviewed.steps
      .slice(0, trace.steps.length)
      .filter((step) => step.action.kind === "extract_table")
      .map((step) => {
        const action = step.action as Extract<ActionV2, { kind: "extract_table" }>;
        return [action.outputName, action.columns];
      }),
  );

  const runtimeStates: RuntimeStateRuleV2[] = [];
  for (const state of reviewed.runtimeStates) {
    try {
      runtimeStates.push(remapTargets(state, targetAliases) as RuntimeStateRuleV2);
    } catch (error) {
      if (!(error instanceof UnmappedTarget)) throw error;
      // A state requiring a locator outside the successful discovery trace is
      // not smuggled in as an ungrounded target. Target-free states remain.
    }
  }
  const sensitiveTargetIds = reviewed.targets
    .filter((target) => target.sensitive)
    .map((target) => targetAliases.get(target.id))
    .filter((id): id is string => Boolean(id));

  return {
    capability: {
      id: reviewed.capability.id,
      name: reviewed.capability.name,
      description:
        writeBoundary === -1
          ? reviewed.capability.description
          : `${reviewed.capability.description} This discovered draft ends at the reviewed, non-persistent prefix.`,
      version: reviewed.capability.version,
      risk: reviewed.capability.risk,
      tags: [...new Set([...reviewed.capability.tags, "discovered-v2"])],
    },
    compatibility: reviewed.compatibility,
    inputs: reviewed.inputs,
    outputs,
    policy: reviewed.policy,
    runtimeStates,
    stepAnnotations,
    ...(Object.keys(tableColumns).length > 0 ? { tableColumns } : {}),
    ...(sensitiveTargetIds.length > 0 ? { sensitiveTargetIds } : {}),
  };
}
