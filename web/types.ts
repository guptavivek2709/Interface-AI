export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type RiskLevel = "read" | "write" | "irreversible" | "supervisor_only";

export interface FieldType {
  kind: "string" | "number" | "boolean" | "money" | "object" | "array";
  format?: string;
  enum?: JsonValue[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  integer?: boolean;
  currency?: string;
  minimumMinorUnits?: number;
  maximumMinorUnits?: number;
  properties?: Record<string, FieldType>;
  required?: string[];
  items?: FieldType;
  maxItems?: number;
}

export interface CapabilityField {
  name: string;
  description: string;
  type: FieldType;
  required: boolean;
  classification: string;
}

export interface CapabilityLineage {
  lineageId: string;
  discoveryRunId: string;
  provider: "anthropic-messages";
  model: string;
  traceDigest: string;
  draftDigest: string;
  reviewedDigest: string;
  approvedDigest: string;
  canaryRunId: string;
}

export interface Capability {
  id: string;
  name: string;
  description: string;
  version: string;
  schemaVersion: string;
  approval: string;
  risk: RiskLevel;
  tags: string[];
  inputs: CapabilityField[];
  outputs: CapabilityField[];
  digest: string;
  /** Immutable digest of the exact target profile reviewed with this catalog entry. */
  targetProfileDigest: string;
  /** Digest-bound discovery, review, canary, and publication chain. */
  lineage?: CapabilityLineage;
  /** False when the wire contract was incomplete or structurally unsupported. */
  contractValid: boolean;
  /** True only for a reviewed same-live-session supervisor escalation path. */
  supportsSupervisorHandoff: boolean;
}

export type DiscoveryRunStatus = "draft" | "reviewed" | "canary_passed" | "approved";

export interface DiscoveryRunInput extends CapabilityField {
  /** Discovery invocation values are deliberately never persisted or returned. */
  valueStatus: "withheld";
}

export interface DiscoveryRunTimelineEvent {
  type: "draft_created" | "reviewed" | "canary_passed" | "approved";
  at: string;
  actor: string;
  artifactDigest: string;
  parentArtifactDigest?: string;
  traceDigest?: string;
  reviewDiffDigest?: string;
  changedPathCount?: number;
  canaryRunId?: string;
  evidenceDigest?: string;
}

export interface DiscoveryRunOutput {
  traceDigest: string;
  draftDigest: string;
  reviewedDigest: string;
  approvedDigest: string;
  canaryRunId: string;
}

export interface DiscoveryEvidenceReference {
  kind: "artifact" | "lineage" | "canary";
  label: string;
  sha256: string;
  /** Authenticated same-origin projection of the validated persisted record. */
  href?: string;
}

/**
 * Read-only projection of one genuine model discovery and its external
 * promotion lineage. It is not a replay record or a fabricated run.
 */
export interface DiscoveryRunRecord {
  kind: "discovery";
  id: string;
  discoveryRunId: string;
  capabilityId: string;
  capabilityVersion: string;
  capabilityName: string;
  goal: string;
  createdAt: string;
  completedAt: string;
  status: DiscoveryRunStatus;
  provider: "anthropic-messages";
  model: string;
  inputs: DiscoveryRunInput[];
  outputContract: CapabilityField[];
  output: DiscoveryRunOutput;
  timeline: DiscoveryRunTimelineEvent[];
  evidence: DiscoveryEvidenceReference[];
}

export type RunPhase =
  | "queued"
  | "running"
  | "recovering"
  | "awaiting_approval"
  | "awaiting_human"
  | "completed";

export type TerminalStatus = "success" | "business_outcome" | "failure" | "escalation";

export interface RunJournalEntry {
  sequence: number;
  stepId: string;
  title: string;
  action: string;
  effect: string;
  attempt: number;
  status: "started" | "succeeded" | "failed";
  startedAt: string;
  completedAt?: string;
  summary?: string;
}

export interface RunIncident {
  code: string;
  category: "recoverable" | "failure" | "escalation" | "intervention";
  message: string;
  stepId?: string;
  occurredAt: string;
  recoveryAttempt?: number;
}

export interface ApprovalSummaryItem {
  targetId: string;
  value: JsonValue;
  sensitive: boolean;
  /** True only when the API supplied an explicitly authorized display projection. */
  reviewable: boolean;
}

export interface ApprovalChallenge {
  challengeId: string;
  runId: string;
  stepId: string;
  stepTitle: string;
  requirement: "user_confirmation" | "supervisor_confirmation";
  createdAt: string;
  expiresAt: string;
  summary: ApprovalSummaryItem[];
  /** Server-derived authority for this principal and retained target session. */
  authorized: boolean;
}

export interface HumanIntervention {
  interventionId: string;
  runId: string;
  stepId: string;
  reasonCode: string;
  action: "restore_session" | "authenticate_supervisor";
  state: "awaiting_human" | "human_active" | "action_completed" | "revalidating";
  createdAt: string;
  expiresAt: string;
  sameLiveSession: true;
  requiredRole?: string;
}

export type RunOrchestration =
  | {
      kind: "chat_sequence";
      sequenceId: string;
      stepId: string;
      stepIndex: number;
      stepCount: number;
      parentRunId?: string;
    }
  | {
      kind: "reconciliation";
      sourceRunId: string;
    };

export interface ReconciliationDecision {
  classification: "applied" | "not_applied" | "still_unknown";
  reason: string;
  checkedFields: string[];
}

export interface ReconciliationRecord {
  sourceRunId: string;
  runId?: string;
  status: "not_started" | "running" | "running_or_complete" | "complete";
  decision?: ReconciliationDecision;
}

export interface RunRecord {
  id: string;
  capabilityId: string;
  capabilityVersion: string;
  artifactDigest?: string;
  targetProfileDigest?: string;
  revision?: number;
  lastEventId?: number;
  phase: RunPhase;
  terminalStatus?: TerminalStatus;
  code?: string;
  message?: string;
  retryable?: boolean;
  effectUncertain?: boolean;
  createdAt?: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt?: string;
  inputs?: Record<string, JsonValue>;
  outputs?: Record<string, JsonValue>;
  outputsDisplaySafe?: boolean;
  journal: RunJournalEntry[];
  incidents: RunIncident[];
  challenge?: ApprovalChallenge;
  intervention?: HumanIntervention;
  orchestration?: RunOrchestration;
}

export interface LiveEvent {
  id: string;
  type: string;
  timestamp: string;
  title: string;
  summary?: string;
  tone: "neutral" | "positive" | "warning" | "critical";
}

export interface ChatSequenceBinding {
  sourceStepId: string;
  sourceCollectionPath: string[];
  valuePath: string[];
  targetInput: string;
  selection: "exactly_one";
  onZero: "stop_no_match";
  onMany: "pause_for_authenticated_selection";
}

export interface ChatSequenceStep {
  stepId: string;
  toolName: string;
  capabilityId: string;
  capabilityVersion: string;
  literalArguments: Record<string, JsonValue>;
  bindings: ChatSequenceBinding[];
  artifactDigest: string;
  targetProfileDigest: string;
}

export interface ChatSequencePlan {
  kind: "sequence";
  sequenceId: string;
  steps: ChatSequenceStep[];
  failurePolicy: "stop_on_non_success";
  expiresAt: string;
}

export interface ChatApprovalExecution {
  challengeId: string;
  state: "submitting" | "accepted" | "unconfirmed" | "rejected";
  code?: string;
  message?: string;
}

export interface ChatSequenceStepExecution {
  stepId: string;
  state: "pending" | "starting" | "submitted" | "success" | "selection_required" | "stopped" | "unconfirmed" | "rejected";
  runId?: string;
  code?: string;
  message?: string;
  approval?: ChatApprovalExecution;
}

export interface ChatSequenceExecution {
  state: "connecting" | "running" | "selection_required" | "completed" | "stopped" | "unconfirmed" | "rejected";
  currentStepIndex: number;
  steps: ChatSequenceStepExecution[];
  selection?: {
    stepId: string;
    sourceStepId: string;
    sourceCollectionPath: string[];
    count: number;
  };
  code?: string;
  message?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  proposal?: {
    capabilityId: string;
    capabilityVersion: string;
    artifactDigest: string;
    targetProfileDigest: string;
    arguments: Record<string, JsonValue>;
  };
  sequence?: ChatSequencePlan;
  /**
   * Browser-owned execution state for a proposal launched from an authenticated
   * Send action. This is never sent back to the model as conversation history.
   */
  execution?: {
    state: "connecting" | "starting" | "submitted" | "unconfirmed" | "rejected";
    runId?: string;
    code?: string;
    message?: string;
    approval?: ChatApprovalExecution;
  };
  sequenceExecution?: ChatSequenceExecution;
  routing?: {
    provider: string;
    model?: string;
  };
}

export interface ConsolePrincipal {
  id: string;
  displayName: string;
  role: "operator" | "teller" | "supervisor";
}

export interface OperatorSession {
  runId?: string;
  profile: "teller" | "supervisor";
  branch: "MAIN-001" | "WEST-014" | "EAST-022";
  status: "provisioning" | "active" | "failed";
  message?: string;
}

export type ConnectionState = "idle" | "connecting" | "live" | "disconnected";
