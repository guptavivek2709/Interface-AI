import path from "node:path";
import { rm } from "node:fs/promises";
import type { ApprovalAuthority } from "../approval/index.js";
import type { CapabilityCatalog } from "../catalog/index.js";
import {
  CapabilityArtifactV2Schema,
  type ReplayProgressV2,
  type RunValueV2,
} from "../domain/index.js";
import { EventRecorder } from "../evidence/event-recorder.js";
import { EvidenceStore } from "../evidence/store.js";
import { createMeridianSurfaceOptions } from "../profiles/index.js";
import { ReplayRunnerV2 } from "../replay/replayRunnerV2.js";
import type {
  ManagedReplayRunnerV2,
  ManagedRunnerCloseOutcome,
  ManagedRunnerFactory,
  ManagedRunnerFactoryContext,
  ManagedRunnerFactoryRequest,
} from "../runs/index.js";
import { Redactor } from "../safety/redactor.js";
import { SessionManager, type SessionLease, type SessionPrincipal } from "../sessions/index.js";
import { PlaywrightSurface } from "../surface/playwright/playwrightSurface.js";
import { PlaywrightReplayRuntimeV2 } from "../surface/playwright/runtimeV2.js";
import type {
  ReplayRuntimeV2,
  RuntimeContextV2,
  RuntimePageStateV2,
} from "../surface/replayRuntimeV2.js";

class NonClosingRuntime implements ReplayRuntimeV2 {
  readonly #runtime: ReplayRuntimeV2;

  constructor(runtime: ReplayRuntimeV2) {
    this.#runtime = runtime;
  }

  get sessionId(): string {
    return this.#runtime.sessionId;
  }

  get sessionRef(): string {
    return this.#runtime.sessionRef;
  }

  getTarget(id: string) {
    return this.#runtime.getTarget(id);
  }

  resolveValue(expression: Parameters<ReplayRuntimeV2["resolveValue"]>[0], context: RuntimeContextV2) {
    return this.#runtime.resolveValue(expression, context);
  }

  act(action: Parameters<ReplayRuntimeV2["act"]>[0], context: RuntimeContextV2) {
    return this.#runtime.act(action, context);
  }

  evaluate(condition: Parameters<ReplayRuntimeV2["evaluate"]>[0], context: RuntimeContextV2) {
    return this.#runtime.evaluate(condition, context);
  }

  waitFor(
    condition: Parameters<ReplayRuntimeV2["waitFor"]>[0],
    context: RuntimeContextV2,
    timeoutMs: number,
  ) {
    return this.#runtime.waitFor(condition, context, timeoutMs);
  }

  pageState(): Promise<RuntimePageStateV2> {
    return this.#runtime.pageState();
  }

  captureMaskedScreenshot(): Promise<Buffer> {
    return this.#runtime.captureMaskedScreenshot();
  }

  sanitizedDomSnapshot(): Promise<string> {
    return this.#runtime.sanitizedDomSnapshot();
  }

  async close(): Promise<void> {
    // Browser lifetime belongs to SessionManager, not an individual run.
  }
}

interface ManagedMeridianRunnerOptions {
  runner: ReplayRunnerV2;
  recorder: EventRecorder;
  evidence: EvidenceStore;
  sessionManager: SessionManager<PlaywrightSurface>;
  sessionRef: string;
  mode: "sign_on" | "borrowed";
  principal?: SessionPrincipal;
  lease?: SessionLease<PlaywrightSurface>;
  capabilityId: string;
  artifactDigest: string;
  inputDigest: string;
}

class ManagedMeridianRunner implements ManagedReplayRunnerV2 {
  readonly #options: ManagedMeridianRunnerOptions;
  #lastProgress: ReplayProgressV2 | undefined;
  #closePromise: Promise<void> | undefined;
  #activated = false;

  constructor(options: ManagedMeridianRunnerOptions) {
    this.#options = options;
  }

  async run(): Promise<ReplayProgressV2> {
    return this.#handle(await this.#options.runner.run());
  }

  issueApproval(actor: { id: string; roles: readonly string[] }): string {
    return this.#options.runner.issueApproval(actor);
  }

  async resume(approvalToken: string): Promise<ReplayProgressV2> {
    return this.#handle(await this.#options.runner.resume(approvalToken));
  }

  close(outcome?: ManagedRunnerCloseOutcome): Promise<void> {
    this.#closePromise ??= this.#finalize(outcome);
    return this.#closePromise;
  }

