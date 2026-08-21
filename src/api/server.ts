import { createHash, randomBytes } from "node:crypto";
import { lstat, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { CapabilityCatalog, CapabilityMetadata } from "../catalog/index.js";
import {
  catalogToChatTools,
  ChatRoutingError,
  prepareChatTools,
  type ChatRouter,
  validateToolInput,
  JsonObjectSchema,
} from "../chat/index.js";
import {
  CapabilityArtifactV2Schema,
  type CapabilityArtifactV2,
  type FieldSpecV2,
  type RunValueV2,
  type TypeSpecV2,
} from "../domain/index.js";
import { validateInvocationInputsV2 } from "../replay/replayRunnerV2.js";
import {
  classifyReconciliation,
  isReconcilableCapability,
  reconciliationReadInputs,
  type ReconcilableCapabilityId,
} from "../reconciliation/index.js";
import type { RunManager, RunManagerEvent, RunSnapshot } from "../runs/index.js";
import { RunManagerError } from "../runs/index.js";
import { sha256Digest } from "../security/digest.js";
import {
  SessionManagerError,
  type SessionManager,
  type SessionPrincipal,
} from "../sessions/index.js";
import type { PlaywrightSurface } from "../surface/playwright/playwrightSurface.js";
import { parseRuntimeValue } from "../surface/replayRuntimeV2.js";
import {
  CONSOLE_COOKIE_NAME,
  ConsoleIdentityError,
  type ConsoleIdentityProvider,
  type ConsolePrincipal,
} from "./identity.js";
import {
  DiscoveryRunDetailResponseSchema,
  DiscoveryRunIdSchema,
  DiscoveryRunListResponseSchema,
  PublishedDiscoveryHistory,
} from "./discoveryRuns.js";
import { SequenceCoordinator, SequenceCoordinatorError } from "./sequenceCoordinator.js";

const IdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/u);
const VersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/u);

const RunRequestSchema = z
  .object({
    capabilityId: IdSchema,
    capabilityVersion: VersionSchema.optional(),
    artifactDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    targetProfileDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    inputs: JsonObjectSchema,
    idempotencyKey: z.string().min(1).max(200).optional(),
    sequence: z
      .object({
        sequenceId: z.string().uuid(),
        stepId: z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_-]*$/u),
        selectionIndex: z.number().int().nonnegative().max(10_000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const SessionRequestSchema = z
  .object({
    profile: z.enum(["teller", "supervisor"]),
    branch: z.enum(["MAIN-001", "WEST-014", "EAST-022"]).default("MAIN-001"),
  })
  .strict();

const ChatRequestSchema = z
  .object({
    message: z.string().min(1).max(8_000),
    history: z
      .array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().min(1).max(8_000) }).strict())
      .max(20)
      .default([]),
  })
  .strict();

const CancelRequestSchema = z.object({ reason: z.string().min(1).max(500).optional() }).strict();
const LoginRequestSchema = z.object({ accessCode: z.string().min(16).max(512) }).strict();
const ApprovalRequestSchema = z
  .object({ challengeId: z.string().uuid(), decision: z.literal("approve") })
  .strict();
const HandoffRequestSchema = z.object({ interventionId: z.string().uuid() }).strict();
const HandoffActionRequestSchema = z
  .object({
    interventionId: z.string().uuid(),
    action: z.enum(["restore_session", "authenticate_supervisor"]),
  })
  .strict();
const HandoffInvitationRequestSchema = z.object({ interventionId: z.string().uuid() }).strict();
const HandoffInvitationRedeemSchema = z
  .object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/u) })
  .strict();
const SSE_CONNECTION_MAX_MS = 5 * 60_000;
const MAX_API_CHAT_ROUTER_TIMEOUT_MS = 18_000;
const CHAT_TRANSPORT_GRACE_MS = 500;
const MAX_EVIDENCE_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_EVIDENCE_FILE_BYTES = 32 * 1024 * 1024;
const MAX_EVIDENCE_BUNDLE_BYTES = 128 * 1024 * 1024;

const EvidenceReferenceSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(["screenshot", "dom", "json", "text", "attachment"]),
  path: z.string().min(1).max(1_000),
  mimeType: z.string().min(1).max(256),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  bytes: z.number().int().min(0).max(MAX_EVIDENCE_FILE_BYTES),
  createdAt: z.string().min(1).max(64).refine((value) => Number.isFinite(Date.parse(value))),
  masked: z.boolean().optional(),
  redacted: z.boolean().optional(),
}).strict();

const EvidenceManifestSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1).max(160),
  createdAt: z.string().min(1).max(64).refine((value) => Number.isFinite(Date.parse(value))),
  metadata: z.unknown(),
  evidence: z.array(EvidenceReferenceSchema).max(10_000),
}).strict();

export interface CredentialProfile {
  operator: string;
  password: string;
  role: "teller" | "supervisor";
}

export interface ApiServerOptions {
  catalog: CapabilityCatalog;
  runs: RunManager;
  sessions: SessionManager<PlaywrightSurface>;
  chat: ChatRouter;
  identity: ConsoleIdentityProvider;
  credentials: Readonly<Record<"teller" | "supervisor", CredentialProfile | undefined>>;
  evidenceRoot: string;
  /** Digest of the server-selected non-secret target instance profile. */
  targetProfileDigest?: string;
  /** Called before session.sign_on runner construction to establish trusted role metadata. */
  registerPendingPrincipal: (
    sessionRef: string,
    principal: SessionPrincipal,
    signOnInputs: Readonly<Record<string, RunValueV2>>,
  ) => void;
  clearPendingPrincipal: (sessionRef: string) => void;
  /** Additional exact console/bootstrap secrets blocked from model traffic. */
  chatRedactionSecrets?: readonly string[];
  logger?: boolean;
}

export function credentialProfilesFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): ApiServerOptions["credentials"] {
  const profile = (role: "teller" | "supervisor", operatorDefault: string): CredentialProfile | undefined => {
    const prefix = role === "teller" ? "MERIDIAN_TELLER" : "MERIDIAN_SUPERVISOR";
    const password = environment[`${prefix}_PASSWORD`];
    if (!password) return undefined;
    return {
      operator: environment[`${prefix}_OPERATOR`]?.trim() || operatorDefault,
      password,
      role,
    };
  };
  return Object.freeze({
    teller: profile("teller", "teller1"),
    supervisor: profile("supervisor", "super1"),
  });
}

function latestCapability(catalog: CapabilityCatalog, id: string, version?: string): CapabilityMetadata | undefined {
  if (version) return catalog.get(id, version);
  return catalog
    .list()
    .filter((item) => item.id === id)
    .sort((left, right) => right.version.localeCompare(left.version, "en-US", { numeric: true }))[0];
}

function errorStatus(error: unknown): number {
  if (error instanceof z.ZodError) return 400;
  if (error instanceof SequenceCoordinatorError) return error.statusCode;
  if (error instanceof ChatRoutingError) {
    if (error.code === "INVALID_REQUEST" || error.code === "SECRET_INPUT_BLOCKED") return 400;
    if (error.code === "INVALID_TOOL_INPUT") return 422;
    if (error.code === "REQUEST_CANCELLED") return 408;
    if (error.code === "PROVIDER_CONFIGURATION_ERROR" || error.code === "PROVIDER_UNAVAILABLE") return 503;
    if (error.code === "INVALID_TOOL_DEFINITION") return 503;
    return 502;
  }
  if (error instanceof ConsoleIdentityError) {
    if (error.code === "AUTH_RATE_LIMITED") return 429;
    if (error.code === "AUTH_UNAVAILABLE") return 503;
    return 401;
  }
  if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return 404;
  if (error instanceof RunManagerError) {
    if (error.code === "INVALID_REQUEST") return 400;
    if (error.code === "RUN_NOT_FOUND") return 404;
    if (error.code === "QUEUE_FULL") return 429;
    if (error.code === "IDEMPOTENCY_CONFLICT") return 409;
    if (error.code === "IDEMPOTENCY_RETAINED") return 409;
    if (error.code === "IDEMPOTENCY_LEDGER_UNAVAILABLE") return 503;
    if (
      error.code === "RUN_NOT_APPROVABLE" ||
      error.code === "RUN_NOT_HANDOFFABLE" ||
      error.code === "RUN_NOT_CANCELLABLE"
    ) return 409;
    if (error.code === "ROLE_REQUIRED" || error.code === "MODEL_APPROVAL_FORBIDDEN") return 403;
    if (error.code === "MANAGER_CLOSED") return 503;
  }
  if (error instanceof SessionManagerError) {
    if (error.code === "SESSION_NOT_FOUND" || error.code === "SESSION_EXPIRED") return 409;
    if (error.code === "SESSION_QUEUE_FULL") return 429;
    if (error.code === "SESSION_ACQUIRE_TIMEOUT") return 503;
    if (error.code === "SESSION_ACQUIRE_CANCELLED") return 409;
    return 409;
  }
  return 500;
}

function assertBoundedJson(value: unknown, maximumDepth = 32, maximumNodes = 10_000): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > maximumNodes || current.depth > maximumDepth) {
      throw new RunManagerError("INVALID_REQUEST", "Request JSON exceeds the allowed size or nesting depth.");
    }
    if (Array.isArray(current.value)) {
      for (const item of current.value) pending.push({ value: item, depth: current.depth + 1 });
    } else if (current.value && typeof current.value === "object") {
      for (const item of Object.values(current.value)) pending.push({ value: item, depth: current.depth + 1 });
    }
  }
}

function errorCode(error: unknown): string {
  if (error instanceof z.ZodError) return "REQUEST_INVALID";
  if (error instanceof SequenceCoordinatorError) return error.code;
  if (error instanceof ChatRoutingError) return error.code;
  if (error instanceof ConsoleIdentityError) return error.code;
  if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return "EVIDENCE_NOT_FOUND";
  if (error instanceof RunManagerError) return error.code;
  if (error instanceof SessionManagerError) return error.code;
  return "INTERNAL_ERROR";
}

function errorMessage(error: unknown, status: number): string {
  if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return "Evidence not found.";
  if (error instanceof ChatRoutingError) {
    const messages: Readonly<Record<ChatRoutingError["code"], string>> = {
      INVALID_REQUEST: "The assistant request was invalid.",
      INVALID_TOOL_DEFINITION: "The approved assistant capability schema is temporarily unavailable.",
      INVALID_TOOL_INPUT: "The assistant proposal did not pass local capability validation.",
      SECRET_INPUT_BLOCKED: "Authentication material is not allowed in assistant messages or proposals.",
      TOOL_CALL_LIMIT_EXCEEDED: "The assistant returned too many capability proposals.",
      REQUEST_CANCELLED: "The assistant request was cancelled.",
      PROVIDER_CONFIGURATION_ERROR: "The assistant provider is not configured safely.",
      PROVIDER_REQUEST_FAILED: "The assistant provider rejected the routing request.",
      PROVIDER_RESPONSE_INVALID: "The assistant provider returned an invalid routing response.",
      PROVIDER_UNAVAILABLE: "The assistant provider is temporarily unavailable.",
    };
    return messages[error.code];
  }
  if (error instanceof SequenceCoordinatorError) return error.message;
  if (status >= 500) return "The server could not complete the request safely.";
  return error instanceof Error ? error.message : "The request was rejected.";
}

function identityRequest(request: FastifyRequest, touch = false) {
  const cookie = request.headers.cookie;
  const authorization = request.headers.authorization;
  return {
    ...(typeof cookie === "string" ? { cookieHeader: cookie } : {}),
    ...(typeof authorization === "string" ? { authorizationHeader: authorization } : {}),
    ...(touch ? { touch: true } : {}),
  };
}

