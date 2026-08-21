import { describe, expect, it } from "vitest";
import { meridianArtifacts } from "../../src/capabilities/meridianArtifacts.js";
import { compileArtifactV2 } from "../../src/discovery/artifactCompilerV2.js";
import { createMeridianDiscoveryPolicyV2 } from "../../src/discovery/cliV2.js";
import {
  DiscoveryTraceV2Schema,
  type DiscoveryTraceActionV2,
  type DiscoveryTraceV2,
} from "../../src/discovery/discoveryTraceV2.js";
import {
  meridianDiscoveryRecipeFactoriesV2,
  meridianDiscoveryRecipeV2,
} from "../../src/discovery/recipes/index.js";
import type { ActionV2, CapabilityArtifactV2 } from "../../src/domain/index.js";

function traceAction(action: ActionV2): DiscoveryTraceActionV2 {
  switch (action.kind) {
    case "click":
      return { kind: "click", targetId: action.targetId };
    case "fill":
    case "select":
      return { kind: action.kind, targetId: action.targetId, value: action.value };
    case "extract":
      if (!action.outputName) throw new Error("Recipe fixture requires output extraction");
      return { kind: "extract", targetId: action.targetId, outputName: action.outputName };
    case "extract_table":
      return { kind: "extract", targetId: action.targetId, outputName: action.outputName };
    case "press":
      return { kind: "press", key: action.key };
  }
}

function safePrefixTrace(artifact: CapabilityArtifactV2): DiscoveryTraceV2 {
  const boundary = artifact.steps.findIndex(
    (step) => step.effect === "reversible_write" || step.effect === "irreversible_commit",
  );
  const steps = boundary === -1 ? artifact.steps : artifact.steps.slice(0, boundary);
  return DiscoveryTraceV2Schema.parse({
    schemaVersion: "2.0",
    runId: `recipe.${artifact.capability.id}`,
    goalTemplate: artifact.provenance.goal,
    createdAt: "2026-08-20T20:00:00.000Z",
    planner: {
      provider: "anthropic-messages",
      model: "claude-sonnet-5",
      mode: "model",
      callCount: steps.length + 1,
    },
    inputs: artifact.inputs.map((input) => ({ name: input.name, scalarType: "string" as const })),
    checkpointText: "Reviewed prefix ready",
    finalState: {
      url: artifact.compatibility.entryPoint,
      title: "Reviewed prefix ready",
      httpStatus: 200,
      stateHash: "final",
      headings: ["Reviewed prefix ready"],
    },
    steps: steps.map((step, index) => {
      const action = traceAction(step.action);
      const targetId = "targetId" in action ? action.targetId : undefined;
      const target = targetId
        ? artifact.targets.find((candidate) => candidate.id === targetId)
        : undefined;
      if (targetId && !target) throw new Error(`Missing fixture target ${targetId}`);
      return {
        id: `trace.${String(index + 1).padStart(3, "0")}.${step.action.kind}`,
        sequence: index + 1,
        action,
        ...(target
          ? {
              target: {
                id: target.id,
                description: target.description,
                framePath: target.framePath,
                strategies: target.strategies,
                cardinality: "exactly_one" as const,
              },
            }
          : {}),
        before: { stateHash: `before-${index}`, headings: ["MERIDIAN"] },
        after: { stateHash: `after-${index}`, headings: ["MERIDIAN"] },
      };
    }),
  });
}

describe("reviewed MERIDIAN discovery recipes", () => {
  it("registers and compiles all eight annotation-only recipes", () => {
    expect(Object.keys(meridianDiscoveryRecipeFactoriesV2)).toHaveLength(8);
    for (const reviewed of meridianArtifacts) {
      const trace = safePrefixTrace(reviewed);
      const recipe = meridianDiscoveryRecipeV2(reviewed.capability.id, trace);
      const compiled = compileArtifactV2(trace, recipe);
      expect(compiled.capability.id).toBe(reviewed.capability.id);
      expect(compiled.capability.approval).toBe("draft");
      expect(compiled.steps).toHaveLength(trace.steps.length);
      expect(compiled.steps.every(
        (step) => step.effect !== "reversible_write" && step.effect !== "irreversible_commit",
      )).toBe(true);
    }
  });

  it("keeps table column types in reviewer annotations", () => {
    const reviewed = meridianArtifacts.find(
      (artifact) => artifact.capability.id === "member.get_record_and_balances",
    )!;
    const trace = safePrefixTrace(reviewed);
    const compiled = compileArtifactV2(trace, meridianDiscoveryRecipeV2(reviewed.capability.id, trace));
    expect(compiled.steps.find((step) => step.action.kind === "extract_table")?.action).toMatchObject({
      kind: "extract_table",
      outputName: "shares",
      columns: expect.arrayContaining([
        expect.objectContaining({ header: "Balance", key: "balance", type: { kind: "money", currency: "USD" } }),
      ]),
    });
  });

  it("rejects a final commit trace even when discovery admits critical form-entry actions", () => {
    const reviewed = meridianArtifacts.find((artifact) => artifact.capability.id === "funds.transfer")!;
    const policy = createMeridianDiscoveryPolicyV2("https://meridian.example");
    expect(policy.evaluateAction({ action: "click", label: "Post Transfer" })).toMatchObject({
      allowed: true,
      assessment: { level: "critical" },
    });
    const safe = safePrefixTrace(reviewed);
    const boundaryStep = reviewed.steps[safe.steps.length]!;
    const targetId = "targetId" in boundaryStep.action ? boundaryStep.action.targetId : undefined;
    const target = reviewed.targets.find((candidate) => candidate.id === targetId)!;
    const unsafe = DiscoveryTraceV2Schema.parse({
      ...safe,
      steps: [
        ...safe.steps,
        {
          id: "trace.999.commit",
          sequence: safe.steps.length + 1,
          action: traceAction(boundaryStep.action),
          target: {
            id: target.id,
            description: target.description,
            framePath: target.framePath,
            strategies: target.strategies,
            cardinality: "exactly_one",
          },
          before: { stateHash: "before-write", headings: ["Review"] },
          after: { stateHash: "after-write", headings: ["Posted"] },
        },
      ],
    });
    expect(() => meridianDiscoveryRecipeV2(reviewed.capability.id, unsafe)).toThrow(
      /persistent-write boundary/u,
    );
  });
});
