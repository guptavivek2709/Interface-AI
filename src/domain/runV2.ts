import type { ActionV2, ApprovalRequirementV2, StepEffectV2 } from "./capabilityV2.js";

export type RunValueV2 = null | boolean | number | string | RunValueV2[] | { [key: string]: RunValueV2 };

export type RunPhaseV2 =
  | "queued"
  | "running"
  | "recovering"
  | "awaiting_approval"
  | "awaiting_human"
  | "completed";

export interface RunJournalEntryV2 {
  sequence: number;
  stepId: string;
  title: string;
  action: ActionV2["kind"];
  effect: StepEffectV2;
  attempt: number;
  status: "started" | "succeeded" | "failed";
  startedAt: string;
  completedAt?: string;
  summary?: string;
  evidencePaths: string[];
}

export interface RunIncidentV2 {
  code: string;
  category: "recoverable" | "failure" | "escalation" | "intervention";
  message: string;
  stepId?: string;
  occurredAt: string;
  recoveryAttempt?: number;
}

export interface HumanInterventionV2 {
  interventionId: string;
  runId: string;
  stepId: string;
  reasonCode: string;
  action: "restore_session" | "authenticate_supervisor";
  requiredRole?: string;
  state: "awaiting_human" | "human_active" | "action_completed" | "revalidating";
  createdAt: string;
  expiresAt: string;
  sameLiveSession: true;
}

export interface ApprovalSummaryItemV2 {
  targetId: string;
  value: RunValueV2;
  sensitive: boolean;
}

export interface ApprovalChallengeV2 {
  challengeId: string;
  runId: string;
  stepId: string;
  stepTitle: string;
  requirement: ApprovalRequirementV2["kind"];
  expiresInMs: number;
  createdAt: string;
  expiresAt: string;
  summary: ApprovalSummaryItemV2[];
}

interface RunResultBaseV2 {
  runId: string;
  capabilityId: string;
  capabilityVersion: string;
  artifactDigest: string;
  /** Deployment profile bound independently from the reusable vendor artifact. */
  targetProfileDigest?: string;
  inputDigest: string;
  sessionRef: string;
  startedAt: string;
  completedAt: string;
  journal: RunJournalEntryV2[];
  incidents: RunIncidentV2[];
  evidencePaths: string[];
}

export type TerminalRunResultV2 =
  | (RunResultBaseV2 & { status: "success"; outputs: Record<string, RunValueV2> })
  | (RunResultBaseV2 & { status: "business_outcome"; code: string; message: string })
  | (RunResultBaseV2 & {
      status: "failure";
      code: string;
      message: string;
      retryable: boolean;
      stepId?: string;
      effectUncertain: boolean;
      /** Typed, already-extracted pre-commit markers available only for read-only reconciliation. */
      reconciliationOutputs?: Record<string, RunValueV2>;
    })
  | (RunResultBaseV2 & {
      status: "escalation";
      code: string;
      message: string;
      requiredRole?: string;
      stepId?: string;
    });

export type ReplayProgressV2 =
  | {
      status: "awaiting_approval";
      phase: "awaiting_approval";
      challenge: ApprovalChallengeV2;
      journal: RunJournalEntryV2[];
      incidents: RunIncidentV2[];
    }
  | {
      status: "awaiting_human";
      phase: "awaiting_human";
      intervention: HumanInterventionV2;
      journal: RunJournalEntryV2[];
      incidents: RunIncidentV2[];
    }
  | { status: "terminal"; phase: "completed"; result: TerminalRunResultV2 };
