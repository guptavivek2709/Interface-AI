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
  /** False when the wire contract was incomplete or structurally unsupported. */
  contractValid: boolean;
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
  category: "recoverable" | "failure" | "escalation";
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
}

export interface RunRecord {
  id: string;
  capabilityId: string;
  capabilityVersion: string;
  artifactDigest?: string;
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
}

export interface LiveEvent {
  id: string;
  type: string;
  timestamp: string;
  title: string;
  summary?: string;
  tone: "neutral" | "positive" | "warning" | "critical";
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
    arguments: Record<string, JsonValue>;
  };
  routing?: {
    provider: string;
    model?: string;
    fallbackFrom?: string;
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
