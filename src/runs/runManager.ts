import { randomUUID } from "node:crypto";
import type { ReplayProgressV2, RunValueV2 } from "../domain/index.js";
import { sha256Digest } from "../security/digest.js";
import {
  MemoryIdempotencyLedger,
  type IdempotencyLedger,
} from "./idempotencyLedger.js";

export type ManagedRunPhase =
  | "queued"
  | "running"
  | "recovering"
  | "awaiting_approval"
  | "completed";

export interface SubmitRunRequest {
  readonly capabilityId: string;
  readonly capabilityVersion: string;
  readonly artifactDigest: string;
  readonly sessionRef: string;
  readonly inputs: Readonly<Record<string, RunValueV2>>;
  /** Server-derived opaque audit binding used when raw inputs contain credentials. */
  readonly inputDigestOverride?: string;
  readonly idempotencyKey?: string;
}

/**
 * Only authenticated human principals may cross the approval boundary. Chat or
 * model code has no representable approval source in this contract.
 */
export interface RunApprovalActor {
  readonly source: "user" | "operator";
  readonly id: string;
  readonly roles: readonly string[];
}

export interface ManagedReplayRunnerV2 {
  run(): Promise<ReplayProgressV2>;
  issueApproval(actor: { id: string; roles: readonly string[] }): string;
  resume(approvalToken: string): Promise<ReplayProgressV2>;
  close(outcome?: ManagedRunnerCloseOutcome): Promise<void>;
}

export type ManagedRunnerCloseOutcome =
  | {
      readonly kind: "result";
      readonly status: "success" | "business_outcome" | "failure" | "escalation";
      readonly code?: string;
    }
  | { readonly kind: "cancellation"; readonly code: "CANCELLED" | "TTL_EXPIRED" }
  | { readonly kind: "manager_failure"; readonly code: string };

export interface EvidenceFinalization {
  readonly status: "complete" | "failed" | "not_applicable";
  readonly code?: "EVIDENCE_FINALIZATION_FAILED";
}

export interface ManagedRunnerFactoryRequest {
  readonly runId: string;
  readonly capabilityId: string;
  readonly capabilityVersion: string;
  readonly artifactDigest: string;
  readonly inputDigest: string;
  readonly sessionRef: string;
  readonly inputs: Readonly<Record<string, RunValueV2>>;
}

export interface ManagedRunnerFactoryContext {
  /** Optional runner instrumentation hook, e.g. from a state.recovering event. */
  reportPhase(phase: "running" | "recovering", detail?: Readonly<Record<string, unknown>>): void;
}

export type ManagedRunnerFactory = (
  request: ManagedRunnerFactoryRequest,
  context: ManagedRunnerFactoryContext,
) => ManagedReplayRunnerV2 | Promise<ManagedReplayRunnerV2>;

export interface RunManagerFailure {
  readonly code: string;
  readonly message: string;
}

export interface RunCancellation {
  readonly code: "CANCELLED" | "TTL_EXPIRED";
  readonly reason: string;
}

export interface RunSnapshot {
  readonly runId: string;
  readonly capabilityId: string;
  readonly capabilityVersion: string;
  readonly artifactDigest: string;
  readonly inputDigest: string;
  /** Exact submitted contract field names; values are intentionally not retained. */
  readonly inputNames: readonly string[];
  readonly sessionRef: string;
  readonly phase: ManagedRunPhase;
  readonly submittedAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly retainedUntil?: string;
  readonly revision: number;
  readonly lastEventId: number;
  readonly progress?: DeepReadonly<ReplayProgressV2>;
  readonly cancellation?: RunCancellation;
  readonly managerFailure?: RunManagerFailure;
  readonly evidenceFinalization?: EvidenceFinalization;
}

export interface RunManagerEvent {
  readonly id: number;
  readonly runId: string;
  readonly type: string;
  readonly timestamp: string;
  readonly phase: ManagedRunPhase;
  readonly data: DeepReadonly<unknown>;
  readonly snapshot: RunSnapshot;
}

