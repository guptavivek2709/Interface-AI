import { describe, expect, it } from "vitest";
import type { ChatSequenceRoute } from "../../src/chat/index.js";
import type { RunSnapshot } from "../../src/runs/index.js";
import {
  SequenceCoordinator,
  SequenceCoordinatorError,
} from "../../src/api/sequenceCoordinator.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const PROFILE = "c".repeat(64);

function route(): ChatSequenceRoute {
  return {
    kind: "sequence",
    toolCallId: "tool-sequence-1",
    failurePolicy: "stop_on_non_success",
    assistantText: "I will find the member and load the selected record.",
    metadata: {
      provider: "anthropic-messages",
      model: null,
      responseId: null,
      latencyMs: 1,
    },
    steps: [
      {
        stepId: "search",
        toolName: "member_search",
        capabilityId: "member.search",
        capabilityVersion: "2.0.0",
        literalArguments: { last_name: "Smith" },
        bindings: [],
      },
      {
        stepId: "balances",
        toolName: "member_balances",
        capabilityId: "member.balances",
        capabilityVersion: "2.0.0",
        literalArguments: {},
        bindings: [{
          sourceStepId: "search",
          sourceCollectionPath: ["candidates"],
          valuePath: ["member_number"],
          targetInput: "member_number",
          selection: "exactly_one",
          onZero: "stop_no_match",
          onMany: "pause_for_authenticated_selection",
        }],
      },
    ],
  };
}

function success(runId: string, candidates: unknown[]): RunSnapshot {
  return {
    runId,
    capabilityId: "member.search",
    capabilityVersion: "2.0.0",
    artifactDigest: DIGEST_A,
    inputDigest: DIGEST_A,
    inputNames: ["last_name"],
    sessionRef: "session-1",
    phase: "completed",
    submittedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    revision: 2,
    lastEventId: 2,
    progress: {
      status: "terminal",
      result: {
        schemaVersion: "2.0",
        runId,
        capabilityId: "member.search",
        capabilityVersion: "2.0.0",
        artifactDigest: DIGEST_A,
        sessionRef: "session-1",
        inputDigest: DIGEST_A,
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:00:01.000Z",
        durationMs: 1_000,
        status: "success",
        outputs: { candidates },
        evidence: [],
        journal: [],
        incidents: [],
      },
    },
  } as unknown as RunSnapshot;
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("Expected sequence coordinator error");
  } catch (error) {
    expect(error).toBeInstanceOf(SequenceCoordinatorError);
    expect((error as SequenceCoordinatorError).code).toBe(code);
  }
}

describe("SequenceCoordinator", () => {
  it("binds approved digests, enforces order, and resolves one typed result automatically", () => {
    const coordinator = new SequenceCoordinator({
      idFactory: () => "11111111-1111-4111-8111-111111111111",
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    const plan = coordinator.create({
      owner: "operator-1",
      route: route(),
      resolveDigest: (step) => step.stepId === "search" ? DIGEST_A : DIGEST_B,
      targetProfileDigest: PROFILE,
    });
    expect(plan.steps.map((step) => step.artifactDigest)).toEqual([DIGEST_A, DIGEST_B]);
    expect(plan.steps.every((step) => step.targetProfileDigest === PROFILE)).toBe(true);

    const runs = new Map<string, RunSnapshot>();
    const first = coordinator.prepare({
      owner: "operator-1",
      reference: { sequenceId: plan.sequenceId, stepId: "search" },
      capabilityId: "member.search",
      capabilityVersion: "2.0.0",
      artifactDigest: DIGEST_A,
      targetProfileDigest: PROFILE,
      suppliedInputs: { last_name: "Smith" },
      getRun: (id) => runs.get(id),
    });
    expect(first.inputs).toEqual({ last_name: "Smith" });
    expect(first.idempotencyKey).toContain(plan.sequenceId);
    coordinator.recordRun(plan.sequenceId, "search", "run-search");
    runs.set("run-search", success("run-search", [{ member_number: "M-100" }]));

    const second = coordinator.prepare({
      owner: "operator-1",
      reference: { sequenceId: plan.sequenceId, stepId: "balances" },
      capabilityId: "member.balances",
      capabilityVersion: "2.0.0",
      artifactDigest: DIGEST_B,
      targetProfileDigest: PROFILE,
      suppliedInputs: {},
      getRun: (id) => runs.get(id),
    });
    expect(second.inputs).toEqual({ member_number: "M-100" });
    expect(second.parentRunId).toBe("run-search");
    expect(second.stepIndex).toBe(1);
  });

  it("pauses only for a real multi-match and accepts an authenticated index", () => {
    const coordinator = new SequenceCoordinator({ idFactory: () => "22222222-2222-4222-8222-222222222222" });
    const plan = coordinator.create({
      owner: "operator-1",
      route: route(),
      resolveDigest: (step) => step.stepId === "search" ? DIGEST_A : DIGEST_B,
      targetProfileDigest: PROFILE,
    });
    const runs = new Map<string, RunSnapshot>([[
      "run-search",
      success("run-search", [{ member_number: "M-100" }, { member_number: "M-200" }]),
    ]]);
    coordinator.recordRun(plan.sequenceId, "search", "run-search");
    const base = {
      owner: "operator-1",
      capabilityId: "member.balances",
      capabilityVersion: "2.0.0",
      artifactDigest: DIGEST_B,
      targetProfileDigest: PROFILE,
      suppliedInputs: {},
      getRun: (id: string) => runs.get(id),
    } as const;
    expectCode(
      () => coordinator.prepare({
        ...base,
        reference: { sequenceId: plan.sequenceId, stepId: "balances" },
      }),
      "SEQUENCE_SELECTION_REQUIRED",
    );
    const selected = coordinator.prepare({
      ...base,
      reference: { sequenceId: plan.sequenceId, stepId: "balances", selectionIndex: 1 },
    });
    expect(selected.inputs).toEqual({ member_number: "M-200" });
  });

  it("stops on zero matches and rejects cross-owner, out-of-order, or changed steps", () => {
    const coordinator = new SequenceCoordinator({ idFactory: () => "33333333-3333-4333-8333-333333333333" });
    const plan = coordinator.create({
      owner: "operator-1",
      route: route(),
      resolveDigest: (step) => step.stepId === "search" ? DIGEST_A : DIGEST_B,
      targetProfileDigest: PROFILE,
    });
    const submission = {
      reference: { sequenceId: plan.sequenceId, stepId: "balances" },
      capabilityId: "member.balances",
      capabilityVersion: "2.0.0",
      artifactDigest: DIGEST_B,
      targetProfileDigest: PROFILE,
      suppliedInputs: {},
      getRun: (_id: string) => undefined,
    } as const;
    expectCode(() => coordinator.prepare({ ...submission, owner: "operator-2" }), "SEQUENCE_NOT_FOUND");
    expectCode(() => coordinator.prepare({ ...submission, owner: "operator-1" }), "SEQUENCE_OUT_OF_ORDER");

    coordinator.recordRun(plan.sequenceId, "search", "run-search");
    const empty = success("run-search", []);
    expectCode(() => coordinator.prepare({
      ...submission,
      owner: "operator-1",
      getRun: () => empty,
    }), "SEQUENCE_NO_MATCH");
    expectCode(() => coordinator.prepare({
      ...submission,
      owner: "operator-1",
      artifactDigest: DIGEST_A,
      getRun: () => empty,
    }), "SEQUENCE_STEP_MISMATCH");
  });
});
