import {
  CapabilityArtifactV2Schema,
  type ApprovalRequirementV2,
  type ActionV2,
  type CapabilityArtifactV2,
  type ConditionV2,
  type FieldSpecV2,
  type RuntimeStateRuleV2,
  type StepEffectV2,
  type StepV2,
  type TargetV2,
} from "../domain/index.js";
import {
  DiscoveryTraceV2Schema,
  assertNoRawDiscoveryInputLeak,
  type DiscoveryTraceStepV2,
  type DiscoveryTraceV2,
} from "./discoveryTraceV2.js";

export interface ReviewerStepAnnotationV2 {
  /** Safety/effect classification supplied by a human-reviewed target recipe. */
  readonly effect: StepEffectV2;
  readonly approval?: ApprovalRequirementV2;
  readonly safeRestartStepId?: string;
  readonly timeoutMs?: number;
  readonly retry?: { readonly maxAttempts: number; readonly backoffMs: number };
}

export type ReviewerTableColumnV2 = Extract<
  ActionV2,
  { kind: "extract_table" }
>["columns"][number];

/**
 * Reviewer-owned semantic annotations. Locators, actions, ordering,
 * postconditions, and the terminal checkpoint deliberately cannot be supplied
 * here: those are compiled from the discovery trace.
 */
export interface ArtifactCompilerV2Recipe {
  readonly capability: Omit<CapabilityArtifactV2["capability"], "approval">;
  readonly compatibility: CapabilityArtifactV2["compatibility"];
  readonly inputs: readonly FieldSpecV2[];
  readonly outputs: CapabilityArtifactV2["outputs"];
  readonly policy: CapabilityArtifactV2["policy"];
  readonly runtimeStates: readonly RuntimeStateRuleV2[];
  readonly stepAnnotations: Readonly<Record<string, ReviewerStepAnnotationV2>>;
  /** Reviewer-owned schema mapping for semantic table extracts. */
  readonly tableColumns?: Readonly<Record<string, readonly ReviewerTableColumnV2[]>>;
  /** Extra sensitive targets used by approval/recovery annotations, if any. */
  readonly sensitiveTargetIds?: readonly string[];
}

export interface CompileArtifactV2Options {
  /** Raw invocation values are denylist material only and are never serialized. */
  readonly forbiddenInputValues?: Iterable<string | number | boolean>;
}

function containsPlaceholder(value: string): boolean {
  return /\{\{[A-Za-z0-9._:-]+\}\}/u.test(value);
}

function sensitivityRank(classification: FieldSpecV2["classification"]): number {
  return {
    public: 0,
    internal: 1,
    confidential: 2,
    restricted: 3,
    secret: 4,
  }[classification];
}

function deriveSensitiveTargetIds(
  trace: DiscoveryTraceV2,
  recipe: ArtifactCompilerV2Recipe,
): ReadonlySet<string> {
  const result = new Set(recipe.sensitiveTargetIds ?? []);
  const inputClassifications = new Map(recipe.inputs.map((field) => [field.name, field.classification]));
  const outputClassifications = new Map(recipe.outputs.map((field) => [field.name, field.classification]));
  for (const step of trace.steps) {
    if (!("targetId" in step.action)) continue;
    if (
      "value" in step.action &&
      step.action.value.kind === "input" &&
      sensitivityRank(inputClassifications.get(step.action.value.name) ?? "secret") >= 2
    ) {
      result.add(step.action.targetId);
    }
    if (
      step.action.kind === "extract" &&
      sensitivityRank(outputClassifications.get(step.action.outputName) ?? "secret") >= 2
    ) {
      result.add(step.action.targetId);
    }
  }
  return result;
}

function compileTargets(
  trace: DiscoveryTraceV2,
  sensitiveTargetIds: ReadonlySet<string>,
): TargetV2[] {
  const targets = new Map<string, TargetV2>();
  for (const step of trace.steps) {
    if (!step.target) continue;
    const candidate: TargetV2 = {
      ...step.target,
      sensitive: sensitiveTargetIds.has(step.target.id),
    };
    const existing = targets.get(candidate.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(candidate)) {
      throw new Error(`Discovery target ${candidate.id} changed its locator contract during the trace`);
    }
    targets.set(candidate.id, candidate);
  }
  return [...targets.values()];
}

