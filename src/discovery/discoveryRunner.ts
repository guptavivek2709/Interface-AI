import { randomUUID } from "node:crypto";
import path from "node:path";
import type { EventRecorder } from "../evidence/event-recorder.js";
import {
  ControlCoordinator,
  type InterventionContext,
} from "../handoff/controlCoordinator.js";
import { OperatorServer } from "../handoff/operatorServer.js";
import type { Planner, PlannerAction, PlannerHistoryEntry } from "../model/planner.js";
import type { PolicyEngine } from "../safety/policy.js";
import type { Redactor } from "../safety/redactor.js";
import type { DiscoverySurface, ObservedControl, SurfaceObservation } from "../surface/types.js";

export interface DiscoveryJournalEntry {
  step: number;
  plannerReason: string;
  plannerProvider: string;
  plannerModel: string;
  plannerResponseId: string | null;
  plannerLatencyMs: number;
  action: PlannerAction;
  risk: "safe" | "reversible" | "irreversible";
  target: ObservedControl | null;
  beforeStateHash: string;
  afterStateHash: string;
  beforeHeadings: string[];
  afterHeadings: string[];
  result: "completed";
  outputValue?: string;
}

export interface DiscoverySuccess {
  kind: "success";
  runId: string;
  goal: string;
  sessionId: string;
  sessionRef: string;
  planner: { provider: string; model: string; callCount: number };
  checkpointText: string;
  outputs: Record<string, string>;
  journal: DiscoveryJournalEntry[];
  finalObservation: SurfaceObservation;
}

export interface DiscoveryFailure {
  kind: "failure";
  runId: string;
  code:
    | "MAX_STEPS"
    | "TIMEOUT"
    | "MODEL_ESCALATED"
    | "POLICY_DENIED"
    | "INTERVENTION_TIMEOUT"
    | "STUCK"
    | "CHECKPOINT_FAILED"
    | "ERROR";
  message: string;
  journal: DiscoveryJournalEntry[];
  observation?: SurfaceObservation;
}

export type DiscoveryResult = DiscoverySuccess | DiscoveryFailure;

export interface DiscoveryRunnerOptions {
  surface: DiscoverySurface;
  planner: Planner;
  policy: PolicyEngine;
  recorder: EventRecorder;
  redactor: Redactor;
  goal: string;
  inputs: Record<string, string | number | boolean>;
  maxSteps?: number;
  timeoutMs?: number;
  runId?: string;
  control?: ControlCoordinator;
  operatorServer?: OperatorServer;
  autoHandoff?: (operatorUrl: string) => Promise<void>;
  onOperatorAvailable?: (operatorUrl: string) => void;
}

function safeControl(control: ObservedControl | null): Record<string, unknown> | null {
  if (!control) return null;
  return {
    ref: control.ref,
    framePath: control.framePath,
    role: control.role,
    name: control.name,
    label: control.label,
    nameAttribute: control.nameAttribute,
    disabled: control.disabled,
  };
}

export class DiscoveryRunner {
  readonly #options: Required<Pick<DiscoveryRunnerOptions, "maxSteps" | "timeoutMs">> &
    DiscoveryRunnerOptions;
  readonly #control: ControlCoordinator;
  readonly #operator: OperatorServer;
  #handoffCount = 0;

