import { randomUUID } from "node:crypto";
import type { ApprovalActor, ApprovalBinding } from "../approval/index.js";
import { ApprovalAuthority, ApprovalError } from "../approval/index.js";
import {
  CapabilityArtifactV2Schema,
  type CapabilityArtifactV2,
  type FieldSpecV2,
  type InputRelationV2,
  type ReplayProgressV2,
  type RunIncidentV2,
  type RunJournalEntryV2,
  type RunValueV2,
  type RuntimeStateRuleV2,
  type StepEffectV2,
  type StepV2,
  type TerminalRunResultV2,
  type TypeSpecV2,
} from "../domain/index.js";
import type { EventRecorder } from "../evidence/event-recorder.js";
import type { EvidenceStore } from "../evidence/store.js";
import type { Redactor } from "../safety/redactor.js";
import { sha256Digest } from "../security/digest.js";
import {
  parseRuntimeValue,
  type ReplayRuntimeV2,
  type RuntimeContextV2,
  type RuntimeValue,
} from "../surface/replayRuntimeV2.js";

const EFFECT_RANK: Readonly<Record<StepEffectV2, number>> = {
  read: 0,
  draft: 1,
  review: 2,
  reversible_write: 3,
  irreversible_commit: 4,
};

function registerSensitiveRuntimeValue(
  redactor: Redactor | undefined,
  value: RuntimeValue | undefined,
  depth = 0,
): void {
  if (!redactor || value === undefined || value === null || depth > 20) return;
  if (typeof value === "string") {
    redactor.register(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) registerSensitiveRuntimeValue(redactor, item, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value)) registerSensitiveRuntimeValue(redactor, item, depth + 1);
  }
}

interface PendingApproval {
  binding: ApprovalBinding;
  expiresInMs: number;
  expiresAtMs: number;
  progress: Extract<ReplayProgressV2, { status: "awaiting_approval" }>;
}

interface ApprovalSnapshot {
  summary: Array<{ targetId: string; value: RuntimeValue; sensitive: boolean }>;
  reviewDigest: string;
  stateNonceDigest: string;
}

interface EffectAttempt {
  stepIndex: number;
  stepId: string;
  effect: "reversible_write" | "irreversible_commit";
  safeRestartStepId?: string;
  confirmed: boolean;
}

interface DetectedState {
  rule: RuntimeStateRuleV2;
}

type StateDisposition =
  | { kind: "continue"; stepIndex: number }
  | { kind: "terminal"; result: TerminalRunResultV2 };

type TerminalDetailsV2 =
  | { status: "success"; outputs: Record<string, RunValueV2> }
  | { status: "business_outcome"; code: string; message: string }
  | {
      status: "failure";
      code: string;
      message: string;
      retryable: boolean;
      stepId?: string;
      effectUncertain: boolean;
    }
  | { status: "escalation"; code: string; message: string; requiredRole?: string; stepId?: string };

class StepPostconditionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "StepPostconditionError";
    this.code = code;
  }
}

export interface ReplayRunnerV2Options {
  artifact: CapabilityArtifactV2;
  artifactDigest?: string;
  /**
   * Trusted request digest supplied by the execution boundary. This permits a
   * server to hydrate secret inputs only inside the runner factory without
   * placing those secrets in the public/request digest. When omitted, the
   * runner hashes the exact invocation inputs for direct callers.
   */
  inputDigest?: string;
  inputs: Record<string, RuntimeValue>;
  runtime: ReplayRuntimeV2;
  approvalAuthority: ApprovalAuthority;
  recorder?: EventRecorder;
  evidence?: EvidenceStore;
  redactor?: Redactor;
  runId?: string;
  timeoutMs?: number;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  onPhase?: (phase: "running" | "recovering", detail?: Readonly<Record<string, unknown>>) => void;
}

export class ReplayRunnerV2 {
  readonly #artifact: CapabilityArtifactV2;
  readonly #artifactDigest: string;
  readonly #inputDigest: string;
  readonly #options: ReplayRunnerV2Options;
  readonly #runtime: ReplayRuntimeV2;
  readonly #authority: ApprovalAuthority;
  readonly #runId: string;
  readonly #startedAt: string;
  readonly #deadline: number;
  readonly #context: RuntimeContextV2;
  readonly #outputs = Object.create(null) as Record<string, RuntimeValue>;
  readonly #journal: RunJournalEntryV2[] = [];
  readonly #incidents: RunIncidentV2[] = [];
  readonly #evidencePaths: string[] = [];
  readonly #recoveryAttempts = new Map<string, number>();
  readonly #approvedSteps = new Set<string>();
  readonly #approvedBindings = new Map<string, ApprovalBinding>();
  readonly #effectAttempts = new Map<number, EffectAttempt>();
  readonly #bindingSnapshots = new Map<number, Record<string, RuntimeValue>>();
  readonly #outputStepIndices = new Map<string, number>();
  readonly #now: () => Date;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  #stepIndex = 0;
  #started = false;
  #pending: PendingApproval | undefined;
  #terminal: TerminalRunResultV2 | undefined;
  #recoveryRedirected = false;

