import { containsProtectedMaterial, isProtectedKey, redactForDisplay, textForDisplay } from "./security";
import type {
  ApprovalChallenge,
  Capability,
  CapabilityField,
  ChatMessage,
  ConsolePrincipal,
  FieldType,
  JsonValue,
  LiveEvent,
  RiskLevel,
  RunIncident,
  RunJournalEntry,
  RunPhase,
  RunRecord,
  TerminalStatus,
} from "./types";

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

function normalizeType(rawType: unknown, field: UnknownObject = {}): FieldType {
  if (typeof rawType === "string") {
    const supported = ["string", "number", "boolean", "money"].includes(rawType);
    const kind = supported ? rawType : "string";
    return {
      kind: kind as FieldType["kind"],
      ...(!supported ? { format: "unsupported" } : {}),
      ...(Array.isArray(field.enum) ? { enum: field.enum.map(jsonValue) } : {}),
      ...(typeof field.pattern === "string" ? { pattern: field.pattern } : {}),
    };
  }
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
    type: normalizeType(source.type, source),
    required: output ? false : boolean(source.required),
    classification: ["public", "internal", "confidential", "restricted", "secret"].includes(
      string(source.classification),
    )
      ? string(source.classification)
      : "secret",
  };
}

function validType(rawType: unknown, schemaVersion: string, output = false): boolean {
  if (schemaVersion === "1.0") {
    return typeof rawType === "string" && (output
      ? ["string", "number", "boolean", "money"].includes(rawType)
      : ["string", "number", "boolean"].includes(rawType));
  }
  if (schemaVersion !== "2.0" || typeof rawType === "string") return false;
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
    return Object.keys(properties).every(validId) && required.every(validId) && new Set(required).size === required.length && required.every((item) => Object.hasOwn(properties, item)) && Object.values(properties).every((item) => validType(item, "2.0"));
  }
  if (kind === "array") return only(["kind", "items", "maxItems"]) && source.items !== undefined && validType(source.items, "2.0") && integerIfPresent(source.maxItems) && !(typeof source.maxItems === "number" && (source.maxItems <= 0 || source.maxItems > 10_000));
  return true;
}

function validId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(value) && !["__proto__", "constructor", "prototype"].includes(value);
}