function compileAction(
  step: DiscoveryTraceStepV2,
  recipe: ArtifactCompilerV2Recipe,
): StepV2["action"] {
  const action = step.action;
  switch (action.kind) {
    case "click":
      return { kind: "click", targetId: action.targetId };
    case "fill":
    case "select":
      return { kind: action.kind, targetId: action.targetId, value: action.value };
    case "extract":
      if (step.target?.strategies.some((strategy) => strategy.kind === "table")) {
        const columns = recipe.tableColumns?.[action.outputName];
        if (!columns?.length) {
          throw new Error(
            `Semantic table output ${action.outputName} requires reviewer-supplied column semantics`,
          );
        }
        const observedHeaders = new Set(
          step.target.strategies
            .filter((strategy) => strategy.kind === "table")
            .flatMap((strategy) => strategy.headers),
        );
        for (const column of columns) {
          if (!observedHeaders.has(column.header)) {
            throw new Error(
              `Reviewer table column ${column.header} was not observed in trace step ${step.id}`,
            );
          }
        }
        return {
          kind: "extract_table",
          targetId: action.targetId,
          outputName: action.outputName,
          columns: columns.map((column) => ({ ...column })),
        };
      }
      return {
        kind: "extract",
        targetId: action.targetId,
        outputName: action.outputName,
        source: "text",
      };
    case "press":
      return { kind: "press", key: action.key };
  }
}

function transitionHeading(step: DiscoveryTraceStepV2): string | undefined {
  return step.after.headings.find(
    (heading) => !step.before.headings.includes(heading) && !containsPlaceholder(heading),
  );
}

function postconditionFor(
  trace: DiscoveryTraceV2,
  step: DiscoveryTraceStepV2,
  index: number,
  sensitiveTargetIds: ReadonlySet<string>,
): ConditionV2 {
  const action = step.action;
  if (action.kind === "fill" || action.kind === "select") {
    return {
      kind: "target_value",
      targetId: action.targetId,
      operator: "equals",
      value: action.value,
      redactActual: sensitiveTargetIds.has(action.targetId),
    };
  }
  if (action.kind === "extract") {
    return { kind: "target_present", targetId: action.targetId, present: true };
  }
  const heading = transitionHeading(step);
  if (heading) return { kind: "text_visible", text: heading, exact: true };
  const nextStep = trace.steps[index + 1];
  if (nextStep && "targetId" in nextStep.action) {
    return { kind: "target_present", targetId: nextStep.action.targetId, present: true };
  }
  if (!containsPlaceholder(trace.checkpointText)) {
    return { kind: "text_visible", text: trace.checkpointText, exact: true };
  }
  if (trace.finalState.title && !containsPlaceholder(trace.finalState.title)) {
    return { kind: "page_title", title: trace.finalState.title, exact: true };
  }
  if ("targetId" in action) {
    return { kind: "target_present", targetId: action.targetId, present: true };
  }
  throw new Error(`Trace step ${step.id} has no observable, privacy-safe postcondition`);
}

function checkpointFor(trace: DiscoveryTraceV2): ConditionV2 {
  if (!containsPlaceholder(trace.checkpointText)) {
    return { kind: "text_visible", text: trace.checkpointText, exact: true };
  }
  const finalHeading = trace.finalState.headings.find((heading) => !containsPlaceholder(heading));
  if (finalHeading) return { kind: "text_visible", text: finalHeading, exact: true };
  if (trace.finalState.title && !containsPlaceholder(trace.finalState.title)) {
    return { kind: "page_title", title: trace.finalState.title, exact: true };
  }
  const lastTargeted = [...trace.steps].reverse().find((step) => "targetId" in step.action);
  if (lastTargeted && "targetId" in lastTargeted.action) {
    return { kind: "target_present", targetId: lastTargeted.action.targetId, present: true };
  }
  throw new Error("Discovery trace has no privacy-safe terminal checkpoint");
}

