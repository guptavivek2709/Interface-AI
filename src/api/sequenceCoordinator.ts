import { randomUUID } from "node:crypto";
import type { ChatSequenceRoute, ChatSequenceStep, JsonObject, JsonValue } from "../chat/index.js";
import type { RunValueV2 } from "../domain/index.js";
import type { RunSnapshot } from "../runs/index.js";

export type SequenceCoordinatorErrorCode =
  | "SEQUENCE_NOT_FOUND"
  | "SEQUENCE_OUT_OF_ORDER"
  | "SEQUENCE_STEP_MISMATCH"
  | "SEQUENCE_STOPPED"
  | "SEQUENCE_NO_MATCH"
  | "SEQUENCE_SELECTION_REQUIRED"
  | "SEQUENCE_SELECTION_INVALID"
  | "SEQUENCE_RESULT_INVALID";

export class SequenceCoordinatorError extends Error {
  readonly code: SequenceCoordinatorErrorCode;
  readonly statusCode: number;
  readonly details: Readonly<Record<string, JsonValue>> | undefined;

  constructor(
    code: SequenceCoordinatorErrorCode,
    message: string,
    statusCode = 409,
    details?: Readonly<Record<string, JsonValue>>,
  ) {
    super(message);
    this.name = "SequenceCoordinatorError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export interface BoundSequenceStep extends ChatSequenceStep {
  readonly artifactDigest: string;
  readonly targetProfileDigest?: string;
}

export interface PublicSequencePlan {
  readonly kind: "sequence";
  readonly sequenceId: string;
  readonly steps: readonly BoundSequenceStep[];
  readonly failurePolicy: "stop_on_non_success";
  readonly assistantText: string | null;
  readonly metadata: {
    readonly provider: string;
  };
  readonly expiresAt: string;
}

export interface SequenceSubmissionReference {
  readonly sequenceId: string;
  readonly stepId: string;
  readonly selectionIndex?: number;
}

export interface SequenceSubmissionContract {
  readonly plan: PublicSequencePlan;
  readonly step: BoundSequenceStep;
  readonly stepIndex: number;
  readonly inputs: Readonly<Record<string, RunValueV2>>;
  readonly parentRunId?: string;
  readonly existingRunId?: string;
  readonly idempotencyKey: string;
}

interface StoredSequencePlan {
  readonly publicPlan: PublicSequencePlan;
  readonly owner: string;
  readonly expiresAtMs: number;
  readonly runIds: Map<string, string>;
}

export interface SequenceCoordinatorOptions {
  readonly ttlMs?: number;
  readonly now?: () => number;
  readonly idFactory?: () => string;
}

export interface CreateSequencePlanOptions {
  readonly owner: string;
  readonly route: ChatSequenceRoute;
  readonly resolveDigest: (step: ChatSequenceStep) => string | undefined;
  readonly targetProfileDigest?: string;
}

export interface PrepareSequenceSubmissionOptions {
  readonly owner: string;
  readonly reference: SequenceSubmissionReference;
  readonly capabilityId: string;
  readonly capabilityVersion: string;
  readonly artifactDigest: string;
  readonly targetProfileDigest?: string;
  readonly suppliedInputs: Readonly<Record<string, RunValueV2>>;
  readonly getRun: (runId: string) => RunSnapshot | undefined;
}

function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

function atPath(root: unknown, path: readonly string[]): unknown {
  let current = root;
  for (const segment of path) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    if (!Object.hasOwn(current, segment)) return undefined;
    current = (current as Readonly<Record<string, unknown>>)[segment];
  }
  return current;
}

function successOutputs(run: RunSnapshot): Readonly<Record<string, unknown>> {
  if (run.phase !== "completed" || run.managerFailure || run.cancellation) {
    throw new SequenceCoordinatorError(
      "SEQUENCE_OUT_OF_ORDER",
      "The preceding sequence step has not completed successfully.",
    );
  }
  const progress = run.progress;
  if (progress?.status !== "terminal" || progress.result.status !== "success") {
    throw new SequenceCoordinatorError(
      "SEQUENCE_STOPPED",
      "The sequence stopped because a preceding step did not succeed.",
    );
  }
  return progress.result.outputs as Readonly<Record<string, unknown>>;
}

