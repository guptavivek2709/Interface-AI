import { randomUUID } from "node:crypto";
import { canonicalArtifactDigest } from "../catalog/index.js";
import { CapabilityArtifactV2Schema, type CapabilityArtifactV2 } from "../domain/index.js";
import { sha256Digest } from "../security/digest.js";
import type {
  ReplayRuntimeV2,
  RuntimeContextV2,
  RuntimeValue,
} from "../surface/replayRuntimeV2.js";
import type { CanaryAttestationV2 } from "./artifactPromotionV2.js";

export type ReadOnlyCanaryFailureCode =
  | "DIGEST_MISMATCH"
  | "NOT_REVIEWABLE"
  | "NO_SAFE_PREFIX"
  | "PRECONDITION_FAILED"
  | "ACTION_FAILED"
  | "POSTCONDITION_FAILED"
  | "RUNTIME_STATE_MATCHED"
  | "CHECKPOINT_FAILED";

export class ReadOnlyCanaryError extends Error {
  readonly code: ReadOnlyCanaryFailureCode;

  constructor(code: ReadOnlyCanaryFailureCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReadOnlyCanaryError";
    this.code = code;
  }
}

export interface ReadOnlyCanaryResultV2 extends CanaryAttestationV2 {
  readonly executedStepIds: readonly string[];
  readonly stoppedBeforeStepId?: string;
  readonly failureCode?: Exclude<ReadOnlyCanaryFailureCode, "DIGEST_MISMATCH" | "NOT_REVIEWABLE">;
}

export interface ReadOnlyCanaryOptionsV2 {
  readonly artifactDigest: string;
  readonly inputs: Readonly<Record<string, RuntimeValue>>;
  readonly runtime: ReplayRuntimeV2;
  readonly canaryRunId?: string;
  readonly completedAt?: () => string;
}

interface SafeTranscriptEntry {
  readonly stepId: string;
  readonly action: string;
  readonly effect: string;
  readonly preconditions: number;
  readonly strategy: string | null;
  readonly resolutionCounts: readonly number[];
}

function attestation(
  artifactDigest: string,
  canaryRunId: string,
  status: "passed" | "failed",
  completedAt: string,
  transcript: readonly SafeTranscriptEntry[],
  stoppedBeforeStepId: string | undefined,
  failureCode?: ReadOnlyCanaryResultV2["failureCode"],
): ReadOnlyCanaryResultV2 {
  const evidenceDigest = sha256Digest({
    schemaVersion: "1.0",
    kind: "read_only_canary",
    artifactDigest,
    canaryRunId,
    status,
    transcript,
    stoppedBeforeStepId: stoppedBeforeStepId ?? null,
    failureCode: failureCode ?? null,
  });
  return {
    status,
    artifactDigest,
    canaryRunId,
    evidenceDigest,
    completedAt,
    executedStepIds: transcript.map((entry) => entry.stepId),
    ...(stoppedBeforeStepId ? { stoppedBeforeStepId } : {}),
    ...(failureCode ? { failureCode } : {}),
  };
}

/**
 * Executes only the reviewed draft/review prefix. The first persistent write
 * (reversible or irreversible) is a hard boundary and is never invoked.
 */
export async function runReadOnlyCanaryV2(
  artifactValue: CapabilityArtifactV2,
  options: ReadOnlyCanaryOptionsV2,
): Promise<ReadOnlyCanaryResultV2> {
  const artifact = CapabilityArtifactV2Schema.parse(artifactValue);
  const artifactDigest = canonicalArtifactDigest(artifact);
  if (artifactDigest !== options.artifactDigest) {
    throw new ReadOnlyCanaryError(
      "DIGEST_MISMATCH",
      "Read-only canary digest does not match the reviewed artifact",
    );
  }
  if (artifact.capability.approval !== "draft") {
    throw new ReadOnlyCanaryError(
      "NOT_REVIEWABLE",
      "Read-only canary accepts only a reviewed, non-executable draft",
    );
  }

  const boundaryIndex = artifact.steps.findIndex(
    (step) => step.effect === "reversible_write" || step.effect === "irreversible_commit",
  );
  const safeSteps = boundaryIndex === -1 ? artifact.steps : artifact.steps.slice(0, boundaryIndex);
  const boundary = boundaryIndex === -1 ? undefined : artifact.steps[boundaryIndex];
  if (safeSteps.length === 0) {
    throw new ReadOnlyCanaryError(
      "NO_SAFE_PREFIX",
      "Artifact reaches a persistent write before any safe canary step",
    );
  }
  if (safeSteps.some((step) => step.effect === "reversible_write" || step.effect === "irreversible_commit")) {
    throw new ReadOnlyCanaryError("NO_SAFE_PREFIX", "Canary prefix contains a persistent write");
  }

  const canaryRunId = options.canaryRunId ?? `canary.${randomUUID()}`;
  const now = options.completedAt ?? (() => new Date().toISOString());
  const context: RuntimeContextV2 = { inputs: options.inputs, bindings: Object.create(null) };
  const transcript: SafeTranscriptEntry[] = [];
  const fail = (
    code: NonNullable<ReadOnlyCanaryResultV2["failureCode"]>,
  ): ReadOnlyCanaryResultV2 =>
    attestation(
      artifactDigest,
      canaryRunId,
      "failed",
      now(),
      transcript,
      boundary?.id,
      code,
    );

  for (const step of safeSteps) {
    try {
      for (const condition of step.preconditions) {
        if (!(await options.runtime.evaluate(condition, context)).matched) {
          return fail("PRECONDITION_FAILED");
        }
      }
    } catch {
      return fail("PRECONDITION_FAILED");
    }

    let result;
    try {
      result = await options.runtime.act(step.action, context);
    } catch {
      return fail("ACTION_FAILED");
    }
    if (result.bindingName && result.value !== undefined) {
      context.bindings[result.bindingName] = result.value;
    }
    transcript.push({
      stepId: step.id,
      action: step.action.kind,
      effect: step.effect,
      preconditions: step.preconditions.length,
      strategy: result.strategy ?? null,
      resolutionCounts: result.attempts.map((attempt) => attempt.count),
    });

    try {
      if (!(await options.runtime.waitFor(step.postcondition, context, step.timeoutMs)).matched) {
        return fail("POSTCONDITION_FAILED");
      }
      for (const state of [...artifact.runtimeStates].sort((left, right) => right.priority - left.priority)) {
        if ((await options.runtime.evaluate(state.condition, context)).matched) {
          return fail("RUNTIME_STATE_MATCHED");
        }
      }
    } catch {
      return fail("POSTCONDITION_FAILED");
    }
  }

  try {
    if (boundary) {
      for (const condition of boundary.preconditions) {
        if (!(await options.runtime.evaluate(condition, context)).matched) {
          return fail("PRECONDITION_FAILED");
        }
      }
    } else if (!(await options.runtime.evaluate(artifact.checkpoint, context)).matched) {
      return fail("CHECKPOINT_FAILED");
    }
  } catch {
    return fail(boundary ? "PRECONDITION_FAILED" : "CHECKPOINT_FAILED");
  }

  return attestation(
    artifactDigest,
    canaryRunId,
    "passed",
    now(),
    transcript,
    boundary?.id,
  );
}