  constructor(options: ReplayRunnerV2Options) {
    this.#options = options;
    this.#artifact = CapabilityArtifactV2Schema.parse(options.artifact);
    const computedArtifactDigest = sha256Digest(this.#artifact);
    if (options.artifactDigest !== undefined && options.artifactDigest !== computedArtifactDigest) {
      throw new TypeError("Supplied artifact digest does not match the validated capability artifact");
    }
    this.#artifactDigest = computedArtifactDigest;
    if (options.inputDigest !== undefined && !/^[a-f0-9]{64}$/u.test(options.inputDigest)) {
      throw new TypeError("Supplied input digest must be a lowercase SHA-256 digest");
    }
    this.#inputDigest = options.inputDigest ?? sha256Digest(options.inputs);
    this.#runtime = options.runtime;
    this.#authority = options.approvalAuthority;
    options.redactor?.register(this.#runtime.sessionRef);
    this.#runId = options.runId ?? options.recorder?.runId ?? randomUUID();
    this.#now = options.now ?? (() => new Date());
    this.#sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    const started = this.#now();
    this.#startedAt = started.toISOString();
    this.#deadline = started.getTime() + (options.timeoutMs ?? 180_000);
    this.#context = {
      inputs: Object.freeze({ ...options.inputs }),
      bindings: Object.create(null) as Record<string, RuntimeValue>,
    };
    for (const spec of this.#artifact.inputs) {
      if (
        spec.classification === "confidential" ||
        spec.classification === "restricted" ||
        spec.classification === "secret"
      ) {
        registerSensitiveRuntimeValue(options.redactor, options.inputs[spec.name]);
      }
    }
  }

  get runId(): string {
    return this.#runId;
  }

  get artifactDigest(): string {
    return this.#artifactDigest;
  }

  get inputDigest(): string {
    return this.#inputDigest;
  }

  async run(): Promise<ReplayProgressV2> {
    if (this.#terminal) return { status: "terminal", phase: "completed", result: this.#terminal };
    if (this.#pending) return this.#pending.progress;
    if (!this.#started) {
      this.#started = true;
      await this.#record("replay.v2.started", {
        runId: this.#runId,
        capabilityId: this.#artifact.capability.id,
        capabilityVersion: this.#artifact.capability.version,
        artifactDigest: this.#artifactDigest,
        inputDigest: this.#inputDigest,
        sessionBindingDigest: sha256Digest(this.#runtime.sessionRef),
        plannerCallsAllowed: false,
      });
      const setupFailure = await this.#validateSetup();
      if (setupFailure) return this.#terminalProgress(setupFailure);
    }
    return this.#drive();
  }

  issueApproval(actor: ApprovalActor): string {
    if (!this.#pending) throw new ApprovalError("APPROVAL_MISMATCH", "This run is not awaiting approval");
    const remaining = this.#pending.expiresAtMs - this.#now().getTime();
    if (remaining <= 0) throw new ApprovalError("APPROVAL_EXPIRED", "Approval challenge has expired");
    return this.#authority.issue(this.#pending.binding, actor, remaining);
  }

  async resume(approvalToken: string): Promise<ReplayProgressV2> {
    if (!this.#pending) throw new ApprovalError("APPROVAL_MISMATCH", "This run is not awaiting approval");
    const pending = this.#pending;
    const claims = this.#authority.consume(approvalToken, pending.binding);
    this.#approvedSteps.add(pending.binding.stepId);
    this.#approvedBindings.set(pending.binding.stepId, pending.binding);
    this.#pending = undefined;
    await this.#record("approval.consumed", {
      challengeId: pending.binding.challengeId,
      stepId: pending.binding.stepId,
      approvalId: claims.approvalId,
      actorId: claims.actorId,
      actorRoles: claims.actorRoles,
    });
    return this.#drive();
  }

  async close(): Promise<void> {
    await this.#runtime.close();
  }

  approvalBinding(): ApprovalBinding | undefined {
    return this.#pending ? { ...this.#pending.binding } : undefined;
  }

  async #drive(): Promise<ReplayProgressV2> {
    while (this.#stepIndex < this.#artifact.steps.length) {
      const step = this.#artifact.steps[this.#stepIndex]!;
      this.#rememberBindings(this.#stepIndex);
      if (this.#now().getTime() >= this.#deadline) {
        return this.#terminalProgress(await this.#failure("TIMEOUT", "Run time budget was exhausted", step, false));
      }

      const routeFailure = this.#assertRoute(await this.#runtime.pageState());
      if (routeFailure) return this.#terminalProgress(await this.#failure("POLICY_ROUTE_DENIED", routeFailure, step, false));

      const declared = await this.#detectState();
      if (declared) {
        const disposition = await this.#applyState(declared, step);
        if (disposition.kind === "terminal") return this.#terminalProgress(disposition.result);
        this.#stepIndex = disposition.stepIndex;
        continue;
      }

      const preconditionFailure = await this.#firstUnmatched(step.preconditions);
      if (preconditionFailure) {
        return this.#terminalProgress(
          await this.#failure("PRECONDITION_FAILED", preconditionFailure, step, false),
        );
      }

      if (step.approval && !this.#approvedSteps.has(step.id)) {
        return this.#pauseForApproval(step);
      }

      const execution = await this.#executeStep(step);
      if (execution) return this.#terminalProgress(execution);
      if (this.#recoveryRedirected) {
        this.#recoveryRedirected = false;
        continue;
      }
      this.#approvedSteps.delete(step.id);
      this.#approvedBindings.delete(step.id);
      this.#stepIndex += 1;
    }

    const checkpoint = await this.#runtime.evaluate(this.#artifact.checkpoint, this.#context);
    if (!checkpoint.matched) {
      const state = await this.#detectState();
      if (state) {
        const disposition = await this.#applyState(state, this.#artifact.steps.at(-1));
        if (disposition.kind === "terminal") return this.#terminalProgress(disposition.result);
        this.#stepIndex = disposition.stepIndex;
        return this.#drive();
      }
      return this.#terminalProgress(
        await this.#failure("CHECKPOINT_FAILED", checkpoint.summary, this.#artifact.steps.at(-1), false),
      );
    }
    for (const output of this.#artifact.outputs) {
      if (!Object.hasOwn(this.#outputs, output.name)) {
        return this.#terminalProgress(
          await this.#failure("OUTPUT_MISSING", `Declared output ${output.name} was not extracted`, undefined, false),
        );
      }
    }
    await this.#capture("completion");
    const result = this.#baseResult({ status: "success", outputs: { ...this.#outputs } });
    await this.#record("replay.v2.finished", { status: result.status, incidentCount: this.#incidents.length });
    return this.#terminalProgress(result);
  }

  async #executeStep(step: StepV2): Promise<TerminalRunResultV2 | undefined> {
    const actionAllowed = this.#artifact.policy.allowedActions.includes(step.action.kind);
    if (!actionAllowed) return this.#failure("POLICY_ACTION_DENIED", `Action ${step.action.kind} is not allowed`, step, false);
    if (EFFECT_RANK[step.effect] > EFFECT_RANK[this.#artifact.policy.maxEffect]) {
      return this.#failure("POLICY_EFFECT_DENIED", `Effect ${step.effect} exceeds artifact policy`, step, false);
    }
    if (EFFECT_RANK[step.effect] >= EFFECT_RANK.reversible_write && !step.approval) {
      return this.#failure("APPROVAL_REQUIRED", "Externally visible write step has no approval requirement", step, false);
    }

    const safeToRetry =
      (step.effect === "read" || step.effect === "draft") &&
      step.action.kind !== "click";
    const maxAttempts = safeToRetry ? step.retry.maxAttempts : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const entry: RunJournalEntryV2 = {
        sequence: this.#journal.length + 1,
        stepId: step.id,
        title: step.title,
        action: step.action.kind,
        effect: step.effect,
        attempt,
        status: "started",
        startedAt: this.#now().toISOString(),
        evidencePaths: [],
      };
      this.#journal.push(entry);
      await this.#record("step.started", {
        sequence: entry.sequence,
        stepId: step.id,
        action: step.action.kind,
        effect: step.effect,
        attempt,
      });
      if (step.approval) {
        try {
          await this.#revalidateApproval(step);
        } catch {
          entry.status = "failed";
          entry.completedAt = this.#now().toISOString();
          entry.summary = "The reviewed state changed before the write";
          await this.#record("step.failed", {
            sequence: entry.sequence,
            stepId: step.id,
            attempt,
            code: "REVIEW_STALE",
          });
          return this.#failure(
            "REVIEW_STALE",
            "The reviewed values or transaction state changed before execution; obtain a new review and approval",
            step,
            false,
          );
        }
      }
      try {
        this.#markEffectAttempt(step);
        const receipt = await this.#runtime.act(step.action, this.#context);
        const routeFailure = this.#assertRoute(await this.#runtime.pageState());
        if (routeFailure) throw new Error(routeFailure);
        const state = await this.#detectState();
        if (state) {
          entry.status = "failed";
          entry.completedAt = this.#now().toISOString();
          entry.summary = state.rule.description;
          if (EFFECT_RANK[step.effect] >= EFFECT_RANK.reversible_write && state.rule.effectCertainty !== "not_applied") {
            return this.#failure(
              "EFFECT_UNKNOWN",
              `The target reported ${state.rule.code} after a write attempt; reconcile before any retry`,
              step,
              false,
              true,
            );
          }
          if (EFFECT_RANK[step.effect] >= EFFECT_RANK.reversible_write) this.#effectAttempts.delete(this.#stepIndex);
          const disposition = await this.#applyState(state, step);
          if (disposition.kind === "terminal") return disposition.result;
          this.#stepIndex = disposition.stepIndex;
          this.#recoveryRedirected = true;
          return undefined;
        }
        const postcondition = await this.#runtime.waitFor(step.postcondition, this.#context, step.timeoutMs);
        if (!postcondition.matched) {
          throw new StepPostconditionError(
            step.postconditionFailureCode ?? "POSTCONDITION_FAILED",
            `Postcondition failed: ${postcondition.summary}`,
          );
        }
        if (step.action.kind === "extract" && step.action.outputName) {
          this.#storeOutput(step.action.outputName, receipt.value, this.#stepIndex);
        }
        if (step.action.kind === "extract_table") this.#storeOutput(step.action.outputName, receipt.value, this.#stepIndex);
        const effectAttempt = this.#effectAttempts.get(this.#stepIndex);
        if (effectAttempt) effectAttempt.confirmed = true;
        entry.status = "succeeded";
        entry.completedAt = this.#now().toISOString();
        entry.summary = postcondition.summary;
        await this.#record("step.succeeded", {
          sequence: entry.sequence,
          stepId: step.id,
          attempt,
          strategy: receipt.strategy,
          resolutionAttempts: receipt.attempts,
        });
        return undefined;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        entry.status = "failed";
        entry.completedAt = this.#now().toISOString();
        entry.summary = message;
        await this.#record("step.failed", { sequence: entry.sequence, stepId: step.id, attempt, message });
        if (attempt < maxAttempts) {
          await this.#sleep(step.retry.backoffMs);
          continue;
        }
        const effectUncertain = EFFECT_RANK[step.effect] >= EFFECT_RANK.reversible_write;
        return this.#failure(
          effectUncertain
            ? "EFFECT_UNKNOWN"
            : error instanceof StepPostconditionError
              ? error.code
              : "STEP_FAILED",
          effectUncertain
            ? "The write may have taken effect; automatic retry is forbidden and reconciliation is required"
            : message,
          step,
          false,
          effectUncertain,
        );
      }
    }
    return this.#failure("STEP_FAILED", "Step attempts were exhausted", step, false);
  }

  async #pauseForApproval(step: StepV2): Promise<ReplayProgressV2> {
    if (!step.approval) throw new Error("Approval pause requested without a requirement");
    const snapshot = await this.#approvalSnapshot(step);
    await this.#capture(`approval-${step.id}`);
    const challengeId = randomUUID();
    const createdAt = this.#now();
    const expiresAtMs = createdAt.getTime() + step.approval.expiresInMs;
    const binding: ApprovalBinding = {
      challengeId,
      runId: this.#runId,
      artifactDigest: this.#artifactDigest,
      inputDigest: this.#inputDigest,
      sessionRef: this.#runtime.sessionRef,
      stepId: step.id,
      kind: step.approval.kind,
      reviewDigest: snapshot.reviewDigest,
      stateNonceDigest: snapshot.stateNonceDigest,
    };
    const progress: Extract<ReplayProgressV2, { status: "awaiting_approval" }> = {
      status: "awaiting_approval",
      phase: "awaiting_approval",
      challenge: {
        challengeId,
        runId: this.#runId,
        stepId: step.id,
        stepTitle: step.title,
        requirement: step.approval.kind,
        expiresInMs: step.approval.expiresInMs,
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(expiresAtMs).toISOString(),
        summary: snapshot.summary,
      },
      journal: this.#journal.map((entry) => ({ ...entry, evidencePaths: [...entry.evidencePaths] })),
      incidents: this.#incidents.map((incident) => ({ ...incident })),
    };
    this.#pending = { binding, expiresInMs: step.approval.expiresInMs, expiresAtMs, progress };
    await this.#record("approval.requested", {
      challengeId,
      stepId: step.id,
      requirement: step.approval.kind,
      summaryTargets: step.approval.summaryTargets,
      expiresInMs: step.approval.expiresInMs,
    });
    return progress;
  }

  async #approvalSnapshot(step: StepV2): Promise<ApprovalSnapshot> {
    if (!step.approval) throw new Error("Approval snapshot requested for an unapproved step");
    const summary: ApprovalSnapshot["summary"] = [];
    for (const targetId of step.approval.summaryTargets) {
      const target = this.#runtime.getTarget(targetId);
      const value = await this.#extractApprovalValue(
        step,
        targetId,
        step.approval.summarySources[targetId] ?? "text",
        "summary",
      );
      if (target.sensitive) registerSensitiveRuntimeValue(this.#options.redactor, value);
      summary.push({ targetId, value, sensitive: target.sensitive });
    }
    const nonceTarget = this.#runtime.getTarget(step.approval.stateNonceTarget);
    const stateNonce = await this.#extractApprovalValue(
      step,
      step.approval.stateNonceTarget,
      "value",
      "nonce",
    );
    if (nonceTarget.sensitive) registerSensitiveRuntimeValue(this.#options.redactor, stateNonce);
    return {
      summary,
      reviewDigest: sha256Digest(summary),
      stateNonceDigest: sha256Digest({ targetId: step.approval.stateNonceTarget, value: stateNonce }),
    };
  }

  async #extractApprovalValue(
    step: StepV2,
    targetId: string,
    source: "text" | "value",
    purpose: "summary" | "nonce",
  ): Promise<RuntimeValue> {
    const bindingName = `approval:${purpose}:${step.id}:${targetId}`;
    try {
      const receipt = await this.#runtime.act(
        { kind: "extract", targetId, bindingName, source },
        this.#context,
      );
      if (receipt.value === undefined) throw new Error(`Approval ${purpose} target did not return a value`);
      return receipt.value;
    } finally {
      delete this.#context.bindings[bindingName];
    }
  }

  async #revalidateApproval(step: StepV2): Promise<void> {
    const approved = this.#approvedBindings.get(step.id);
    if (!approved) throw new Error("No consumed approval is bound to this step");
    const current = await this.#approvalSnapshot(step);
    if (
      current.reviewDigest !== approved.reviewDigest ||
      current.stateNonceDigest !== approved.stateNonceDigest
    ) {
      throw new Error("Approval snapshot digest mismatch");
    }
  }

  async #detectState(): Promise<DetectedState | undefined> {
    const rules = [...this.#artifact.runtimeStates].sort((left, right) => right.priority - left.priority);
    for (const rule of rules) {
      const result = await this.#runtime.evaluate(rule.condition, this.#context);
      if (result.matched) return { rule };
    }
    return undefined;
  }

  async #applyState(state: DetectedState, step?: StepV2): Promise<StateDisposition> {
    const { rule } = state;
    if (rule.category === "business_outcome") {
      await this.#capture(`business-outcome-${rule.code}`);
      const result = this.#baseResult({ status: "business_outcome", code: rule.code, message: rule.description });
      await this.#record("state.business_outcome", { code: rule.code, stepId: step?.id });
      return { kind: "terminal", result };
    }
    if (rule.category === "failure") {
      return { kind: "terminal", result: await this.#failure(rule.code, rule.description, step, false) };
    }
    if (rule.category === "escalation") {
      const incident: RunIncidentV2 = {
        code: rule.code,
        category: "escalation",
        message: rule.description,
        ...(step ? { stepId: step.id } : {}),
        occurredAt: this.#now().toISOString(),
      };
      this.#incidents.push(incident);
      await this.#capture(`escalation-${rule.code}`);
      return {
        kind: "terminal",
        result: this.#baseResult({
          status: "escalation",
          code: rule.code,
          message: rule.description,
          ...(rule.requiredRole
            ? { requiredRole: rule.requiredRole }
            : this.#artifact.capability.risk === "supervisor_only"
              ? { requiredRole: "supervisor" }
              : {}),
          ...(step ? { stepId: step.id } : {}),
        }),
      };
    }

    const recovery = rule.recovery;
    if (!recovery) return { kind: "terminal", result: await this.#failure(rule.code, rule.description, step, false) };
    const recoveryBoundary = this.#recoveryBoundary();
    if (recoveryBoundary.unsafeStepId) {
      return {
        kind: "terminal",
        result: await this.#failure(
          "EFFECT_UNKNOWN",
          `A recoverable marker appeared after write step ${recoveryBoundary.unsafeStepId}; automatic recovery is forbidden`,
          step,
          false,
          true,
        ),
      };
    }
    const attempt = (this.#recoveryAttempts.get(rule.code) ?? 0) + 1;
    this.#recoveryAttempts.set(rule.code, attempt);
    if (attempt > recovery.maxAttempts) {
      return {
        kind: "terminal",
        result: await this.#failure(
          "RECOVERY_EXHAUSTED",
          `Recovery ${rule.code} exceeded ${recovery.maxAttempts} attempts`,
          step,
          false,
        ),
      };
    }
    const incident: RunIncidentV2 = {
      code: rule.code,
      category: "recoverable",
      message: rule.description,
      ...(step ? { stepId: step.id } : {}),
      occurredAt: this.#now().toISOString(),
      recoveryAttempt: attempt,
    };
    this.#incidents.push(incident);
    this.#options.onPhase?.("recovering", { code: rule.code, attempt });
    await this.#capture(`recovery-${rule.code}-${attempt}`);
    await this.#record("state.recovering", { code: rule.code, attempt, kind: recovery.kind });
    if (recovery.waitMs > 0) await this.#sleep(recovery.waitMs);
    if (recovery.action) {
      try {
        await this.#runtime.act(recovery.action, this.#context);
        const routeFailure = this.#assertRoute(await this.#runtime.pageState());
        if (routeFailure) {
          return { kind: "terminal", result: await this.#failure("RECOVERY_ROUTE_DENIED", routeFailure, step, false) };
        }
      } catch (error) {
        return {
          kind: "terminal",
          result: await this.#failure(
            "RECOVERY_FAILED",
            error instanceof Error ? error.message : String(error),
            step,
            false,
          ),
        };
      }
    }
    let stepIndex = 0;
    if (recovery.kind === "restart_from_step") {
      stepIndex = this.#artifact.steps.findIndex((candidate) => candidate.id === recovery.stepId);
      if (stepIndex < 0) {
        return { kind: "terminal", result: await this.#failure("ARTIFACT_INVALID", "Recovery step is unknown", step, false) };
      }
    }
    stepIndex = Math.max(stepIndex, recoveryBoundary.minimumStepIndex);
    if (stepIndex >= this.#artifact.steps.length) {
      return {
        kind: "terminal",
        result: await this.#failure("RECOVERY_FAILED", "The declared safe restart boundary is outside the workflow", step, false),
      };
    }
    this.#invalidateFrom(stepIndex);
    for (let index = stepIndex; index < this.#artifact.steps.length; index += 1) {
      this.#approvedSteps.delete(this.#artifact.steps[index]!.id);
      this.#approvedBindings.delete(this.#artifact.steps[index]!.id);
    }
    this.#options.onPhase?.("running", { recoveredFrom: rule.code, attempt });
    return { kind: "continue", stepIndex };
  }

  #recoveryBoundary(): { minimumStepIndex: number; unsafeStepId?: string } {
    let minimumStepIndex = 0;
    for (const attempt of this.#effectAttempts.values()) {
      if (attempt.effect === "irreversible_commit" || !attempt.safeRestartStepId) {
        return { minimumStepIndex, unsafeStepId: attempt.stepId };
      }
      const safeIndex = this.#artifact.steps.findIndex((step) => step.id === attempt.safeRestartStepId);
      if (safeIndex <= attempt.stepIndex) return { minimumStepIndex, unsafeStepId: attempt.stepId };
      minimumStepIndex = Math.max(minimumStepIndex, safeIndex);
    }
    return { minimumStepIndex };
  }

  #rememberBindings(stepIndex: number): void {
    if (!this.#bindingSnapshots.has(stepIndex)) {
      this.#bindingSnapshots.set(stepIndex, { ...this.#context.bindings });
    }
  }

  #invalidateFrom(stepIndex: number): void {
    const snapshot = this.#bindingSnapshots.get(stepIndex) ?? (Object.create(null) as Record<string, RuntimeValue>);
    for (const key of Object.keys(this.#context.bindings)) delete this.#context.bindings[key];
    Object.assign(this.#context.bindings, snapshot);
    for (const [outputName, producerIndex] of this.#outputStepIndices) {
      if (producerIndex >= stepIndex) {
        delete this.#outputs[outputName];
        this.#outputStepIndices.delete(outputName);
      }
    }
    for (const index of [...this.#bindingSnapshots.keys()]) {
      if (index >= stepIndex) this.#bindingSnapshots.delete(index);
    }
    for (const index of [...this.#effectAttempts.keys()]) {
      if (index >= stepIndex) this.#effectAttempts.delete(index);
    }
  }

  #markEffectAttempt(step: StepV2): void {
    if (step.effect !== "reversible_write" && step.effect !== "irreversible_commit") return;
    this.#effectAttempts.set(this.#stepIndex, {
      stepIndex: this.#stepIndex,
      stepId: step.id,
      effect: step.effect,
      ...(step.safeRestartStepId ? { safeRestartStepId: step.safeRestartStepId } : {}),
      confirmed: false,
    });
  }

  async #validateSetup(): Promise<TerminalRunResultV2 | undefined> {
    if (this.#artifact.capability.approval !== "approved") {
      return this.#failure("ARTIFACT_NOT_APPROVED", "Only approved artifacts can be replayed", undefined, false);
    }
    const errors = validateFields(this.#artifact.inputs, this.#options.inputs, true);
    errors.push(...validateInputRelations(this.#artifact.policy.inputRelations, this.#options.inputs));
    if (errors.length > 0) return this.#failure("INPUT_INVALID", errors.join("; "), undefined, false);
    for (const step of this.#artifact.steps) {
      if (EFFECT_RANK[step.effect] >= EFFECT_RANK.reversible_write && !step.approval) {
        return this.#failure("ARTIFACT_INVALID", `Write step ${step.id} requires approval`, step, false);
      }
      if (step.approval?.kind === "supervisor_confirmation" && this.#artifact.capability.risk !== "supervisor_only") {
        return this.#failure(
          "ARTIFACT_INVALID",
          `Supervisor approval on ${step.id} requires supervisor_only capability risk`,
          step,
          false,
        );
      }
    }
    return undefined;
  }

  async #firstUnmatched(conditions: StepV2["preconditions"]): Promise<string | undefined> {
    for (const condition of conditions) {
      const result = await this.#runtime.evaluate(condition, this.#context);
      if (!result.matched) return result.summary;
    }
    return undefined;
  }

  #storeOutput(name: string, observed: RuntimeValue | undefined, stepIndex: number): void {
    if (observed === undefined) throw new Error(`Output ${name} was not returned by the runtime`);
    const spec = this.#artifact.outputs.find((candidate) => candidate.name === name);
    if (!spec) throw new Error(`Output ${name} is not declared`);
    const value = typeof observed === "string" && spec.type.kind !== "string"
      ? parseRuntimeValue(spec.type, observed)
      : observed;
    const errors = validateType(spec.type, value, name);
    if (errors.length > 0) throw new Error(errors.join("; "));
    this.#outputs[name] = value;
    this.#outputStepIndices.set(name, stepIndex);
    if (
      spec.classification === "confidential" ||
      spec.classification === "restricted" ||
      spec.classification === "secret"
    ) {
      registerSensitiveRuntimeValue(this.#options.redactor, value);
    }
  }

  #assertRoute(state: { url: string; method: "GET" | "POST" | null }): string | undefined {
    let url: URL;
    try {
      url = new URL(state.url);
    } catch {
      return "Runtime reported an invalid URL";
    }
    for (const route of this.#artifact.policy.routes) {
      const expectedOrigin = new URL(route.origin).origin;
      if (url.origin !== expectedOrigin) continue;
      let matches = false;
      try {
        matches = new RegExp(route.pathPattern, "u").test(url.pathname);
      } catch {
        return `Route policy contains an invalid path expression`;
      }
      if (!matches) continue;
      if (state.method !== null && !route.methods.includes(state.method)) continue;
      const allowedQuery = route.query ?? {};
      let queryMatches = true;
      for (const key of new Set(url.searchParams.keys())) {
        const values = url.searchParams.getAll(key);
        const rule = allowedQuery[key];
        if (!rule) {
          queryMatches = false;
          continue;
        }
        for (const value of values) {
          const exact = rule.values?.includes(value) ?? false;
          const patterned = rule.pattern ? new RegExp(rule.pattern, "u").test(value) : false;
          if (!exact && !patterned) queryMatches = false;
        }
      }
      for (const [key, rule] of Object.entries(allowedQuery)) {
        if (rule.required && !url.searchParams.has(key)) queryMatches = false;
      }
      if (queryMatches) return undefined;
    }
    return `Navigation to ${url.origin}${url.pathname} is outside the artifact route policy`;
  }

  async #failure(
    code: string,
    message: string,
    step: StepV2 | undefined,
    retryable: boolean,
    effectUncertain = false,
  ): Promise<TerminalRunResultV2> {
    const reconciliationRequired = effectUncertain || this.#effectAttempts.size > 0;
    const failureMessage = reconciliationRequired && !effectUncertain
      ? `${message}; a prior write was attempted, so reconcile its outcome before retrying`
      : message;
    const incident: RunIncidentV2 = {
      code,
      category: "failure",
      message: failureMessage,
      ...(step ? { stepId: step.id } : {}),
      occurredAt: this.#now().toISOString(),
    };
    this.#incidents.push(incident);
    await this.#capture(`failure-${code}`);
    await this.#record("replay.v2.failed", {
      code,
      stepId: step?.id,
      retryable,
      effectUncertain: reconciliationRequired,
      message: failureMessage,
    });
    return this.#baseResult({
      status: "failure",
      code,
      message: failureMessage,
      retryable,
      ...(step ? { stepId: step.id } : {}),
      effectUncertain: reconciliationRequired,
    });
  }

  #baseResult(terminal: TerminalDetailsV2): TerminalRunResultV2 {
    return { ...this.#resultBase(), ...terminal } as TerminalRunResultV2;
  }

  #resultBase() {
    return {
      runId: this.#runId,
      capabilityId: this.#artifact.capability.id,
      capabilityVersion: this.#artifact.capability.version,
      artifactDigest: this.#artifactDigest,
      inputDigest: this.#inputDigest,
      sessionRef: this.#runtime.sessionRef,
      startedAt: this.#startedAt,
      completedAt: this.#now().toISOString(),
      journal: this.#journal.map((entry) => ({ ...entry, evidencePaths: [...entry.evidencePaths] })),
      incidents: this.#incidents.map((incident) => ({ ...incident })),
      evidencePaths: [...this.#evidencePaths],
    };
  }

  #terminalProgress(result: TerminalRunResultV2): ReplayProgressV2 {
    this.#terminal = result;
    return { status: "terminal", phase: "completed", result };
  }

  async #capture(label: string): Promise<void> {
    const evidence = this.#options.evidence;
    if (!evidence) return;
    const screenshot = await evidence.saveMaskedScreenshot(label, await this.#runtime.captureMaskedScreenshot(), {
      masked: true,
      mimeType: "image/png",
    });
    const dom = await evidence.saveDomSnapshot(label, await this.#runtime.sanitizedDomSnapshot());
    this.#evidencePaths.push(screenshot.path, dom.path);
    await this.#record("evidence.captured", { label, evidenceIds: [screenshot.id, dom.id] });
  }

  async #record(type: string, data: unknown): Promise<void> {
    await this.#options.recorder?.record(type, data, { actor: "runtime" });
  }
}

