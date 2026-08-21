import { describe, expect, it } from "vitest";
import { canonicalArtifactDigest } from "../../src/catalog/index.js";
import { meridianTransferArtifact } from "../../src/capabilities/meridianArtifacts.js";
import { CapabilityArtifactV2Schema, type CapabilityArtifactV2 } from "../../src/domain/index.js";
import {
  ReadOnlyCanaryError,
  runReadOnlyCanaryV2,
} from "../../src/discovery/readOnlyCanaryV2.js";
import type {
  ReplayRuntimeV2,
  RuntimeContextV2,
  RuntimeValue,
} from "../../src/surface/replayRuntimeV2.js";

class FakeRuntime implements ReplayRuntimeV2 {
  readonly sessionId = "canary-session";
  readonly sessionRef = "f".repeat(64);
  readonly actions: string[] = [];
  readonly #artifact: CapabilityArtifactV2;
  readonly #runtimeConditions: Set<string>;
  failWait = false;

  constructor(artifact: CapabilityArtifactV2) {
    this.#artifact = artifact;
    this.#runtimeConditions = new Set(
      artifact.runtimeStates.map((state) => JSON.stringify(state.condition)),
    );
  }

  getTarget(id: string) {
    const target = this.#artifact.targets.find((candidate) => candidate.id === id);
    if (!target) throw new Error(`unknown target ${id}`);
    return target;
  }

  resolveValue(expression: Parameters<ReplayRuntimeV2["resolveValue"]>[0], context: RuntimeContextV2): RuntimeValue {
    if (expression.kind === "literal") return expression.value;
    return expression.kind === "input"
      ? context.inputs[expression.name] ?? null
      : context.bindings[expression.name] ?? null;
  }

  async act(action: Parameters<ReplayRuntimeV2["act"]>[0]) {
    this.actions.push(action.kind);
    return {
      startedAt: "2026-08-20T20:00:00.000Z",
      completedAt: "2026-08-20T20:00:00.001Z",
      attempts: [],
    };
  }

  async evaluate(condition: Parameters<ReplayRuntimeV2["evaluate"]>[0]) {
    return {
      matched: !this.#runtimeConditions.has(JSON.stringify(condition)),
      summary: "safe fake condition",
    };
  }

  async waitFor() {
    return { matched: !this.failWait, summary: "safe fake wait" };
  }

  async pageState() {
    return { url: "https://meridian.example/review", title: "Review", httpStatus: 200, method: "GET" as const };
  }

  async captureMaskedScreenshot() { return Buffer.from([]); }
  async sanitizedDomSnapshot() { return "<html></html>"; }
  async close() {}
}

function reviewedTransfer(): CapabilityArtifactV2 {
  return CapabilityArtifactV2Schema.parse({
    ...structuredClone(meridianTransferArtifact),
    capability: { ...meridianTransferArtifact.capability, approval: "draft" },
  });
}

describe("read-only V2 canary", () => {
  it("runs through review and stops before the persistent commit", async () => {
    const artifact = reviewedTransfer();
    const runtime = new FakeRuntime(artifact);
    const result = await runReadOnlyCanaryV2(artifact, {
      artifactDigest: canonicalArtifactDigest(artifact),
      inputs: {
        member_number: "100234",
        from_share: "100234-S0001",
        to_share: "100234-S0070",
        amount: "10.00",
        memo: "canary",
      },
      runtime,
      canaryRunId: "canary.transfer.1",
      completedAt: () => "2026-08-20T20:05:00.000Z",
    });

    const commit = artifact.steps.find((step) => step.effect === "irreversible_commit");
    expect(result).toMatchObject({
      status: "passed",
      artifactDigest: canonicalArtifactDigest(artifact),
      stoppedBeforeStepId: commit?.id,
    });
    expect(result.executedStepIds).not.toContain(commit?.id);
    expect(runtime.actions).toHaveLength(result.executedStepIds.length);
    expect(runtime.actions).not.toContain("irreversible_commit");
  });

  it("returns a failed attestation when the safe prefix does not satisfy a postcondition", async () => {
    const artifact = reviewedTransfer();
    const runtime = new FakeRuntime(artifact);
    runtime.failWait = true;
    const result = await runReadOnlyCanaryV2(artifact, {
      artifactDigest: canonicalArtifactDigest(artifact),
      inputs: {},
      runtime,
      canaryRunId: "canary.transfer.failed",
      completedAt: () => "2026-08-20T20:05:00.000Z",
    });
    expect(result).toMatchObject({ status: "failed", failureCode: "POSTCONDITION_FAILED" });
  });

  it("rejects a mismatched digest before executing the runtime", async () => {
    const artifact = reviewedTransfer();
    const runtime = new FakeRuntime(artifact);
    await expect(runReadOnlyCanaryV2(artifact, {
      artifactDigest: "0".repeat(64),
      inputs: {},
      runtime,
    })).rejects.toMatchObject({ code: "DIGEST_MISMATCH" } satisfies Partial<ReadOnlyCanaryError>);
    expect(runtime.actions).toEqual([]);
  });
});
