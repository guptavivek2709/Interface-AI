import { describe, expect, it } from "vitest";
import {
  CapabilityArtifactSchema,
  type CapabilityArtifact,
} from "../../src/domain/index.js";
import { createLegacyBankProfile } from "../../src/profiles/index.js";

function validArtifact(): CapabilityArtifact {
  const profile = createLegacyBankProfile("http://127.0.0.1:4173");
  return CapabilityArtifactSchema.parse({
    schemaVersion: "1.0",
    capability: {
      id: "lookup-member",
      name: "Lookup member",
      description: "Looks up a synthetic member and returns the visible member name.",
      version: "1.0.0",
      approval: "draft",
      tags: ["training"],
    },
    provenance: {
      source: "discovery",
      createdAt: "2026-08-13T12:00:00.000Z",
      discoveryRunId: "run-1",
      goal: "Look up a member",
      planner: { provider: "test", model: "scripted" },
    },
    compatibility: {
      surfaceAdapter: profile.surfaceAdapter,
      vendorProduct: "COREBANK/7",
      appVersion: "7",
      tenantVariant: "summit",
      entryPoint: profile.entryPoint,
    },
    inputs: [
      {
        name: "memberId",
        description: "Synthetic member number.",
        type: "string",
        required: true,
        classification: "restricted",
        pattern: "^[A-Z]+-[0-9]{4}$",
      },
    ],
    outputs: [
      {
        name: "memberName",
        description: "Synthetic member name.",
        type: "string",
        classification: "restricted",
      },
    ],
    policy: profile.policy,
    targets: [
      ...profile.targets,
      {
        id: "memberNumber",
        description: "Member number input.",
        framePath: [{ title: "Core banking workspace" }],
        strategies: [{ kind: "label", label: "Member number", exact: true }],
        cardinality: "exactly_one",
        rationale: "The associated label is stable while generated element IDs are not.",
      },
      {
        id: "memberName",
        description: "Member name value.",
        framePath: [{ title: "Core banking workspace" }],
        strategies: [{ kind: "text", text: "Member name", exact: true }],
        cardinality: "exactly_one",
        rationale: "The row heading is stable across tenant variants.",
      },
    ],
    steps: [
      {
        id: "step.fill-member",
        title: "Enter member number",
        action: { kind: "fill", targetId: "memberNumber", value: { kind: "input", name: "memberId" } },
        preconditions: [{ kind: "target_visible", targetId: "memberNumber", visible: true }],
        postcondition: {
          kind: "target_value",
          targetId: "memberNumber",
          operator: "equals",
          value: { kind: "input", name: "memberId" },
        },
        timeoutMs: 5_000,
        retry: { maxAttempts: 2, backoffMs: 100 },
        risk: "safe",
      },
      {
        id: "step.extract-name",
        title: "Read member name",
        action: { kind: "extract", targetId: "memberName", outputName: "memberName" },
        preconditions: [{ kind: "target_visible", targetId: "memberName", visible: true }],
        postcondition: { kind: "target_visible", targetId: "memberName", visible: true },
        timeoutMs: 5_000,
        retry: { maxAttempts: 1, backoffMs: 0 },
        risk: "safe",
      },
    ],
    businessOutcomes: profile.businessOutcomes,
    recoveries: profile.recoveries,
    exceptions: profile.exceptions,
    checkpoint: { kind: "text_visible", text: "Member details", exact: true },
  });
}

function invalidWith(mutator: (artifact: Record<string, any>) => void) {
  const candidate = structuredClone(validArtifact()) as unknown as Record<string, any>;
  mutator(candidate);
  return CapabilityArtifactSchema.safeParse(candidate);
}

describe("CapabilityArtifactSchema graph integrity", () => {
  it("loads a valid artifact assembled with the legacy-bank profile", () => {
    expect(CapabilityArtifactSchema.parse(validArtifact()).schemaVersion).toBe("1.0");
  });

  it("rejects duplicate graph identifiers", () => {
    const result = invalidWith((artifact) => {
      artifact.targets.push(structuredClone(artifact.targets[0]));
      artifact.steps.push(structuredClone(artifact.steps[0]));
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toEqual(
        expect.arrayContaining([
          expect.stringContaining("Duplicate target ID"),
          expect.stringContaining("Duplicate step ID"),
        ]),
      );
    }
  });

  it.each([
    ["target", (artifact: Record<string, any>) => { artifact.steps[0].action.targetId = "missing-target"; }],
    ["input", (artifact: Record<string, any>) => { artifact.steps[0].action.value.name = "missing-input"; }],
    ["output", (artifact: Record<string, any>) => { artifact.steps[1].action.outputName = "missing-output"; }],
    ["recovery target", (artifact: Record<string, any>) => { artifact.recoveries[0].action.targetId = "missing-recovery-target"; }],
  ])("rejects a missing %s reference", (_name, mutate) => {
    const result = invalidWith(mutate);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some((issue) => issue.message.startsWith("Unknown "))).toBe(true);
  });

  it("rejects an input pattern with invalid ECMAScript regex syntax", () => {
    const result = invalidWith((artifact) => { artifact.inputs[0].pattern = "(?<unterminated"; });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["inputs", 0, "pattern"]);
      expect(result.error.issues[0]?.message).toContain("Invalid ECMAScript regular expression");
    }
  });

  it("rejects prototype-reserved input and output identifiers", () => {
    const input = invalidWith((artifact) => {
      artifact.inputs[0].name = "constructor";
    });
    const output = invalidWith((artifact) => {
      artifact.outputs[0].name = "__proto__";
    });
    expect(input.success).toBe(false);
    expect(output.success).toBe(false);
  });

  it.each([
    ["unknown schema version", (artifact: Record<string, any>) => { artifact.schemaVersion = "2.0"; }],
    ["unknown top-level field", (artifact: Record<string, any>) => { artifact.unreviewed = true; }],
    ["unknown nested field", (artifact: Record<string, any>) => { artifact.steps[0].retry.jitter = true; }],
  ])("rejects an %s", (_name, mutate) => {
    expect(invalidWith(mutate).success).toBe(false);
  });
});