export function validateInvocationInputsV2(
  fields: readonly FieldSpecV2[],
  values: Readonly<Record<string, RuntimeValue>>,
): readonly string[] {
  return validateFields(fields, values, true);
}

function validateFields(
  fields: readonly FieldSpecV2[],
  values: Readonly<Record<string, RuntimeValue>>,
  rejectUnknown: boolean,
): string[] {
  const errors: string[] = [];
  const names = new Set(fields.map((field) => field.name));
  for (const field of fields) {
    if (!Object.hasOwn(values, field.name)) {
      if (field.required) errors.push(`Missing required input ${field.name}`);
      continue;
    }
    errors.push(...validateType(field.type, values[field.name]!, field.name));
  }
  if (rejectUnknown) {
    for (const name of Object.keys(values)) if (!names.has(name)) errors.push(`Unknown input ${name}`);
  }
  return errors;
}

function validateInputRelations(
  relations: readonly InputRelationV2[],
  values: Readonly<Record<string, RuntimeValue>>,
): string[] {
  const errors: string[] = [];
  for (const relation of relations) {
    if (relation.kind === "not_equal") {
      if (!Object.hasOwn(values, relation.left) || !Object.hasOwn(values, relation.right)) continue;
      if (sha256Digest(values[relation.left]) === sha256Digest(values[relation.right])) {
        errors.push(`${relation.left} and ${relation.right} must be different`);
      }
      continue;
    }
    if (!Object.hasOwn(values, relation.value) || !Object.hasOwn(values, relation.prefix)) continue;
    const value = values[relation.value];
    const prefix = values[relation.prefix];
    if (typeof value !== "string" || typeof prefix !== "string" || !value.startsWith(`${prefix}${relation.separator}`)) {
      errors.push(`${relation.value} must belong to ${relation.prefix}`);
    }
  }
  return errors;
}