export type RunEventListener = (event: RunManagerEvent) => void;

export interface RunManagerOptions {
  readonly runnerFactory: ManagedRunnerFactory;
  readonly maxConcurrentRuns?: number;
  readonly maxQueuedRuns?: number;
  readonly eventBufferSize?: number;
  readonly retentionTtlMs?: number;
  readonly idempotencyLedger?: IdempotencyLedger;
  /** Set false to drive cleanup explicitly with cleanupExpired(). */
  readonly cleanupIntervalMs?: number | false;
  readonly now?: () => number;
  readonly runIdFactory?: () => string;
}

export type RunManagerErrorCode =
  | "INVALID_REQUEST"
  | "QUEUE_FULL"
  | "RUN_NOT_FOUND"
  | "IDEMPOTENCY_CONFLICT"
  | "IDEMPOTENCY_RETAINED"
  | "IDEMPOTENCY_LEDGER_UNAVAILABLE"
  | "RUN_NOT_APPROVABLE"
  | "ROLE_REQUIRED"
  | "MODEL_APPROVAL_FORBIDDEN"
  | "RUN_NOT_CANCELLABLE"
  | "MANAGER_CLOSED";

export class RunManagerError extends Error {
  readonly code: RunManagerErrorCode;

  constructor(code: RunManagerErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RunManagerError";
    this.code = code;
  }
}

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

interface MutableRun {
  runId: string;
  capabilityId: string;
  capabilityVersion: string;
  artifactDigest: string;
  inputDigest: string;
  inputNames: readonly string[];
  sessionRef: string;
  inputs: Readonly<Record<string, RunValueV2>>;
  idempotencyKey?: string;
  idempotencyBinding?: string;
  phase: ManagedRunPhase;
  submittedAtMs: number;
  updatedAtMs: number;
  startedAtMs?: number;
  completedAtMs?: number;
  revision: number;
  runner?: ManagedReplayRunnerV2 | undefined;
  progress?: ReplayProgressV2 | undefined;
  cancellation?: RunCancellation;
  managerFailure?: RunManagerFailure;
  evidenceFinalization?: EvidenceFinalization;
  pendingApprovalActor?: RunApprovalActor | undefined;
  finalizingAs?: "result" | "manager_failure" | "cancellation";
  finalization?: Promise<void>;
  ownsSession: boolean;
  activeSlot: boolean;
  events: RunManagerEvent[];
  subscribers: Set<RunEventListener>;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): DeepReadonly<T> {
  if (value === null || typeof value !== "object") return value as DeepReadonly<T>;
  if (seen.has(value)) return value as DeepReadonly<T>;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value) as DeepReadonly<T>;
}

function frozenClone<T>(value: T): DeepReadonly<T> {
  return deepFreeze(structuredClone(value));
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return value;
}

function nonEmpty(value: string, label: string): string {
  if (!value.trim()) throw new RunManagerError("INVALID_REQUEST", `${label} is required`);
  return value;
}

function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

export class RunManager {
  readonly #factory: ManagedRunnerFactory;
  readonly #maxConcurrentRuns: number;
  readonly #maxQueuedRuns: number;
  readonly #eventBufferSize: number;
  readonly #retentionTtlMs: number;
  readonly #now: () => number;
  readonly #runIdFactory: () => string;
  readonly #idempotency: IdempotencyLedger;
  readonly #runs = new Map<string, MutableRun>();
  readonly #queue: string[] = [];
  readonly #sessionOwners = new Map<string, string>();
  readonly #evictionListeners = new Set<(snapshot: RunSnapshot) => void | Promise<void>>();
  readonly #tasks = new Set<Promise<void>>();
  readonly #cleanupTimer: NodeJS.Timeout | undefined;
  #nextEventId = 0;
  #activeRuns = 0;
  #drainScheduled = false;
  #cleanupRunning = false;
  #closed = false;