function compileSteps(
  trace: DiscoveryTraceV2,
  recipe: ArtifactCompilerV2Recipe,
  sensitiveTargetIds: ReadonlySet<string>,
): StepV2[] {
  const traceStepIds = new Set(trace.steps.map((step) => step.id));
  const annotationIds = Object.keys(recipe.stepAnnotations);
  const missing = trace.steps.filter((step) => !Object.hasOwn(recipe.stepAnnotations, step.id));
  const extra = annotationIds.filter((stepId) => !traceStepIds.has(stepId));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `Reviewer step annotations must match the trace exactly (missing=${missing.map((step) => step.id).join(",") || "none"}; extra=${extra.join(",") || "none"})`,
    );
  }

  return trace.steps.map((step, index) => {
    const annotation = recipe.stepAnnotations[step.id]!;
    return {
      id: step.id,
      title: `${step.action.kind} ${step.target?.description ?? step.action.kind}`,
      action: compileAction(step, recipe),
      preconditions:
        "targetId" in step.action
          ? [{ kind: "target_present" as const, targetId: step.action.targetId, present: true }]
          : [],
      postcondition: postconditionFor(trace, step, index, sensitiveTargetIds),
      timeoutMs: annotation.timeoutMs ?? 8_000,
      retry: annotation.retry ?? { maxAttempts: 1, backoffMs: 0 },
      effect: annotation.effect,
      ...(annotation.approval ? { approval: annotation.approval } : {}),
      ...(annotation.safeRestartStepId ? { safeRestartStepId: annotation.safeRestartStepId } : {}),
    };
  });
}

/**
 * Compiles a V2 draft whose executable structure comes from the model-backed
 * trace. The recipe can add only reviewed contract/safety semantics.
 */
export function compileArtifactV2(
  value: DiscoveryTraceV2,
  recipe: ArtifactCompilerV2Recipe,
  options: CompileArtifactV2Options = {},
): CapabilityArtifactV2 {
  const trace = DiscoveryTraceV2Schema.parse(value);
  const inputNames = new Set(recipe.inputs.map((field) => field.name));
  const outputNames = new Set(recipe.outputs.map((field) => field.name));
  for (const input of trace.inputs) {
    if (!inputNames.has(input.name)) throw new Error(`Reviewer recipe omitted discovered input ${input.name}`);
  }
  for (const step of trace.steps) {
    if ("value" in step.action && step.action.value.kind === "input" && !inputNames.has(step.action.value.name)) {
      throw new Error(`Trace step ${step.id} references input absent from the reviewer recipe`);
    }
    if (step.action.kind === "extract" && !outputNames.has(step.action.outputName)) {
      throw new Error(`Trace step ${step.id} extracts output absent from the reviewer recipe`);
    }
  }

  const sensitiveTargetIds = deriveSensitiveTargetIds(trace, recipe);
  const artifact = CapabilityArtifactV2Schema.parse({
    schemaVersion: "2.0",
    capability: {
      ...recipe.capability,
      approval: "draft",
    },
    provenance: {
      source: "discovery",
      createdAt: trace.createdAt,
      goal: trace.goalTemplate,
      discoveryRunId: trace.runId,
      planner: {
        provider: trace.planner.provider,
        model: trace.planner.model,
      },
    },
    compatibility: recipe.compatibility,
    inputs: recipe.inputs,
    outputs: recipe.outputs,
    policy: recipe.policy,
    targets: compileTargets(trace, sensitiveTargetIds),
    steps: compileSteps(trace, recipe, sensitiveTargetIds),
    runtimeStates: recipe.runtimeStates,
    checkpoint: checkpointFor(trace),
  });
  assertNoRawDiscoveryInputLeak(artifact, options.forbiddenInputValues ?? []);
  return artifact;
}
