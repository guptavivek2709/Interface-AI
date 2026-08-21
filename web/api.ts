import { containsProtectedMaterial, isProtectedKey, redactForDisplay, textForDisplay } from "./security.js";
import { approvalAuthorizedFromServerRoles } from "./authorization.js";
import type {
  ApprovalChallenge,
  Capability,
  CapabilityField,
  ChatMessage,
  ChatSequenceBinding,
  ChatSequencePlan,
  ChatSequenceStep,
  ConsolePrincipal,
  DiscoveryEvidenceReference,
  DiscoveryRunRecord,
  DiscoveryRunStatus,
  DiscoveryRunTimelineEvent,
  FieldType,
  HumanIntervention,
  JsonValue,
  LiveEvent,
  RiskLevel,
  ReconciliationRecord,
  RunIncident,
  RunJournalEntry,
  RunPhase,
  RunRecord,
  RunOrchestration,
  TerminalStatus,
} from "./types.js";

// Production stays same-origin so browser authentication cannot be redirected
// to a caller-controlled API host. Vite's dev proxy owns VITE_API_ORIGIN.
const API_ROOT = "/api/v1";
export const CHAT_REQUEST_TIMEOUT_MS = 20_000;

type UnknownObject = Record<string, unknown>;
export type EvidenceFinalizationStatus = "complete" | "failed" | "not_applicable";

function object(value: unknown): UnknownObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownObject)
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function number(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function boolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item)]));
  }
  return String(value ?? "");
}

function normalizeType(rawType: unknown): FieldType {
  const source = object(rawType);
  const rawKind = string(source.kind, "string");
  const supported = ["string", "number", "boolean", "money", "object", "array"].includes(rawKind);
  const kind = supported
    ? (rawKind as FieldType["kind"])
    : "string";
  const properties = Object.fromEntries(
    Object.entries(object(source.properties)).map(([name, type]) => [name, normalizeType(type)]),
  );
  return {
    kind,
    ...(!supported ? { format: "unsupported" } : typeof source.format === "string" ? { format: source.format } : {}),
    ...(Array.isArray(source.enum) ? { enum: source.enum.map(jsonValue) } : {}),
    ...(typeof source.pattern === "string" ? { pattern: source.pattern } : {}),
    ...(typeof source.minLength === "number" ? { minLength: source.minLength } : {}),
    ...(typeof source.maxLength === "number" ? { maxLength: source.maxLength } : {}),
    ...(typeof source.minimum === "number" ? { minimum: source.minimum } : {}),
    ...(typeof source.maximum === "number" ? { maximum: source.maximum } : {}),
    ...(typeof source.integer === "boolean" ? { integer: source.integer } : {}),
    ...(typeof source.currency === "string" ? { currency: source.currency } : {}),
    ...(typeof source.minimumMinorUnits === "number" ? { minimumMinorUnits: source.minimumMinorUnits } : {}),
    ...(typeof source.maximumMinorUnits === "number" ? { maximumMinorUnits: source.maximumMinorUnits } : {}),
    ...(Object.keys(properties).length > 0 ? { properties } : {}),
    ...(Array.isArray(source.required)
      ? { required: source.required.filter((item): item is string => typeof item === "string") }
      : {}),
    ...(source.items !== undefined ? { items: normalizeType(source.items) } : {}),
    ...(typeof source.maxItems === "number" ? { maxItems: source.maxItems } : {}),
  };
}

function normalizeField(raw: unknown, output = false): CapabilityField | null {
  const source = object(raw);
  const name = string(source.name);
  if (!name) return null;
  return {
    name,
    description: string(source.description, name.replace(/[._-]+/gu, " ")),
    type: normalizeType(source.type),
    required: output ? false : boolean(source.required),
    classification: ["public", "internal", "confidential", "restricted", "secret"].includes(
      string(source.classification),
    )
      ? string(source.classification)
      : "secret",
  };
}

function validType(rawType: unknown): boolean {
  if (typeof rawType === "string") return false;
  const source = object(rawType);
  const kind = string(source.kind);
  if (!["string", "number", "boolean", "money", "object", "array"].includes(kind)) return false;
  const only = (allowed: readonly string[]) => Object.keys(source).every((key) => allowed.includes(key));
  const finiteIfPresent = (value: unknown) => value === undefined || (typeof value === "number" && Number.isFinite(value));
  const integerIfPresent = (value: unknown) => value === undefined || (typeof value === "number" && Number.isSafeInteger(value));
  if (kind === "string") {
    if (!only(["kind", "format", "minLength", "maxLength", "pattern", "enum"])) return false;
    if (!integerIfPresent(source.minLength) || !integerIfPresent(source.maxLength)) return false;
    if (typeof source.minLength === "number" && source.minLength < 0) return false;
    if (typeof source.maxLength === "number" && source.maxLength <= 0) return false;
    if (source.format !== undefined && !["plain", "email", "phone", "member_number", "share_id"].includes(string(source.format))) return false;
    if (source.pattern !== undefined) {
      if (typeof source.pattern !== "string" || source.pattern.length === 0) return false;
      try { new RegExp(source.pattern, "u"); } catch { return false; }
    }
    if (typeof source.minLength === "number" && typeof source.maxLength === "number" && source.minLength > source.maxLength) return false;
    return source.enum === undefined || (Array.isArray(source.enum) && source.enum.length > 0 && source.enum.every((item) => typeof item === "string"));
  }
  if (kind === "number") {
    return only(["kind", "integer", "minimum", "maximum"]) && finiteIfPresent(source.minimum) && finiteIfPresent(source.maximum) &&
      (source.integer === undefined || typeof source.integer === "boolean") &&
      !(typeof source.minimum === "number" && typeof source.maximum === "number" && source.minimum > source.maximum);
  }
  if (kind === "boolean") return only(["kind"]);
  if (kind === "money") {
    return only(["kind", "currency", "minimumMinorUnits", "maximumMinorUnits"]) && typeof source.currency === "string" && /^[A-Z]{3}$/u.test(source.currency) &&
      integerIfPresent(source.minimumMinorUnits) && integerIfPresent(source.maximumMinorUnits) &&
      !(typeof source.minimumMinorUnits === "number" && typeof source.maximumMinorUnits === "number" && source.minimumMinorUnits > source.maximumMinorUnits);
  }
  if (kind === "object") {
    if (!only(["kind", "properties", "required"])) return false;
    if (!source.properties || typeof source.properties !== "object" || Array.isArray(source.properties)) return false;
    if (!Array.isArray(source.required) || source.required.some((item) => typeof item !== "string")) return false;
    const properties = object(source.properties);
    const required = source.required as string[];
    return Object.keys(properties).every(validId) && required.every(validId) && new Set(required).size === required.length && required.every((item) => Object.hasOwn(properties, item)) && Object.values(properties).every((item) => validType(item));
  }
  if (kind === "array") return only(["kind", "items", "maxItems"]) && source.items !== undefined && validType(source.items) && integerIfPresent(source.maxItems) && !(typeof source.maxItems === "number" && (source.maxItems <= 0 || source.maxItems > 10_000));
  return true;
}

function validId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(value) && !["__proto__", "constructor", "prototype"].includes(value);
}

function validField(raw: unknown, output: boolean): boolean {
  const source = object(raw);
  const allowed = ["name", "description", "type", "classification", ...(!output ? ["required"] : [])];
  const classifications = ["public", "internal", "confidential", "restricted", "secret"];
  return (
    Object.keys(source).every((key) => allowed.includes(key)) &&
    typeof source.name === "string" &&
    validId(source.name) &&
    typeof source.description === "string" &&
    source.description.trim().length > 0 &&
    validType(source.type) &&
    (output || typeof source.required === "boolean") &&
    classifications.includes(string(source.classification))
  );
}