function asRunValue(value: unknown): RunValueV2 {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) return value;
  if (Array.isArray(value)) return value.map((item) => asRunValue(item));
  if (value && typeof value === "object") {
    const output = Object.create(null) as Record<string, RunValueV2>;
    for (const [key, child] of Object.entries(value)) output[key] = asRunValue(child);
    return output;
  }
  throw new SequenceCoordinatorError(
    "SEQUENCE_RESULT_INVALID",
    "A typed sequence result could not be bound to the next capability.",
  );
}

function sameJson(left: unknown, right: unknown): boolean {
  // Sequence arguments have already passed the canonical JSON-only schemas, so
  // recursively sorted serialization is sufficient for this local exact check.
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b, "en-US"))
          .map(([key, child]) => [key, canonical(child)]),
      );
    }
    return value;
  };
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

/**
 * Owner-scoped, short-lived coordinator for model-proposed sequences. The model
 * can name approved capabilities and typed bindings, but only the API can bind
 * digests, resolve prior results, choose order, or derive idempotency identity.
 */
export class SequenceCoordinator {
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #idFactory: () => string;
  readonly #plans = new Map<string, StoredSequencePlan>();

  constructor(options: SequenceCoordinatorOptions = {}) {
    this.#ttlMs = options.ttlMs ?? 15 * 60_000;
    if (!Number.isInteger(this.#ttlMs) || this.#ttlMs < 1_000) {
      throw new TypeError("Sequence coordinator ttlMs must be at least 1000 milliseconds");
    }
    this.#now = options.now ?? Date.now;
    this.#idFactory = options.idFactory ?? randomUUID;
  }

  create(options: CreateSequencePlanOptions): PublicSequencePlan {
    this.cleanupExpired();
    const now = this.#now();
    const sequenceId = this.#idFactory();
    const steps = options.route.steps.map((step) => {
      const artifactDigest = options.resolveDigest(step);
      if (!artifactDigest) {
        throw new SequenceCoordinatorError(
          "SEQUENCE_STEP_MISMATCH",
          "A sequence step no longer matches an approved capability.",
        );
      }
      return Object.freeze({
        ...cloneJson(step),
        artifactDigest,
        ...(options.targetProfileDigest ? { targetProfileDigest: options.targetProfileDigest } : {}),
      });
    });
    const publicPlan = Object.freeze({
      kind: "sequence" as const,
      sequenceId,
      steps: Object.freeze(steps),
      failurePolicy: "stop_on_non_success" as const,
      assistantText: options.route.assistantText,
      metadata: {
        provider: options.route.metadata.provider,
      },
      expiresAt: new Date(now + this.#ttlMs).toISOString(),
    });
    this.#plans.set(sequenceId, {
      publicPlan,
      owner: options.owner,
      expiresAtMs: now + this.#ttlMs,
      runIds: new Map(),
    });
    return publicPlan;
  }