function validateType(type: TypeSpecV2, value: RuntimeValue, path: string): string[] {
  if (type.kind === "string") {
    if (typeof value !== "string") return [`${path} must be a string`];
    if (type.minLength !== undefined && value.length < type.minLength) return [`${path} is shorter than allowed`];
    if (type.maxLength !== undefined && value.length > type.maxLength) return [`${path} is longer than allowed`];
    if (type.enum && !type.enum.includes(value)) return [`${path} is not an allowed value`];
    if (type.pattern) {
      try {
        if (!new RegExp(type.pattern, "u").test(value)) return [`${path} does not match its pattern`];
      } catch {
        return [`${path} declares an invalid pattern`];
      }
    }
    if (type.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)) return [`${path} must be an email`];
    if (type.format === "phone" && !/^\+?[0-9](?:[0-9() .-]{5,22}[0-9])?$/u.test(value)) {
      return [`${path} must be a phone number`];
    }
    if (type.format === "member_number" && !/^[0-9]{6}$/u.test(value)) return [`${path} must be a member number`];
    if (type.format === "share_id" && !/^[0-9]{6}-[A-Z0-9-]{5,20}$/u.test(value)) return [`${path} must be a share ID`];
    return [];
  }
  if (type.kind === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return [`${path} must be a finite number`];
    if (type.integer && !Number.isInteger(value)) return [`${path} must be an integer`];
    if (type.minimum !== undefined && value < type.minimum) return [`${path} is below its minimum`];
    if (type.maximum !== undefined && value > type.maximum) return [`${path} is above its maximum`];
    return [];
  }
  if (type.kind === "boolean") return typeof value === "boolean" ? [] : [`${path} must be a boolean`];
  if (type.kind === "money") {
    if (!value || Array.isArray(value) || typeof value !== "object") return [`${path} must be a money object`];
    const item = value as Record<string, RuntimeValue>;
    if (item.currency !== type.currency || typeof item.amount !== "string" || !Number.isSafeInteger(item.minorUnits)) {
      return [`${path} must contain currency, decimal amount, and integer minorUnits`];
    }
    const minor = item.minorUnits as number;
    try {
      const parsed = parseRuntimeValue(type, item.amount as string) as Record<string, RuntimeValue>;
      if (parsed.minorUnits !== minor) return [`${path} decimal amount and minorUnits do not agree`];
    } catch {
      return [`${path}.amount must be a canonical decimal amount`];
    }
    if (type.minimumMinorUnits !== undefined && minor < type.minimumMinorUnits) return [`${path} is below its minimum`];
    if (type.maximumMinorUnits !== undefined && minor > type.maximumMinorUnits) return [`${path} is above its maximum`];
    return [];
  }
  if (type.kind === "array") {
    if (!Array.isArray(value)) return [`${path} must be an array`];
    if (type.maxItems !== undefined && value.length > type.maxItems) return [`${path} has too many items`];
    return value.flatMap((item, index) => validateType(type.items, item, `${path}[${index}]`));
  }
  if (!value || Array.isArray(value) || typeof value !== "object") return [`${path} must be an object`];
  const object = value as Record<string, RuntimeValue>;
  const errors: string[] = [];
  for (const required of type.required) if (!Object.hasOwn(object, required)) errors.push(`${path}.${required} is required`);
  for (const [key, item] of Object.entries(object)) {
    const property = type.properties[key];
    if (!property) errors.push(`${path}.${key} is not declared`);
    else errors.push(...validateType(property, item, `${path}.${key}`));
  }
  return errors;
}