function normalizeRisk(value: unknown): RiskLevel {
  return ["read", "write", "irreversible", "supervisor_only"].includes(string(value))
    ? (value as RiskLevel)
    : "supervisor_only";
}

export function normalizeCapability(raw: unknown): Capability | null {
  const envelope = object(raw);
  const metadata = object(envelope.metadata ?? raw);
  const artifact = object(envelope.artifact);
  const artifactCapability = object(artifact.capability);
  const id = string(metadata.id, string(artifactCapability.id));
  if (!id) return null;
  const name = string(metadata.name, string(artifactCapability.name, id));
  const version = string(metadata.version, string(artifactCapability.version, "unknown"));
  const schemaVersion = string(metadata.schemaVersion, string(artifact.schemaVersion, "unknown"));
  const approval = string(metadata.approval, string(artifactCapability.approval, "unknown"));
  const rawRisk = metadata.risk ?? artifactCapability.risk;
  const risk = normalizeRisk(rawRisk);
  const digest = string(metadata.digest);
  const targetProfileDigest = string(metadata.targetProfileDigest);
  const supportsSupervisorHandoff = metadata.supportsSupervisorHandoff === true;
  const inputSource = metadata.inputs ?? artifact.inputs;
  const outputSource = metadata.outputs ?? artifact.outputs;
  const rawInputs = array(inputSource);
  const rawOutputs = array(outputSource);
  const lineageSource = object(metadata.lineage);
  const lineageId = string(lineageSource.lineageId);
  const discoveryRunId = string(lineageSource.discoveryRunId);
  const lineageProvider = string(lineageSource.provider);
  const lineageModel = string(lineageSource.model);
  const traceDigest = string(lineageSource.traceDigest);
  const draftDigest = string(lineageSource.draftDigest);
  const reviewedDigest = string(lineageSource.reviewedDigest);
  const approvedDigest = string(lineageSource.approvedDigest);
  const canaryRunId = string(lineageSource.canaryRunId);
  const safeLineageId = /^[A-Za-z0-9._-]{1,300}$/u.test(lineageId);
  const safeDiscoveryRunId = /^[A-Za-z0-9._-]{1,300}$/u.test(discoveryRunId);
  const safeCanaryRunId = /^[A-Za-z0-9._-]{1,300}$/u.test(canaryRunId);
  const completeLineage =
    safeLineageId &&
    safeDiscoveryRunId &&
    safeCanaryRunId &&
    lineageProvider === "anthropic-messages" &&
    /^[A-Za-z0-9._:-]{1,200}$/u.test(lineageModel) &&
    [traceDigest, draftDigest, reviewedDigest, approvedDigest].every((value) => /^[a-f0-9]{64}$/u.test(value)) &&
    approvedDigest === digest;
  const inputs = rawInputs
    .map((item) => normalizeField(item))
    .filter((item): item is CapabilityField => item !== null);
  const outputs = rawOutputs
    .map((item) => normalizeField(item, true))
    .filter((item): item is CapabilityField => item !== null);
  return {
    id,
    name,
    description: string(metadata.description, string(artifactCapability.description, "Approved operation")),
    version,
    schemaVersion,
    approval,
    risk,
    tags: array(metadata.tags ?? artifactCapability.tags).filter((item): item is string => typeof item === "string"),
    inputs,
    outputs,
    digest,
    targetProfileDigest,
    ...(completeLineage
      ? {
          lineage: {
            lineageId,
            discoveryRunId,
            provider: "anthropic-messages" as const,
            model: lineageModel,
            traceDigest,
            draftDigest,
            reviewedDigest,
            approvedDigest,
            canaryRunId,
          },
        }
      : {}),
    contractValid:
      validId(id) &&
      name.trim().length > 0 &&
      /^\d+\.\d+\.\d+$/u.test(version) &&
      schemaVersion === "2.0" &&
      ["draft", "approved", "retired"].includes(approval) &&
      ["read", "write", "irreversible", "supervisor_only"].includes(string(rawRisk)) &&
      /^[a-f0-9]{64}$/u.test(digest) &&
      /^[a-f0-9]{64}$/u.test(targetProfileDigest) &&
      completeLineage &&
      Array.isArray(inputSource) &&
      Array.isArray(outputSource) &&
      rawInputs.every((item) => validField(item, false)) &&
      rawOutputs.every((item) => validField(item, true)) &&
      new Set(inputs.map((field) => field.name)).size === inputs.length &&
      new Set(outputs.map((field) => field.name)).size === outputs.length &&
      inputs.length === rawInputs.length &&
      outputs.length === rawOutputs.length,
    supportsSupervisorHandoff,
  };
}

function phase(value: unknown): RunPhase {
  const candidate = string(value);
  if (["queued", "running", "recovering", "awaiting_approval", "awaiting_human", "completed"].includes(candidate)) {
    return candidate as RunPhase;
  }
  if (
    candidate === "terminal" ||
    ["success", "business_outcome", "failure", "escalation", "intervention"].includes(candidate)
  ) {
    return "completed";
  }
  return "queued";
}

function terminal(value: unknown): TerminalStatus | undefined {
  const candidate = string(value);
  if (candidate === "intervention") return "escalation";
  return ["success", "business_outcome", "failure", "escalation"].includes(candidate)
    ? (candidate as TerminalStatus)
    : undefined;
}

function normalizeJournal(raw: unknown): RunJournalEntry[] {
  return array(raw).map((item, index) => {
    const entry = object(item);
    const status = string(entry.status, "started");
    return {
      sequence: number(entry.sequence, index + 1),
      stepId: string(entry.stepId, `step-${index + 1}`),
      title: string(entry.title, string(entry.stepId, `Step ${index + 1}`)),
      action: string(entry.action, "operation"),
      effect: string(entry.effect, "read"),
      attempt: number(entry.attempt, 1),
      status: ["started", "succeeded", "failed"].includes(status)
        ? (status as RunJournalEntry["status"])
        : "started",
      startedAt: string(entry.startedAt),
      ...(typeof entry.completedAt === "string" ? { completedAt: entry.completedAt } : {}),
      ...(typeof entry.summary === "string" ? { summary: textForDisplay(entry.summary) } : {}),
    };
  });
}

function normalizeIncidents(raw: unknown): RunIncident[] {
  return array(raw).map((item) => {
    const incident = object(item);
    const category = string(incident.category, "failure");
    return {
      code: string(incident.code, "RUNTIME_INCIDENT"),
      category: ["recoverable", "failure", "escalation", "intervention"].includes(category)
        ? (category as RunIncident["category"])
        : "failure",
      message: textForDisplay(string(incident.message, "The run reported an incident.")),
      occurredAt: string(incident.occurredAt),
      ...(typeof incident.stepId === "string" ? { stepId: incident.stepId } : {}),
      ...(typeof incident.recoveryAttempt === "number"
        ? { recoveryAttempt: incident.recoveryAttempt }
        : {}),
    };
  });
}