  async #finalize(outcome?: ManagedRunnerCloseOutcome): Promise<void> {
    const terminal = this.#lastProgress?.status === "terminal" ? this.#lastProgress.result : undefined;
    const status = outcome?.kind === "result"
      ? outcome.status
      : outcome?.kind === "manager_failure"
        ? "failure"
        : "cancelled";
    const code = outcome?.kind === "result"
      ? outcome.code
      : outcome?.kind === "manager_failure" || outcome?.kind === "cancellation"
        ? outcome.code
        : terminal && terminal.status !== "success"
          ? terminal.code
          : undefined;
    const evidenceOutcome = await finalizeEvidenceBundle(
      this.#options.recorder,
      this.#options.evidence,
      {
        capabilityId: this.#options.capabilityId,
        artifactDigest: this.#options.artifactDigest,
        inputDigest: this.#options.inputDigest,
        status,
        ...(code ? { code } : {}),
        incidentCodes: terminal?.incidents.map((incident) => incident.code) ?? [],
        plannerCallsAllowed: false,
      },
    );
    const finalizationFailed = !evidenceOutcome.complete;

    try {
      if (this.#options.mode === "sign_on") {
        if (!this.#activated || finalizationFailed) {
          await this.#options.sessionManager.revoke(this.#options.sessionRef);
        }
      } else {
        const safeToReuse =
          !finalizationFailed &&
          (terminal?.status === "success" || terminal?.status === "business_outcome");
        if (safeToReuse) await this.#options.lease?.release();
        else await this.#options.sessionManager.revoke(this.#options.sessionRef);
      }
    } catch {
      // SessionManager makes a revoked session unusable before closing its
      // resource. Do not mislabel a complete evidence bundle if that resource
      // close fails; a borrowed release also falls back to fail-closed revoke.
      if (this.#options.mode === "borrowed") {
        await this.#options.sessionManager.revoke(this.#options.sessionRef).catch(() => undefined);
      }
    }
    if (finalizationFailed) {
      throw new Error("Run evidence or target-session finalization failed");
    }
  }

  async #handle(progress: ReplayProgressV2): Promise<ReplayProgressV2> {
    this.#lastProgress = progress;
    if (
      this.#options.mode === "sign_on" &&
      progress.status === "terminal" &&
      progress.result.status === "success" &&
      !this.#activated
    ) {
      if (!this.#options.principal) throw new Error("Sign-on runner is missing its session principal");
      this.#options.sessionManager.activate(this.#options.sessionRef, this.#options.principal);
      this.#activated = true;
    }
    return progress;
  }
}

interface ManagedInitializationFailureRunnerOptions {
  request: ManagedRunnerFactoryRequest;
  recorder: EventRecorder;
  evidence: EvidenceStore;
  code: "RUNNER_INITIALIZATION_FAILED" | "TARGET_SESSION_CLEANUP_FAILED";
}

class ManagedInitializationFailureRunner implements ManagedReplayRunnerV2 {
  readonly #options: ManagedInitializationFailureRunnerOptions;
  readonly #progress: ReplayProgressV2;
  #closePromise: Promise<void> | undefined;

  constructor(options: ManagedInitializationFailureRunnerOptions) {
    this.#options = options;
    const timestamp = new Date().toISOString();
    const message = options.code === "TARGET_SESSION_CLEANUP_FAILED"
      ? "Runner initialization stopped and its target session could not be cleanly finalized."
      : "Runner initialization stopped before deterministic replay began.";
    this.#progress = {
      status: "terminal",
      phase: "completed",
      result: {
        status: "failure",
        runId: options.request.runId,
        capabilityId: options.request.capabilityId,
        capabilityVersion: options.request.capabilityVersion,
        artifactDigest: options.request.artifactDigest,
        inputDigest: options.request.inputDigest,
        sessionRef: options.request.sessionRef,
        startedAt: timestamp,
        completedAt: timestamp,
        journal: [],
        incidents: [{
          code: options.code,
          category: "failure",
          message,
          occurredAt: timestamp,
        }],
        evidencePaths: [],
        code: options.code,
        message,
        retryable: false,
        effectUncertain: false,
      },
    };
  }

  async run(): Promise<ReplayProgressV2> {
    return this.#progress;
  }

  issueApproval(): string {
    throw new Error("An initialization failure cannot be approved");
  }

  async resume(): Promise<ReplayProgressV2> {
    throw new Error("An initialization failure cannot be resumed");
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#finalize();
    return this.#closePromise;
  }

  async #finalize(): Promise<void> {
    const result = this.#progress.status === "terminal" ? this.#progress.result : undefined;
    const evidenceOutcome = await finalizeEvidenceBundle(
      this.#options.recorder,
      this.#options.evidence,
      {
        capabilityId: this.#options.request.capabilityId,
        artifactDigest: this.#options.request.artifactDigest,
        inputDigest: this.#options.request.inputDigest,
        status: "failure",
        code: this.#options.code,
        incidentCodes: result?.incidents.map((incident) => incident.code) ?? [this.#options.code],
        plannerCallsAllowed: false,
      },
    );
    if (!evidenceOutcome.complete) throw new Error("Run evidence finalization failed");
  }
}

