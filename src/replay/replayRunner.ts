import path from "node:path";
import {
  CapabilityArtifactSchema,
  type ActionJournalEntry,
  type CapabilityArtifact,
  type Condition,
  type RunResult,
  type OutputSpec,
  type Step,
} from "../domain/index.js";
import type { EventRecorder } from "../evidence/event-recorder.js";
import type { EvidenceRef, EvidenceStore } from "../evidence/store.js";
import {
  ControlCoordinator,
  type InterventionContext,
} from "../handoff/controlCoordinator.js";
import { OperatorServer } from "../handoff/operatorServer.js";
import { PolicyEngine, PolicyViolationError } from "../safety/policy.js";
import type { Redactor } from "../safety/redactor.js";
import { PlaywrightArtifactRuntime, TargetResolutionError } from "../surface/playwright/artifactRuntime.js";
import type { PlaywrightSurface } from "../surface/playwright/playwrightSurface.js";

export interface ReplayRunnerOptions {
  artifact: CapabilityArtifact;
  inputs: Record<string, string | number | boolean>;
  surface: PlaywrightSurface;
  recorder: EventRecorder;
  evidence: EvidenceStore;
  redactor: Redactor;
  control?: ControlCoordinator;
  operatorServer?: OperatorServer;
  autoHandoff?: (operatorUrl: string) => Promise<void>;
  onOperatorAvailable?: (operatorUrl: string) => void;
  runId?: string;
  timeoutMs?: number;
}

interface DetectedState {
  kind: "business_outcome" | "failure" | "intervention" | "recovered" | "none";
  code?: string;
  message?: string;
}

class OutputTypeError extends Error {
  readonly outputName: string;

  constructor(outputName: string, expectedType: OutputSpec["type"], observed: string) {
    super(
      `Output ${outputName} expected ${expectedType}, but the extracted value did not match that type ` +
        `(length=${observed.length}).`,
    );
    this.name = "OutputTypeError";
    this.outputName = outputName;
  }
}

function parseOutputValue(spec: OutputSpec, observed: string): string | number | boolean {
  if (spec.type === "string") return observed;
  if (spec.type === "number") {
    if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/u.test(observed.trim())) {
      throw new OutputTypeError(spec.name, spec.type, observed);
    }
    const value = Number(observed);
    if (!Number.isFinite(value)) throw new OutputTypeError(spec.name, spec.type, observed);
    return value;
  }
  if (spec.type === "boolean") {
    const normalized = observed.trim().toLocaleLowerCase("en-US");
    if (normalized === "true") return true;
    if (normalized === "false") return false;
    throw new OutputTypeError(spec.name, spec.type, observed);
  }
  if (
    !/^\s*(?:[A-Z]{3}\s*|[$€£]\s*)?-?(?:\d+(?:\.\d{1,2})?|\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?)\s*$/u.test(
      observed,
    )
  ) {
    throw new OutputTypeError(spec.name, spec.type, observed);
  }
  return observed;
}

function now(): string {
  return new Date().toISOString();
}

function conditionSummary(condition: Condition): string {
  switch (condition.kind) {
    case "all":
      return `all(${condition.conditions.map(conditionSummary).join(", ")})`;
    case "target_visible":
      return `${condition.targetId} visible=${condition.visible}`;
    case "target_value":
      return `${condition.targetId} ${condition.operator} expected value`;
    case "frame_path":
      return `frame path ${condition.framePath.map((item) => item.title).join(" > ")}`;
    case "text_visible":
      return `visible text ${JSON.stringify(condition.text)}`;
  }
}