function validField(raw: unknown, output: boolean, schemaVersion: string): boolean {
  const source = object(raw);
  const legacy = schemaVersion === "1.0";
  const allowed = output || !legacy
    ? ["name", "description", "type", "classification", ...(!output && !legacy ? ["required"] : [])]
    : ["name", "description", "type", "required", "classification", "pattern", "enum"];
  const classifications = legacy
    ? ["public", "internal", "confidential", "restricted"]
    : ["public", "internal", "confidential", "restricted", "secret"];
  const validPattern = source.pattern === undefined || (
    typeof source.pattern === "string" && source.pattern.length > 0 && (() => {
      try { new RegExp(source.pattern as string, "u"); return true; } catch { return false; }
    })()
  );
  const validEnum = source.enum === undefined || (
    Array.isArray(source.enum) && source.enum.length > 0 && source.enum.every((item) =>
      item === null || typeof item === "string" || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item)),
    )
  );
  return (
    Object.keys(source).every((key) => allowed.includes(key)) &&
    typeof source.name === "string" &&
    validId(source.name) &&
    typeof source.description === "string" &&
    source.description.trim().length > 0 &&
    validType(source.type, schemaVersion, output) &&
    (output || typeof source.required === "boolean") &&
    classifications.includes(string(source.classification)) &&
    validPattern &&
    validEnum
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
  const inputSource = metadata.inputs ?? artifact.inputs;
  const outputSource = metadata.outputs ?? artifact.outputs;
  const rawInputs = array(inputSource);
  const rawOutputs = array(outputSource);
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
    contractValid:
      validId(id) &&
      name.trim().length > 0 &&
      /^\d+\.\d+\.\d+$/u.test(version) &&
      ["1.0", "2.0"].includes(schemaVersion) &&
      ["draft", "approved", "retired"].includes(approval) &&
      ["read", "write", "irreversible", "supervisor_only"].includes(string(rawRisk)) &&
      /^[a-f0-9]{64}$/u.test(digest) &&
      Array.isArray(inputSource) &&
      Array.isArray(outputSource) &&
      rawInputs.every((item) => validField(item, false, schemaVersion)) &&
      rawOutputs.every((item) => validField(item, true, schemaVersion)) &&
      new Set(inputs.map((field) => field.name)).size === inputs.length &&
      new Set(outputs.map((field) => field.name)).size === outputs.length &&
      inputs.length === rawInputs.length &&
      outputs.length === rawOutputs.length,
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
      category: ["recoverable", "failure", "escalation"].includes(category)
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
  const outputContainer = Object.hasOwn(result, "outputs") ? result : source;
  const normalizedOutputs = record(outputContainer.outputs);
  return {
    id,
    capabilityId: string(source.capabilityId, string(result.capabilityId, "unknown")),
    capabilityVersion: string(source.capabilityVersion, string(result.capabilityVersion)),
    ...(typeof source.artifactDigest === "string" || typeof result.artifactDigest === "string"
      ? { artifactDigest: string(source.artifactDigest, string(result.artifactDigest)) }
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
    ],
    ...(challenge ? { challenge } : {}),
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

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
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
      throw new ApiError(
        response.status,
        string(error.code, `HTTP_${response.status}`),
        textForDisplay(string(error.message, "The service could not complete that request.")),
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

export async function createRun(
  request: {
    capability: Capability;
    inputs: Record<string, JsonValue>;
    idempotencyKey: string;
  },
): Promise<RunRecord> {
  const { capability, inputs, idempotencyKey } = request;
  const payload = await requestJson("/runs", {
    method: "POST",
    headers: { "idempotency-key": idempotencyKey, "x-meridian-action": "operator" },
    body: JSON.stringify({
      capabilityId: capability.id,
      capabilityVersion: capability.version,
      artifactDigest: capability.digest,
      inputs,
    }),
  });
  const run = normalizeRun(payload);
  if (!run) throw new ApiError(502, "INVALID_RUN_RESPONSE", "The service did not return a run ID.");
  if (
    run.capabilityId !== capability.id ||
    run.capabilityVersion !== capability.version ||
    run.artifactDigest !== capability.digest
  ) {
    throw new ApiError(502, "RUN_BINDING_MISMATCH", "The service returned a run that did not match the reviewed capability binding.");
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

export interface ChatResponse {
  text: string;
  proposal?: { capabilityId: string; capabilityVersion: string; artifactDigest: string; arguments: Record<string, JsonValue> };
  routing?: { provider: string; model?: string; fallbackFrom?: string };
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
    !/^[a-f0-9]{64}$/u.test(run.artifactDigest)
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
  const proposal =
    kind === "invoke" &&
    typeof source.capabilityId === "string" &&
    source.capabilityId.length > 0 &&
    typeof source.capabilityVersion === "string" &&
    /^\d+\.\d+\.\d+$/u.test(source.capabilityVersion) &&
    /^[a-f0-9]{64}$/u.test(artifactDigest) &&
    !containsProtectedMaterial(rawArguments)
      ? {
          capabilityId: source.capabilityId,
          capabilityVersion: source.capabilityVersion,
          artifactDigest,
          arguments: rawArguments,
        }
      : undefined;
  return {
    text: textForDisplay(
      string(
        source.text,
        string(
          source.assistantText,
          kind === "invoke" && !proposal
            ? "I could not prepare that request because its binding was incomplete or protected."
            : proposal
              ? "I prepared a capability request for review."
              : "Request received.",
        ),
      ),
    ),
    ...(proposal ? { proposal } : {}),
    ...(typeof metadata.provider === "string" && metadata.provider.trim()
      ? {
          routing: {
            provider: textForDisplay(metadata.provider.slice(0, 80)),
            ...(typeof metadata.model === "string" && metadata.model.trim()
              ? { model: textForDisplay(metadata.model.slice(0, 120)) }
              : {}),
            ...(typeof metadata.fallbackFrom === "string" && metadata.fallbackFrom.trim()
              ? { fallbackFrom: textForDisplay(metadata.fallbackFrom.slice(0, 80)) }
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