export interface MeridianRunnerFactoryOptions {
  catalog: CapabilityCatalog;
  sessions: SessionManager<PlaywrightSurface>;
  approvalAuthority: ApprovalAuthority;
  evidenceRoot: string;
  origin?: string;
  headless?: boolean;
  timeoutMs?: number;
  resolvePrincipal?: (
    sessionRef: string,
    inputs: Readonly<Record<string, unknown>>,
  ) => SessionPrincipal | undefined;
  /**
   * Resolves trusted sign-on identity and hydrates the secret artifact inputs
   * inside the execution boundary. The submitted/request inputs and their safe
   * digest remain unchanged outside this factory.
   */
  resolveSignOn?: (
    sessionRef: string,
    submittedInputs: Readonly<Record<string, RunValueV2>>,
  ) => {
    principal: SessionPrincipal;
    inputs: Readonly<Record<string, RunValueV2>>;
  } | undefined;
}

interface BundleFinalizationOutcome {
  complete: boolean;
  retained: boolean;
  cleanupFailed: boolean;
}

function isRunDirectoryInsideRoot(evidence: EvidenceStore): boolean {
  const relative = path.relative(evidence.rootDirectory, evidence.runDirectory);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function discardRunEvidence(evidence: EvidenceStore): Promise<boolean> {
  if (!isRunDirectoryInsideRoot(evidence)) return false;
  try {
    await rm(evidence.runDirectory, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

async function finalizeEvidenceBundle(
  recorder: EventRecorder,
  evidence: EvidenceStore,
  metadata: Readonly<Record<string, unknown>>,
): Promise<BundleFinalizationOutcome> {
  let eventLogComplete = false;
  try {
    // events.jsonl is append-only while the run is live. It must be closed and
    // hashed before the atomic manifest is written as the final bundle marker.
    await recorder.close();
    await evidence.registerFinalizedFile(
      "events.jsonl",
      "json",
      "application/x-ndjson; charset=utf-8",
      { redacted: true },
    );
    eventLogComplete = true;
  } catch {
    // Never retain an unverified event stream beside a final marker.
    await rm(path.join(evidence.runDirectory, "events.jsonl"), { recursive: true, force: true }).catch(
      () => undefined,
    );
  }

  try {
    await evidence.writeManifest({
      ...metadata,
      evidenceCompleteness: eventLogComplete ? "complete" : "incomplete",
      ...(eventLogComplete ? {} : { evidenceFailureCode: "EVENT_LOG_FINALIZATION_FAILED" }),
    });
    return { complete: eventLogComplete, retained: true, cleanupFailed: false };
  } catch {
    const removed = await discardRunEvidence(evidence);
    return { complete: false, retained: false, cleanupFailed: !removed };
  }
}

/** Creates live MERIDIAN runners while keeping sessions and evidence outside model control. */
export function createMeridianRunnerFactory(options: MeridianRunnerFactoryOptions): ManagedRunnerFactory {
  return async (request, context) => createManagedRunner(options, request, context);
}

async function createManagedRunner(
  options: MeridianRunnerFactoryOptions,
  request: ManagedRunnerFactoryRequest,
  context: ManagedRunnerFactoryContext,
): Promise<ManagedReplayRunnerV2> {
  const entry = options.catalog.resolve(request.capabilityId, request.capabilityVersion);
  if (!entry) throw new Error("Capability is missing, retired, or not approved");
  if (entry.metadata.digest !== request.artifactDigest) throw new Error("Catalog artifact digest changed after submission");
  if (entry.artifact.schemaVersion !== "2.0") throw new Error("The live API supports only V2 capabilities");
  const artifact = CapabilityArtifactV2Schema.parse(structuredClone(entry.artifact));
  // Consume pending credential material before any fallible evidence/recorder
  // initialization. Hydrated values remain local to this factory invocation
  // and are never used to derive the public request/evidence digest.
  const resolvedSignOn = request.capabilityId === "session.sign_on"
    ? options.resolveSignOn?.(request.sessionRef, request.inputs)
    : undefined;
  const replayInputs: Readonly<Record<string, RunValueV2>> = resolvedSignOn?.inputs ?? request.inputs;
  const redactor = new Redactor();
  const evidence = await EvidenceStore.create({
    rootDirectory: path.resolve(options.evidenceRoot),
    runId: request.runId,
    redactor,
  });
  const recorder = new EventRecorder({
    filePath: path.join(evidence.runDirectory, "events.jsonl"),
    runId: request.runId,
    runMetadata: {
      mode: "replay-v2",
      capabilityId: request.capabilityId,
      artifactDigest: request.artifactDigest,
      inputDigest: request.inputDigest,
    },
    redactor,
  });

  let surface: PlaywrightSurface | undefined;
  let mode: "sign_on" | "borrowed" | undefined;
  let principal: SessionPrincipal | undefined;
  let lease: SessionLease<PlaywrightSurface> | undefined;
  let registered = false;
  let recorderInitialized = false;
  try {
    await recorder.initialize();
    recorderInitialized = true;
    if (request.capabilityId === "session.sign_on") {
      const operator = replayInputs.operator;
      const branch = replayInputs.branch;
      const password = replayInputs.password;
      if (typeof operator !== "string" || typeof password !== "string" || typeof branch !== "string") {
        throw new Error("Sign-on requires symbolic operator and branch inputs");
      }
      principal = resolvedSignOn?.principal ?? options.resolvePrincipal?.(request.sessionRef, replayInputs) ?? {
        operatorId: operator,
        // Fail closed: only an authenticated credential resolver may elevate a session.
        role: "teller",
        branch,
      };
      if (principal.operatorId !== operator || principal.branch !== branch) {
        throw new Error("Resolved session principal does not match the sign-on inputs");
      }
      surface = new PlaywrightSurface(
        createMeridianSurfaceOptions(path.join(evidence.runDirectory, "observations"), {
          ...(options.origin ? { origin: options.origin } : {}),
          ...(options.headless === undefined ? {} : { headless: options.headless }),
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        }),
      );
      await surface.start(artifact.compatibility.entryPoint);
      options.sessions.registerProvisioning(request.sessionRef, surface);
      registered = true;
      mode = "sign_on";
    } else {
      lease = await options.sessions.acquire(request.sessionRef, request.runId);
      surface = lease.resource;
      mode = "borrowed";
    }

    const runtime = new NonClosingRuntime(new PlaywrightReplayRuntimeV2(surface, artifact));
    const runner = new ReplayRunnerV2({
      artifact,
      artifactDigest: request.artifactDigest,
      inputDigest: request.inputDigest,
      inputs: { ...replayInputs },
      runtime,
      approvalAuthority: options.approvalAuthority,
      recorder,
      evidence,
      redactor,
      runId: request.runId,
      onPhase: context.reportPhase,
    });
    return new ManagedMeridianRunner({
      runner,
      recorder,
      evidence,
      sessionManager: options.sessions,
      sessionRef: request.sessionRef,
      mode,
      ...(principal ? { principal } : {}),
      ...(lease ? { lease } : {}),
      capabilityId: request.capabilityId,
      artifactDigest: request.artifactDigest,
      inputDigest: request.inputDigest,
    });
  } catch (error) {
    let targetCleanupFailed = false;
    try {
      if (registered) await options.sessions.revoke(request.sessionRef);
      else if (lease) await lease.release();
      else await surface?.close();
    } catch {
      targetCleanupFailed = true;
      if (lease) await options.sessions.revoke(request.sessionRef).catch(() => undefined);
    }
    if (!recorderInitialized) {
      await recorder.close().catch(() => undefined);
      const removed = await discardRunEvidence(evidence);
      throw new Error(
        removed
          ? "Runner recorder initialization failed"
          : "Runner recorder initialization and evidence cleanup failed",
        { cause: error },
      );
    }
    const code = targetCleanupFailed ? "TARGET_SESSION_CLEANUP_FAILED" : "RUNNER_INITIALIZATION_FAILED";
    await recorder.record("replay.v2.failed", { code, effectUncertain: false }).catch(() => undefined);
    // Returning a terminal runner lets RunManager close/finalize the event log
    // and publish evidenceFinalization=complete instead of incorrectly treating
    // a finalized factory failure as evidence=not_applicable.
    return new ManagedInitializationFailureRunner({ request, recorder, evidence, code });
  }
}