function validateInputs(
  artifact: CapabilityArtifact,
  inputs: Record<string, string | number | boolean>,
): string[] {
  const errors: string[] = [];
  const declared = new Set(artifact.inputs.map((input) => input.name));
  for (const spec of artifact.inputs) {
    if (!Object.hasOwn(inputs, spec.name)) {
      if (spec.required) errors.push(`Missing required input ${spec.name}`);
      continue;
    }
    const value = inputs[spec.name]!;
    if (typeof value !== spec.type) errors.push(`${spec.name} must be ${spec.type}`);
    if (spec.pattern && typeof value === "string" && !new RegExp(spec.pattern, "u").test(value)) {
      errors.push(`${spec.name} does not match its declared pattern`);
    }
    if (spec.enum && !spec.enum.some((candidate) => candidate === value)) {
      errors.push(`${spec.name} is not an allowed value`);
    }
  }
  for (const name of Object.keys(inputs)) {
    if (!declared.has(name)) errors.push(`Unknown input ${name}`);
  }
  return errors;
}

export class ReplayRunner {
  readonly #options: ReplayRunnerOptions;
  readonly #artifact: CapabilityArtifact;
  readonly #runtime: PlaywrightArtifactRuntime;
  readonly #policy: PolicyEngine;
  readonly #control: ControlCoordinator;
  readonly #operator: OperatorServer;
  readonly #runId: string;
  readonly #startedAt = now();
  readonly #journal: ActionJournalEntry[] = [];
  readonly #outputs = Object.create(null) as Record<string, string | number | boolean>;
  readonly #evidenceRefs: EvidenceRef[] = [];
  readonly #timeoutMs: number;
  readonly #deadline: number;

  constructor(options: ReplayRunnerOptions) {
    this.#options = options;
    this.#artifact = CapabilityArtifactSchema.parse(options.artifact);
    this.#runtime = new PlaywrightArtifactRuntime(options.surface, this.#artifact);
    // The reviewed artifact is the sole replay policy authority. Callers cannot
    // substitute a more permissive engine at runtime.
    this.#policy = new PolicyEngine(this.#artifact.policy);
    this.#runId = options.runId ?? options.recorder.runId;
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    this.#deadline = Date.now() + this.#timeoutMs;
    this.#control =
      options.control ??
      new ControlCoordinator({
        sessionId: options.surface.sessionId,
        eventSink: async (event) => {
          await options.recorder.record(event.type, event.data, { actor: event.actor });
        },
      });
    this.#operator =
      options.operatorServer ??
      new OperatorServer({ coordinator: this.#control, surface: options.surface });
    for (const [name, value] of Object.entries(options.inputs)) {
      const classification = this.#artifact.inputs.find((input) => input.name === name)?.classification;
      if (classification === "confidential" || classification === "restricted") {
        options.redactor.register(String(value));
      }
    }
  }

  async run(): Promise<RunResult> {
    await this.#options.recorder.record("replay.started", {
      runId: this.#runId,
      capabilityId: this.#artifact.capability.id,
      capabilityVersion: this.#artifact.capability.version,
      schemaVersion: this.#artifact.schemaVersion,
      sessionId: this.#options.surface.sessionId,
      sessionRef: this.#options.surface.sessionRef,
      plannerCallsAllowed: false,
      stepCount: this.#artifact.steps.length,
    }, { actor: "system" });

    try {
      const inputErrors = validateInputs(this.#artifact, this.#options.inputs);
      if (inputErrors.length > 0) {
        return await this.#failureWithoutSurfaceEvidence(
          "INPUT_INVALID",
          inputErrors.join("; "),
          undefined,
          "valid inputs",
          inputErrors.join("; "),
        );
      }
      const targetIds = new Set(this.#artifact.targets.map((target) => target.id));
      if (targetIds.size !== this.#artifact.targets.length) {
        return await this.#failureWithoutSurfaceEvidence(
          "ARTIFACT_INVALID",
          "Artifact contains duplicate target IDs.",
        );
      }

      await this.#assertNavigationScope();
      for (let index = 0; index < this.#artifact.steps.length; index += 1) {
        const step = this.#artifact.steps[index]!;
        if (Date.now() > this.#deadline) {
          return await this.#failureWithEvidence(
            "TIMEOUT",
            `Replay exceeded ${this.#timeoutMs}ms.`,
            step,
            "completion within the run time budget",
            "time budget exhausted",
          );
        }

        const state = await this.#detectDeclaredStates(step, index);
        if (state.kind === "business_outcome") {
          return await this.#businessOutcome(state.code!, state.message!);
        }
        if (state.kind === "failure") {
          return await this.#failureWithEvidence(
            state.code!,
            state.message!,
            step,
            "a permitted runtime state",
            state.message!,
          );
        }
        if (state.kind === "intervention") {
          const handedBack = await this.#handoff(step, state.code!, state.message!);
          if (!handedBack) {
            return await this.#failureWithEvidence(
              "INTERVENTION_TIMEOUT",
              "The human did not hand control back before the intervention timeout.",
              step,
            );
          }
        }