function authCookie(sessionToken: string, maxAgeSeconds: number, secure: boolean): string {
  return [
    `${CONSOLE_COOKIE_NAME}=${sessionToken}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

function requestUsesSecureCookie(request: FastifyRequest): boolean {
  return request.protocol === "https" || process.env.CONSOLE_COOKIE_SECURE === "1";
}

function assertMutationHeader(request: FastifyRequest): void {
  if (request.headers["x-meridian-action"] !== "operator") {
    throw new RunManagerError("ROLE_REQUIRED", "Operator mutation header is required");
  }
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (origin && host) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new RunManagerError("INVALID_REQUEST", "Request Origin header is invalid");
    }
    if (parsed.host !== host) throw new RunManagerError("ROLE_REQUIRED", "Cross-origin operator action was rejected");
  }
}

function effectiveApprovalRoles(
  principal: ConsolePrincipal,
  sessionRole: SessionPrincipal["role"] | undefined,
): readonly ("teller" | "supervisor")[] {
  if (!sessionRole) return [];
  return principal.roles.filter((role) => sessionRole === "supervisor" || role === "teller");
}

function normalizeValue(type: TypeSpecV2, value: RunValueV2): RunValueV2 {
  if (type.kind === "money" && typeof value === "string") return parseRuntimeValue(type, value);
  if (type.kind === "array" && Array.isArray(value)) {
    return value.map((item) => normalizeValue(type.items, item));
  }
  if (type.kind === "object" && value && typeof value === "object" && !Array.isArray(value)) {
    const source = value as Record<string, RunValueV2>;
    const output = Object.create(null) as Record<string, RunValueV2>;
    for (const [key, item] of Object.entries(source)) {
      const child = type.properties[key];
      output[key] = child ? normalizeValue(child, item) : item;
    }
    return output;
  }
  return value;
}

function normalizeInputs(
  fields: readonly FieldSpecV2[],
  values: Readonly<Record<string, RunValueV2>>,
): Record<string, RunValueV2> {
  const fieldByName = new Map(fields.map((field) => [field.name, field]));
  const output = Object.create(null) as Record<string, RunValueV2>;
  for (const [name, value] of Object.entries(values)) {
    const field = fieldByName.get(name);
    output[name] = field ? normalizeValue(field.type, value) : value;
  }
  const errors = validateInvocationInputsV2(fields, output);
  if (errors.length > 0) {
    throw new z.ZodError(
      errors.map((message) => ({
        code: "custom",
        path: ["inputs"],
        message,
        input: undefined,
      })),
    );
  }
  return output;
}

const PROTECTED_OUTPUT_KEY =
  /(?:^|[_\-.])(?:password|passwd|passcode|pin|secret|authorization|cookie|csrf|api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|private[_-]?key)(?:$|[_\-.])/iu;
const PROTECTED_OUTPUT_TEXT =
  /(?:\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\b(?:sk-ant|sk-proj|sk-live)-[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/u;

function isProtectedOutputKey(key: string): boolean {
  const normalized = key.replace(/([a-z])([A-Z])/gu, "$1_$2").toLocaleLowerCase("en-US");
  return PROTECTED_OUTPUT_KEY.test(`_${normalized}_`);
}

function safeOutputValue(value: RunValueV2, key = "", depth = 0): RunValueV2 {
  if (isProtectedOutputKey(key) || depth > 20) return "[Protected]";
  if (typeof value === "string") return PROTECTED_OUTPUT_TEXT.test(value) ? "[Protected]" : value;
  if (Array.isArray(value)) return value.slice(0, 10_000).map((item) => safeOutputValue(item, "", depth + 1));
  if (value && typeof value === "object") {
    const output = Object.create(null) as Record<string, RunValueV2>;
    for (const [childKey, child] of Object.entries(value).slice(0, 10_000)) {
      output[childKey] = safeOutputValue(child, childKey, depth + 1);
    }
    return output;
  }
  return value;
}

function projectTypedOutput(
  type: TypeSpecV2,
  value: RunValueV2,
  key: string,
  depth = 0,
): RunValueV2 {
  if (isProtectedOutputKey(key) || depth > 20) return "[Protected]";
  if (type.kind === "array") {
    if (!Array.isArray(value)) return "[Protected]";
    return value.slice(0, type.maxItems ?? 10_000).map((item) =>
      projectTypedOutput(type.items, item, "", depth + 1),
    );
  }
  if (type.kind === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return "[Protected]";
    const source = value as Record<string, RunValueV2>;
    const projected = Object.create(null) as Record<string, RunValueV2>;
    for (const [childKey, childType] of Object.entries(type.properties)) {
      if (!Object.hasOwn(source, childKey)) continue;
      projected[childKey] = projectTypedOutput(childType, source[childKey]!, childKey, depth + 1);
    }
    return projected;
  }
  if (type.kind === "money") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return "[Protected]";
    const source = value as Record<string, RunValueV2>;
    return {
      currency: safeOutputValue(source.currency ?? "[Protected]", "currency", depth + 1),
      amount: safeOutputValue(source.amount ?? "[Protected]", "amount", depth + 1),
      minorUnits: safeOutputValue(source.minorUnits ?? "[Protected]", "minorUnits", depth + 1),
    };
  }
  if (value !== null && typeof value === "object") return "[Protected]";
  return safeOutputValue(value, key, depth);
}

function tableColumns(artifact: CapabilityArtifactV2, outputName: string) {
  for (const step of artifact.steps) {
    if (step.action.kind === "extract_table" && step.action.outputName === outputName) {
      return step.action.columns;
    }
  }
  return undefined;
}

function projectedOutputs(
  artifact: CapabilityArtifactV2,
  values: Readonly<Record<string, RunValueV2>>,
): Record<string, RunValueV2> {
  const output = Object.create(null) as Record<string, RunValueV2>;
  for (const field of artifact.outputs) {
    if (!Object.hasOwn(values, field.name)) continue;
    if (field.classification === "secret" || isProtectedOutputKey(field.name)) {
      output[field.name] = "[Protected]";
      continue;
    }
    const value = values[field.name]!;
    const columns = tableColumns(artifact, field.name);
    if (columns && Array.isArray(value)) {
      output[field.name] = value.map((row) => {
        if (!row || typeof row !== "object" || Array.isArray(row)) return "[Protected]";
        const source = row as Record<string, RunValueV2>;
        const projected = Object.create(null) as Record<string, RunValueV2>;
        for (const column of columns) {
          if (!Object.hasOwn(source, column.key)) continue;
          projected[column.key] =
            column.classification === "secret" || isProtectedOutputKey(column.key)
              ? "[Protected]"
              : projectTypedOutput(column.type, source[column.key]!, column.key);
        }
        return projected;
      });
      continue;
    }
    output[field.name] = projectTypedOutput(field.type, value, field.name);
  }
  return output;
}

const PUBLIC_RUN_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  APPLICATION_ERROR: "MERIDIAN reported an application error; no blind retry was attempted.",
  AUTHENTICATION_REQUIRED: "The target session is no longer authenticated.",
  EFFECT_UNKNOWN: "The target effect could not be proven. Reconcile before retrying.",
  HOLD_ALREADY_EXISTS: "The requested hold already exists.",
  INSUFFICIENT_FUNDS: "MERIDIAN rejected the operation because funds were insufficient.",
  INVALID_ADDRESS: "MERIDIAN rejected the submitted address.",
  INVALID_CREDENTIALS: "The target-system sign-in was not accepted.",
  INVALID_EMAIL: "MERIDIAN rejected the submitted email address.",
  INVALID_PHONE: "MERIDIAN rejected the submitted phone number.",
  MAINTENANCE: "MERIDIAN is in maintenance mode.",
  MEMBER_NOT_FOUND: "No matching member was found.",
  RECORD_NOT_FOUND: "The requested record was not found.",
  RECOVERY_EXHAUSTED: "The declared recovery attempt was exhausted.",
  REVIEW_STALE: "The prepared review values changed before approval and were not committed.",
  SESSION_EXPIRED: "The target session expired and must be reconnected.",
  SOURCE_SHARE_HELD: "The source share is held and cannot be used for this operation.",
  SUPERVISOR_REQUIRED: "This operation requires a supervisor-authorized session.",
  VALIDATION_REJECTED: "MERIDIAN rejected the submitted values.",
  WRITE_OUTCOME_UNKNOWN: "The write outcome could not be proven. Reconcile before retrying.",
});

function publicCode(value: unknown, fallback = "RUN_CONDITION"): string {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,99}$/u.test(value) ? value : fallback;
}

function publicRunMessage(code: unknown): string {
  const safeCode = publicCode(code);
  return PUBLIC_RUN_MESSAGES[safeCode] ?? "The guarded run reported a typed execution condition.";
}

function trustedArtifactLabel(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() && value.length <= 300 ? value : fallback;
}

function projectJournal(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 2_000).flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const source = entry as Record<string, unknown>;
    const status = source.status === "started" || source.status === "succeeded" || source.status === "failed"
      ? source.status
      : "failed";
    return [{
      sequence: Number.isSafeInteger(source.sequence) ? source.sequence : 0,
      stepId: trustedArtifactLabel(source.stepId, "unknown_step"),
      title: trustedArtifactLabel(source.title, "Guarded step"),
      action: trustedArtifactLabel(source.action, "unknown"),
      effect: trustedArtifactLabel(source.effect, "none"),
      attempt: Number.isSafeInteger(source.attempt) ? source.attempt : 1,
      status,
      ...(typeof source.startedAt === "string" ? { startedAt: source.startedAt } : {}),
      ...(typeof source.completedAt === "string" ? { completedAt: source.completedAt } : {}),
      summary: status === "failed" ? "Step stopped at a guarded boundary." : status === "succeeded" ? "Step completed." : "Step started.",
    }];
  });
}

function projectIncidents(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 500).flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const source = entry as Record<string, unknown>;
    const code = publicCode(source.code);
    const category =
      source.category === "recoverable" ||
      source.category === "failure" ||
      source.category === "escalation" ||
      source.category === "intervention"
      ? source.category
      : "failure";
    return [{
      code,
      category,
      message: publicRunMessage(code),
      ...(typeof source.stepId === "string" ? { stepId: trustedArtifactLabel(source.stepId, "unknown_step") } : {}),
      ...(typeof source.occurredAt === "string" ? { occurredAt: source.occurredAt } : {}),
      ...(Number.isSafeInteger(source.recoveryAttempt) ? { recoveryAttempt: source.recoveryAttempt } : {}),
    }];
  });
}

function publicSnapshot(
  snapshot: RunSnapshot,
  sessions: SessionManager<PlaywrightSurface>,
  catalog: CapabilityCatalog,
  principal: ConsolePrincipal,
): unknown {
  const output = structuredClone(snapshot) as unknown as Record<string, unknown>;
  delete output.sessionRef;
  delete output.inputDigest;
  const inputNames = Array.isArray(output.inputNames)
    ? output.inputNames.filter((name): name is string => typeof name === "string")
    : [];
  delete output.inputNames;
  const inputEntry = catalog.resolve(snapshot.capabilityId, snapshot.capabilityVersion);
  if (inputEntry) {
    const allowedNames = new Set(inputEntry.artifact.inputs.map((field) => field.name));
    output.inputs = Object.fromEntries(
      inputNames.filter((name) => allowedNames.has(name)).map((name) => [name, "[Protected]"]),
    );
  }
  const progress = output.progress as Record<string, unknown> | undefined;
  if (progress) {
    if (snapshot.phase === "completed" || snapshot.cancellation || snapshot.managerFailure) {
      delete progress.challenge;
      delete progress.intervention;
    }
    if (Object.hasOwn(progress, "journal")) progress.journal = projectJournal(progress.journal);
    if (Object.hasOwn(progress, "incidents")) progress.incidents = projectIncidents(progress.incidents);
  }
  const result = progress?.result as Record<string, unknown> | undefined;
  if (result) {
    delete result.sessionRef;
    delete result.inputDigest;
    delete result.evidencePaths;
    result.journal = projectJournal(result.journal);
    result.incidents = projectIncidents(result.incidents);
    if (result.status !== "success") {
      const code = publicCode(result.code);
      result.code = code;
      result.message = publicRunMessage(code);
    }
    if (result.reconciliationOutputs && typeof result.reconciliationOutputs === "object") {
      const entry = catalog.resolve(snapshot.capabilityId, snapshot.capabilityVersion);
      result.reconciliationOutputs = entry
        ? projectedOutputs(
            CapabilityArtifactV2Schema.parse(entry.artifact),
            result.reconciliationOutputs as Readonly<Record<string, RunValueV2>>,
          )
        : {};
    }
    if (result.status === "success" && result.outputs && typeof result.outputs === "object") {
      const entry = catalog.resolve(snapshot.capabilityId, snapshot.capabilityVersion);
      if (entry) {
        result.outputs = projectedOutputs(
          CapabilityArtifactV2Schema.parse(entry.artifact),
          result.outputs as Record<string, RunValueV2>,
        );
        result.outputsDisplaySafe = true;
      } else {
        delete result.outputs;
        result.outputsDisplaySafe = false;
      }
    }
  }
  const managerFailure = output.managerFailure as Record<string, unknown> | undefined;
  if (managerFailure) {
    managerFailure.code = publicCode(managerFailure.code, "RUNNER_FAILED");
    managerFailure.message = "The deterministic execution service could not complete this run.";
  }
  const cancellation = output.cancellation as Record<string, unknown> | undefined;
  if (cancellation) {
    const code = cancellation.code === "TTL_EXPIRED" ? "TTL_EXPIRED" : "CANCELLED";
    cancellation.code = code;
    cancellation.reason = code === "TTL_EXPIRED"
      ? "Approval expired before authorization; no pending effect was committed."
      : "The run was cancelled at a safe boundary.";
  }
  const challenge = progress?.challenge as Record<string, unknown> | undefined;
  const summary = challenge?.summary;
  if (challenge) {
    const session = sessions.get(snapshot.sessionRef);
    const sessionRole = session && (session.state === "active" || session.state === "busy")
      ? session.principal?.role
      : undefined;
    const effectiveRoles = effectiveApprovalRoles(principal, sessionRole);
    const authorizedRoles = challenge.requirement === "supervisor_confirmation"
      ? effectiveRoles.filter((role) => role === "supervisor")
      : effectiveRoles;
    challenge.authorizedRoles = authorizedRoles;
    const authorized = authorizedRoles.length > 0;
    if (Array.isArray(summary)) {
      challenge.summary = summary.map((raw) => {
        const item = raw as Record<string, unknown>;
        const targetId = typeof item.targetId === "string" ? item.targetId : "unknown";
        const forbidden = isProtectedOutputKey(targetId);
        const displayValue = forbidden
          ? "[Protected]"
          : safeOutputValue(item.value as RunValueV2, targetId);
        const displaySafe = authorized && !forbidden && displayValue !== "[Protected]";
        return {
          targetId,
          sensitive: item.sensitive === true,
          displaySafe,
          ...(displaySafe ? { displayValue } : {}),
        };
      });
    }
  }
  const intervention = progress?.intervention as Record<string, unknown> | undefined;
  if (intervention) {
    const state =
      intervention.state === "human_active" ||
      intervention.state === "action_completed" ||
      intervention.state === "revalidating"
        ? intervention.state
        : "awaiting_human";
    progress!.intervention = {
      interventionId:
        typeof intervention.interventionId === "string" && /^[A-Fa-f0-9-]{36}$/u.test(intervention.interventionId)
          ? intervention.interventionId
          : "00000000-0000-0000-0000-000000000000",
      runId: snapshot.runId,
      stepId: trustedArtifactLabel(intervention.stepId, "checkpoint"),
      reasonCode: publicCode(intervention.reasonCode, "INTERVENTION_REQUIRED"),
      action: intervention.action === "authenticate_supervisor" ? "authenticate_supervisor" : "restore_session",
      state,
      ...(typeof intervention.requiredRole === "string"
        ? { requiredRole: trustedArtifactLabel(intervention.requiredRole, "operator") }
        : {}),
      ...(typeof intervention.createdAt === "string" ? { createdAt: intervention.createdAt } : {}),
      ...(typeof intervention.expiresAt === "string" ? { expiresAt: intervention.expiresAt } : {}),
      sameLiveSession: true,
    };
  }
  return output;
}

interface ValidatedEvidenceBundle {
  readonly evidence: readonly { path: string; bytes: number }[];
  readonly hashes: ReadonlyMap<string, string>;
  readonly finalized: boolean;
}

async function validatedEvidenceBundle(root: string, runId: string): Promise<ValidatedEvidenceBundle> {
  try {
    const manifestPath = await resolveEvidenceFile(root, runId, "manifest.json");
    const manifestStats = await lstat(manifestPath);
    if (manifestStats.size <= 0 || manifestStats.size > MAX_EVIDENCE_MANIFEST_BYTES) {
      throw evidenceNotFound();
    }
    const manifestBytes = await readFile(manifestPath);
    const manifest = EvidenceManifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")) as unknown);
    if (manifest.runId !== runId) throw evidenceNotFound();
    if (
      !manifest.metadata ||
      typeof manifest.metadata !== "object" ||
      Array.isArray(manifest.metadata) ||
      (manifest.metadata as Record<string, unknown>).evidenceCompleteness !== "complete"
    ) {
      throw evidenceNotFound();
    }

    const evidence: Array<{ path: string; bytes: number }> = [
      { path: "manifest.json", bytes: manifestBytes.byteLength },
    ];
    const hashes = new Map<string, string>();
    hashes.set("manifest.json", createHash("sha256").update(manifestBytes).digest("hex"));
    const paths = new Set<string>();
    let totalBytes = manifestBytes.byteLength;
    for (const reference of manifest.evidence) {
      if (!isServableEvidencePath(reference.path) || reference.path === "manifest.json" || paths.has(reference.path)) {
        throw evidenceNotFound();
      }
      if (
        (reference.kind === "screenshot" && reference.masked !== true) ||
        (reference.kind !== "screenshot" && reference.redacted !== true)
      ) {
        throw evidenceNotFound();
      }
      paths.add(reference.path);
      totalBytes += reference.bytes;
      if (totalBytes > MAX_EVIDENCE_BUNDLE_BYTES) throw evidenceNotFound();
      const absolute = await resolveEvidenceFile(root, runId, reference.path);
      const stats = await lstat(absolute);
      if (stats.size !== reference.bytes) throw evidenceNotFound();
      const bytes = await readFile(absolute);
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== reference.sha256) throw evidenceNotFound();
      hashes.set(reference.path, reference.sha256);
      evidence.push({ path: reference.path, bytes: reference.bytes });
    }
    return {
      evidence: Object.freeze(evidence.sort((left, right) => left.path.localeCompare(right.path))),
      hashes,
      finalized: true,
    };
  } catch {
    // A missing, malformed, partial, or hash-mismatched manifest is not a
    // finalized bundle. No unmanifested file crosses the API boundary.
    return { evidence: Object.freeze([]), hashes: new Map(), finalized: false };
  }
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function evidenceNotFound(): NodeJS.ErrnoException {
  const error = new Error("Evidence not found.") as NodeJS.ErrnoException;
  error.code = "ENOENT";
  return error;
}

async function resolveEvidenceFile(root: string, runId: string, relative: string): Promise<string> {
  if (!isServableEvidencePath(relative)) throw evidenceNotFound();
  const runDirectory = safeEvidencePath(root, runId, "");
  const candidate = safeEvidencePath(root, runId, relative);
  const rootReal = await realpath(path.resolve(root));
  const runStats = await lstat(runDirectory);
  if (!runStats.isDirectory() || runStats.isSymbolicLink()) throw evidenceNotFound();
  const runReal = await realpath(runDirectory);
  if (!isWithin(rootReal, runReal)) throw evidenceNotFound();
  const candidateStats = await lstat(candidate);
  if (!candidateStats.isFile() || candidateStats.isSymbolicLink()) throw evidenceNotFound();
  const candidateReal = await realpath(candidate);
  if (!isWithin(runReal, candidateReal)) throw evidenceNotFound();
  return candidateReal;
}

function isServableEvidencePath(relative: string): boolean {
  if (!relative || relative.length > 1_000 || relative.includes("\\") || relative.startsWith("/")) return false;
  const segments = relative.split("/");
  return segments.every((segment) =>
    Boolean(segment) &&
    segment !== "." &&
    segment !== ".." &&
    !segment.startsWith(".") &&
    !segment.toLocaleLowerCase("en-US").endsWith(".tmp") &&
    /^[A-Za-z0-9._-]{1,200}$/u.test(segment) &&
    !isProtectedOutputKey(segment)
  );
}

function safeEvidencePath(root: string, runId: string, relative: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(runId) || runId === "." || runId === "..") {
    throw new Error("Invalid run ID");
  }
  if (relative.includes("\\") || relative.startsWith("/") || /^[A-Za-z]:/u.test(relative)) {
    throw new Error("Invalid evidence path");
  }
  const rootDirectory = path.resolve(root);
  const runDirectory = path.resolve(rootDirectory, runId);
  const resolved = path.resolve(runDirectory, relative || ".");
  const fromRun = path.relative(runDirectory, resolved);
  if (fromRun === ".." || fromRun.startsWith(`..${path.sep}`) || path.isAbsolute(fromRun)) {
    throw new Error("Evidence path escaped its run directory");
  }
  return resolved;
}

function evidenceMime(filePath: string): string {
  const extension = path.extname(filePath).toLocaleLowerCase("en-US");
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  // Evidence DOM snapshots are untrusted target-system content. Serving them as
  // active HTML from the console origin would give that content the console's
  // ambient cookie authority, even when the snapshot was sanitized at capture.
  if (extension === ".html") return "text/plain; charset=utf-8";
  if (extension === ".json" || extension === ".jsonl") return "application/json; charset=utf-8";
  return "text/plain; charset=utf-8";
}

function writeSse(
  reply: FastifyReply,
  event: RunManagerEvent,
  sessions: SessionManager<PlaywrightSurface>,
  catalog: CapabilityCatalog,
  principal: ConsolePrincipal,
): void {
  const source = event.data && typeof event.data === "object" && !Array.isArray(event.data)
    ? event.data as Record<string, unknown>
    : {};
  const data: Record<string, unknown> = Object.create(null);
  if (source.code !== undefined) data.code = publicCode(source.code);
  if (typeof source.status === "string" && /^(?:success|business_outcome|failure|escalation)$/u.test(source.status)) {
    data.status = source.status;
  }
  if (typeof source.evidence === "string" && /^(?:complete|failed|not_applicable)$/u.test(source.evidence)) {
    data.evidence = source.evidence;
  }
  if (typeof source.challengeId === "string" && /^[A-Fa-f0-9-]{36}$/u.test(source.challengeId)) {
    data.challengeId = source.challengeId;
  }
  if (typeof source.interventionId === "string" && /^[A-Fa-f0-9-]{36}$/u.test(source.interventionId)) {
    data.interventionId = source.interventionId;
  }
  if (typeof source.stepId === "string") data.stepId = trustedArtifactLabel(source.stepId, "unknown_step");
  if (source.requirement === "user_confirmation" || source.requirement === "supervisor_confirmation") {
    data.requirement = source.requirement;
  }
  if (typeof source.expiresAt === "string" && Number.isFinite(Date.parse(source.expiresAt))) {
    data.expiresAt = source.expiresAt;
  }
  if (source.action === "restore_session" || source.action === "authenticate_supervisor") data.action = source.action;
  if (typeof source.requiredRole === "string") {
    data.requiredRole = trustedArtifactLabel(source.requiredRole, "operator");
  }
  if (source.sameLiveSession === true) data.sameLiveSession = true;
  if (typeof source.reasonCode === "string") data.reasonCode = publicCode(source.reasonCode, "INTERVENTION_REQUIRED");
  const projected = {
    id: event.id,
    runId: event.runId,
    type: event.type,
    timestamp: event.timestamp,
    phase: event.phase,
    data,
    snapshot: publicSnapshot(event.snapshot, sessions, catalog, principal),
  };
  reply.raw.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(projected)}\n\n`);
}