function normalizeChallenge(raw: unknown): ApprovalChallenge | undefined {
  const challenge = object(raw);
  const challengeId = string(challenge.challengeId);
  const rawSummary = array(challenge.summary);
  const authorizedRoles = array(challenge.authorizedRoles).filter(
    (role): role is "teller" | "supervisor" => role === "teller" || role === "supervisor",
  );
  const summaryIds = rawSummary.map((item) => string(object(item).targetId));
  if (
    !challengeId ||
    typeof challenge.runId !== "string" ||
    !challenge.runId ||
    typeof challenge.stepId !== "string" ||
    !challenge.stepId ||
    !["user_confirmation", "supervisor_confirmation"].includes(string(challenge.requirement)) ||
    typeof challenge.createdAt !== "string" ||
    !Number.isFinite(new Date(challenge.createdAt).getTime()) ||
    typeof challenge.expiresAt !== "string" ||
    !Number.isFinite(new Date(challenge.expiresAt).getTime()) ||
    !Array.isArray(challenge.summary) ||
    rawSummary.some((item) => {
      const summary = object(item);
      return !validId(string(summary.targetId)) || typeof summary.sensitive !== "boolean";
    }) ||
    new Set(summaryIds).size !== summaryIds.length
  ) return undefined;
  return {
    challengeId,
    runId: string(challenge.runId),
    stepId: string(challenge.stepId),
    stepTitle: string(challenge.stepTitle, "Review and approve"),
    requirement: challenge.requirement as ApprovalChallenge["requirement"],
    createdAt: string(challenge.createdAt),
    expiresAt: string(challenge.expiresAt),
    summary: rawSummary.map((item) => {
      const summary = object(item);
      const sensitive = boolean(summary.sensitive);
      const authorizedProjection = summary.displaySafe === true && summary.displayValue !== undefined;
      const projected = authorizedProjection ? jsonValue(summary.displayValue) : "[Protected]";
      const displayed = redactForDisplay(projected, string(summary.targetId));
      const projectionComplete =
        authorizedProjection &&
        !containsProtectedMaterial(projected, string(summary.targetId)) &&
        !JSON.stringify(projected).includes('"[Protected]"') &&
        JSON.stringify(displayed) === JSON.stringify(projected) &&
        approvalProjectionFits(projected);
      return {
        targetId: string(summary.targetId, "value"),
        value: projectionComplete ? displayed : "[Protected]",
        sensitive,
        reviewable: projectionComplete,
      };
    }),
    authorized: approvalAuthorizedFromServerRoles(
      challenge.requirement as ApprovalChallenge["requirement"],
      authorizedRoles,
    ),
  };
}

function normalizeIntervention(raw: unknown, expectedRunId: string): HumanIntervention | undefined {
  const intervention = object(raw);
  const interventionId = string(intervention.interventionId);
  const runId = string(intervention.runId);
  const stepId = string(intervention.stepId);
  const reasonCode = string(intervention.reasonCode);
  const action = string(intervention.action);
  const state = string(intervention.state);
  const createdAt = string(intervention.createdAt);
  const expiresAt = string(intervention.expiresAt);
  const requiredRole = string(intervention.requiredRole);
  const createdAtMs = Date.parse(createdAt);
  const expiresAtMs = Date.parse(expiresAt);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(interventionId) ||
    runId !== expectedRunId ||
    !validId(stepId) ||
    !validId(reasonCode) ||
    !["restore_session", "authenticate_supervisor"].includes(action) ||
    !["awaiting_human", "human_active", "action_completed", "revalidating"].includes(state) ||
    !Number.isFinite(createdAtMs) ||
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= createdAtMs ||
    intervention.sameLiveSession !== true ||
    (action === "authenticate_supervisor" && !validId(requiredRole))
  ) return undefined;
  return {
    interventionId,
    runId,
    stepId,
    reasonCode,
    action: action as HumanIntervention["action"],
    state: state as HumanIntervention["state"],
    createdAt,
    expiresAt,
    sameLiveSession: true,
    ...(requiredRole ? { requiredRole } : {}),
  };
}

function normalizeOrchestration(raw: unknown): RunOrchestration | undefined {
  const orchestration = object(raw);
  if (orchestration.kind === "reconciliation") {
    const sourceRunId = string(orchestration.sourceRunId);
    return sourceRunId ? { kind: "reconciliation", sourceRunId } : undefined;
  }
  const sequenceId = string(orchestration.sequenceId);
  const stepId = string(orchestration.stepId);
  const stepIndex = number(orchestration.stepIndex, -1);
  const stepCount = number(orchestration.stepCount, -1);
  const parentRunId = string(orchestration.parentRunId);
  if (
    orchestration.kind !== "chat_sequence" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(sequenceId) ||
    !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(stepId) ||
    !Number.isSafeInteger(stepIndex) ||
    !Number.isSafeInteger(stepCount) ||
    stepIndex < 0 ||
    stepCount < 1 ||
    stepCount > 3 ||
    stepIndex >= stepCount ||
    (orchestration.parentRunId !== undefined && !parentRunId)
  ) return undefined;
  return {
    kind: "chat_sequence",
    sequenceId,
    stepId,
    stepIndex,
    stepCount,
    ...(parentRunId ? { parentRunId } : {}),
  };
}

