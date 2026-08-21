import { describe, expect, it } from "vitest";
import { initialSequenceExecution, resolveSequenceCapability, sequenceRunMatchesStep, updateSequenceStep } from "./sequence";
import type { Capability, ChatSequencePlan, RunRecord } from "./types";

const capability: Capability = {
  id: "member.search_by_last_name",
  name: "Search members",
  description: "Search by last name",
  version: "2.0.0",
  schemaVersion: "2.0",
  approval: "approved",
  risk: "read",
  tags: [],
  inputs: [],
  outputs: [],
  digest: "1".repeat(64),
  targetProfileDigest: "2".repeat(64),
  contractValid: true,
};

const plan: ChatSequencePlan = {
  kind: "sequence",
  sequenceId: "11111111-1111-4111-8111-111111111111",
  failurePolicy: "stop_on_non_success",
  expiresAt: "2099-08-20T00:15:00.000Z",
  steps: [{
    stepId: "find_member",
    toolName: "member_search",
    capabilityId: capability.id,
    capabilityVersion: capability.version,
    literalArguments: { last_name: "Rivera" },
    bindings: [],
    artifactDigest: capability.digest,
    targetProfileDigest: capability.targetProfileDigest,
  }],
};

describe("chat sequence browser state", () => {
  it("resolves only the exact approved artifact and target profile", () => {
    expect(resolveSequenceCapability([capability], plan.steps[0]!)).toBe(capability);
    expect(resolveSequenceCapability([{ ...capability, targetProfileDigest: "3".repeat(64) }], plan.steps[0]!)).toBeUndefined();
  });

  it("keeps one ordered step state and fails closed on an index mismatch", () => {
    const initial = initialSequenceExecution(plan);
    expect(initial).toEqual(expect.objectContaining({ state: "connecting", currentStepIndex: 0, steps: [{ stepId: "find_member", state: "pending" }] }));
    expect(updateSequenceStep(initial, 0, { stepId: "find_member", state: "submitted", runId: "run-1" }, "running")).toEqual(expect.objectContaining({
      state: "running",
      steps: [expect.objectContaining({ runId: "run-1" })],
    }));
    expect(updateSequenceStep(initial, 1, { stepId: "other", state: "starting" }).state).toBe("rejected");
  });

  it("accepts an observed run only with exact server-authored sequence lineage", () => {
    const run: RunRecord = {
      id: "run-1",
      capabilityId: capability.id,
      capabilityVersion: capability.version,
      artifactDigest: capability.digest,
      targetProfileDigest: capability.targetProfileDigest,
      phase: "queued",
      journal: [],
      incidents: [],
      orchestration: { kind: "chat_sequence", sequenceId: plan.sequenceId, stepId: "find_member", stepIndex: 0, stepCount: 1 },
    };
    expect(sequenceRunMatchesStep(run, plan, plan.steps[0]!, 0)).toBe(true);
    expect(sequenceRunMatchesStep({ ...run, orchestration: { kind: "reconciliation", sourceRunId: "run-write" } }, plan, plan.steps[0]!, 0)).toBe(false);
  });
});