export function buildApiServer(options: ApiServerOptions): FastifyInstance {
  if (
    !Number.isInteger(options.chat.requestTimeoutMs) ||
    options.chat.requestTimeoutMs < 1_000 ||
    options.chat.requestTimeoutMs > MAX_API_CHAT_ROUTER_TIMEOUT_MS
  ) {
    throw new ChatRoutingError(
      "PROVIDER_CONFIGURATION_ERROR",
      `API chat router timeout must be from 1000 through ${MAX_API_CHAT_ROUTER_TIMEOUT_MS} milliseconds`,
    );
  }
  const requestPrincipals = new WeakMap<FastifyRequest, ConsolePrincipal>();
  const ownerSessions = new Map<string, string>();
  const sessionMetadata = new Map<
    string,
    { role: "teller" | "supervisor"; branch: string; signOnRunId?: string }
  >();
  const runOwners = new Map<string, string>();
  const reconciliationCases = new Map<
    string,
    {
      owner: string;
      capabilityId: ReconcilableCapabilityId;
      sourceInputs: Readonly<Record<string, RunValueV2>>;
      readRunId?: string;
    }
  >();
  const handoffInvitations = new Map<
    string,
    {
      runId: string;
      interventionId: string;
      requiredRole: string;
      expiresAtMs: number;
    }
  >();
  const delegatedRuns = new Map<
    string,
    { subject: string; interventionId: string; requiredRole: string; expiresAtMs: number }
  >();
  const activeChats = new Map<string, AbortController>();
  const sequences = new SequenceCoordinator();
  const discoveryHistory = new PublishedDiscoveryHistory(options.catalog);
  const terminatingSubjects = new Set<string>();
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 128 * 1024,
    requestTimeout: 30_000,
    connectionTimeout: 10_000,
    routerOptions: { maxParamLength: 512 },
  });
  const unsubscribeRunEvictions = options.runs.onEvicted(async (snapshot) => {
    runOwners.delete(snapshot.runId);
    delegatedRuns.delete(snapshot.runId);
    reconciliationCases.delete(snapshot.runId);
    for (const [sourceRunId, record] of reconciliationCases) {
      if (record.readRunId === snapshot.runId) reconciliationCases.delete(sourceRunId);
    }
    for (const [digest, invitation] of handoffInvitations) {
      if (invitation.runId === snapshot.runId) handoffInvitations.delete(digest);
    }
    const runDirectory = safeEvidencePath(options.evidenceRoot, snapshot.runId, "");
    try {
      await rm(runDirectory, { recursive: true, force: true });
    } catch {
      app.log.warn(
        { event: "evidence.retention_cleanup_failed", runId: snapshot.runId },
        "Retained evidence cleanup failed",
      );
    }
  });

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("cross-origin-opener-policy", "same-origin");
    reply.header("cross-origin-resource-policy", "same-origin");
    reply.header("referrer-policy", "no-referrer");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
    reply.header(
      "content-security-policy",
      "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'",
    );
    if (request.protocol === "https") {
      reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
    }
    if (request.url.startsWith("/api/")) reply.header("cache-control", "no-store");
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    const status = errorStatus(error);
    if (error instanceof ChatRoutingError) {
      request.log.warn(
        { event: "chat.routing_rejected", classification: error.code, status },
        "Chat routing request was rejected",
      );
    } else if (status >= 500) {
      request.log.error(
        { event: "api.request_failed", classification: errorCode(error), status },
        "API request failed safely",
      );
    }
    void reply.status(status).send({
      error: {
        code: errorCode(error),
        message: errorMessage(error, status),
        ...(error instanceof SequenceCoordinatorError && error.details
          ? { details: error.details }
          : {}),
        ...(error instanceof z.ZodError
          ? {
              issues: error.issues.map((issue) => ({
                code: issue.code,
                path: issue.path,
                message: issue.message,
              })),
            }
          : {}),
      },
    });
  });

  app.addHook("preHandler", async (request, reply) => {
    const pathname = request.url.split("?", 1)[0];
    if (
      pathname === "/api/v1/health" ||
      pathname === "/api/v1/openapi.json" ||
      pathname === "/api/v1/auth/login"
    ) {
      return;
    }
    if (!pathname?.startsWith("/api/v1/")) return;
    const explicitActivity =
      (request.method !== "GET" && request.method !== "HEAD") ||
      request.headers["x-meridian-activity"] === "operator";
    const principal = await options.identity.authenticate(identityRequest(request, explicitActivity));
    if (!principal) {
      return reply.status(401).send({
        error: { code: "AUTH_REQUIRED", message: "Authenticate to the operator console first." },
      });
    }
    if (terminatingSubjects.has(principal.subject) && pathname !== "/api/v1/auth/logout") {
      return reply.status(409).send({
        error: {
          code: "AUTH_SESSION_TERMINATING",
          message: "Sign-out is still closing this console session. Authenticate again when it completes.",
        },
      });
    }
    requestPrincipals.set(request, principal);
  });

  const principalFor = (request: FastifyRequest): ConsolePrincipal => {
    const principal = requestPrincipals.get(request);
    if (!principal) throw new ConsoleIdentityError("AUTH_INVALID", "Authenticated console identity is unavailable.");
    return principal;
  };
  const ownedRun = (request: FastifyRequest, runId: string): RunSnapshot | undefined => {
    const principal = principalFor(request);
    if (runOwners.get(runId) !== principal.subject) return undefined;
    return options.runs.get(runId);
  };
  const delegatedRun = (request: FastifyRequest, runId: string): RunSnapshot | undefined => {
    const principal = principalFor(request);
    const delegation = delegatedRuns.get(runId);
    if (!delegation || delegation.subject !== principal.subject || delegation.expiresAtMs <= Date.now()) {
      if (delegation?.expiresAtMs && delegation.expiresAtMs <= Date.now()) delegatedRuns.delete(runId);
      return undefined;
    }
    return options.runs.get(runId);
  };
  const visibleRun = (request: FastifyRequest, runId: string): RunSnapshot | undefined =>
    ownedRun(request, runId) ?? delegatedRun(request, runId);
  const handoffRun = (
    request: FastifyRequest,
    runId: string,
    interventionId: string,
  ): RunSnapshot | undefined => {
    const owned = ownedRun(request, runId);
    if (owned) return owned;
    const principal = principalFor(request);
    const delegation = delegatedRuns.get(runId);
    if (
      !delegation ||
      delegation.subject !== principal.subject ||
      delegation.interventionId !== interventionId ||
      delegation.expiresAtMs <= Date.now()
    ) return undefined;
    return options.runs.get(runId);
  };

  app.get("/api/v1/health", async () => ({ status: "ok", provider: options.chat.name }));
  app.get("/api/v1/openapi.json", async () => openApiDocument());

  app.post("/api/v1/auth/login", async (request, reply) => {
    assertMutationHeader(request);
    const body = LoginRequestSchema.parse(request.body);
    const currentPrincipal = await options.identity.authenticate(identityRequest(request));
    if (currentPrincipal && terminatingSubjects.has(currentPrincipal.subject)) {
      return reply.status(409).send({
        error: {
          code: "AUTH_SESSION_TERMINATING",
          message: "Sign-out is still closing this console session. Authenticate again when it completes.",
        },
      });
    }
    const login = await options.identity.login(body.accessCode, request.ip);
    if (currentPrincipal && currentPrincipal.subject !== login.principal.subject) {
      // Discard the newly created credential session and preserve the existing
      // cookie. Role/identity changes require the full target-session teardown.
      await options.identity.logout({
        cookieHeader: `${CONSOLE_COOKIE_NAME}=${login.sessionToken}`,
      });
      return reply.status(409).send({
        error: {
          code: "IDENTITY_SWITCH_REQUIRES_LOGOUT",
          message: "Sign out completely before authenticating as a different operator.",
        },
      });
    }
    if (currentPrincipal) await options.identity.logout(identityRequest(request));
    const maxAge = (new Date(login.expiresAt).getTime() - Date.now()) / 1_000;
    reply.header("set-cookie", authCookie(login.sessionToken, maxAge, requestUsesSecureCookie(request)));
    return { principal: login.principal, expiresAt: login.expiresAt };
  });

  app.get("/api/v1/auth/me", async (request) => {
    const principal = principalFor(request);
    const sessionRef = ownerSessions.get(principal.subject);
    const session = sessionRef ? options.sessions.get(sessionRef) : undefined;
    const metadata = sessionRef ? sessionMetadata.get(sessionRef) : undefined;
    const signOnRun = metadata?.signOnRunId ? options.runs.get(metadata.signOnRunId) : undefined;
    const signOnProvisioning =
      signOnRun !== undefined &&
      (signOnRun.phase === "queued" || signOnRun.phase === "running" || signOnRun.phase === "recovering");
    const available = session !== undefined || signOnProvisioning;
    if (sessionRef && (!metadata || !available)) {
      ownerSessions.delete(principal.subject);
      sessionMetadata.delete(sessionRef);
      options.clearPendingPrincipal(sessionRef);
    }
    return {
      principal,
      meridianSession: sessionRef && metadata && available
        ? {
            state: session?.state ?? "provisioning",
            role: session?.principal?.role ?? metadata.role,
            branch: session?.principal?.branch ?? metadata.branch,
            ...(session ? { expiresAt: session.expiresAt, queuedLeases: session.queuedLeases } : {}),
            ...(metadata.signOnRunId ? { signOnRunId: metadata.signOnRunId } : {}),
          }
        : null,
    };
  });

  app.post("/api/v1/auth/logout", async (request, reply) => {
    assertMutationHeader(request);
    const principal = principalFor(request);
    if (terminatingSubjects.has(principal.subject)) {
      return reply.status(409).send({
        error: { code: "AUTH_SESSION_TERMINATING", message: "Sign-out is already in progress." },
      });
    }
    terminatingSubjects.add(principal.subject);
    try {
      activeChats.get(principal.subject)?.abort();
      const ownedActiveRuns = options.runs
        .list()
        .filter((run) => runOwners.get(run.runId) === principal.subject && run.phase !== "completed");
      if (
        ownedActiveRuns.some(
          (run) =>
            run.phase === "running" ||
            run.phase === "recovering" ||
            (run.progress?.status === "awaiting_human" &&
              (run.progress.intervention.state === "human_active" ||
                run.progress.intervention.state === "action_completed" ||
                run.progress.intervention.state === "revalidating")),
        )
      ) {
        return reply.status(409).send({
          error: {
            code: "RUN_IN_PROGRESS",
            message: "Wait for the active browser step to reach a safe boundary before signing out.",
          },
        });
      }
      await Promise.all(
        ownedActiveRuns.map((run) => options.runs.cancel(run.runId, "Console signed out")),
      );
      const sessionRef = ownerSessions.get(principal.subject);
      ownerSessions.delete(principal.subject);
      if (sessionRef) {
        sessionMetadata.delete(sessionRef);
        options.clearPendingPrincipal(sessionRef);
        await options.sessions.revoke(sessionRef);
      }
      await options.identity.logout(identityRequest(request));
      reply.header("set-cookie", authCookie("deleted", 0, requestUsesSecureCookie(request)));
      return { signedOut: true };
    } finally {
      terminatingSubjects.delete(principal.subject);
    }
  });

  const targetBoundMetadata = (metadata: CapabilityMetadata) => ({
    ...metadata,
    ...(options.targetProfileDigest ? { targetProfileDigest: options.targetProfileDigest } : {}),
  });
  app.get("/api/v1/capabilities", async () => ({
    capabilities: options.catalog.list().map(targetBoundMetadata),
  }));
  app.get<{ Params: { id: string; version: string } }>(
    "/api/v1/capabilities/:id/:version",
    async (request, reply) => {
      const entry = options.catalog.resolve(request.params.id, request.params.version);
      if (!entry) return reply.status(404).send({ error: { code: "CAPABILITY_NOT_FOUND", message: "Capability not found" } });
      return { capability: targetBoundMetadata(entry.metadata), artifact: entry.artifact };
    },
  );
  app.get("/api/v1/discovery-runs", async (request) => {
    principalFor(request);
    return DiscoveryRunListResponseSchema.parse({ discoveryRuns: discoveryHistory.list() });
  });
  app.get<{ Params: { id: string } }>(
    "/api/v1/discovery-runs/:id",
    async (request, reply) => {
      principalFor(request);
      const id = DiscoveryRunIdSchema.safeParse(request.params.id);
      const discoveryRun = id.success ? discoveryHistory.get(id.data) : undefined;
      if (!discoveryRun) {
        return reply.status(404).send({
          error: { code: "DISCOVERY_RUN_NOT_FOUND", message: "Discovery run not found" },
        });
      }
      return DiscoveryRunDetailResponseSchema.parse({ discoveryRun });
    },
  );

  app.post("/api/v1/sessions", async (request, reply) => {
    assertMutationHeader(request);
    const consolePrincipal = principalFor(request);
    const body = SessionRequestSchema.parse(request.body);
    if (!consolePrincipal.roles.includes(body.profile)) {
      throw new RunManagerError("ROLE_REQUIRED", `${body.profile} console authorization is required.`);
    }
    const previousRef = ownerSessions.get(consolePrincipal.subject);
    const previous = previousRef ? options.sessions.get(previousRef) : undefined;
    const previousMetadata = previousRef ? sessionMetadata.get(previousRef) : undefined;
    const previousSignOn = previousMetadata?.signOnRunId
      ? options.runs.get(previousMetadata.signOnRunId)
      : undefined;
    if (
      previousRef &&
      ((previous !== undefined && previous.state !== "closed") ||
        (previousSignOn !== undefined && previousSignOn.phase !== "completed"))
    ) {
      return reply.status(409).send({
        error: { code: "SESSION_ALREADY_ACTIVE", message: "Sign out before replacing the active MERIDIAN session." },
      });
    }
    if (previousRef) sessionMetadata.delete(previousRef);
    const credential = options.credentials[body.profile];
    if (!credential) {
      return reply.status(503).send({
        error: {
          code: "CREDENTIAL_PROFILE_UNAVAILABLE",
          message: `Server credential profile ${body.profile} is not configured.`,
        },
      });
    }
    const capability = options.catalog.get("session.sign_on", "2.0.0");
    if (!capability) throw new Error("Approved sign-on capability is unavailable");
    const sessionRef = randomBytes(32).toString("base64url");
    options.registerPendingPrincipal(
      sessionRef,
      {
        operatorId: credential.operator,
        role: credential.role,
        branch: body.branch,
      },
      { operator: credential.operator, password: credential.password, branch: body.branch },
    );
    ownerSessions.set(consolePrincipal.subject, sessionRef);
    sessionMetadata.set(sessionRef, { role: credential.role, branch: body.branch });
    try {
      const run = options.runs.submit({
        capabilityId: capability.id,
        capabilityVersion: capability.version,
        artifactDigest: capability.digest,
        ...(options.targetProfileDigest ? { targetProfileDigest: options.targetProfileDigest } : {}),
        sessionRef,
        // Target credentials are hydrated only inside runner construction via
        // the pending server-owned resolver. RunManager never retains them.
        inputs: { operator: credential.operator, branch: body.branch },
        inputDigestOverride: sha256Digest({
          scope: "server-owned-sign-on",
          sessionRef,
          operator: credential.operator,
          branch: body.branch,
        }),
        idempotencyKey: `session:${sessionRef}`,
      });
      const existingOwner = runOwners.get(run.runId);
      if (existingOwner && existingOwner !== consolePrincipal.subject) {
        throw new RunManagerError("IDEMPOTENCY_CONFLICT", "Idempotent run belongs to another operator.");
      }
      runOwners.set(run.runId, consolePrincipal.subject);
      sessionMetadata.set(sessionRef, {
        role: credential.role,
        branch: body.branch,
        signOnRunId: run.runId,
      });
      return reply.status(202).send({
        run: publicSnapshot(run, options.sessions, options.catalog, consolePrincipal),
      });
    } catch (error) {
      ownerSessions.delete(consolePrincipal.subject);
      sessionMetadata.delete(sessionRef);
      options.clearPendingPrincipal(sessionRef);
      throw error;
    }
  });

  app.post("/api/v1/runs", async (request, reply) => {
    assertMutationHeader(request);
    const principal = principalFor(request);
    assertBoundedJson(request.body);
    const body = RunRequestSchema.parse(request.body);
    if (body.capabilityId === "session.sign_on") {
      return reply.status(400).send({
        error: { code: "SECURE_SESSION_ENDPOINT_REQUIRED", message: "Use the secure session endpoint for sign-on." },
      });
    }
    const sessionRef = ownerSessions.get(principal.subject);
    const session = sessionRef ? options.sessions.get(sessionRef) : undefined;
    if (!session || session.state === "closed" || session.state === "provisioning") {
      return reply.status(409).send({
        error: { code: "SESSION_NOT_ACTIVE", message: "Create or refresh an authenticated session first." },
      });
    }
    const capability = latestCapability(options.catalog, body.capabilityId, body.capabilityVersion);
    if (!capability) {
      return reply.status(404).send({ error: { code: "CAPABILITY_NOT_FOUND", message: "Capability not found" } });
    }
    if (body.artifactDigest !== capability.digest) {
      return reply.status(409).send({
        error: {
          code: "ARTIFACT_DIGEST_MISMATCH",
          message: "The reviewed capability changed. Refresh the catalog and review it again.",
        },
      });
    }
    if (options.targetProfileDigest && body.targetProfileDigest !== options.targetProfileDigest) {
      return reply.status(409).send({
        error: {
          code: "TARGET_PROFILE_DIGEST_MISMATCH",
          message: "The selected target instance changed. Refresh the catalog and review the request again.",
        },
      });
    }
    const entry = options.catalog.resolve(capability.id, capability.version);
    if (!entry) {
      return reply.status(409).send({
        error: { code: "CAPABILITY_VERSION_UNSUPPORTED", message: "This capability cannot run on the live API." },
      });
    }
    if (
      capability.risk === "supervisor_only" &&
      (!principal.roles.includes("supervisor") || session.principal?.role !== "supervisor")
    ) {
      if (!capability.supportsSupervisorHandoff) {
        return reply.status(403).send({
          error: {
            code: "SUPERVISOR_REQUIRED",
            message: "This capability requires a supervisor-authorized target session.",
          },
        });
      }
    }
    const headerKey = request.headers["idempotency-key"];
    if (headerKey !== undefined && typeof headerKey !== "string") {
      return reply.status(400).send({ error: { code: "REQUEST_INVALID", message: "Idempotency-Key must be one value" } });
    }
    if (body.sequence && (headerKey || body.idempotencyKey)) {
      return reply.status(409).send({
        error: {
          code: "SEQUENCE_IDEMPOTENCY_SERVER_MANAGED",
          message: "Sequence idempotency is derived and enforced by the server.",
        },
      });
    }
    if (headerKey && body.idempotencyKey && headerKey !== body.idempotencyKey) {
      return reply.status(409).send({ error: { code: "IDEMPOTENCY_CONFLICT", message: "Header and body idempotency keys differ" } });
    }
    const artifact = CapabilityArtifactV2Schema.parse(entry.artifact);
    const sequenceContract = body.sequence
      ? sequences.prepare({
          owner: principal.subject,
          reference: {
            sequenceId: body.sequence.sequenceId,
            stepId: body.sequence.stepId,
            ...(body.sequence.selectionIndex === undefined
              ? {}
              : { selectionIndex: body.sequence.selectionIndex }),
          },
          capabilityId: capability.id,
          capabilityVersion: capability.version,
          artifactDigest: capability.digest,
          ...(options.targetProfileDigest ? { targetProfileDigest: options.targetProfileDigest } : {}),
          suppliedInputs: body.inputs as Record<string, RunValueV2>,
          getRun: (runId) => options.runs.get(runId),
        })
      : undefined;
    const idempotencyKey = sequenceContract?.idempotencyKey ?? body.idempotencyKey ?? headerKey;
    if (capability.risk !== "read" && !idempotencyKey) {
      return reply.status(400).send({
        error: { code: "IDEMPOTENCY_REQUIRED", message: "Business writes require an Idempotency-Key." },
      });
    }
    const inputs = normalizeInputs(
      artifact.inputs,
      sequenceContract?.inputs ?? body.inputs as Record<string, RunValueV2>,
    );
    const scopedIdempotencyKey = idempotencyKey
      ? sha256Digest({ owner: principal.subject, key: idempotencyKey })
      : undefined;
    const run = options.runs.submit({
      capabilityId: capability.id,
      capabilityVersion: capability.version,
      artifactDigest: capability.digest,
      ...(options.targetProfileDigest ? { targetProfileDigest: options.targetProfileDigest } : {}),
      sessionRef: sessionRef!,
      inputs,
      ...(scopedIdempotencyKey ? { idempotencyKey: scopedIdempotencyKey } : {}),
      ...(sequenceContract
        ? {
            orchestration: {
              kind: "chat_sequence" as const,
              sequenceId: sequenceContract.plan.sequenceId,
              stepId: sequenceContract.step.stepId,
              stepIndex: sequenceContract.stepIndex,
              stepCount: sequenceContract.plan.steps.length,
              ...(sequenceContract.parentRunId ? { parentRunId: sequenceContract.parentRunId } : {}),
            },
          }
        : {}),
    });
    const existingOwner = runOwners.get(run.runId);
    if (existingOwner && existingOwner !== principal.subject) {
      throw new RunManagerError("IDEMPOTENCY_CONFLICT", "Idempotent run belongs to another operator.");
    }
    runOwners.set(run.runId, principal.subject);
    if (isReconcilableCapability(capability.id)) {
      const existing = reconciliationCases.get(run.runId);
      if (!existing) {
        reconciliationCases.set(run.runId, {
          owner: principal.subject,
          capabilityId: capability.id,
          sourceInputs: structuredClone(inputs),
        });
      }
    }
    if (sequenceContract) {
      sequences.recordRun(
        sequenceContract.plan.sequenceId,
        sequenceContract.step.stepId,
        run.runId,
      );
    }
    return reply.status(202).send({
      run: publicSnapshot(run, options.sessions, options.catalog, principal),
    });
  });

  app.get("/api/v1/runs", async (request) => {
    const principal = principalFor(request);
    const live = options.runs.list();
    const liveIds = new Set(live.map((run) => run.runId));
    for (const runId of runOwners.keys()) if (!liveIds.has(runId)) runOwners.delete(runId);
    const now = Date.now();
    for (const [runId, delegation] of delegatedRuns) {
      if (!liveIds.has(runId) || delegation.expiresAtMs <= now) delegatedRuns.delete(runId);
    }
    return {
      runs: live
        .filter((run) => {
          if (runOwners.get(run.runId) === principal.subject) return true;
          const delegation = delegatedRuns.get(run.runId);
          return delegation?.subject === principal.subject && delegation.expiresAtMs > now;
        })
        .map((run) => publicSnapshot(run, options.sessions, options.catalog, principal)),
    };
  });
  app.get<{ Params: { runId: string } }>("/api/v1/runs/:runId", async (request, reply) => {
    const principal = principalFor(request);
    const run = visibleRun(request, request.params.runId);
    return run
      ? { run: publicSnapshot(run, options.sessions, options.catalog, principal) }
      : reply.status(404).send({ error: { code: "RUN_NOT_FOUND", message: "Run not found" } });
  });

  app.post<{ Params: { runId: string } }>("/api/v1/runs/:runId/reconciliation", async (request, reply) => {
    assertMutationHeader(request);
    const principal = principalFor(request);
    const source = visibleRun(request, request.params.runId);
    if (!source) {
      return reply.status(404).send({ error: { code: "RUN_NOT_FOUND", message: "Run not found" } });
    }
    const record = reconciliationCases.get(source.runId);
    if (!record || record.owner !== principal.subject || !isReconcilableCapability(source.capabilityId)) {
      return reply.status(409).send({
        error: { code: "RECONCILIATION_UNAVAILABLE", message: "This run has no supported reconciliation workflow." },
      });
    }
    const sourceResult = source.progress?.status === "terminal" ? source.progress.result : undefined;
    if (sourceResult?.status !== "failure" || !sourceResult.effectUncertain) {
      return reply.status(409).send({
        error: {
          code: "RECONCILIATION_NOT_REQUIRED",
          message: "Reconciliation starts only after an effect-uncertain write result.",
        },
      });
    }
    if (record.readRunId) {
      const existing = options.runs.get(record.readRunId);
      if (existing) {
        return reply.status(202).send({
          reconciliation: { sourceRunId: source.runId, runId: existing.runId, status: "running_or_complete" },
          run: publicSnapshot(existing, options.sessions, options.catalog, principal),
        });
      }
    }
    const sessionRef = ownerSessions.get(principal.subject);
    const session = sessionRef ? options.sessions.get(sessionRef) : undefined;
    if (!session || session.state === "closed" || session.state === "provisioning") {
      return reply.status(409).send({
        error: { code: "SESSION_NOT_ACTIVE", message: "Create or refresh an authenticated session first." },
      });
    }
    const readCapability = options.catalog.get("member.get_record_and_balances", "2.0.0");
    const readEntry = options.catalog.resolve("member.get_record_and_balances", "2.0.0");
    if (!readCapability || !readEntry) {
      return reply.status(503).send({
        error: { code: "RECONCILIATION_UNAVAILABLE", message: "The approved read-only reconciliation capability is unavailable." },
      });
    }
    const readArtifact = CapabilityArtifactV2Schema.parse(readEntry.artifact);
    const inputs = normalizeInputs(readArtifact.inputs, reconciliationReadInputs(record.sourceInputs));
    const readRun = options.runs.submit({
      capabilityId: readCapability.id,
      capabilityVersion: readCapability.version,
      artifactDigest: readCapability.digest,
      ...(options.targetProfileDigest ? { targetProfileDigest: options.targetProfileDigest } : {}),
      sessionRef: sessionRef!,
      inputs,
      idempotencyKey: sha256Digest({ owner: principal.subject, reconciliationOf: source.runId }),
      orchestration: { kind: "reconciliation", sourceRunId: source.runId },
    });
    const existingOwner = runOwners.get(readRun.runId);
    if (existingOwner && existingOwner !== principal.subject) {
      throw new RunManagerError("IDEMPOTENCY_CONFLICT", "Reconciliation run belongs to another operator.");
    }
    runOwners.set(readRun.runId, principal.subject);
    record.readRunId = readRun.runId;
    return reply.status(202).send({
      reconciliation: { sourceRunId: source.runId, runId: readRun.runId, status: "running" },
      run: publicSnapshot(readRun, options.sessions, options.catalog, principal),
    });
  });

  app.get<{ Params: { runId: string } }>("/api/v1/runs/:runId/reconciliation", async (request, reply) => {
    const principal = principalFor(request);
    const source = visibleRun(request, request.params.runId);
    if (!source) {
      return reply.status(404).send({ error: { code: "RUN_NOT_FOUND", message: "Run not found" } });
    }
    const record = reconciliationCases.get(source.runId);
    if (!record || record.owner !== principal.subject) {
      return reply.status(404).send({ error: { code: "RECONCILIATION_NOT_FOUND", message: "Reconciliation not found" } });
    }
    if (!record.readRunId) {
      return { reconciliation: { sourceRunId: source.runId, status: "not_started" } };
    }
    const readRun = options.runs.get(record.readRunId);
    if (!readRun) {
      return {
        reconciliation: {
          sourceRunId: source.runId,
          runId: record.readRunId,
          status: "complete",
          decision: {
            classification: "still_unknown",
            reason: "The retained read-only reconciliation run is no longer available.",
            checkedFields: [],
          },
        },
      };
    }
    const readResult = readRun.progress?.status === "terminal" ? readRun.progress.result : undefined;
    if (!readResult) {
      return {
        reconciliation: { sourceRunId: source.runId, runId: readRun.runId, status: "running" },
        run: publicSnapshot(readRun, options.sessions, options.catalog, principal),
      };
    }
    let decision;
    const sourceResult = source.progress?.status === "terminal" ? source.progress.result : undefined;
    if (readResult.status === "success" && sourceResult?.status === "failure") {
      decision = classifyReconciliation({
        capabilityId: record.capabilityId,
        sourceInputs: record.sourceInputs,
        preCommit: structuredClone(sourceResult.reconciliationOutputs ?? {}) as Record<string, RunValueV2>,
        current: structuredClone(readResult.outputs) as Record<string, RunValueV2>,
      });
    } else {
      decision = {
        classification: "still_unknown" as const,
        reason: "The read-only reconciliation capability did not return a complete current snapshot.",
        checkedFields: [] as readonly string[],
      };
    }
    return {
      reconciliation: {
        sourceRunId: source.runId,
        runId: readRun.runId,
        status: "complete",
        decision,
      },
      run: publicSnapshot(readRun, options.sessions, options.catalog, principal),
    };
  });

  app.get<{ Params: { runId: string } }>("/api/v1/runs/:runId/events", async (request, reply) => {
    const principal = principalFor(request);
    if (!visibleRun(request, request.params.runId)) {
      return reply.status(404).send({ error: { code: "RUN_NOT_FOUND", message: "Run not found" } });
    }
    const rawLastId = request.headers["last-event-id"];
    const afterEventId = typeof rawLastId === "string" && /^\d+$/u.test(rawLastId) ? Number(rawLastId) : 0;
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-stream-max-age": String(SSE_CONNECTION_MAX_MS),
    });
    reply.raw.write("retry: 2000\n\n");
    let closed = false;
    let checkingIdentity = false;
    let unsubscribe: () => void = () => undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    let rotation: NodeJS.Timeout | undefined;
    const clearStreamResources = () => {
      if (heartbeat) clearInterval(heartbeat);
      if (rotation) clearTimeout(rotation);
      unsubscribe();
      unsubscribe = () => undefined;
    };
    const closeStream = (event: "auth.expired" | "stream.rotate", reason: string) => {
      if (closed) return;
      closed = true;
      clearStreamResources();
      try {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify({ reason })}\n\n`);
        reply.raw.end();
      } catch {
        reply.raw.destroy();
      }
    };
    const subscription = options.runs.subscribe(
      request.params.runId,
      (event) => {
        if (!visibleRun(request, request.params.runId)) {
          closeStream("auth.expired", "reauthenticate");
          return;
        }
        writeSse(reply, event, options.sessions, options.catalog, principal);
      },
      { afterEventId },
    );
    if (closed) {
      subscription();
      return;
    }
    unsubscribe = subscription;
    heartbeat = setInterval(() => {
      if (closed || checkingIdentity) return;
      checkingIdentity = true;
      void options.identity
        .authenticate(identityRequest(request))
        .then((current) => {
          if (!current || current.subject !== principal.subject) {
            closeStream("auth.expired", "reauthenticate");
            return;
          }
          if (!visibleRun(request, request.params.runId)) {
            closeStream("auth.expired", "reauthenticate");
            return;
          }
          if (!closed) reply.raw.write(": heartbeat\n\n");
        })
        .catch(() => closeStream("auth.expired", "reauthenticate"))
        .finally(() => {
          checkingIdentity = false;
        });
    }, 15_000);
    heartbeat.unref();
    rotation = setTimeout(() => {
      closeStream("stream.rotate", "reauthenticate");
    }, SSE_CONNECTION_MAX_MS);
    rotation.unref();
    request.raw.once("close", () => {
      closed = true;
      clearStreamResources();
    });
  });

  app.post<{ Params: { runId: string } }>("/api/v1/runs/:runId/approve", async (request, reply) => {
    assertMutationHeader(request);
    const principal = principalFor(request);
    const body = ApprovalRequestSchema.parse(request.body);
    const run = visibleRun(request, request.params.runId);
    if (!run) throw new RunManagerError("RUN_NOT_FOUND", "Run not found");
    if (run.progress?.status !== "awaiting_approval" || run.progress.challenge.challengeId !== body.challengeId) {
      throw new RunManagerError("RUN_NOT_APPROVABLE", "The submitted approval challenge is no longer current.");
    }
    const session = options.sessions.get(run.sessionRef);
    if (!session?.principal || (session.state !== "active" && session.state !== "busy")) {
      throw new RunManagerError("ROLE_REQUIRED", "Authenticated session principal is unavailable");
    }
    const effectiveRoles = effectiveApprovalRoles(principal, session.principal.role);
    const approved = options.runs.approve(run.runId, {
      source: "operator",
      id: principal.subject,
      roles: effectiveRoles,
    });
    return reply.status(202).send({
      run: publicSnapshot(approved, options.sessions, options.catalog, principal),
    });
  });

  const handoffActor = (principal: ConsolePrincipal, run: RunSnapshot) => {
    const session = options.sessions.get(run.sessionRef);
    if (!session?.principal || session.state !== "busy") {
      throw new RunManagerError("ROLE_REQUIRED", "The retained live session principal is unavailable");
    }
    return {
      source: "operator" as const,
      id: principal.subject,
      roles: [...principal.roles],
    };
  };

  app.post<{ Params: { runId: string } }>(
    "/api/v1/runs/:runId/handoff/invitations",
    async (request, reply) => {
      assertMutationHeader(request);
      const body = HandoffInvitationRequestSchema.parse(request.body);
      const run = ownedRun(request, request.params.runId);
      if (!run) throw new RunManagerError("RUN_NOT_FOUND", "Run not found");
      if (
        run.progress?.status !== "awaiting_human" ||
        run.progress.intervention.interventionId !== body.interventionId ||
        !run.progress.intervention.requiredRole
      ) {
        throw new RunManagerError("RUN_NOT_HANDOFFABLE", "This intervention cannot be delegated");
      }
      const interventionExpiry = Date.parse(run.progress.intervention.expiresAt);
      const expiresAtMs = Math.min(interventionExpiry, Date.now() + 120_000);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
        throw new RunManagerError("RUN_NOT_HANDOFFABLE", "The intervention has expired");
      }
      for (const [digest, invitation] of handoffInvitations) {
        if (invitation.runId === run.runId && invitation.interventionId === body.interventionId) {
          handoffInvitations.delete(digest);
        }
      }
      const token = randomBytes(32).toString("base64url");
      handoffInvitations.set(createHash("sha256").update(token).digest("hex"), {
        runId: run.runId,
        interventionId: body.interventionId,
        requiredRole: run.progress.intervention.requiredRole,
        expiresAtMs,
      });
      return reply.status(201).send({
        invitation: {
          token,
          runId: run.runId,
          interventionId: body.interventionId,
          requiredRole: run.progress.intervention.requiredRole,
          expiresAt: new Date(expiresAtMs).toISOString(),
          oneTime: true,
        },
      });
    },
  );

  app.post("/api/v1/handoff/invitations/redeem", async (request, reply) => {
    assertMutationHeader(request);
    const principal = principalFor(request);
    const body = HandoffInvitationRedeemSchema.parse(request.body);
    const digest = createHash("sha256").update(body.token).digest("hex");
    const invitation = handoffInvitations.get(digest);
    // Consume before validation so a captured or raced token can never be replayed.
    handoffInvitations.delete(digest);
    if (!invitation || invitation.expiresAtMs <= Date.now()) {
      return reply.status(409).send({
        error: { code: "HANDOFF_INVITATION_INVALID", message: "The one-time handoff invitation is invalid or expired." },
      });
    }
    if (!principal.roles.some((role) => role === invitation.requiredRole)) {
      return reply.status(403).send({
        error: { code: "ROLE_REQUIRED", message: "The invited intervention requires a different authenticated role." },
      });
    }
    const run = options.runs.get(invitation.runId);
    if (
      !run ||
      run.progress?.status !== "awaiting_human" ||
      run.progress.intervention.interventionId !== invitation.interventionId
    ) {
      return reply.status(409).send({
        error: { code: "HANDOFF_INVITATION_INVALID", message: "The invited intervention is no longer current." },
      });
    }
    delegatedRuns.set(run.runId, {
      subject: principal.subject,
      interventionId: invitation.interventionId,
      requiredRole: invitation.requiredRole,
      expiresAtMs: invitation.expiresAtMs,
    });
    return reply.status(200).send({
      delegation: {
        runId: run.runId,
        interventionId: invitation.interventionId,
        requiredRole: invitation.requiredRole,
        expiresAt: new Date(invitation.expiresAtMs).toISOString(),
      },
      run: publicSnapshot(run, options.sessions, options.catalog, principal),
    });
  });

  app.post<{ Params: { runId: string } }>("/api/v1/runs/:runId/handoff/take", async (request, reply) => {
    assertMutationHeader(request);
    const principal = principalFor(request);
    const body = HandoffRequestSchema.parse(request.body);
    const run = handoffRun(request, request.params.runId, body.interventionId);
    if (!run) throw new RunManagerError("RUN_NOT_FOUND", "Run not found");
    if (
      run.progress?.status !== "awaiting_human" ||
      run.progress.intervention.interventionId !== body.interventionId
    ) {
      throw new RunManagerError("RUN_NOT_HANDOFFABLE", "The submitted intervention is no longer current");
    }
    const updated = await options.runs.takeHumanControl(
      run.runId,
      body.interventionId,
      handoffActor(principal, run),
    );
    return reply.status(202).send({
      run: publicSnapshot(updated, options.sessions, options.catalog, principal),
    });
  });

  app.post<{ Params: { runId: string } }>("/api/v1/runs/:runId/handoff/action", async (request, reply) => {
    assertMutationHeader(request);
    const principal = principalFor(request);
    const body = HandoffActionRequestSchema.parse(request.body);
    const run = handoffRun(request, request.params.runId, body.interventionId);
    if (!run) throw new RunManagerError("RUN_NOT_FOUND", "Run not found");
    if (
      run.progress?.status !== "awaiting_human" ||
      run.progress.intervention.interventionId !== body.interventionId ||
      run.progress.intervention.action !== body.action
    ) {
      throw new RunManagerError("RUN_NOT_HANDOFFABLE", "The requested intervention action is not current");
    }
    const updated = await options.runs.performHumanAction(
      run.runId,
      body.interventionId,
      handoffActor(principal, run),
      body.action,
    );
    return reply.status(202).send({
      run: publicSnapshot(updated, options.sessions, options.catalog, principal),
    });
  });

  app.post<{ Params: { runId: string } }>("/api/v1/runs/:runId/handoff/resume", async (request, reply) => {
    assertMutationHeader(request);
    const principal = principalFor(request);
    const body = HandoffRequestSchema.parse(request.body);
    const run = handoffRun(request, request.params.runId, body.interventionId);
    if (!run) throw new RunManagerError("RUN_NOT_FOUND", "Run not found");
    const updated = options.runs.resumeHuman(
      run.runId,
      body.interventionId,
      handoffActor(principal, run),
    );
    return reply.status(202).send({
      run: publicSnapshot(updated, options.sessions, options.catalog, principal),
    });
  });

  app.post<{ Params: { runId: string } }>("/api/v1/runs/:runId/cancel", async (request) => {
    assertMutationHeader(request);
    const principal = principalFor(request);
    if (!ownedRun(request, request.params.runId)) throw new RunManagerError("RUN_NOT_FOUND", "Run not found");
    const body = CancelRequestSchema.parse(request.body ?? {});
    const cancelled = await options.runs.cancel(request.params.runId, body.reason);
    if (cancelled.capabilityId === "session.sign_on" && cancelled.cancellation) {
      const metadata = sessionMetadata.get(cancelled.sessionRef);
      if (
        ownerSessions.get(principal.subject) === cancelled.sessionRef &&
        metadata?.signOnRunId === cancelled.runId
      ) {
        ownerSessions.delete(principal.subject);
        sessionMetadata.delete(cancelled.sessionRef);
        options.clearPendingPrincipal(cancelled.sessionRef);
        await options.sessions.revoke(cancelled.sessionRef);
      }
    }
    return {
      run: publicSnapshot(
        cancelled,
        options.sessions,
        options.catalog,
        principal,
      ),
    };
  });

  app.post("/api/v1/chat", async (request, reply) => {
    assertMutationHeader(request);
    const principal = principalFor(request);
    if (activeChats.has(principal.subject)) {
      return reply.status(409).send({
        error: {
          code: "CHAT_IN_PROGRESS",
          message: "An assistant request is already in progress for this console identity.",
        },
      });
    }
    const body = ChatRequestSchema.parse(request.body);
    const tools = catalogToChatTools(
      options.catalog
        .list()
        .map((metadata) => options.catalog.resolve(metadata.id, metadata.version))
        .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined),
    );
    const controller = new AbortController();
    activeChats.set(principal.subject, controller);
    const abortOnDisconnect = () => controller.abort();
    const abortOnResponseClose = () => {
      if (!reply.raw.writableEnded) controller.abort();
    };
    request.raw.once("aborted", abortOnDisconnect);
    reply.raw.once("close", abortOnResponseClose);
    const credentialSecrets = Object.values(options.credentials).flatMap((profile) =>
      profile ? [profile.operator, profile.password] : [],
    );
    const chatSecrets = [...credentialSecrets, ...(options.chatRedactionSecrets ?? [])];
    const serverDeadlineMs = options.chat.requestTimeoutMs + CHAT_TRANSPORT_GRACE_MS;
    let deadline: NodeJS.Timeout | undefined;
    try {
      const route = await Promise.race([
        options.chat.route({
          message: body.message,
          history: body.history,
          tools,
          secrets: chatSecrets,
          signal: controller.signal,
        }),
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => {
            reject(new ChatRoutingError("PROVIDER_UNAVAILABLE", "Assistant routing deadline expired"));
            controller.abort();
          }, serverDeadlineMs);
          deadline.unref();
        }),
      ]);
      const metadata = {
        provider: route.metadata.provider,
      };
      if (route.kind === "reply") {
        return { route: { kind: "reply", text: route.text, metadata } };
      }
      if (route.kind === "sequence") {
        const plan = sequences.create({
          owner: principal.subject,
          route,
          resolveDigest: (step) => options.catalog.get(step.capabilityId, step.capabilityVersion)?.digest,
          ...(options.targetProfileDigest ? { targetProfileDigest: options.targetProfileDigest } : {}),
        });
        return { route: plan };
      }
      const capability = options.catalog.get(route.capabilityId, route.capabilityVersion);
      if (!capability) {
        throw new ChatRoutingError(
          "PROVIDER_RESPONSE_INVALID",
          "Chat selected a capability that is no longer approved",
        );
      }
      const selectedTool = prepareChatTools(tools).find((tool) =>
        tool.definition.capabilityId === route.capabilityId &&
        tool.definition.capabilityVersion === route.capabilityVersion,
      );
      if (!selectedTool) {
        throw new ChatRoutingError("PROVIDER_RESPONSE_INVALID", "Chat selected a tool outside the approved catalog");
      }
      const validatedArguments = validateToolInput(selectedTool, route.arguments, chatSecrets);
      return {
        route: {
          kind: "invoke",
          capabilityId: route.capabilityId,
          capabilityVersion: route.capabilityVersion,
          arguments: validatedArguments,
          assistantText: route.assistantText,
          metadata,
        },
        artifactDigest: capability.digest,
        ...(options.targetProfileDigest ? { targetProfileDigest: options.targetProfileDigest } : {}),
      };
    } finally {
      if (deadline) clearTimeout(deadline);
      request.raw.removeListener("aborted", abortOnDisconnect);
      reply.raw.removeListener("close", abortOnResponseClose);
      if (activeChats.get(principal.subject) === controller) activeChats.delete(principal.subject);
    }
  });

  app.get<{ Params: { runId: string } }>("/api/v1/runs/:runId/evidence", async (request, reply) => {
    if (!ownedRun(request, request.params.runId)) {
      return reply.status(404).send({ error: { code: "RUN_NOT_FOUND", message: "Run not found" } });
    }
    const bundle = await validatedEvidenceBundle(options.evidenceRoot, request.params.runId);
    return {
      evidence: bundle.evidence,
      finalized: bundle.finalized,
    };
  });

  app.get<{ Params: { runId: string; "*": string } }>(
    "/api/v1/runs/:runId/evidence/*",
    async (request, reply) => {
      if (!ownedRun(request, request.params.runId)) {
        return reply.status(404).send({ error: { code: "RUN_NOT_FOUND", message: "Run not found" } });
      }
      const relative = request.params["*"];
      const bundle = await validatedEvidenceBundle(options.evidenceRoot, request.params.runId);
      if (!bundle.finalized) throw evidenceNotFound();
      const expectedHash = bundle.hashes.get(relative);
      if (!expectedHash) throw evidenceNotFound();
      const absolute = await resolveEvidenceFile(options.evidenceRoot, request.params.runId, relative);
      const bytes = await readFile(absolute);
      if (createHash("sha256").update(bytes).digest("hex") !== expectedHash) {
        throw evidenceNotFound();
      }
      if (path.extname(absolute).toLocaleLowerCase("en-US") === ".html") {
        reply.header("Content-Disposition", `attachment; filename="${path.basename(absolute)}"`);
      }
      reply.type(evidenceMime(absolute));
      return reply.send(bytes);
    },
  );

  app.addHook("onClose", async () => {
    unsubscribeRunEvictions();
    for (const controller of activeChats.values()) controller.abort();
    activeChats.clear();
    handoffInvitations.clear();
    delegatedRuns.clear();
    await options.runs.shutdown();
    await options.sessions.closeAll();
    await options.identity.close?.();
  });

  return app;
}

function openApiDocument() {
  const document = {
    openapi: "3.1.0",
    info: {
      title: "MERIDIAN Capability API",
      version: "2.0.0",
      description:
        "Authenticated, asynchronous execution of approved deterministic UI capabilities. Anthropic proposes routes but never approves or executes a hidden run.",
    },
    security: [{ consoleCookie: [] }],
    components: {
      securitySchemes: {
        consoleCookie: { type: "apiKey", in: "cookie", name: CONSOLE_COOKIE_NAME },
      },
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message"],
              properties: { code: { type: "string" }, message: { type: "string" } },
            },
          },
        },
        RunRequest: {
          type: "object",
          additionalProperties: false,
          required: ["capabilityId", "artifactDigest", "targetProfileDigest", "inputs"],
          properties: {
            capabilityId: { type: "string" },
            capabilityVersion: { type: "string" },
            artifactDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
            targetProfileDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
            inputs: { type: "object" },
            idempotencyKey: { type: "string" },
            sequence: {
              type: "object",
              additionalProperties: false,
              required: ["sequenceId", "stepId"],
              properties: {
                sequenceId: { type: "string", format: "uuid" },
                stepId: { type: "string" },
                selectionIndex: { type: "integer", minimum: 0 },
              },
            },
          },
        },
        HandoffRequest: {
          type: "object",
          additionalProperties: false,
          required: ["interventionId"],
          properties: { interventionId: { type: "string", format: "uuid" } },
        },
        HandoffActionRequest: {
          type: "object",
          additionalProperties: false,
          required: ["interventionId", "action"],
          properties: {
            interventionId: { type: "string", format: "uuid" },
            action: { type: "string", enum: ["restore_session", "authenticate_supervisor"] },
          },
        },
        HandoffInvitationRedeem: {
          type: "object",
          additionalProperties: false,
          required: ["token"],
          properties: { token: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" } },
        },
        DiscoveryRunInput: {
          type: "object",
          additionalProperties: false,
          required: ["name", "type", "classification", "required", "valueStatus"],
          properties: {
            name: { type: "string" },
            type: {
              type: "object",
              description: "Validated V2 input type contract; never an invocation value.",
            },
            classification: {
              type: "string",
              enum: ["public", "internal", "confidential", "restricted", "secret"],
            },
            required: { type: "boolean" },
            valueStatus: { type: "string", const: "withheld" },
          },
        },
        DiscoveryRunOutput: {
          type: "object",
          additionalProperties: false,
          required: ["traceDigest", "draftDigest", "reviewedDigest", "canaryRunId", "approvedDigest"],
          properties: {
            traceDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
            draftDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
            reviewedDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
            canaryRunId: { type: "string" },
            approvedDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
          },
          description: "Persisted integrity references only; trace bytes are not claimed or returned.",
        },
        DiscoveryRunOutputField: {
          type: "object",
          additionalProperties: false,
          required: ["name", "description", "type", "classification"],
          properties: {
            name: { type: "string" },
            description: { type: "string" },
            type: {
              type: "object",
              description: "Validated V2 output type contract; never a discovered or replayed value.",
            },
            classification: {
              type: "string",
              enum: ["public", "internal", "confidential", "restricted", "secret"],
            },
          },
        },
        DiscoveryTimelineEvent: {
          discriminator: { propertyName: "type" },
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["type", "at", "actor", "artifactDigest", "traceDigest"],
              properties: {
                type: { type: "string", const: "draft_created" },
                at: { type: "string", format: "date-time" },
                actor: { type: "string", const: "discovery_compiler" },
                artifactDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
                traceDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              required: [
                "type",
                "at",
                "actor",
                "artifactDigest",
                "parentArtifactDigest",
                "reviewDiffDigest",
                "changedPathCount",
              ],
              properties: {
                type: { type: "string", const: "reviewed" },
                at: { type: "string", format: "date-time" },
                actor: { type: "string" },
                artifactDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
                parentArtifactDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
                reviewDiffDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
                changedPathCount: { type: "integer", minimum: 0 },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["type", "at", "actor", "artifactDigest", "canaryRunId", "evidenceDigest"],
              properties: {
                type: { type: "string", const: "canary_passed" },
                at: { type: "string", format: "date-time" },
                actor: { type: "string", const: "canary_runner" },
                artifactDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
                canaryRunId: { type: "string" },
                evidenceDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["type", "at", "actor", "artifactDigest", "parentArtifactDigest"],
              properties: {
                type: { type: "string", const: "approved" },
                at: { type: "string", format: "date-time" },
                actor: { type: "string" },
                artifactDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
                parentArtifactDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
              },
            },
          ],
        },
        DiscoveryEvidenceReference: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "referenceId", "url", "sha256"],
          properties: {
            kind: { type: "string", enum: ["artifact", "lineage"] },
            referenceId: { type: "string" },
            url: { type: "string" },
            sha256: {
              type: "string",
              pattern: "^[a-f0-9]{64}$",
              description: "SHA-256 of the canonical persisted source record, not the API projection bytes.",
            },
          },
        },
        DiscoveryRun: {
          type: "object",
          additionalProperties: false,
          required: [
            "kind",
            "id",
            "discoveryRunId",
            "capabilityId",
            "capabilityVersion",
            "createdAt",
            "completedAt",
            "status",
            "provider",
            "model",
            "inputs",
            "outputContract",
            "output",
            "timeline",
            "evidence",
          ],
          properties: {
            kind: { type: "string", const: "discovery" },
            id: { type: "string" },
            discoveryRunId: { type: "string" },
            capabilityId: { type: "string" },
            capabilityVersion: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
            completedAt: { type: "string", format: "date-time" },
            status: { type: "string", const: "approved" },
            provider: { type: "string" },
            model: { type: "string" },
            goal: { type: "string" },
            inputs: {
              type: "array",
              items: { $ref: "#/components/schemas/DiscoveryRunInput" },
            },
            outputContract: {
              type: "array",
              items: { $ref: "#/components/schemas/DiscoveryRunOutputField" },
            },
            output: { $ref: "#/components/schemas/DiscoveryRunOutput" },
            timeline: {
              type: "array",
              description: "Exact privacy-safe lifecycle attestation events from the validated lineage record.",
              items: { $ref: "#/components/schemas/DiscoveryTimelineEvent" },
            },
            evidence: {
              type: "array",
              items: { $ref: "#/components/schemas/DiscoveryEvidenceReference" },
            },
          },
        },
      },
    },
    paths: {
      "/api/v1/health": { get: { security: [], summary: "Read service health and active chat provider" } },
      "/api/v1/auth/login": {
        post: {
          security: [],
          summary: "Exchange an operator access code for an HttpOnly console cookie",
        },
      },
      "/api/v1/auth/me": { get: { summary: "Read the authenticated console and MERIDIAN session state" } },
      "/api/v1/auth/logout": { post: { summary: "Revoke the console and server-owned MERIDIAN session" } },
      "/api/v1/capabilities": { get: { summary: "List approved capability contracts" } },
      "/api/v1/capabilities/{id}/{version}": {
        get: { summary: "Read one immutable approved capability and its digest" },
      },
      "/api/v1/discovery-runs": {
        get: {
          summary: "List actual published model-discovery runs from validated artifact and lineage records",
          responses: {
            "200": {
              description: "Published discovery history",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    required: ["discoveryRuns"],
                    properties: {
                      discoveryRuns: {
                        type: "array",
                        items: { $ref: "#/components/schemas/DiscoveryRun" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/v1/discovery-runs/{id}": {
        get: {
          summary: "Read one actual published discovery run and its lifecycle attestations",
          responses: {
            "200": {
              description: "Published discovery detail",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    required: ["discoveryRun"],
                    properties: { discoveryRun: { $ref: "#/components/schemas/DiscoveryRun" } },
                  },
                },
              },
            },
            "404": { description: "Discovery run not found" },
          },
        },
      },
      "/api/v1/sessions": {
        post: { summary: "Create a server-owned MERIDIAN browser session from an authorized credential profile" },
      },
      "/api/v1/runs": {
        get: { summary: "List identity-visible retained runs: owned runs plus active delegated handoffs" },
        post: {
          summary: "Queue an approved deterministic capability against the operator's bound session",
          parameters: [
            {
              in: "header",
              name: "Idempotency-Key",
              schema: { type: "string" },
              description: "Required for write, irreversible, and supervisor-only capabilities.",
            },
          ],
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/RunRequest" } } } },
          responses: { "202": { description: "Queued" }, "409": { description: "Reviewed artifact digest changed" } },
        },
      },
      "/api/v1/runs/{runId}": { get: { summary: "Read a run snapshot" } },
      "/api/v1/runs/{runId}/reconciliation": {
        post: {
          summary: "Start a bound read-only reconciliation after an effect-uncertain write",
        },
        get: {
          summary: "Read the reconciliation run and applied/not-applied/still-unknown decision",
        },
      },
      "/api/v1/runs/{runId}/events": { get: { summary: "Stream replayable run events over SSE" } },
      "/api/v1/runs/{runId}/approve": {
        post: { summary: "Approve one exact, current challenge ID with the authenticated role" },
      },
      "/api/v1/runs/{runId}/handoff/take": {
        post: {
          summary: "Claim one current same-session intervention with the authenticated operator identity",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/HandoffRequest" } } },
          },
        },
      },
      "/api/v1/runs/{runId}/handoff/invitations": {
        post: {
          summary: "Create one short-lived invitation scoped to the current required-role intervention",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/HandoffRequest" } } },
          },
        },
      },
      "/api/v1/handoff/invitations/redeem": {
        post: {
          summary: "Consume a one-time intervention invitation with the authenticated required role",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/HandoffInvitationRedeem" } } },
          },
        },
      },
      "/api/v1/runs/{runId}/handoff/action": {
        post: {
          summary: "Restore the session or authenticate a supervisor using the server-selected action",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/HandoffActionRequest" } } },
          },
        },
      },
      "/api/v1/runs/{runId}/handoff/resume": {
        post: {
          summary: "Revalidate and resume the same run on the same retained live session",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/HandoffRequest" } } },
          },
        },
      },
      "/api/v1/runs/{runId}/cancel": { post: { summary: "Cancel owned queued or paused work" } },
      "/api/v1/runs/{runId}/evidence": { get: { summary: "List redacted evidence for an owned run" } },
      "/api/v1/chat": {
        post: { summary: "Return an Anthropic reply, exact capability proposal, or bounded sequence; never starts or approves a run." },
      },
    },
  };

  const operationMethods = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;
  for (const [pathTemplate, rawPathItem] of Object.entries(document.paths)) {
    const pathItem = rawPathItem as Record<string, unknown>;
    const templateVariables = [...pathTemplate.matchAll(/\{([^{}]+)\}/gu)].map((match) => match[1]!);
    if (templateVariables.length > 0) {
      pathItem.parameters = templateVariables.map((name) => ({
        in: "path",
        name,
        required: true,
        schema: { type: "string" },
      }));
    }
    for (const method of operationMethods) {
      const operation = pathItem[method];
      if (!operation || typeof operation !== "object" || Array.isArray(operation)) continue;
      const record = operation as Record<string, unknown>;
      const responses = record.responses;
      if (!responses || typeof responses !== "object" || Array.isArray(responses) || Object.keys(responses).length === 0) {
        record.responses = { default: { description: "Operation response" } };
      }
    }
  }
  return document;
}