/** Mirrors ValueView's visible bounds so a truncated review can never authorize a mutation. */
function approvalProjectionFits(value: JsonValue, depth = 0): boolean {
  if (depth > 8) return false;
  if (Array.isArray(value)) {
    if (value.length > 100) return false;
    const rows = value.filter((item) => Boolean(item) && typeof item === "object" && !Array.isArray(item)) as Array<Record<string, JsonValue>>;
    if (rows.length === value.length && rows.length > 0) {
      const columns = new Set(rows.flatMap((row) => Object.keys(row).filter((key) => !isProtectedKey(key))));
      if (columns.size > 12) return false;
    }
    return value.every((item) => approvalProjectionFits(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([key]) => !isProtectedKey(key));
    return entries.length <= 250 && entries.every(([, item]) => approvalProjectionFits(item, depth + 1));
  }
  return true;
}

function record(value: unknown): Record<string, JsonValue> | undefined {
  const source = object(value);
  if (Object.keys(source).length === 0) return undefined;
  return jsonValue(source) as Record<string, JsonValue>;
}

export function normalizeRun(raw: unknown): RunRecord | null {
  const envelope = object(raw);
  const source = object(envelope.run ?? raw);
  const progress = object(source.progress);
  const result = object(source.result ?? progress.result);
  const id = string(source.id, string(source.runId, string(result.runId)));
  if (!id) return null;
  const rawChallenge = source.challenge ?? progress.challenge;
  const normalizedChallenge = normalizeChallenge(rawChallenge);
  const managerFailure = object(source.managerFailure);
  const cancellation = object(source.cancellation);
  const rawEvidenceFinalization = object(source.evidenceFinalization);
  const evidenceFinalization = ["complete", "failed", "not_applicable"].includes(string(rawEvidenceFinalization.status))
    ? { status: string(rawEvidenceFinalization.status) as EvidenceFinalizationStatus }
    : undefined;
  const runPhase = phase(source.phase ?? progress.phase ?? (Object.keys(result).length ? "completed" : source.status));
  const terminalStatus = managerFailure.code
    ? "failure"
    : cancellation.code
      ? "failure"
      : terminal(result.status ?? source.status);
  // A retained replay progress object can still contain its former challenge
  // after cancellation or expiry. Only the authoritative manager phase may
  // make a challenge actionable in the browser.
  const approvalIsCurrent = runPhase === "awaiting_approval" && terminalStatus === undefined;
  const challenge = approvalIsCurrent && normalizedChallenge?.runId === id
    ? normalizedChallenge
    : undefined;
  const invalidChallenge =
    approvalIsCurrent && Object.keys(object(rawChallenge)).length > 0 && !challenge;
  const rawIntervention = source.intervention ?? progress.intervention;
  const interventionIsCurrent = runPhase === "awaiting_human" && terminalStatus === undefined;
  const normalizedIntervention = normalizeIntervention(rawIntervention, id);
  const intervention = interventionIsCurrent ? normalizedIntervention : undefined;
  const invalidIntervention = interventionIsCurrent && !intervention;
  const orchestration = normalizeOrchestration(source.orchestration);
  const outputContainer = Object.hasOwn(result, "outputs") ? result : source;
  const normalizedOutputs = record(outputContainer.outputs);
  return {
    id,
    capabilityId: string(source.capabilityId, string(result.capabilityId, "unknown")),
    capabilityVersion: string(source.capabilityVersion, string(result.capabilityVersion)),
    ...(typeof source.artifactDigest === "string" || typeof result.artifactDigest === "string"
      ? { artifactDigest: string(source.artifactDigest, string(result.artifactDigest)) }
      : {}),
    ...(typeof source.targetProfileDigest === "string" || typeof result.targetProfileDigest === "string"
      ? { targetProfileDigest: string(source.targetProfileDigest, string(result.targetProfileDigest)) }
      : {}),
    ...(typeof source.revision === "number" && Number.isSafeInteger(source.revision) && source.revision >= 0
      ? { revision: source.revision }
      : {}),
    ...(typeof source.lastEventId === "number" && Number.isSafeInteger(source.lastEventId) && source.lastEventId >= 0
      ? { lastEventId: source.lastEventId }
      : {}),
    phase: terminalStatus ? "completed" : invalidChallenge ? "awaiting_human" : challenge ? "awaiting_approval" : runPhase,
    ...(terminalStatus ? { terminalStatus } : {}),
    ...(typeof managerFailure.code === "string" || typeof cancellation.code === "string" || typeof result.code === "string" || typeof source.code === "string"
      ? { code: string(managerFailure.code, string(cancellation.code, string(result.code, string(source.code)))) }
      : {}),
    ...(typeof managerFailure.message === "string" || typeof cancellation.reason === "string" || typeof result.message === "string" || typeof source.message === "string"
      ? { message: textForDisplay(string(managerFailure.message, string(cancellation.reason, string(result.message, string(source.message))))) }
      : {}),
    ...(typeof result.retryable === "boolean" ? { retryable: result.retryable } : {}),
    ...(typeof result.effectUncertain === "boolean" ? { effectUncertain: result.effectUncertain } : {}),
    ...(typeof source.createdAt === "string" || typeof source.submittedAt === "string"
      ? { createdAt: string(source.createdAt, string(source.submittedAt)) }
      : {}),
    ...(typeof result.startedAt === "string" || typeof source.startedAt === "string"
      ? { startedAt: string(result.startedAt, string(source.startedAt)) }
      : {}),
    ...(typeof result.completedAt === "string" || typeof source.completedAt === "string"
      ? { completedAt: string(result.completedAt, string(source.completedAt)) }
      : {}),
    ...(typeof source.updatedAt === "string" ? { updatedAt: source.updatedAt } : {}),
    ...(evidenceFinalization ? { evidenceFinalization } : {}),
    ...(record(source.inputs) ? { inputs: record(source.inputs)! } : {}),
    ...(normalizedOutputs ? { outputs: normalizedOutputs } : {}),
    ...(typeof outputContainer.outputsDisplaySafe === "boolean"
      ? { outputsDisplaySafe: outputContainer.outputsDisplaySafe }
      : {}),
    journal: normalizeJournal(result.journal ?? source.journal ?? progress.journal),
    incidents: [
      ...normalizeIncidents(result.incidents ?? source.incidents ?? progress.incidents),
      ...(invalidChallenge
        ? [{ code: "APPROVAL_PROJECTION_INVALID", category: "escalation" as const, message: "The approval challenge was incomplete or used an unsupported requirement.", occurredAt: new Date().toISOString() }]
        : []),
      ...(invalidIntervention
        ? [{ code: "INTERVENTION_PROJECTION_INVALID", category: "escalation" as const, message: "The human handoff projection was incomplete or did not match this run.", occurredAt: new Date().toISOString() }]
        : []),
    ],
    ...(challenge ? { challenge } : {}),
    ...(intervention ? { intervention } : {}),
    ...(orchestration ? { orchestration } : {}),
  };
}

export function evidenceFinalizationStatus(run: RunRecord): EvidenceFinalizationStatus | undefined {
  const status = string(object(object(run).evidenceFinalization).status);
  return ["complete", "failed", "not_applicable"].includes(status)
    ? status as EvidenceFinalizationStatus
    : undefined;
}

function collection(raw: unknown, keys: string[]): unknown[] {
  if (Array.isArray(raw)) return raw;
  const source = object(raw);
  for (const key of keys) if (Array.isArray(source[key])) return source[key] as unknown[];
  return [];
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Readonly<Record<string, JsonValue>> | undefined;

  constructor(status: number, code: string, message: string, details?: Readonly<Record<string, JsonValue>>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function sequenceSelectionDetails(raw: unknown): Readonly<Record<string, JsonValue>> | undefined {
  const details = object(raw);
  const count = number(details.count, -1);
  const sourceStepId = string(details.sourceStepId);
  const sourceCollectionPath = array(details.sourceCollectionPath);
  if (
    !Number.isSafeInteger(count) || count < 2 || count > 10_000 ||
    !validId(sourceStepId) ||
    sourceCollectionPath.length === 0 ||
    sourceCollectionPath.some((segment) => typeof segment !== "string" || !validId(segment))
  ) return undefined;
  return { count, sourceStepId, sourceCollectionPath: sourceCollectionPath as string[] };
}

async function requestJson(path: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<unknown> {
  const controller = new AbortController();
  const externalSignal = init.signal;
  let abortSource: "external" | "timeout" | null = null;
  const abort = () => {
    if (controller.signal.aborted) return;
    abortSource = "external";
    controller.abort(externalSignal?.reason);
  };
  if (externalSignal?.aborted) abort();
  else externalSignal?.addEventListener("abort", abort, { once: true });
  const timeout = window.setTimeout(() => {
    if (controller.signal.aborted) return;
    abortSource = "timeout";
    controller.abort("timeout");
  }, timeoutMs);
  try {
    const response = await fetch(`${API_ROOT}${path}`, {
      ...init,
      signal: controller.signal,
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
    const text = await response.text();
    let payload: unknown = undefined;
    if (text) {
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        payload = undefined;
      }
    }
    if (!response.ok) {
      const error = object(object(payload).error ?? payload);
      const code = string(error.code, `HTTP_${response.status}`);
      const details = code === "SEQUENCE_SELECTION_REQUIRED"
        ? sequenceSelectionDetails(error.details)
        : undefined;
      throw new ApiError(
        response.status,
        code,
        textForDisplay(string(error.message, "The service could not complete that request.")),
        details,
      );
    }
    return payload;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (controller.signal.aborted && abortSource === "timeout") {
      throw new ApiError(0, "REQUEST_TIMEOUT", "The service did not respond in time.");
    }
    if (controller.signal.aborted) {
      throw new ApiError(0, "REQUEST_CANCELLED", "The request was cancelled before it completed.");
    }
    throw new ApiError(0, "NETWORK_UNAVAILABLE", "The service is currently unreachable.");
  } finally {
    window.clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", abort);
  }
}

export async function getCapabilities(signal?: AbortSignal): Promise<Capability[]> {
  const payload = await requestJson("/capabilities", signal ? { signal } : {});
  return collection(payload, ["capabilities", "items", "data"])
    .map(normalizeCapability)
    .filter((item): item is Capability => item !== null);
}

function validDigest(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

function normalizeDiscoveryTimeline(raw: unknown): DiscoveryRunTimelineEvent[] {
  const supported = new Set<DiscoveryRunTimelineEvent["type"]>([
    "draft_created",
    "reviewed",
    "canary_passed",
    "approved",
  ]);
  return array(raw).flatMap((item) => {
    const source = object(item);
    const type = string(source.type) as DiscoveryRunTimelineEvent["type"];
    const at = string(source.at);
    const actor = textForDisplay(string(source.actor));
    const artifactDigest = string(source.artifactDigest);
    if (!supported.has(type) || !Number.isFinite(Date.parse(at)) || !actor || !validDigest(artifactDigest)) return [];
    const parentArtifactDigest = string(source.parentArtifactDigest);
    const traceDigest = string(source.traceDigest);
    const reviewDiffDigest = string(source.reviewDiffDigest);
    const changedPathCount = number(source.changedPathCount, -1);
    const canaryRunId = string(source.canaryRunId);
    const evidenceDigest = string(source.evidenceDigest);
    return [{
      type,
      at,
      actor,
      artifactDigest,
      ...(validDigest(parentArtifactDigest) ? { parentArtifactDigest } : {}),
      ...(validDigest(traceDigest) ? { traceDigest } : {}),
      ...(validDigest(reviewDiffDigest) ? { reviewDiffDigest } : {}),
      ...(Number.isSafeInteger(changedPathCount) && changedPathCount >= 0 ? { changedPathCount } : {}),
      ...(validId(canaryRunId) ? { canaryRunId } : {}),
      ...(validDigest(evidenceDigest) ? { evidenceDigest } : {}),
    }];
  });
}

function normalizeDiscoveryEvidence(raw: unknown): DiscoveryEvidenceReference[] {
  return array(raw).flatMap((item) => {
    const source = object(item);
    const kind = string(source.kind);
    const label = textForDisplay(string(source.label, string(source.referenceId)));
    const sha256 = string(source.sha256, string(source.digest));
    const href = string(source.href, string(source.url));
    if (!["artifact", "lineage", "canary"].includes(kind) || !label || !validDigest(sha256)) return [];
    const safeHref = /^\/api\/v1\/(?:capabilities\/[A-Za-z0-9._:-]{1,160}\/\d+\.\d+\.\d+|discovery-runs\/[A-Za-z0-9._:-]{1,300})$/u.test(href);
    return [{
      kind: kind as DiscoveryEvidenceReference["kind"],
      label,
      sha256,
      ...(safeHref ? { href } : {}),
    }];
  });
}

export function normalizeDiscoveryRun(raw: unknown): DiscoveryRunRecord | null {
  const envelope = object(raw);
  const source = object(envelope.discoveryRun ?? envelope.run ?? raw);
  if (source.kind !== undefined && source.kind !== "discovery") return null;
  const id = string(source.discoveryRunId, string(source.id));
  const discoveryRunId = string(source.discoveryRunId, id);
  const capabilityId = string(source.capabilityId);
  const capabilityVersion = string(source.capabilityVersion);
  const createdAt = string(source.createdAt);
  const timeline = normalizeDiscoveryTimeline(source.timeline ?? source.events);
  const completedAt = string(source.completedAt, timeline.at(-1)?.at ?? "");
  const status = string(source.status) as DiscoveryRunStatus;
  const provider = string(source.provider);
  const model = string(source.model);
  const rawInputs = array(source.inputs ?? source.inputContract);
  const inputs = rawInputs.flatMap((item) => {
    const field = normalizeField(item);
    return field ? [{ ...field, valueStatus: "withheld" as const }] : [];
  });
  const rawOutputContract = array(source.outputContract ?? source.outputs);
  const outputContract = rawOutputContract.flatMap((item) => {
    const field = normalizeField(item, true);
    return field ? [field] : [];
  });
  const outputSource = object(source.output ?? source.result ?? source.structuredOutput);
  const output = {
    traceDigest: string(outputSource.traceDigest),
    draftDigest: string(outputSource.draftDigest),
    reviewedDigest: string(outputSource.reviewedDigest),
    approvedDigest: string(outputSource.approvedDigest),
    canaryRunId: string(outputSource.canaryRunId),
  };
  const evidence = normalizeDiscoveryEvidence(source.evidence);
  if (
    !validId(id) || id !== discoveryRunId || !validId(capabilityId) ||
    !/^\d+\.\d+\.\d+$/u.test(capabilityVersion) ||
    !Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(completedAt)) ||
    !["draft", "reviewed", "canary_passed", "approved"].includes(status) ||
    provider !== "anthropic-messages" || !/^[A-Za-z0-9._:-]{1,200}$/u.test(model) ||
    rawInputs.length !== inputs.length || rawOutputContract.length !== outputContract.length ||
    ![output.traceDigest, output.draftDigest, output.reviewedDigest, output.approvedDigest].every(validDigest) ||
    !validId(output.canaryRunId) || timeline.length === 0
  ) return null;
  return {
    kind: "discovery",
    id,
    discoveryRunId,
    capabilityId,
    capabilityVersion,
    capabilityName: textForDisplay(string(source.capabilityName, humanizeIdentifier(capabilityId))),
    goal: textForDisplay(string(source.goal, "Privacy-safe discovery goal retained in the approved artifact.")),
    createdAt,
    completedAt,
    status,
    provider: "anthropic-messages",
    model,
    inputs,
    outputContract,
    output,
    timeline,
    evidence,
  };
}

function humanizeIdentifier(value: string): string {
  return value.replace(/[._:-]+/gu, " ").replace(/\b\w/gu, (letter) => letter.toLocaleUpperCase());
}

export async function getDiscoveryRuns(signal?: AbortSignal): Promise<DiscoveryRunRecord[]> {
  const payload = await requestJson("/discovery-runs", signal ? { signal } : {});
  return collection(payload, ["discoveryRuns", "runs", "items", "data"])
    .map(normalizeDiscoveryRun)
    .filter((item): item is DiscoveryRunRecord => item !== null);
}

export async function getDiscoveryRun(id: string, signal?: AbortSignal): Promise<DiscoveryRunRecord> {
  const payload = await requestJson(`/discovery-runs/${encodeURIComponent(id)}`, signal ? { signal } : {});
  const run = normalizeDiscoveryRun(payload);
  if (!run) throw new ApiError(502, "INVALID_DISCOVERY_RUN_RESPONSE", "The service returned an invalid discovery record.");
  if (run.id !== id) throw new ApiError(502, "DISCOVERY_RUN_BINDING_MISMATCH", "The service returned a different discovery record.");
  return run;
}

export async function getRuns(signal?: AbortSignal): Promise<RunRecord[]> {
  const payload = await requestJson("/runs", signal ? { signal } : {});
  return collection(payload, ["runs", "items", "data"])
    .map(normalizeRun)
    .filter((item): item is RunRecord => item !== null);
}

export async function getRun(id: string, signal?: AbortSignal): Promise<RunRecord> {
  const payload = await requestJson(`/runs/${encodeURIComponent(id)}`, signal ? { signal } : {});
  const run = normalizeRun(payload);
  if (!run) throw new ApiError(502, "INVALID_RUN_RESPONSE", "The service returned an invalid run record.");
  if (run.id !== id) throw new ApiError(502, "RUN_BINDING_MISMATCH", "The service returned details for a different run.");
  return run;
}

export interface EvidenceItem {
  path: string;
  bytes: number;
}

export interface EvidenceListing {
  items: EvidenceItem[];
  /** True only when the server and the retained manifest agree on finality. */
  finalized: boolean;
}

export function normalizeEvidenceList(raw: unknown): EvidenceItem[] {
  const items = collection(raw, ["evidence", "items", "data"]);
  return items.flatMap((item) => {
    const source = object(item);
    const evidencePath = string(source.path);
    const bytes = number(source.bytes, -1);
    const segments = evidencePath.split("/");
    if (
      !evidencePath ||
      evidencePath.length > 1_000 ||
      evidencePath.includes("\\") ||
      evidencePath.startsWith("/") ||
      segments.some((segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.startsWith(".") ||
        /\.(?:tmp|temp|part|partial)$/iu.test(segment) ||
        !/^[A-Za-z0-9._-]{1,200}$/u.test(segment)
      ) ||
      segments.some(isProtectedKey) ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0
    ) return [];
    return [{ path: evidencePath, bytes }];
  });
}

export function normalizeEvidenceListing(raw: unknown): EvidenceListing {
  const items = normalizeEvidenceList(raw);
  return {
    items,
    finalized: object(raw).finalized === true && items.some((item) => item.path === "manifest.json"),
  };
}

export async function getEvidence(runId: string, signal?: AbortSignal): Promise<EvidenceListing> {
  const payload = await requestJson(`/runs/${encodeURIComponent(runId)}/evidence`, signal ? { signal } : {});
  return normalizeEvidenceListing(payload);
}

export function evidenceUrl(runId: string, evidencePath: string): string {
  if (!normalizeEvidenceList({ evidence: [{ path: evidencePath, bytes: 0 }] }).length) {
    throw new TypeError("Evidence path is not safe for browser navigation.");
  }
  const encodedPath = evidencePath.split("/").map(encodeURIComponent).join("/");
  return `${API_ROOT}/runs/${encodeURIComponent(runId)}/evidence/${encodedPath}`;
}

export type CreateRunRequest = {
  capability: Capability;
  inputs: Record<string, JsonValue>;
} & (
  | { idempotencyKey: string; sequence?: never }
  | { idempotencyKey?: never; sequence: { sequenceId: string; stepId: string; selectionIndex?: number } }
);

export async function createRun(request: CreateRunRequest): Promise<RunRecord> {
  const { capability, inputs, idempotencyKey, sequence } = request;
  if (!/^[a-f0-9]{64}$/u.test(capability.targetProfileDigest)) {
    throw new ApiError(0, "TARGET_PROFILE_BINDING_INVALID", "The reviewed target profile binding is unavailable. Refresh the catalog before starting a run.");
  }
  const payload = await requestJson("/runs", {
    method: "POST",
    headers: {
      "x-meridian-action": "operator",
      ...(sequence ? {} : { "idempotency-key": idempotencyKey }),
    },
    body: JSON.stringify({
      capabilityId: capability.id,
      capabilityVersion: capability.version,
      artifactDigest: capability.digest,
      targetProfileDigest: capability.targetProfileDigest,
      inputs,
      ...(sequence ? { sequence } : {}),
    }),
  });
  const run = normalizeRun(payload);
  if (!run) throw new ApiError(502, "INVALID_RUN_RESPONSE", "The service did not return a run ID.");
  if (
    run.capabilityId !== capability.id ||
    run.capabilityVersion !== capability.version ||
    run.artifactDigest !== capability.digest ||
    run.targetProfileDigest !== capability.targetProfileDigest
  ) {
    throw new ApiError(502, "RUN_BINDING_MISMATCH", "The service returned a run that did not match the reviewed capability binding.");
  }
  if (sequence && (
    run.orchestration?.kind !== "chat_sequence" ||
    run.orchestration.sequenceId !== sequence.sequenceId ||
    run.orchestration.stepId !== sequence.stepId
  )) {
    throw new ApiError(502, "SEQUENCE_BINDING_MISMATCH", "The service returned a run that did not match the authorized sequence step.");
  }
  return run;
}

export async function approveRun(id: string, challengeId: string): Promise<RunRecord> {
  const payload = await requestJson(`/runs/${encodeURIComponent(id)}/approve`, {
    method: "POST",
    headers: { "x-meridian-action": "operator" },
    body: JSON.stringify({ challengeId, decision: "approve" }),
  });
  const run = normalizeRun(payload);
  if (!run) throw new ApiError(502, "INVALID_RUN_RESPONSE", "The approval response was invalid.");
  if (run.id !== id || (run.challenge && run.challenge.runId !== id)) {
    throw new ApiError(502, "RUN_BINDING_MISMATCH", "The approval response did not match the bound run.");
  }
  return run;
}

export async function cancelRun(id: string, signal?: AbortSignal): Promise<RunRecord> {
  const payload = await requestJson(`/runs/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
    headers: { "x-meridian-action": "operator" },
    body: JSON.stringify({ reason: "Cancelled by operator" }),
    ...(signal ? { signal } : {}),
  });
  const run = normalizeRun(payload);
  if (!run) throw new ApiError(502, "INVALID_RUN_RESPONSE", "The cancellation response was invalid.");
  if (run.id !== id) {
    throw new ApiError(502, "RUN_BINDING_MISMATCH", "The cancellation response did not match the requested run.");
  }
  return run;
}

export interface HandoffInvitation {
  token: string;
  runId: string;
  interventionId: string;
  requiredRole: string;
  expiresAt: string;
  oneTime: true;
}

function handoffRun(payload: unknown, runId: string, interventionId: string): RunRecord {
  const run = normalizeRun(payload);
  if (!run || run.id !== runId) {
    throw new ApiError(502, "RUN_BINDING_MISMATCH", "The handoff response did not match the requested run.");
  }
  if (run.phase === "awaiting_human" && run.intervention?.interventionId !== interventionId) {
    throw new ApiError(502, "INTERVENTION_BINDING_MISMATCH", "The handoff response did not preserve the current intervention binding.");
  }
  return run;
}

async function mutateHandoff(
  runId: string,
  interventionId: string,
  operation: "take" | "resume",
): Promise<RunRecord> {
  const payload = await requestJson(`/runs/${encodeURIComponent(runId)}/handoff/${operation}`, {
    method: "POST",
    headers: { "x-meridian-action": "operator" },
    body: JSON.stringify({ interventionId }),
  });
  return handoffRun(payload, runId, interventionId);
}

export function takeHumanControl(runId: string, interventionId: string): Promise<RunRecord> {
  return mutateHandoff(runId, interventionId, "take");
}

export async function performHandoffAction(
  runId: string,
  interventionId: string,
  action: "restore_session" | "authenticate_supervisor",
): Promise<RunRecord> {
  const payload = await requestJson(`/runs/${encodeURIComponent(runId)}/handoff/action`, {
    method: "POST",
    headers: { "x-meridian-action": "operator" },
    body: JSON.stringify({ interventionId, action }),
  });
  return handoffRun(payload, runId, interventionId);
}

export function resumeHumanControl(runId: string, interventionId: string): Promise<RunRecord> {
  return mutateHandoff(runId, interventionId, "resume");
}

export async function createHandoffInvitation(
  runId: string,
  interventionId: string,
): Promise<HandoffInvitation> {
  const payload = await requestJson(`/runs/${encodeURIComponent(runId)}/handoff/invitations`, {
    method: "POST",
    headers: { "x-meridian-action": "operator" },
    body: JSON.stringify({ interventionId }),
  });
  const invitation = object(object(payload).invitation);
  const token = string(invitation.token);
  const requiredRole = string(invitation.requiredRole);
  const expiresAt = string(invitation.expiresAt);
  if (
    !/^[A-Za-z0-9_-]{43}$/u.test(token) ||
    invitation.runId !== runId ||
    invitation.interventionId !== interventionId ||
    !validId(requiredRole) ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    invitation.oneTime !== true
  ) {
    throw new ApiError(502, "INVALID_HANDOFF_INVITATION", "The service returned an invalid handoff invitation.");
  }
  return { token, runId, interventionId, requiredRole, expiresAt, oneTime: true };
}

export async function redeemHandoffInvitation(token: string): Promise<RunRecord> {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) {
    throw new ApiError(400, "HANDOFF_INVITATION_INVALID", "Enter the exact one-time handoff invitation.");
  }
  const payload = await requestJson("/handoff/invitations/redeem", {
    method: "POST",
    headers: { "x-meridian-action": "operator" },
    body: JSON.stringify({ token }),
  });
  const delegation = object(object(payload).delegation);
  const runId = string(delegation.runId);
  const interventionId = string(delegation.interventionId);
  const run = handoffRun(payload, runId, interventionId);
  if (
    !runId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(interventionId) ||
    !validId(string(delegation.requiredRole)) ||
    !Number.isFinite(Date.parse(string(delegation.expiresAt)))
  ) {
    throw new ApiError(502, "INVALID_HANDOFF_DELEGATION", "The service returned an invalid handoff delegation.");
  }
  return run;
}

export interface ReconciliationResponse {
  reconciliation: ReconciliationRecord;
  run?: RunRecord;
}

function normalizeReconciliation(payload: unknown, expectedSourceRunId: string): ReconciliationResponse {
  const envelope = object(payload);
  const source = object(envelope.reconciliation);
  const sourceRunId = string(source.sourceRunId);
  const runId = string(source.runId);
  const status = string(source.status);
  if (
    sourceRunId !== expectedSourceRunId ||
    !["not_started", "running", "running_or_complete", "complete"].includes(status) ||
    ((status === "running" || status === "running_or_complete") && !runId)
  ) {
    throw new ApiError(502, "INVALID_RECONCILIATION_RESPONSE", "The service returned an invalid reconciliation binding.");
  }
  const rawDecision = object(source.decision);
  const classification = string(rawDecision.classification);
  const checkedFields = array(rawDecision.checkedFields);
  const decision = status === "complete" &&
    ["applied", "not_applied", "still_unknown"].includes(classification) &&
    typeof rawDecision.reason === "string" &&
    rawDecision.reason.length > 0 &&
    checkedFields.length <= 100 &&
    checkedFields.every((field) => typeof field === "string" && validId(field))
    ? {
        classification: classification as NonNullable<ReconciliationRecord["decision"]>["classification"],
        reason: textForDisplay(rawDecision.reason),
        checkedFields: checkedFields as string[],
      }
    : undefined;
  if (status === "complete" && !decision) {
    throw new ApiError(502, "INVALID_RECONCILIATION_RESPONSE", "The service returned an incomplete reconciliation decision.");
  }
  const run = envelope.run === undefined ? undefined : normalizeRun(envelope.run);
  if (
    (envelope.run !== undefined && !run) ||
    (run && (
      !runId ||
      run.id !== runId ||
      run.orchestration?.kind !== "reconciliation" ||
      run.orchestration.sourceRunId !== expectedSourceRunId
    ))
  ) {
    throw new ApiError(502, "RECONCILIATION_BINDING_MISMATCH", "The service returned a read run outside the requested reconciliation lineage.");
  }
  return {
    reconciliation: {
      sourceRunId,
      status: status as ReconciliationRecord["status"],
      ...(runId ? { runId } : {}),
      ...(decision ? { decision } : {}),
    },
    ...(run ? { run } : {}),
  };
}

export async function startReconciliation(sourceRunId: string): Promise<ReconciliationResponse> {
  const payload = await requestJson(`/runs/${encodeURIComponent(sourceRunId)}/reconciliation`, {
    method: "POST",
    headers: { "x-meridian-action": "operator" },
    body: JSON.stringify({}),
  });
  const response = normalizeReconciliation(payload, sourceRunId);
  if (!response.run || !["running", "running_or_complete"].includes(response.reconciliation.status)) {
    throw new ApiError(502, "INVALID_RECONCILIATION_RESPONSE", "The service did not return the bound read-only reconciliation run.");
  }
  return response;
}

export async function getReconciliation(sourceRunId: string, signal?: AbortSignal): Promise<ReconciliationResponse> {
  const payload = await requestJson(
    `/runs/${encodeURIComponent(sourceRunId)}/reconciliation`,
    signal ? { signal } : {},
  );
  return normalizeReconciliation(payload, sourceRunId);
}

export interface ChatResponse {
  text: string;
  proposal?: { capabilityId: string; capabilityVersion: string; artifactDigest: string; targetProfileDigest: string; arguments: Record<string, JsonValue> };
  sequence?: ChatSequencePlan;
  routing?: { provider: string; model?: string };
}

function sequencePath(raw: unknown, allowEmpty: boolean): string[] | undefined {
  if (!Array.isArray(raw) || (!allowEmpty && raw.length === 0) || raw.length > 8) return undefined;
  if (raw.some((segment) => typeof segment !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,99}$/u.test(segment))) return undefined;
  return raw as string[];
}

function normalizeSequenceBinding(raw: unknown, priorStepIds: ReadonlySet<string>): ChatSequenceBinding | undefined {
  const binding = object(raw);
  const sourceStepId = string(binding.sourceStepId);
  const sourceCollectionPath = sequencePath(binding.sourceCollectionPath, false);
  const valuePath = sequencePath(binding.valuePath, true);
  const targetInput = string(binding.targetInput);
  if (
    !priorStepIds.has(sourceStepId) ||
    !sourceCollectionPath ||
    !valuePath ||
    !/^[A-Za-z][A-Za-z0-9_]{0,99}$/u.test(targetInput) ||
    binding.selection !== "exactly_one" ||
    binding.onZero !== "stop_no_match" ||
    binding.onMany !== "pause_for_authenticated_selection"
  ) return undefined;
  return {
    sourceStepId,
    sourceCollectionPath,
    valuePath,
    targetInput,
    selection: "exactly_one",
    onZero: "stop_no_match",
    onMany: "pause_for_authenticated_selection",
  };
}

function normalizeChatSequence(raw: unknown): ChatSequencePlan | undefined {
  const sequence = object(raw);
  const sequenceId = string(sequence.sequenceId);
  const expiresAt = string(sequence.expiresAt);
  const rawSteps = array(sequence.steps);
  if (
    sequence.kind !== "sequence" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(sequenceId) ||
    sequence.failurePolicy !== "stop_on_non_success" ||
    rawSteps.length < 1 ||
    rawSteps.length > 3 ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    Date.parse(expiresAt) <= Date.now()
  ) return undefined;
  const steps: ChatSequenceStep[] = [];
  const priorStepIds = new Set<string>();
  for (const rawStep of rawSteps) {
    const step = object(rawStep);
    const stepId = string(step.stepId);
    const toolName = string(step.toolName);
    const capabilityId = string(step.capabilityId);
    const capabilityVersion = string(step.capabilityVersion);
    const artifactDigest = string(step.artifactDigest);
    const targetProfileDigest = string(step.targetProfileDigest);
    const literalArgumentsSource = step.literalArguments;
    if (
      !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(stepId) ||
      priorStepIds.has(stepId) ||
      !/^[A-Za-z0-9_-]{1,64}$/u.test(toolName) ||
      !validId(capabilityId) ||
      !/^\d+\.\d+\.\d+$/u.test(capabilityVersion) ||
      !/^[a-f0-9]{64}$/u.test(artifactDigest) ||
      !/^[a-f0-9]{64}$/u.test(targetProfileDigest) ||
      literalArgumentsSource === null ||
      typeof literalArgumentsSource !== "object" ||
      Array.isArray(literalArgumentsSource) ||
      !Array.isArray(step.bindings) ||
      step.bindings.length > 16
    ) return undefined;
    const literalArguments = jsonValue(literalArgumentsSource) as Record<string, JsonValue>;
    const bindings = step.bindings.map((binding) => normalizeSequenceBinding(binding, priorStepIds));
    if (
      bindings.some((binding) => !binding) ||
      containsProtectedMaterial(literalArguments) ||
      new Set(bindings.map((binding) => binding!.targetInput)).size !== bindings.length ||
      bindings.some((binding) => Object.hasOwn(literalArguments, binding!.targetInput))
    ) return undefined;
    steps.push({
      stepId,
      toolName,
      capabilityId,
      capabilityVersion,
      literalArguments,
      bindings: bindings as ChatSequenceBinding[],
      artifactDigest,
      targetProfileDigest,
    });
    priorStepIds.add(stepId);
  }
  return { kind: "sequence", sequenceId, steps, failurePolicy: "stop_on_non_success", expiresAt };
}

export interface CreatedSession {
  run: RunRecord;
}

export async function createSession(
  profile: "teller" | "supervisor",
  branch: "MAIN-001" | "WEST-014" | "EAST-022",
): Promise<CreatedSession> {
  const payload = await requestJson("/sessions", {
    method: "POST",
    headers: { "x-meridian-action": "operator" },
    body: JSON.stringify({ profile, branch }),
  }, 30_000);
  const source = object(payload);
  const run = normalizeRun(source.run);
  if (
    !run ||
    run.capabilityId !== "session.sign_on" ||
    run.capabilityVersion !== "2.0.0" ||
    !run.artifactDigest ||
    !/^[a-f0-9]{64}$/u.test(run.artifactDigest) ||
    !run.targetProfileDigest ||
    !/^[a-f0-9]{64}$/u.test(run.targetProfileDigest)
  ) {
    throw new ApiError(502, "INVALID_SESSION_RESPONSE", "The service returned an invalid session response.");
  }
  return { run };
}

export async function postChat(
  message: string,
  history: ChatMessage[],
  signal?: AbortSignal,
): Promise<ChatResponse> {
  const payload = await requestJson("/chat", {
    method: "POST",
    headers: { "x-meridian-action": "operator" },
    body: JSON.stringify({
      message,
      history: history.slice(-8).map((item) => ({ role: item.role, text: item.text })),
    }),
    ...(signal ? { signal } : {}),
  }, CHAT_REQUEST_TIMEOUT_MS);
  const envelope = object(payload);
  const source = object(envelope.route ?? envelope.result ?? payload);
  const metadata = object(source.metadata);
  const kind = string(source.kind);
  const rawArguments = jsonValue(object(source.arguments)) as Record<string, JsonValue>;
  const artifactDigest = string(envelope.artifactDigest);
  const targetProfileDigest = string(envelope.targetProfileDigest);
  const proposal =
    kind === "invoke" &&
    typeof source.capabilityId === "string" &&
    source.capabilityId.length > 0 &&
    typeof source.capabilityVersion === "string" &&
    /^\d+\.\d+\.\d+$/u.test(source.capabilityVersion) &&
    /^[a-f0-9]{64}$/u.test(artifactDigest) &&
    /^[a-f0-9]{64}$/u.test(targetProfileDigest) &&
    !containsProtectedMaterial(rawArguments)
      ? {
          capabilityId: source.capabilityId,
          capabilityVersion: source.capabilityVersion,
          artifactDigest,
          targetProfileDigest,
          arguments: rawArguments,
        }
      : undefined;
  const sequence = kind === "sequence" ? normalizeChatSequence(source) : undefined;
  return {
    text: textForDisplay(
      string(
        source.text,
        string(
          source.assistantText,
          (kind === "invoke" && !proposal) || (kind === "sequence" && !sequence)
            ? "I could not prepare that request because its binding was incomplete or protected."
            : proposal
              ? "I matched an approved capability and am starting its exact validated request."
              : sequence
                ? "I matched an approved capability sequence and am starting its exact validated steps."
              : "Request received.",
        ),
      ),
    ),
    ...(proposal ? { proposal } : {}),
    ...(sequence ? { sequence } : {}),
    ...(typeof metadata.provider === "string" && metadata.provider.trim()
      ? {
          routing: {
            provider: textForDisplay(metadata.provider.slice(0, 80)),
            ...(typeof metadata.model === "string" && metadata.model.trim()
              ? { model: textForDisplay(metadata.model.slice(0, 120)) }
              : {}),
          },
        }
      : {}),
  };
}

function normalizePrincipal(raw: unknown): ConsolePrincipal | null {
  const envelope = object(raw);
  const source = object(envelope.principal ?? envelope.user ?? raw);
  const roles = array(source.roles).filter((item): item is string => typeof item === "string");
  const role = string(
    source.role,
    roles.includes("supervisor") ? "supervisor" : roles.includes("teller") ? "teller" : roles.includes("operator") ? "operator" : "",
  );
  if (!["operator", "teller", "supervisor"].includes(role)) return null;
  const id = string(source.id, string(source.operatorId, string(source.subject)));
  if (!id) return null;
  return {
    id,
    displayName: string(source.displayName, string(source.name, id)),
    role: role as ConsolePrincipal["role"],
  };
}

export interface AuthState {
  principal: ConsolePrincipal;
  meridianSession: null | {
    status: "provisioning" | "active";
    profile?: "teller" | "supervisor";
    branch?: "MAIN-001" | "WEST-014" | "EAST-022";
  };
}

export function normalizeAuthState(payload: unknown): AuthState | null {
  const envelope = object(payload);
  const principal = normalizePrincipal(payload);
  if (!principal) return null;
  const rawSession = object(envelope.meridianSession);
  if (Object.keys(rawSession).length === 0) return { principal, meridianSession: null };
  const sessionPrincipal = object(rawSession.principal);
  const profile = string(rawSession.role, string(sessionPrincipal.role));
  const branch = string(rawSession.branch, string(sessionPrincipal.branch));
  const state = string(rawSession.state);
  if (!["provisioning", "active", "busy"].includes(state)) return { principal, meridianSession: null };
  const validProfile = ["teller", "supervisor"].includes(profile);
  const validBranch = ["MAIN-001", "WEST-014", "EAST-022"].includes(branch);
  if (state !== "provisioning" && (!validProfile || !validBranch)) return { principal, meridianSession: null };
  return {
    principal,
    meridianSession: {
      status: state === "provisioning" ? "provisioning" : "active",
      ...(validProfile ? { profile: profile as "teller" | "supervisor" } : {}),
      ...(validBranch ? { branch: branch as "MAIN-001" | "WEST-014" | "EAST-022" } : {}),
    },
  };
}

export async function getAuthState(signal?: AbortSignal, touch = false): Promise<AuthState | null> {
  try {
    const payload = await requestJson("/auth/me", {
      ...(signal ? { signal } : {}),
      ...(touch ? { headers: { "x-meridian-activity": "operator" } } : {}),
    });
    const envelope = object(payload);
    if (envelope.authenticated === false) return null;
    const state = normalizeAuthState(payload);
    if (!state) throw new ApiError(502, "INVALID_AUTH_RESPONSE", "The service returned an invalid authentication response.");
    return state;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

export async function login(accessCode: string): Promise<ConsolePrincipal> {
  const payload = await requestJson("/auth/login", {
    method: "POST",
    headers: { "x-meridian-action": "operator" },
    body: JSON.stringify({ accessCode }),
  });
  const principal = normalizePrincipal(payload);
  if (!principal) throw new ApiError(502, "INVALID_AUTH_RESPONSE", "The service returned an invalid sign-in response.");
  return principal;
}

export async function logout(): Promise<void> {
  await requestJson("/auth/logout", {
    method: "POST",
    headers: { "x-meridian-action": "operator" },
  });
}

export function eventsUrl(runId: string): string {
  return `${API_ROOT}/runs/${encodeURIComponent(runId)}/events`;
}

export function normalizeLiveEvent(raw: unknown, eventType = "message", eventId = ""): LiveEvent {
  const source = object(raw);
  const data = object(source.data);
  const type = string(source.type, eventType);
  const title = textForDisplay(string(
    source.title,
    string(data.title, type.replace(/[._-]+/gu, " ").replace(/\b\w/gu, (letter) => letter.toUpperCase())),
  ));
  const summary = textForDisplay(string(source.summary, string(source.message, string(data.summary, string(data.message)))));
  const lowered = `${type} ${string(source.status)} ${string(data.status)}`.toLocaleLowerCase();
  const tone = /fail|error|denied|unknown/iu.test(lowered)
    ? "critical"
    : /recover|wait|approval|human|warn/iu.test(lowered)
      ? "warning"
      : /success|complete|succeed/iu.test(lowered)
        ? "positive"
        : "neutral";
  return {
    id: eventId || string(source.id, crypto.randomUUID()),
    type,
    timestamp: string(source.timestamp, string(source.occurredAt, new Date().toISOString())),
    title,
    ...(summary ? { summary } : {}),
    tone,
  };
}