        const preconditionResult = await this.#evaluateAll(step.preconditions);
        if (!preconditionResult.matched) {
          return await this.#failureWithEvidence(
            "PRECONDITION_FAILED",
            `Precondition failed for ${step.id}: ${preconditionResult.summary}`,
            step,
            step.preconditions.map(conditionSummary).join(" and "),
            preconditionResult.summary,
          );
        }
        if (Date.now() > this.#deadline) {
          return await this.#failureWithEvidence(
            "TIMEOUT",
            `Replay exceeded ${this.#timeoutMs}ms after evaluating ${step.id} preconditions.`,
            step,
            "action start within the run time budget",
            "time budget exhausted",
          );
        }

        const outcome = await this.#executeStep(step, index + 1);
        if (outcome) return outcome;
      }

      const checkpoint = await this.#runtime.waitFor(
        this.#artifact.checkpoint,
        this.#options.inputs,
        this.#remainingMs(8_000),
      );
      if (!checkpoint.matched) {
        return await this.#failureWithEvidence(
          "CHECKPOINT_FAILED",
          checkpoint.summary,
          undefined,
          conditionSummary(this.#artifact.checkpoint),
          checkpoint.summary,
        );
      }
      for (const output of this.#artifact.outputs) {
        if (!Object.hasOwn(this.#outputs, output.name)) {
          return await this.#failureWithEvidence(
            "OUTPUT_MISSING",
            `Declared output ${output.name} was not extracted.`,
            undefined,
          );
        }
        if (output.classification === "confidential" || output.classification === "restricted") {
          this.#options.redactor.register(String(this.#outputs[output.name]!));
        }
      }
      const result: RunResult = {
        status: "success",
        runId: this.#runId,
        capabilityId: this.#artifact.capability.id,
        startedAt: this.#startedAt,
        completedAt: now(),
        journal: this.#journal,
        outputs: this.#outputs,
      };
      await this.#options.recorder.recordRunFinished({
        status: "success",
        mode: "replay",
        plannerCallCount: 0,
        outputNames: Object.keys(this.#outputs),
        checkpoint: checkpoint.summary,
      }, { actor: "system" });
      await this.#control.terminate();
      return result;
    } catch (error) {
      const code = error instanceof TargetResolutionError ? error.code : "SURFACE_ERROR";
      return await this.#failureWithEvidence(
        code,
        error instanceof Error ? error.message : String(error),
        undefined,
      );
    } finally {
      await this.#operator.close().catch(() => undefined);
    }
  }

  async #executeStep(step: Step, sequence: number): Promise<RunResult | undefined> {
    const startedAt = now();
    const fail = async (
      code: string,
      message: string,
      expected?: string,
      observed?: string,
    ): Promise<RunResult> => {
      this.#appendFailedJournal(step, sequence, startedAt, code);
      return await this.#failureWithEvidence(code, message, step, expected, observed);
    };
    let lastError: unknown;
    for (let attempt = 1; attempt <= step.retry.maxAttempts; attempt += 1) {
      try {
        if (step.risk === "irreversible") {
          await this.#options.recorder.recordPolicyDecision({
            stepId: step.id,
            allowed: false,
            reason: "Irreversible steps require a separate approval-token contract and are blocked in this build.",
          }, { actor: "system" });
          return fail(
            "APPROVAL_REQUIRED",
            `Irreversible step ${step.id} is blocked pending explicit human approval.`,
          );
        }
        const target = step.action.kind === "press" ? undefined : this.#runtime.getTarget(step.action.targetId);
        const policyRequest = {
          action: step.action.kind,
          ...(target ? { label: target.description, target: target.description } : {}),
          context: `artifact step ${step.id}; declared risk=${step.risk}`,
          stepId: step.id,
        };
        const policyEvaluation = this.#policy.evaluateAction(policyRequest);
        await this.#options.recorder.recordPolicyDecision({
          stepId: step.id,
          allowed: policyEvaluation.allowed,
          policyRisk: policyEvaluation.assessment.level,
          declaredRisk: step.risk,
          reason: policyEvaluation.reason,
        }, { actor: "system" });
        if (!policyEvaluation.allowed) {
          throw new PolicyViolationError(
            "ACTION_DENIED",
            policyEvaluation.reason,
            { decision: policyEvaluation },
          );
        }
        this.#control.assertLease(this.#control.automationLease());
        if (Date.now() > this.#deadline) {
          return fail(
            "TIMEOUT",
            `Replay exceeded ${this.#timeoutMs}ms before acting at ${step.id}.`,
            "action start within the run time budget",
            "time budget exhausted",
          );
        }
        const receipt = await this.#runtime.act(step.action, this.#options.inputs);
        await this.#assertNavigationScope();
        if (step.action.kind === "extract" && receipt.observedValue !== undefined) {
          const outputName = step.action.outputName;
          const outputSpec = this.#artifact.outputs.find((output) => output.name === outputName)!;
          this.#outputs[outputName] = parseOutputValue(outputSpec, receipt.observedValue);
          const classification = outputSpec.classification;
          if (classification === "confidential" || classification === "restricted") {
            this.#options.redactor.register(receipt.observedValue);
          }
        }
        const postcondition = await this.#runtime.waitFor(
          step.postcondition,
          this.#options.inputs,
          this.#remainingMs(step.timeoutMs),
        );
        if (!postcondition.matched) {
          throw new Error(`Postcondition did not match: ${postcondition.summary}`);
        }
        this.#journal.push({
          sequence,
          stepId: step.id,
          action: step.action,
          status: "succeeded",
          startedAt,
          completedAt: now(),
          summary: `Attempt ${attempt}; ${postcondition.summary}`,
          evidencePaths: [],
        });
        await this.#options.recorder.recordAction({
          mode: "replay",
          stepId: step.id,
          attempt,
          action: step.action.kind,
          valueSource:
            step.action.kind === "fill" || step.action.kind === "select"
              ? step.action.value.kind
              : null,
          targetId: step.action.kind === "press" ? null : step.action.targetId,
          outputName: step.action.kind === "extract" ? step.action.outputName : null,
          strategy: receipt.strategy,
          resolutionAttempts: receipt.attempts,
          postcondition: postcondition.summary,
          plannerCallCount: 0,
        }, { actor: "automation" });
        return undefined;
      } catch (error) {
        lastError = error;
        if (error instanceof PolicyViolationError) {
          return fail(error.code, error.message);
        }
        if (error instanceof OutputTypeError) {
          return fail(
            "OUTPUT_TYPE_MISMATCH",
            error.message,
            `declared type for ${error.outputName}`,
            "extracted value had a different shape",
          );
        }
        const state = await this.#detectDeclaredStates(step, sequence - 1);
        if (state.kind === "business_outcome") {
          return await this.#businessOutcome(state.code!, state.message!);
        }
        if (state.kind === "failure") {
          return fail(state.code!, state.message!);
        }
        if (state.kind === "intervention") {
          const handedBack = await this.#handoff(step, state.code!, state.message!);
          if (!handedBack) return fail("INTERVENTION_TIMEOUT", state.message!);
          const reconciledPostcondition = await this.#runtime.evaluate(
            step.postcondition,
            this.#options.inputs,
          );
          if (reconciledPostcondition.matched) {
            this.#journal.push({
              sequence,
              stepId: step.id,
              action: step.action,
              status: "succeeded",
              startedAt,
              completedAt: now(),
              summary: `Human handoff satisfied the pending postcondition: ${reconciledPostcondition.summary}`,
              evidencePaths: [],
            });
            await this.#options.recorder.recordAction({
              mode: "replay",
              stepId: step.id,
              action: step.action.kind,
              completedBy: "human-handoff",
              postcondition: reconciledPostcondition.summary,
              plannerCallCount: 0,
            }, { actor: "automation" });
            return undefined;
          }
          const reconciledPreconditions = await this.#evaluateAll(step.preconditions);
          if (reconciledPreconditions.matched && step.risk !== "irreversible") {
            attempt -= 1;
            continue;
          }
          return fail(
            "HANDOFF_RECONCILIATION_FAILED",
            "After handoff, neither the pending postcondition nor the step preconditions matched.",
            `${conditionSummary(step.postcondition)} or valid preconditions`,
            `${reconciledPostcondition.summary}; ${reconciledPreconditions.summary}`,
          );
        }
        const retrySafe =
          step.risk !== "irreversible" &&
          step.action.kind !== "click" &&
          step.action.kind !== "press";
        if (!retrySafe || attempt >= step.retry.maxAttempts) break;
        await new Promise<void>((resolve) => setTimeout(resolve, step.retry.backoffMs));
      }
    }
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    return fail(
      "RECOVERY_EXHAUSTED",
      `Step ${step.id} failed after ${step.retry.maxAttempts} attempt(s): ${message}`,
      conditionSummary(step.postcondition),
      message,
    );
  }

  async #detectDeclaredStates(step: Step, _index: number): Promise<DetectedState> {
    for (const outcome of this.#artifact.businessOutcomes) {
      const result = await this.#runtime.evaluate(outcome.condition, this.#options.inputs);
      if (result.matched) {
        await this.#options.recorder.record("state.business-outcome", {
          code: outcome.code,
          stepId: step.id,
          condition: result.summary,
        }, { actor: "automation" });
        return { kind: "business_outcome", code: outcome.code, message: outcome.description };
      }
    }
    for (const exception of this.#artifact.exceptions) {
      const result = await this.#runtime.evaluate(exception.condition, this.#options.inputs);
      if (result.matched) {
        return {
          kind: exception.disposition === "intervention" ? "intervention" : "failure",
          code: exception.code,
          message: exception.description,
        };
      }
    }
    for (const recovery of this.#artifact.recoveries) {
      const result = await this.#runtime.evaluate(recovery.condition, this.#options.inputs);
      if (!result.matched) continue;
      let recovered = false;
      for (let attempt = 1; attempt <= recovery.maxAttempts; attempt += 1) {
        try {
          if (Date.now() > this.#deadline) throw new Error("Run deadline exceeded during recovery");
          if (recovery.strategy === "wait") {
            await this.#options.surface.waitUntilReady(this.#remainingMs(8_000));
          } else if (recovery.action) {
            const target = recovery.action.kind === "press"
              ? undefined
              : this.#runtime.getTarget(recovery.action.targetId);
            const decision = this.#policy.evaluateAction({
              action: recovery.action.kind,
              ...(target ? { label: target.description, target: target.description } : {}),
              context: `declared recovery ${recovery.code}`,
            });
            await this.#options.recorder.recordPolicyDecision({
              recoveryCode: recovery.code,
              allowed: decision.allowed,
              risk: decision.assessment.level,
              reason: decision.reason,
            }, { actor: "system" });
            if (!decision.allowed) throw new Error(decision.reason);
            this.#control.assertLease(this.#control.automationLease());
            await this.#runtime.act(recovery.action, this.#options.inputs);
            await this.#assertNavigationScope();
          }
          const stillPresent = await this.#runtime.evaluate(recovery.condition, this.#options.inputs);
          recovered = !stillPresent.matched;
        } catch (error) {
          await this.#options.recorder.record("recovery.error", {
            code: recovery.code,
            stepId: step.id,
            attempt,
            error: error instanceof Error ? error.message : String(error),
          }, { actor: "runtime" });
        }
        await this.#options.recorder.record("recovery.attempted", {
          code: recovery.code,
          stepId: step.id,
          attempt,
          strategy: recovery.strategy,
          recovered,
        }, { actor: "automation" });
        if (recovered) return { kind: "recovered", code: recovery.code, message: recovery.description };
      }
      return {
        kind: "failure",
        code: "RECOVERY_EXHAUSTED",
        message: `Declared recovery ${recovery.code} remained active after ${recovery.maxAttempts} attempt(s).`,
      };
    }
    return { kind: "none" };
  }

  async #handoff(step: Step, code: string, message: string): Promise<boolean> {
    const screenshot = await this.#captureFailureEvidence(`intervention-${step.id}`);
    const context: InterventionContext = {
      runId: this.#runId,
      capabilityId: this.#artifact.capability.id,
      goal: this.#artifact.provenance.goal,
      stepId: step.id,
      reasonCode: code,
      reason: message,
      screenshotPath: screenshot?.path ?? "unavailable",
      observedState: `Declared exception ${code} matched in sessionRef ${this.#options.surface.sessionRef}.`,
    };
    await this.#control.requestIntervention(context);
    const baseUrl = await this.#operator.start();
    await this.#options.recorder.record("operator.available", {
      interventionId: this.#control.intervention?.interventionId,
      sessionId: this.#options.surface.sessionId,
      sessionRef: this.#options.surface.sessionRef,
      operatorUrl: baseUrl,
    }, { actor: "system" });
    this.#options.onOperatorAvailable?.(baseUrl);
    if (this.#options.autoHandoff) await this.#options.autoHandoff(baseUrl);
    try {
      await this.#control.waitForAutomation(this.#remainingMs(60_000));
      await this.#assertNavigationScope();
      const reconciled = await this.#runtime.evaluate(step.preconditions[0] ?? step.postcondition, this.#options.inputs);
      await this.#options.recorder.record("handoff.reconciled", {
        stepId: step.id,
        sessionId: this.#options.surface.sessionId,
        sessionRef: this.#options.surface.sessionRef,
        result: reconciled.summary,
      }, { actor: "automation" });
      return true;
    } catch {
      return false;
    }
  }

  async #evaluateAll(conditions: Condition[]) {
    if (conditions.length === 0) return { matched: true, summary: "No preconditions declared." };
    const results = [];
    for (const condition of conditions) {
      results.push(await this.#runtime.evaluate(condition, this.#options.inputs));
    }
    const failed = results.filter((result) => !result.matched);
    return {
      matched: failed.length === 0,
      summary:
        failed.length === 0
          ? `All ${results.length} preconditions matched.`
          : failed.map((result) => result.summary).join("; "),
    };
  }

  #appendFailedJournal(
    step: Step,
    sequence: number,
    startedAt: string,
    code: string,
  ): void {
    if (this.#journal.some((entry) => entry.sequence === sequence)) return;
    this.#journal.push({
      sequence,
      stepId: step.id,
      action: step.action,
      status: "failed",
      startedAt,
      completedAt: now(),
      summary: `Terminal step outcome: ${code}.`,
      evidencePaths: [],
    });
  }

  #remainingMs(capMs: number): number {
    return Math.max(1, Math.min(capMs, this.#deadline - Date.now()));
  }

  async #assertNavigationScope(): Promise<void> {
    const main = this.#options.surface.page.mainFrame();
    for (const frame of this.#options.surface.page.frames()) {
      const url = frame.url();
      if (url === "about:blank") continue;
      this.#policy.assertNavigationAllowed({
        url,
        kind: frame === main ? "direct" : "frame",
      });
    }
  }

  async #businessOutcome(code: string, message: string): Promise<RunResult> {
    const result: RunResult = {
      status: "business_outcome",
      runId: this.#runId,
      capabilityId: this.#artifact.capability.id,
      startedAt: this.#startedAt,
      completedAt: now(),
      journal: this.#journal,
      code,
      message,
    };
    await this.#options.recorder.recordRunFinished({
      status: "business_outcome",
      mode: "replay",
      code,
      plannerCallCount: 0,
    }, { actor: "system" });
    await this.#control.terminate();
    return result;
  }

  #failure(
    code: string,
    message: string,
    step?: Step,
    expected?: string,
    observed?: string,
    evidencePaths: string[] = [],
  ): RunResult {
    return {
      status: "failure",
      runId: this.#runId,
      capabilityId: this.#artifact.capability.id,
      startedAt: this.#startedAt,
      completedAt: now(),
      journal: this.#journal,
      code,
      message,
      ...(step ? { stepId: step.id } : {}),
      ...(expected ? { expected } : {}),
      ...(observed ? { observed } : {}),
      retryable: false,
      evidencePaths,
    };
  }

  async #failureWithoutSurfaceEvidence(
    code: string,
    message: string,
    step?: Step,
    expected?: string,
    observed?: string,
  ): Promise<RunResult> {
    const result = this.#failure(code, message, step, expected, observed);
    await this.#options.recorder.recordRunFinished({
      status: "failure",
      mode: "replay",
      code,
      message,
      stepId: step?.id,
      expected,
      observed,
      plannerCallCount: 0,
      evidencePaths: [],
    }, { actor: "system" });
    await this.#control.terminate();
    return result;
  }

  async #failureWithEvidence(
    code: string,
    message: string,
    step?: Step,
    expected?: string,
    observed?: string,
  ): Promise<RunResult> {
    const screenshot = await this.#captureFailureEvidence(`failure-${code.toLocaleLowerCase()}`);
    try {
      const dom = await this.#options.evidence.saveDomSnapshot(
        `failure-${code.toLocaleLowerCase()}`,
        await this.#options.surface.domSnapshot(),
      );
      this.#evidenceRefs.push(dom);
    } catch (error) {
      await this.#options.recorder.recordError(error, { phase: "dom-evidence", code }, { actor: "runtime" });
    }
    const evidencePaths = this.#evidenceRefs.map((reference) => reference.path);
    if (step) {
      const failedEntry = [...this.#journal]
        .reverse()
        .find((entry) => entry.stepId === step.id && entry.status === "failed");
      if (failedEntry) failedEntry.evidencePaths.push(...evidencePaths);
    }
    const result = this.#failure(code, message, step, expected, observed, evidencePaths);
    await this.#options.recorder.recordRunFinished({
      status: "failure",
      mode: "replay",
      code,
      message,
      stepId: step?.id,
      expected,
      observed,
      plannerCallCount: 0,
      evidencePaths,
      screenshot: screenshot?.path,
    }, { actor: "system" });
    await this.#control.terminate();
    return result;
  }

  async #captureFailureEvidence(name: string): Promise<EvidenceRef | undefined> {
    try {
      const bytes = await this.#options.surface.captureMaskedScreenshot();
      const ref = await this.#options.evidence.saveMaskedScreenshot(name, bytes, { masked: true });
      this.#evidenceRefs.push(ref);
      return ref;
    } catch (error) {
      await this.#options.recorder.recordError(error, {
        phase: "failure-evidence",
        requestedName: path.basename(name),
      }, { actor: "runtime" });
      return undefined;
    }
  }
}