  constructor(options: DiscoveryRunnerOptions) {
    this.#options = {
      ...options,
      maxSteps: options.maxSteps ?? 24,
      timeoutMs: options.timeoutMs ?? 180_000,
    };
    this.#options.redactor.registerMany(
      Object.values(options.inputs).map((value) => String(value)),
    );
    this.#control =
      options.control ??
      new ControlCoordinator({
        sessionId: options.surface.sessionId,
        automationId: "discovery-engine",
        eventSink: async (event) => {
          await options.recorder.record(event.type, event.data, { actor: event.actor });
        },
      });
    this.#operator =
      options.operatorServer ??
      new OperatorServer({ coordinator: this.#control, surface: options.surface });
  }

  async run(): Promise<DiscoveryResult> {
    const runId = this.#options.runId ?? this.#options.recorder.runId ?? randomUUID();
    const started = Date.now();
    const journal: DiscoveryJournalEntry[] = [];
    const history: PlannerHistoryEntry[] = [];
    const outputs = Object.create(null) as Record<string, string>;
    let plannerCallCount = 0;
    let lastObservation: SurfaceObservation | undefined;
    let unchangedDecisions = 0;

    await this.#options.recorder.record("discovery.started", {
      runId,
      goal: this.#options.goal,
      sessionId: this.#options.surface.sessionId,
      sessionRef: this.#options.surface.sessionRef,
      planner: { provider: this.#options.planner.name, model: this.#options.planner.model },
      limits: { maxSteps: this.#options.maxSteps, timeoutMs: this.#options.timeoutMs },
    }, { actor: "agent" });

    try {
      for (let step = 1; step <= this.#options.maxSteps; step += 1) {
        if (Date.now() - started > this.#options.timeoutMs) {
          return await this.#failure(runId, "TIMEOUT", "Discovery exceeded its time budget.", journal, lastObservation);
        }

        const observation = await this.#options.surface.observe();
        lastObservation = observation;
        await this.#options.recorder.recordObservation({
          mode: "discovery",
          step,
          url: observation.url,
          title: observation.title,
          stateHash: observation.stateHash,
          frames: observation.frames.map((frame) => ({
            framePath: frame.framePath,
            url: frame.url,
            headings: frame.headings,
          })),
          controls: observation.controls.map(safeControl),
          screenshotPath: path.basename(observation.screenshotPath),
        }, { actor: "runtime" });

        plannerCallCount += 1;
        const response = await this.#options.planner.decide({
          goal: this.#options.goal,
          inputs: this.#options.inputs,
          observation,
          history,
          maxSteps: this.#options.maxSteps,
          currentStep: step,
        });
        const decision = response.decision;
        await this.#options.recorder.record("model.decision", {
          step,
          provider: response.metadata.provider,
          model: response.metadata.model,
          responseId: response.metadata.responseId,
          latencyMs: response.metadata.latencyMs,
          decision: decision.decision,
          reason: decision.reason,
          action: decision.action,
          checkpointText: decision.checkpointText,
          escalationReason: decision.escalationReason,
        }, { actor: "agent" });

        if (decision.decision === "escalate") {
          if (await this.#handoff(runId, step, decision.escalationReason ?? "MODEL_ESCALATED", decision.reason, observation)) {
            history.push({
              step,
              decision: "escalate",
              actionKind: null,
              targetName: null,
              outputName: null,
              result: "human-resolved-same-session",
            });
            unchangedDecisions = 0;
            continue;
          }
          return await this.#failure(runId, this.#handoffCount > 0 ? "INTERVENTION_TIMEOUT" : "MODEL_ESCALATED", decision.escalationReason ?? decision.reason, journal, observation);
        }
        if (decision.decision === "finish") {
          const declaredCheckpoint = decision.checkpointText ?? "";
          const normalizedDeclared = declaredCheckpoint.toLocaleLowerCase();
          const exactVisible = observation.visibleText
            .toLocaleLowerCase()
            .includes(normalizedDeclared);
          const verifiedHeading = observation.frames
            .flatMap((frame) => frame.headings)
            .filter(
              (heading) =>
                normalizedDeclared.includes(heading.toLocaleLowerCase()) &&
                observation.visibleText.toLocaleLowerCase().includes(heading.toLocaleLowerCase()),
            )
            .sort((left, right) => right.length - left.length)[0];
          const checkpoint = exactVisible ? declaredCheckpoint : verifiedHeading;
          if (!checkpoint) {
            return await this.#failure(
              runId,
              "CHECKPOINT_FAILED",
              `Planner declared completion but checkpoint ${JSON.stringify(declaredCheckpoint)} was not visible or grounded in a visible heading.`,
              journal,
              observation,
            );
          }
          await this.#options.recorder.record("checkpoint.verified", {
            step,
            declaredCheckpoint,
            verifiedCheckpoint: checkpoint,
            canonicalizedToHeading: checkpoint !== declaredCheckpoint,
          }, { actor: "runtime" });
          const result: DiscoverySuccess = {
            kind: "success",
            runId,
            goal: this.#options.goal,
            sessionId: this.#options.surface.sessionId,
            sessionRef: this.#options.surface.sessionRef,
            planner: {
              provider: this.#options.planner.name,
              model: this.#options.planner.model,
              callCount: plannerCallCount,
            },
            checkpointText: checkpoint,
            outputs,
            journal,
            finalObservation: observation,
          };
          await this.#options.recorder.recordRunFinished({
            kind: "success",
            mode: "discovery",
            runId,
            checkpoint,
            outputNames: Object.keys(outputs),
            plannerCallCount,
            actionCount: journal.length,
          }, { actor: "system" });
          await this.#control.terminate();
          return result;
        }

        const action = decision.action!;
        const target = action.targetRef
          ? observation.controls.find((control) => control.ref === action.targetRef) ?? null
          : null;
        const policyDecision = this.#options.policy.evaluateAction({
          action: action.kind,
          ...(target?.name ? { label: target.name, target: target.name } : {}),
          context: action.value?.kind === "input" ? "parameterized caller input" : "literal UI action",
          stepId: `discovery-${step}`,
        });
        await this.#options.recorder.recordPolicyDecision({
          step,
          action: action.kind,
          allowed: policyDecision.allowed,
          risk: policyDecision.assessment.level,
          reason: policyDecision.reason,
        }, { actor: "system" });
        if (!policyDecision.allowed) {
          const resumed = await this.#handoff(
            runId,
            step,
            "POLICY_DENIED",
            policyDecision.reason,
            observation,
          );
          if (resumed) continue;
          return await this.#failure(
            runId,
            this.#handoffCount > 0 ? "INTERVENTION_TIMEOUT" : "POLICY_DENIED",
            policyDecision.reason,
            journal,
            observation,
          );
        }

        this.#control.assertLease(this.#control.automationLease());
        const receipt = await this.#options.surface.actFromObservation(
          action,
          observation,
          this.#options.inputs,
        );
        if (action.kind === "extract" && action.outputName && receipt.observedValue !== undefined) {
          outputs[action.outputName] = receipt.observedValue;
          this.#options.redactor.register(receipt.observedValue);
        }
        const after = await this.#options.surface.observe();
        if (after.stateHash === observation.stateHash && action.kind !== "extract") {
          unchangedDecisions += 1;
        } else {
          unchangedDecisions = 0;
        }
        const journalEntry: DiscoveryJournalEntry = {
          step,
          plannerReason: decision.reason,
          plannerProvider: response.metadata.provider,
          plannerModel: response.metadata.model,
          plannerResponseId: response.metadata.responseId,
          plannerLatencyMs: response.metadata.latencyMs,
          action,
          risk:
            policyDecision.assessment.level === "low"
              ? "safe"
              : policyDecision.assessment.level === "medium"
                ? "reversible"
                : "irreversible",
          target,
          beforeStateHash: observation.stateHash,
          afterStateHash: after.stateHash,
          beforeHeadings: observation.frames.flatMap((frame) => frame.headings),
          afterHeadings: after.frames.flatMap((frame) => frame.headings),
          result: "completed",
          ...(receipt.observedValue === undefined ? {} : { outputValue: receipt.observedValue }),
        };
        journal.push(journalEntry);
        history.push({
          step,
          decision: "act",
          actionKind: action.kind,
          targetName: target?.name ?? null,
          outputName: action.outputName,
          result: "completed",
        });
        await this.#options.recorder.recordAction({
          mode: "discovery",
          step,
          reason: decision.reason,
          action: action.kind,
          target: safeControl(target),
          valueSource: action.value?.kind ?? null,
          inputName: action.value?.kind === "input" ? action.value.name : null,
          outputName: action.outputName,
          beforeStateHash: observation.stateHash,
          afterStateHash: after.stateHash,
          receipt,
        }, { actor: "agent" });
        if (unchangedDecisions >= 3) {
          if (await this.#handoff(runId, step, "STUCK", "Three consecutive actions left the observable UI unchanged.", after)) {
            unchangedDecisions = 0;
            lastObservation = after;
            continue;
          }
          return await this.#failure(
            runId,
            "STUCK",
            "Three consecutive actions left the observable UI unchanged.",
            journal,
            after,
          );
        }
        lastObservation = after;
      }
      return await this.#failure(runId, "MAX_STEPS", "Discovery reached its maximum step count.", journal, lastObservation);
    } catch (error) {
      await this.#options.recorder.recordError(error, { mode: "discovery", runId }, { actor: "runtime" });
      return await this.#failure(
        runId,
        "ERROR",
        error instanceof Error ? error.message : String(error),
        journal,
        lastObservation,
      );
    } finally {
      await this.#operator.close().catch(() => undefined);
    }
  }

  async #handoff(
    runId: string,
    step: number,
    reasonCode: string,
    reason: string,
    observation: SurfaceObservation,
  ): Promise<boolean> {
    if (this.#handoffCount >= 1) return false;
    this.#handoffCount += 1;
    const context: InterventionContext = {
      runId,
      capabilityId: "discovery:uncompiled",
      goal: this.#options.goal,
      stepId: `discovery-${step}`,
      reasonCode,
      reason,
      screenshotPath: path.basename(observation.screenshotPath),
      observedState: `state=${observation.stateHash}; headings=${observation.frames.flatMap((frame) => frame.headings).join(" | ")}`,
    };
    await this.#control.requestIntervention(context);
    const operatorUrl = await this.#operator.start();
    await this.#options.recorder.record("operator.available", {
      interventionId: this.#control.intervention?.interventionId,
      sessionId: this.#options.surface.sessionId,
      sessionRef: this.#options.surface.sessionRef,
      operatorUrl,
    }, { actor: "system" });
    this.#options.onOperatorAvailable?.(operatorUrl);
    if (this.#options.autoHandoff) await this.#options.autoHandoff(operatorUrl);
    const remaining = Math.max(1, Math.min(60_000, this.#options.timeoutMs));
    try {
      await this.#control.waitForAutomation(remaining);
      const reconciled = await this.#options.surface.observe();
      await this.#options.recorder.record("handoff.reconciled", {
        mode: "discovery",
        step,
        sessionId: this.#options.surface.sessionId,
        sessionRef: this.#options.surface.sessionRef,
        beforeStateHash: observation.stateHash,
        afterStateHash: reconciled.stateHash,
      }, { actor: "automation" });
      return true;
    } catch {
      return false;
    }
  }

  async #failure(
    runId: string,
    code: DiscoveryFailure["code"],
    message: string,
    journal: DiscoveryJournalEntry[],
    observation?: SurfaceObservation,
  ): Promise<DiscoveryFailure> {
    await this.#options.recorder.recordRunFinished({
      kind: "failure",
      mode: "discovery",
      runId,
      code,
      message,
      actionCount: journal.length,
      ...(observation
        ? { stateHash: observation.stateHash, screenshotPath: path.basename(observation.screenshotPath) }
        : {}),
    }, { actor: "system" });
    await this.#control.terminate();
    return {
      kind: "failure",
      runId,
      code,
      message,
      journal,
      ...(observation ? { observation } : {}),
    };
  }
}