  prepare(options: PrepareSequenceSubmissionOptions): SequenceSubmissionContract {
    this.cleanupExpired();
    const stored = this.#plans.get(options.reference.sequenceId);
    if (!stored || stored.owner !== options.owner) {
      throw new SequenceCoordinatorError("SEQUENCE_NOT_FOUND", "Sequence not found.", 404);
    }
    const stepIndex = stored.publicPlan.steps.findIndex((step) => step.stepId === options.reference.stepId);
    if (stepIndex < 0) {
      throw new SequenceCoordinatorError("SEQUENCE_STEP_MISMATCH", "The submitted sequence step is not current.");
    }
    const step = stored.publicPlan.steps[stepIndex]!;
    if (
      step.capabilityId !== options.capabilityId ||
      step.capabilityVersion !== options.capabilityVersion ||
      step.artifactDigest !== options.artifactDigest ||
      step.targetProfileDigest !== options.targetProfileDigest
    ) {
      throw new SequenceCoordinatorError(
        "SEQUENCE_STEP_MISMATCH",
        "The submitted sequence step does not match its server-bound capability.",
      );
    }

    for (let index = 0; index < stepIndex; index += 1) {
      const prior = stored.publicPlan.steps[index]!;
      const priorRunId = stored.runIds.get(prior.stepId);
      if (!priorRunId) {
        throw new SequenceCoordinatorError("SEQUENCE_OUT_OF_ORDER", "Sequence steps must run in their approved order.");
      }
      successOutputs(options.getRun(priorRunId) ?? (() => {
        throw new SequenceCoordinatorError("SEQUENCE_STOPPED", "A preceding sequence run is no longer available.");
      })());
    }

    const existingRunId = stored.runIds.get(step.stepId);
    const inputs = cloneJson(step.literalArguments) as Record<string, RunValueV2>;
    let selectionUsed = false;
    for (const binding of step.bindings) {
      const sourceRunId = stored.runIds.get(binding.sourceStepId);
      const sourceRun = sourceRunId ? options.getRun(sourceRunId) : undefined;
      if (!sourceRun) {
        throw new SequenceCoordinatorError("SEQUENCE_OUT_OF_ORDER", "A bound source step is unavailable.");
      }
      const collection = atPath(successOutputs(sourceRun), binding.sourceCollectionPath);
      if (!Array.isArray(collection)) {
        throw new SequenceCoordinatorError(
          "SEQUENCE_RESULT_INVALID",
          "A bound sequence output did not match its reviewed collection contract.",
        );
      }
      if (collection.length === 0) {
        throw new SequenceCoordinatorError("SEQUENCE_NO_MATCH", "No matching result was available for the next step.", 409, {
          sourceStepId: binding.sourceStepId,
          sourceCollectionPath: [...binding.sourceCollectionPath],
        });
      }
      let rowIndex = 0;
      if (collection.length > 1) {
        if (options.reference.selectionIndex === undefined) {
          throw new SequenceCoordinatorError(
            "SEQUENCE_SELECTION_REQUIRED",
            "An authenticated operator selection is required before the sequence can continue.",
            409,
            {
              sourceStepId: binding.sourceStepId,
              sourceCollectionPath: [...binding.sourceCollectionPath],
              count: collection.length,
            },
          );
        }
        rowIndex = options.reference.selectionIndex;
        selectionUsed = true;
        if (rowIndex < 0 || rowIndex >= collection.length) {
          throw new SequenceCoordinatorError(
            "SEQUENCE_SELECTION_INVALID",
            "The authenticated sequence selection is outside the available result set.",
          );
        }
      }
      const value = atPath(collection[rowIndex], binding.valuePath);
      if (value === undefined) {
        throw new SequenceCoordinatorError(
          "SEQUENCE_RESULT_INVALID",
          "A bound sequence output did not match its reviewed value contract.",
        );
      }
      inputs[binding.targetInput] = asRunValue(value);
    }
    if (options.reference.selectionIndex !== undefined && !selectionUsed) {
      throw new SequenceCoordinatorError(
        "SEQUENCE_SELECTION_INVALID",
        "A selection index was supplied when no sequence disambiguation was pending.",
      );
    }

    const literalInputs = step.literalArguments as JsonObject;
    if (!sameJson(options.suppliedInputs, literalInputs) && !sameJson(options.suppliedInputs, inputs)) {
      throw new SequenceCoordinatorError(
        "SEQUENCE_STEP_MISMATCH",
        "Sequence inputs must match the reviewed literals and server-resolved bindings exactly.",
      );
    }
    const parentRunId = stepIndex > 0
      ? stored.runIds.get(stored.publicPlan.steps[stepIndex - 1]!.stepId)
      : undefined;
    return {
      plan: stored.publicPlan,
      step,
      stepIndex,
      inputs,
      ...(parentRunId ? { parentRunId } : {}),
      ...(existingRunId ? { existingRunId } : {}),
      idempotencyKey: `chat-sequence:${stored.publicPlan.sequenceId}:${step.stepId}`,
    };
  }

  recordRun(sequenceId: string, stepId: string, runId: string): void {
    const stored = this.#plans.get(sequenceId);
    if (!stored) throw new SequenceCoordinatorError("SEQUENCE_NOT_FOUND", "Sequence not found.", 404);
    const existing = stored.runIds.get(stepId);
    if (existing && existing !== runId) {
      throw new SequenceCoordinatorError("SEQUENCE_STEP_MISMATCH", "A sequence step is already bound to another run.");
    }
    stored.runIds.set(stepId, runId);
  }

  cleanupExpired(): number {
    const now = this.#now();
    let removed = 0;
    for (const [id, plan] of this.#plans) {
      if (plan.expiresAtMs <= now) {
        this.#plans.delete(id);
        removed += 1;
      }
    }
    return removed;
  }
}