  constructor(options: RunManagerOptions) {
    this.#factory = options.runnerFactory;
    this.#maxConcurrentRuns = positiveInteger(options.maxConcurrentRuns ?? 2, "maxConcurrentRuns");
    this.#maxQueuedRuns = positiveInteger(options.maxQueuedRuns ?? 100, "maxQueuedRuns");
    this.#eventBufferSize = positiveInteger(options.eventBufferSize ?? 100, "eventBufferSize");
    this.#retentionTtlMs = positiveInteger(options.retentionTtlMs ?? 8 * 60 * 60_000, "retentionTtlMs");
    this.#now = options.now ?? Date.now;
    this.#runIdFactory = options.runIdFactory ?? randomUUID;
    this.#idempotency = options.idempotencyLedger ?? new MemoryIdempotencyLedger();
    const cleanupInterval = options.cleanupIntervalMs === false
      ? false
      : positiveInteger(
          options.cleanupIntervalMs ?? Math.min(30_000, this.#retentionTtlMs),
          "cleanupIntervalMs",
        );
    if (cleanupInterval !== false) {
      this.#cleanupTimer = setInterval(() => {
        void this.cleanupExpired();
      }, cleanupInterval);
      this.#cleanupTimer.unref();
    }
  }

  /** Accepts work without waiting for browser execution, matching an HTTP 202 response. */
  submit(request: SubmitRunRequest): RunSnapshot {
    this.#assertOpen();
    nonEmpty(request.capabilityId, "capabilityId");
    nonEmpty(request.capabilityVersion, "capabilityVersion");
    nonEmpty(request.sessionRef, "sessionRef");
    if (!/^[a-f0-9]{64}$/u.test(request.artifactDigest)) {
      throw new RunManagerError("INVALID_REQUEST", "artifactDigest must be a lowercase SHA-256 digest");
    }
    if (request.idempotencyKey !== undefined && !request.idempotencyKey.trim()) {
      throw new RunManagerError("INVALID_REQUEST", "idempotencyKey cannot be empty");
    }
    const inputs = frozenClone(request.inputs) as Readonly<Record<string, RunValueV2>>;
    if (
      request.inputDigestOverride !== undefined &&
      !/^[a-f0-9]{64}$/u.test(request.inputDigestOverride)
    ) {
      throw new RunManagerError("INVALID_REQUEST", "inputDigestOverride must be a lowercase SHA-256 digest");
    }
    const bindingInputDigest = sha256Digest(inputs);
    const inputDigest = request.inputDigestOverride ?? bindingInputDigest;
    const inputNames = Object.freeze(Object.keys(inputs).sort((left, right) => left.localeCompare(right, "en-US")));
    const idempotencyBinding = request.idempotencyKey === undefined
        ? undefined
      : sha256Digest({
          capabilityId: request.capabilityId,
          capabilityVersion: request.capabilityVersion,
          artifactDigest: request.artifactDigest,
          inputDigest: bindingInputDigest,
          sessionRef: request.sessionRef,
        });
    if (request.idempotencyKey !== undefined) {
      const existing = this.#idempotency.get(request.idempotencyKey);
      if (existing) {
        if (existing.binding !== idempotencyBinding) {
          throw new RunManagerError(
            "IDEMPOTENCY_CONFLICT",
            "Idempotency key is already bound to different capability inputs",
          );
        }
        const existingRun = this.#runs.get(existing.runId);
        if (existingRun) return this.#snapshot(existingRun);
        throw new RunManagerError(
          "IDEMPOTENCY_RETAINED",
          "This idempotency key is retained after run history expiry; reconcile the prior operation before retrying.",
        );
      }
    }
    if (this.#queue.length >= this.#maxQueuedRuns) {
      throw new RunManagerError("QUEUE_FULL", "The bounded run queue is full");
    }

    const now = this.#now();
    const runId = this.#uniqueRunId();
    if (request.idempotencyKey !== undefined && idempotencyBinding !== undefined) {
      try {
        // Persist the safety tombstone before work can enter the execution queue.
        // A crash after this point fails closed on retry instead of replaying an
        // operation whose outcome may be ambiguous.
        this.#idempotency.put({
          key: request.idempotencyKey,
          binding: idempotencyBinding,
          runId,
          createdAt: iso(now),
        });
      } catch (error) {
        throw new RunManagerError(
          "IDEMPOTENCY_LEDGER_UNAVAILABLE",
          "Risky work cannot start because its durable idempotency binding could not be stored.",
          { cause: error },
        );
      }
    }
    const run: MutableRun = {
      runId,
      capabilityId: request.capabilityId,
      capabilityVersion: request.capabilityVersion,
      artifactDigest: request.artifactDigest,
      inputDigest,
      inputNames,
      sessionRef: request.sessionRef,
      inputs,
      ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
      ...(idempotencyBinding === undefined ? {} : { idempotencyBinding }),
      phase: "queued",
      submittedAtMs: now,
      updatedAtMs: now,
      revision: 0,
      ownsSession: false,
      activeSlot: false,
      events: [],
      subscribers: new Set(),
    };
    this.#runs.set(runId, run);
    this.#queue.push(runId);
    const event = this.#emit(run, "run.submitted", {
      capabilityId: run.capabilityId,
      capabilityVersion: run.capabilityVersion,
      inputDigest,
    });
    this.#scheduleDrain();
    return event.snapshot;
  }

  get(runId: string): RunSnapshot | undefined {
    const run = this.#runs.get(runId);
    return run ? this.#snapshot(run) : undefined;
  }

  list(): readonly RunSnapshot[] {
    return Object.freeze(
      [...this.#runs.values()]
        .sort((left, right) => left.submittedAtMs - right.submittedAtMs)
        .map((run) => this.#snapshot(run)),
    );
  }

  onEvicted(listener: (snapshot: RunSnapshot) => void | Promise<void>): () => void {
    this.#evictionListeners.add(listener);
    return () => this.#evictionListeners.delete(listener);
  }

  replayEvents(runId: string, afterEventId = 0): readonly RunManagerEvent[] {
    const run = this.#requireRun(runId);
    return Object.freeze(run.events.filter((event) => event.id > afterEventId));
  }

  /** Replays buffered events first, then delivers live events until unsubscribed. */
  subscribe(
    runId: string,
    listener: RunEventListener,
    options: { afterEventId?: number } = {},
  ): () => void {
    const run = this.#requireRun(runId);
    run.subscribers.add(listener);
    for (const event of run.events) {
      if (event.id > (options.afterEventId ?? 0)) this.#notify(listener, event);
    }
    return () => run.subscribers.delete(listener);
  }

  /**
   * Delegates approval to the runner's signed authority. The manager accepts an
   * authenticated human actor, never a caller-supplied token or model decision.
   */
  approve(runId: string, actor: RunApprovalActor): RunSnapshot {
    this.#assertOpen();
    const run = this.#requireRun(runId);
    if ((actor as { source?: unknown }).source !== "user" && (actor as { source?: unknown }).source !== "operator") {
      throw new RunManagerError(
        "MODEL_APPROVAL_FORBIDDEN",
        "Approval must originate from an authenticated user or operator control",
      );
    }
    if (!actor.id.trim() || actor.roles.length === 0) {
      throw new RunManagerError("ROLE_REQUIRED", "Approval actor identity and roles are required");
    }
    if (
      run.finalization !== undefined ||
      run.phase !== "awaiting_approval" ||
      run.progress?.status !== "awaiting_approval"
    ) {
      throw new RunManagerError("RUN_NOT_APPROVABLE", "Run is not awaiting approval");
    }
    const challengeExpiry = Date.parse(run.progress.challenge.expiresAt);
    if (!Number.isFinite(challengeExpiry) || challengeExpiry <= this.#now()) {
      throw new RunManagerError("RUN_NOT_APPROVABLE", "The approval challenge has expired");
    }
    if (
      run.progress.challenge.requirement === "supervisor_confirmation" &&
      !actor.roles.includes("supervisor")
    ) {
      throw new RunManagerError("ROLE_REQUIRED", "Supervisor role is required for this approval");
    }
    if (run.pendingApprovalActor) {
      throw new RunManagerError("RUN_NOT_APPROVABLE", "Approval has already been accepted for this challenge");
    }
    run.pendingApprovalActor = frozenClone({
      source: actor.source,
      id: actor.id,
      roles: [...actor.roles],
    }) as RunApprovalActor;
    const event = this.#emit(run, "approval.accepted", {
      actorId: actor.id,
      actorRoles: [...actor.roles],
      source: actor.source,
      challengeId: run.progress.challenge.challengeId,
    });
    this.#scheduleDrain();
    return event.snapshot;
  }

  async cancel(runId: string, reason = "Cancelled by caller"): Promise<RunSnapshot> {
    this.#assertOpen();
    const run = this.#requireRun(runId);
    if (run.phase === "completed") return this.#snapshot(run);
    if (run.finalization !== undefined) {
      if (run.finalizingAs !== "cancellation") {
        throw new RunManagerError(
          "RUN_NOT_CANCELLABLE",
          "The run has already crossed its safe cancellation boundary",
        );
      }
      await run.finalization;
      return this.#snapshot(run);
    }
    if (run.phase !== "queued" && run.phase !== "awaiting_approval") {
      throw new RunManagerError(
        "RUN_NOT_CANCELLABLE",
        "Only queued or approval-paused runs can be cancelled safely",
      );
    }
    await this.#cancelRun(run, { code: "CANCELLED", reason });
    return this.#snapshot(run);
  }

  /** Removes stale completed/approval-paused runs and closes retained runners. */
  async cleanupExpired(): Promise<number> {
    if (this.#cleanupRunning) return 0;
    this.#cleanupRunning = true;
    let removed = 0;
    try {
      const now = this.#now();
      for (const run of [...this.#runs.values()]) {
        if (run.phase === "awaiting_approval") {
          const challengeExpiry = run.progress?.status === "awaiting_approval"
            ? Date.parse(run.progress.challenge.expiresAt)
            : Number.POSITIVE_INFINITY;
          if (challengeExpiry <= now || now - run.updatedAtMs >= this.#retentionTtlMs) {
            await this.#cancelRun(run, {
              code: "TTL_EXPIRED",
              reason: "Approval challenge or retained run expired",
            });
            // TTL expiry is a terminal business-visible lifecycle event. Keep
            // it for the normal completed-run retention window so refresh and
            // evidence access cannot turn it immediately into RUN_NOT_FOUND.
            removed += 1;
          }
        } else if (run.phase === "completed" && now - run.updatedAtMs >= this.#retentionTtlMs) {
          await this.#safeClose(run);
          this.#emit(run, "run.evicted", { reason: "retention_ttl" });
          const snapshot = this.#snapshot(run);
          this.#evict(run);
          await Promise.allSettled([...this.#evictionListeners].map(async (listener) => listener(snapshot)));
          removed += 1;
        }
      }
      return removed;
    } finally {
      this.#cleanupRunning = false;
    }
  }

  async shutdown(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#cleanupTimer) clearInterval(this.#cleanupTimer);
    for (const run of [...this.#runs.values()]) {
      if (run.phase === "queued" || run.phase === "awaiting_approval") {
        await this.#cancelRun(run, { code: "CANCELLED", reason: "Run manager shut down" });
      }
    }
    await Promise.allSettled(
      [...this.#runs.values()]
        .filter((run) => run.phase === "running" || run.phase === "recovering")
        .map(async (run) => this.#safeClose(run)),
    );
    await Promise.allSettled([...this.#tasks]);
    for (const run of this.#runs.values()) await this.#safeClose(run);
  }

  #scheduleDrain(): void {
    if (this.#closed || this.#drainScheduled) return;
    this.#drainScheduled = true;
    queueMicrotask(() => {
      this.#drainScheduled = false;
      this.#drain();
    });
  }

  #drain(): void {
    if (this.#closed) return;
    while (this.#activeRuns < this.#maxConcurrentRuns) {
      const approval = [...this.#runs.values()].find(
        (run) =>
          run.finalization === undefined &&
          run.phase === "awaiting_approval" &&
          run.pendingApprovalActor !== undefined,
      );
      if (approval) {
        this.#occupySlot(approval);
        approval.phase = "running";
        approval.progress = undefined;
        this.#emit(approval, "run.resuming", {});
        this.#track(this.#resume(approval));
        continue;
      }

      const queueIndex = this.#queue.findIndex((runId) => {
        const run = this.#runs.get(runId);
        return run?.phase === "queued" && !this.#sessionOwners.has(run.sessionRef);
      });
      if (queueIndex < 0) return;
      const [runId] = this.#queue.splice(queueIndex, 1);
      const run = runId ? this.#runs.get(runId) : undefined;
      if (!run || run.phase !== "queued") continue;
      this.#sessionOwners.set(run.sessionRef, run.runId);
      run.ownsSession = true;
      this.#occupySlot(run);
      run.phase = "running";
      run.startedAtMs ??= this.#now();
      this.#emit(run, "run.started", {});
      this.#track(this.#start(run));
    }
  }

  async #start(run: MutableRun): Promise<void> {
    try {
      const context: ManagedRunnerFactoryContext = {
        reportPhase: (phase, detail = {}) => {
          if (run.phase !== "running" && run.phase !== "recovering") return;
          if (run.phase === phase) return;
          run.phase = phase;
          this.#emit(run, phase === "recovering" ? "run.recovering" : "run.running", detail);
        },
      };
      run.runner = await this.#factory(
        {
          runId: run.runId,
          capabilityId: run.capabilityId,
          capabilityVersion: run.capabilityVersion,
          artifactDigest: run.artifactDigest,
          inputDigest: run.inputDigest,
          sessionRef: run.sessionRef,
          inputs: run.inputs,
        },
        context,
      );
      // Invocation values are needed only to construct the runner. Drop the
      // manager's copy immediately, especially for secure session sign-on.
      run.inputs = Object.freeze({});
      await this.#handleProgress(run, await run.runner.run());
    } catch (error) {
      run.inputs = Object.freeze({});
      await this.#managerFailed(run, "RUNNER_FAILED", error);
    }
  }

  async #resume(run: MutableRun): Promise<void> {
    const actor = run.pendingApprovalActor;
    const runner = run.runner;
    run.pendingApprovalActor = undefined;
    if (!actor || !runner) {
      await this.#managerFailed(run, "APPROVAL_STATE_INVALID", new Error("Approval runner state is missing"));
      return;
    }
    try {
      const token = runner.issueApproval({ id: actor.id, roles: actor.roles });
      await this.#handleProgress(run, await runner.resume(token));
    } catch (error) {
      await this.#managerFailed(run, "APPROVAL_FAILED", error);
    }
  }

  async #handleProgress(run: MutableRun, progress: ReplayProgressV2): Promise<void> {
    run.progress = frozenClone(progress) as ReplayProgressV2;
    if (progress.status === "awaiting_approval") {
      run.phase = "awaiting_approval";
      this.#releaseSlot(run);
      this.#emit(run, "approval.requested", {
        challengeId: progress.challenge.challengeId,
        stepId: progress.challenge.stepId,
        requirement: progress.challenge.requirement,
        expiresAt: progress.challenge.expiresAt,
      });
      this.#scheduleDrain();
      return;
    }
    await this.#beginFinalization(run, "result", async () => {
      this.#releaseSlot(run);
      await this.#safeClose(run, {
        kind: "result",
        status: progress.result.status,
        ...(progress.result.status === "success" ? {} : { code: progress.result.code }),
      });
      this.#releaseSession(run);
      run.phase = "completed";
      run.completedAtMs = this.#now();
      this.#emit(run, "run.completed", {
        status: progress.result.status,
        evidence: run.evidenceFinalization?.status ?? "not_applicable",
      });
      this.#scheduleDrain();
    });
  }

  async #managerFailed(run: MutableRun, code: string, error: unknown): Promise<void> {
    await this.#beginFinalization(run, "manager_failure", async () => {
      run.managerFailure = deepFreeze({
        code,
        message: "The deterministic execution service could not complete this run.",
      });
      this.#releaseSlot(run);
      await this.#safeClose(run, { kind: "manager_failure", code });
      this.#releaseSession(run);
      run.phase = "completed";
      run.completedAtMs = this.#now();
      this.#emit(run, "run.manager_failed", {
        code,
        message: run.managerFailure.message,
        evidence: run.evidenceFinalization?.status ?? "not_applicable",
      });
      // Preserve the original exception only as an in-process cause for a future
      // structured logger seam. It is deliberately absent from snapshots/events.
      void error;
      this.#scheduleDrain();
    });
  }

  async #cancelRun(run: MutableRun, cancellation: RunCancellation): Promise<void> {
    await this.#beginFinalization(run, "cancellation", async () => {
      const queueIndex = this.#queue.indexOf(run.runId);
      if (queueIndex >= 0) this.#queue.splice(queueIndex, 1);
      // Queued sign-on work may still contain a target password because it has
      // not reached runner construction. Cancellation must drop that manager
      // copy immediately, not retain it for the history TTL.
      run.inputs = Object.freeze({});
      run.pendingApprovalActor = undefined;
      const safeCancellation = deepFreeze({
        code: cancellation.code,
        reason: cancellation.code === "TTL_EXPIRED"
          ? "Approval expired before authorization; no pending effect was committed."
          : "The run was cancelled at a safe boundary.",
      } satisfies RunCancellation);
      run.cancellation = safeCancellation;
      this.#releaseSlot(run);
      await this.#safeClose(run, { kind: "cancellation", code: cancellation.code });
      this.#releaseSession(run);
      run.phase = "completed";
      run.completedAtMs = this.#now();
      this.#emit(run, "run.cancelled", {
        ...safeCancellation,
        evidence: run.evidenceFinalization?.status ?? "not_applicable",
      });
      this.#scheduleDrain();
    });
  }

  #beginFinalization(
    run: MutableRun,
    kind: NonNullable<MutableRun["finalizingAs"]>,
    finalize: () => Promise<void>,
  ): Promise<void> {
    if (run.finalization !== undefined) return run.finalization;

    let resolveFinalization!: () => void;
    let rejectFinalization!: (error: unknown) => void;
    const marker = new Promise<void>((resolve, reject) => {
      resolveFinalization = resolve;
      rejectFinalization = reject;
    });
    // Install the marker before invoking any close hook. A close implementation
    // may yield, emit callbacks, or be observed by another HTTP request.
    run.finalizingAs = kind;
    run.finalization = marker;
    void (async () => {
      try {
        await finalize();
        resolveFinalization();
      } catch (error) {
        rejectFinalization(error);
      }
    })();
    return marker;
  }

  async #safeClose(run: MutableRun, outcome?: ManagedRunnerCloseOutcome): Promise<void> {
    const runner = run.runner;
    run.runner = undefined;
    if (!runner) {
      run.evidenceFinalization ??= deepFreeze({ status: "not_applicable" });
      return;
    }
    try {
      await runner.close(outcome);
      run.evidenceFinalization = deepFreeze({ status: "complete" });
    } catch {
      run.evidenceFinalization = deepFreeze({
        status: "failed",
        code: "EVIDENCE_FINALIZATION_FAILED",
      });
      this.#emit(run, "evidence.finalization_failed", {
        code: "EVIDENCE_FINALIZATION_FAILED",
        message: "Required run evidence could not be finalized.",
      });
    }
  }

  #occupySlot(run: MutableRun): void {
    if (run.activeSlot) return;
    run.activeSlot = true;
    this.#activeRuns += 1;
  }

  #releaseSlot(run: MutableRun): void {
    if (!run.activeSlot) return;
    run.activeSlot = false;
    this.#activeRuns -= 1;
  }

  #releaseSession(run: MutableRun): void {
    if (!run.ownsSession) return;
    if (this.#sessionOwners.get(run.sessionRef) === run.runId) this.#sessionOwners.delete(run.sessionRef);
    run.ownsSession = false;
  }

  #track(task: Promise<void>): void {
    this.#tasks.add(task);
    void task.finally(() => this.#tasks.delete(task));
  }

  #snapshot(run: MutableRun, lastEventId = run.events.at(-1)?.id ?? 0): RunSnapshot {
    return deepFreeze({
      runId: run.runId,
      capabilityId: run.capabilityId,
      capabilityVersion: run.capabilityVersion,
      artifactDigest: run.artifactDigest,
      inputDigest: run.inputDigest,
      inputNames: [...run.inputNames],
      sessionRef: run.sessionRef,
      phase: run.phase,
      submittedAt: iso(run.submittedAtMs),
      updatedAt: iso(run.updatedAtMs),
      ...(run.startedAtMs === undefined ? {} : { startedAt: iso(run.startedAtMs) }),
      ...(run.completedAtMs === undefined ? {} : { completedAt: iso(run.completedAtMs) }),
      ...(run.completedAtMs === undefined
        ? {}
        : { retainedUntil: iso(run.updatedAtMs + this.#retentionTtlMs) }),
      revision: run.revision,
      lastEventId,
      ...(run.progress === undefined ? {} : { progress: frozenClone(run.progress) }),
      ...(run.cancellation === undefined ? {} : { cancellation: { ...run.cancellation } }),
      ...(run.managerFailure === undefined ? {} : { managerFailure: { ...run.managerFailure } }),
      ...(run.evidenceFinalization === undefined
        ? {}
        : { evidenceFinalization: { ...run.evidenceFinalization } }),
    });
  }

  #emit(run: MutableRun, type: string, data: unknown): RunManagerEvent {
    const now = this.#now();
    run.updatedAtMs = now;
    run.revision += 1;
    const id = ++this.#nextEventId;
    const event = deepFreeze({
      id,
      runId: run.runId,
      type,
      timestamp: iso(now),
      phase: run.phase,
      data: frozenClone(data),
      snapshot: this.#snapshot(run, id),
    });
    run.events.push(event);
    while (run.events.length > this.#eventBufferSize) run.events.shift();
    for (const listener of run.subscribers) this.#notify(listener, event);
    return event;
  }

  #notify(listener: RunEventListener, event: RunManagerEvent): void {
    try {
      listener(event);
    } catch {
      // A disconnected SSE client must not disrupt execution or other clients.
    }
  }

  #evict(run: MutableRun): void {
    this.#releaseSlot(run);
    this.#releaseSession(run);
    this.#runs.delete(run.runId);
    run.subscribers.clear();
  }

  #requireRun(runId: string): MutableRun {
    const run = this.#runs.get(runId);
    if (!run) throw new RunManagerError("RUN_NOT_FOUND", `Unknown run ${JSON.stringify(runId)}`);
    return run;
  }

  #uniqueRunId(): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const candidate = this.#runIdFactory();
      if (
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(candidate) &&
        candidate !== "." &&
        candidate !== ".." &&
        !this.#runs.has(candidate)
      ) return candidate;
    }
    throw new Error("Unable to allocate a unique run ID");
  }

  #assertOpen(): void {
    if (this.#closed) throw new RunManagerError("MANAGER_CLOSED", "Run manager is shut down");
  }
}
