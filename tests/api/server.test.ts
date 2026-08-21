import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApiServer } from "../../src/api/index.js";
import { StaticConsoleIdentityProvider } from "../../src/api/index.js";
import { meridianArtifacts } from "../../src/capabilities/index.js";
import { CapabilityCatalog, loadConfiguredCapabilityCatalog } from "../../src/catalog/index.js";
import {
  ChatRequestCancelledError,
  ChatRoutingError,
  type ChatRouteRequest,
  type ChatRouteResult,
  type ChatRouter,
} from "../../src/chat/index.js";
import type { ReplayProgressV2 } from "../../src/domain/index.js";
import { RunManager, type ManagedReplayRunnerV2, type ManagedRunnerFactoryRequest } from "../../src/runs/index.js";
import { SessionManager } from "../../src/sessions/index.js";
import type { PlaywrightSurface } from "../../src/surface/playwright/playwrightSurface.js";

class Resource {
  closeCount = 0;
  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function readSseUntil(
  reader: { read(): Promise<{ done: boolean; value: Uint8Array | undefined }> },
  marker: string,
  timeoutMs = 2_000,
): Promise<{ text: string; done: boolean }> {
  const decoder = new TextDecoder();
  let text = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const consume = async () => {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.value) text += decoder.decode(chunk.value, { stream: !chunk.done });
      if (text.includes(marker) || chunk.done) return { text, done: chunk.done };
    }
  };
  try {
    return await Promise.race([
      consume(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for SSE marker ${marker}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Test-only intent seam; production constructs the Anthropic router. */
class TestInvocationChatRouter implements ChatRouter {
  readonly name = "api-test-intent";
  readonly model = null;
  readonly requestTimeoutMs = 1_000;

  async route(request: ChatRouteRequest): Promise<ChatRouteResult> {
    const tool = request.tools.find(
      (candidate) => candidate.capabilityId === "member.get_record_and_balances",
    );
    if (!tool) throw new Error("Expected balance capability in the API test catalog");
    return {
      kind: "invoke",
      toolCallId: "api-test-tool-call",
      toolName: tool.name,
      capabilityId: tool.capabilityId,
      capabilityVersion: tool.capabilityVersion,
      arguments: { member_number: "100234" },
      assistantText: null,
      metadata: {
        provider: "api-test-intent",
        model: null,
        responseId: null,
        latencyMs: 0,
      },
    };
  }
}

class BlockingResource extends Resource {
  readonly gate = deferred<void>();

  override async close(): Promise<void> {
    this.closeCount += 1;
    await this.gate.promise;
  }
}

class SuccessRunner implements ManagedReplayRunnerV2 {
  readonly #request: ManagedRunnerFactoryRequest;
  readonly #beforeRun: (() => void) | undefined;
  constructor(request: ManagedRunnerFactoryRequest, beforeRun?: () => void) {
    this.#request = request;
    this.#beforeRun = beforeRun;
  }
  async run(): Promise<ReplayProgressV2> {
    this.#beforeRun?.();
    return {
      status: "terminal",
      phase: "completed",
      result: {
        runId: this.#request.runId,
        capabilityId: this.#request.capabilityId,
        capabilityVersion: this.#request.capabilityVersion,
        artifactDigest: this.#request.artifactDigest,
        inputDigest: this.#request.inputDigest,
        sessionRef: this.#request.sessionRef,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        journal: [],
        incidents: [],
        evidencePaths: [],
        status: "success",
        outputs:
          this.#request.capabilityId === "member.search_by_last_name"
            ? {
                candidates: [{ member_number: "100234", name: "Ada Example", share_count: 1 }],
              }
          : this.#request.capabilityId === "member.get_record_and_balances"
            ? {
                member_number: "100234",
                member_name: "Ada Example",
                email: "ada@example.test",
                phone: "555-0100",
                address: "100 Test Street",
                shares: [
                  {
                    share_id: "100234-S0001",
                    type: "Savings",
                    balance: { currency: "USD", amount: "10.00", minorUnits: 1000 },
                    status: "OPEN",
                    password: "must-not-leak",
                  },
                ],
                password: "must-not-leak",
              }
            : {},
      },
    };
  }
  issueApproval(): string {
    throw new Error("Not awaiting approval");
  }
  resume(): Promise<ReplayProgressV2> {
    throw new Error("Not awaiting approval");
  }
  async close(): Promise<void> {}
}

const CURRENT_CHALLENGE = "11111111-1111-4111-8111-111111111111";

class ApprovalRunner implements ManagedReplayRunnerV2 {
  readonly #request: ManagedRunnerFactoryRequest;
  readonly #requirement: "user_confirmation" | "supervisor_confirmation";
  constructor(
    request: ManagedRunnerFactoryRequest,
    requirement: "user_confirmation" | "supervisor_confirmation" = "user_confirmation",
  ) {
    this.#request = request;
    this.#requirement = requirement;
  }
  async run(): Promise<ReplayProgressV2> {
    return {
      status: "awaiting_approval",
      phase: "awaiting_approval",
      challenge: {
        challengeId: CURRENT_CHALLENGE,
        runId: this.#request.runId,
        stepId: "commit_transfer",
        stepTitle: "Post transfer",
        requirement: this.#requirement,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        expiresInMs: 60_000,
        summary: [{ targetId: "review_amount", value: "$1.25", sensitive: true }],
      },
      journal: [],
      incidents: [],
    };
  }
  issueApproval(): string {
    return "test-approval";
  }
  async resume(_approvalToken: string): Promise<ReplayProgressV2> {
    return new SuccessRunner(this.#request).run();
  }
  async close(): Promise<void> {}
}

class EffectUnknownRunner implements ManagedReplayRunnerV2 {
  readonly #request: ManagedRunnerFactoryRequest;
  constructor(request: ManagedRunnerFactoryRequest) {
    this.#request = request;
  }
  async run(): Promise<ReplayProgressV2> {
    return {
      status: "terminal",
      phase: "completed",
      result: {
        runId: this.#request.runId,
        capabilityId: this.#request.capabilityId,
        capabilityVersion: this.#request.capabilityVersion,
        artifactDigest: this.#request.artifactDigest,
        inputDigest: this.#request.inputDigest,
        sessionRef: this.#request.sessionRef,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        journal: [],
        incidents: [],
        evidencePaths: [],
        status: "failure",
        code: "EFFECT_UNKNOWN",
        message: "The write outcome requires reconciliation.",
        retryable: false,
        effectUncertain: true,
        reconciliationOutputs: {
          email_before: "ada@example.test",
          phone_before: "555-0100",
          address_before: "100 Test Street",
        },
      },
    };
  }
  issueApproval(): string {
    throw new Error("Not awaiting approval");
  }
  resume(): Promise<ReplayProgressV2> {
    throw new Error("Not awaiting approval");
  }
  async close(): Promise<void> {}
}

const CURRENT_INTERVENTION = "22222222-2222-4222-8222-222222222222";

class HandoffRunner implements ManagedReplayRunnerV2 {
  readonly #request: ManagedRunnerFactoryRequest;
  readonly #release: () => Promise<void>;
  readonly #action: "restore_session" | "authenticate_supervisor";
  readonly #requiredRole: string | undefined;
  readonly #onAction: (() => void | Promise<void>) | undefined;
  readonly #resumeToSupervisorApproval: boolean;
  #state: "awaiting_human" | "human_active" | "action_completed" | "revalidating" = "awaiting_human";
  #actorId: string | undefined;
  #actionCompleted = false;
  #approvalRunner: ApprovalRunner | undefined;

  constructor(
    request: ManagedRunnerFactoryRequest,
    release: () => Promise<void>,
    options: {
      action?: "restore_session" | "authenticate_supervisor";
      requiredRole?: string;
      onAction?: () => void | Promise<void>;
      resumeToSupervisorApproval?: boolean;
    } = {},
  ) {
    this.#request = request;
    this.#release = release;
    this.#action = options.action ?? "restore_session";
    this.#requiredRole = options.requiredRole;
    this.#onAction = options.onAction;
    this.#resumeToSupervisorApproval = options.resumeToSupervisorApproval ?? false;
  }

  async run(): Promise<ReplayProgressV2> {
    return this.#progress();
  }

  issueApproval(): string {
    if (!this.#approvalRunner) throw new Error("Not awaiting approval");
    return this.#approvalRunner.issueApproval();
  }

  resume(approvalToken: string): Promise<ReplayProgressV2> {
    if (!this.#approvalRunner) throw new Error("Not awaiting approval");
    return this.#approvalRunner.resume(approvalToken);
  }

  async takeHumanControl(
    interventionId: string,
    actor: { id: string; roles: readonly string[] },
  ): Promise<ReplayProgressV2> {
    if (interventionId !== CURRENT_INTERVENTION) throw new Error("Stale intervention");
    if (this.#requiredRole && !actor.roles.includes(this.#requiredRole)) {
      throw Object.assign(new Error("Required role missing"), { code: "ROLE_REQUIRED" });
    }
    this.#actorId = actor.id;
    this.#state = "human_active";
    return this.#progress();
  }

  async performHumanAction(
    interventionId: string,
    actor: { id: string; roles: readonly string[] },
    action: "restore_session" | "authenticate_supervisor",
  ): Promise<ReplayProgressV2> {
    if (interventionId !== CURRENT_INTERVENTION || actor.id !== this.#actorId || action !== this.#action) {
      throw new Error("Invalid intervention action");
    }
    await this.#onAction?.();
    this.#actionCompleted = true;
    this.#state = "action_completed";
    return this.#progress();
  }

  async resumeHuman(
    interventionId: string,
    actor: { id: string; roles: readonly string[] },
  ): Promise<ReplayProgressV2> {
    if (
      interventionId !== CURRENT_INTERVENTION ||
      actor.id !== this.#actorId ||
      !this.#actionCompleted ||
      this.#state !== "action_completed"
    ) {
      throw new Error("Invalid intervention resume");
    }
    this.#state = "revalidating";
    if (this.#resumeToSupervisorApproval) {
      this.#approvalRunner = new ApprovalRunner(this.#request, "supervisor_confirmation");
      return this.#approvalRunner.run();
    }
    return new SuccessRunner(this.#request).run();
  }

  async close(): Promise<void> {
    await this.#release();
  }

  #progress(): Extract<ReplayProgressV2, { status: "awaiting_human" }> {
    return {
      status: "awaiting_human",
      phase: "awaiting_human",
      intervention: {
        interventionId: CURRENT_INTERVENTION,
        runId: this.#request.runId,
        stepId: "open_member",
        reasonCode: "SESSION_EXPIRED",
        action: this.#action,
        ...(this.#requiredRole ? { requiredRole: this.#requiredRole } : {}),
        state: this.#state,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        sameLiveSession: true,
      },
      journal: [],
      incidents: [{
        code: "SESSION_EXPIRED",
        category: "intervention",
        message: "RAW_TARGET_SESSION_CANARY",
        stepId: "open_member",
        occurredAt: new Date().toISOString(),
      }],
    };
  }
}

const apps: Array<ReturnType<typeof buildApiServer>> = [];

async function fixture(options: {
  approvalForWrites?: boolean;
  handoffForReads?: boolean;
  chat?: ChatRouter;
  catalog?: CapabilityCatalog;
  failCapability?: string;
  effectUnknownCapability?: string;
  signOnFails?: boolean;
  signOnPaused?: boolean;
  sessionResource?: Resource;
  onFactoryRequest?: (request: ManagedRunnerFactoryRequest) => void;
  sessionNow?: () => number;
} = {}) {
  const catalog = options.catalog ?? CapabilityCatalog.fromArtifacts(meridianArtifacts);
  const sessions = new SessionManager<PlaywrightSurface>({
    ...(options.sessionNow ? { now: options.sessionNow, idleTtlMs: 5_000 } : {}),
  });
  const pending = new Map<string, { operatorId: string; role: "teller" | "supervisor"; branch: string }>();
  const runs = new RunManager({
    runnerFactory: async (request) => {
      options.onFactoryRequest?.(request);
      if (options.signOnFails && request.capabilityId === "session.sign_on") {
        throw new Error("SIGNON_SECRET_CANARY C:\\private\\browser-profile");
      }
      if (options.signOnPaused && request.capabilityId === "session.sign_on") {
        return new ApprovalRunner(request);
      }
      if (options.failCapability === request.capabilityId) {
        throw new Error("RUNNER_SECRET_CANARY C:\\private\\member-100234.html");
      }
      if (options.effectUnknownCapability === request.capabilityId) {
        return new EffectUnknownRunner(request);
      }
      if (options.approvalForWrites && request.capabilityId === "funds.transfer") {
        return new ApprovalRunner(request);
      }
      if (options.handoffForReads && request.capabilityId === "member.get_record_and_balances") {
        const lease = await sessions.acquire(request.sessionRef, request.runId);
        return new HandoffRunner(request, async () => lease.release());
      }
      if (request.capabilityId === "account.place_hold") {
        const lease = await sessions.acquire(request.sessionRef, request.runId);
        return new HandoffRunner(request, async () => lease.release(), {
          action: "authenticate_supervisor",
          requiredRole: "supervisor",
          resumeToSupervisorApproval: true,
          onAction: () => {
            sessions.rebindPrincipal(
              request.sessionRef,
              request.runId,
              lease.principal,
              { operatorId: "super1", role: "supervisor", branch: lease.principal.branch },
            );
          },
        });
      }
      return new SuccessRunner(
        request,
        request.capabilityId === "session.sign_on"
          ? () => {
              const principal = pending.get(request.sessionRef);
              if (!principal) throw new Error("Missing test principal");
              pending.delete(request.sessionRef);
              sessions.registerProvisioning(
                request.sessionRef,
                (options.sessionResource ?? new Resource()) as unknown as PlaywrightSurface,
              );
              sessions.activate(request.sessionRef, principal);
            }
          : undefined,
      );
    },
    cleanupIntervalMs: false,
  });
  const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "meridian-api-"));
  const identity = new StaticConsoleIdentityProvider({
    teller: { accessCode: "teller-console-test-code-0001", subject: "test:teller" },
    supervisor: { accessCode: "supervisor-console-test-code-0001", subject: "test:supervisor" },
  });
  const app = buildApiServer({
    catalog,
    runs,
    sessions,
    chat: options.chat ?? new TestInvocationChatRouter(),
    identity,
    credentials: {
      teller: { operator: "teller1", password: "server-only-password", role: "teller" },
      supervisor: { operator: "super1", password: "server-only-password", role: "supervisor" },
    },
    evidenceRoot,
    registerPendingPrincipal: (sessionRef, principal) => pending.set(sessionRef, principal),
    clearPendingPrincipal: (sessionRef) => pending.delete(sessionRef),
  });
  apps.push(app);
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { "x-meridian-action": "operator" },
    payload: { accessCode: "teller-console-test-code-0001" },
  });
  expect(login.statusCode).toBe(200);
  const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
  const signOn = await app.inject({
    method: "POST",
    url: "/api/v1/sessions",
    headers: { cookie, "x-meridian-action": "operator" },
    payload: { profile: "teller", branch: "MAIN-001" },
  });
  expect(signOn.statusCode).toBe(202);
  if (!options.signOnFails && !options.signOnPaused) {
    await vi.waitFor(async () => {
      const me = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie } });
      expect(me.json().meridianSession?.state).toBe("active");
    });
  }
  return { app, catalog, cookie, evidenceRoot, signOnRunId: signOn.json().run.runId as string };
}

function metadata(provider = "test-provider") {
  return {
    provider,
    model: "private-model-id",
    responseId: "private-provider-response-id",
    latencyMs: 42,
  } as const;
}

class ExposingChatRouter implements ChatRouter {
  readonly name = "exposing-test-router";
  readonly model = "private-model-id";
  readonly requestTimeoutMs: number = 1_000;
  async route(): Promise<ChatRouteResult> {
    return {
      kind: "invoke",
      toolCallId: "private-provider-tool-call-id",
      toolName: "member_get_record_and_balances",
      capabilityId: "member.get_record_and_balances",
      capabilityVersion: "2.0.0",
      arguments: { member_number: "100234" },
      assistantText: "Prepared for local review.",
      metadata: metadata(),
    };
  }
}

class SequenceChatRouter implements ChatRouter {
  readonly name = "sequence-test-router";
  readonly model = "private-model-id";
  readonly requestTimeoutMs = 1_000;
  async route(): Promise<ChatRouteResult> {
    return {
      kind: "sequence",
      toolCallId: "private-sequence-tool-call-id",
      failurePolicy: "stop_on_non_success",
      assistantText: "I will find the member and load the unique result.",
      metadata: metadata(),
      steps: [
        {
          stepId: "search",
          toolName: "member_search_by_last_name",
          capabilityId: "member.search_by_last_name",
          capabilityVersion: "2.0.0",
          literalArguments: { last_name: "Example" },
          bindings: [],
        },
        {
          stepId: "balances",
          toolName: "member_get_record_and_balances",
          capabilityId: "member.get_record_and_balances",
          capabilityVersion: "2.0.0",
          literalArguments: {},
          bindings: [{
            sourceStepId: "search",
            sourceCollectionPath: ["candidates"],
            valuePath: ["member_number"],
            targetInput: "member_number",
            selection: "exactly_one",
            onZero: "stop_no_match",
            onMany: "pause_for_authenticated_selection",
          }],
        },
      ],
    };
  }
}

class FailingChatRouter implements ChatRouter {
  readonly name = "failing-test-router";
  readonly model = null;
  readonly requestTimeoutMs = 1_000;
  async route(): Promise<ChatRouteResult> {
    throw new ChatRoutingError(
      "PROVIDER_REQUEST_FAILED",
      "PROVIDER_PAYLOAD_CANARY sk-ant-private-value",
      { cause: new Error("Authorization: Bearer PRIVATE_CAUSE_CANARY") },
    );
  }
}

class MisconfiguredSlowChatRouter extends ExposingChatRouter {
  override readonly requestTimeoutMs = 18_001;
}

class BlockingChatRouter implements ChatRouter {
  readonly name = "blocking-test-router";
  readonly model = null;
  readonly requestTimeoutMs = 1_000;
  private startedResolve!: () => void;
  readonly started = new Promise<void>((resolve) => { this.startedResolve = resolve; });
  async route(request: ChatRouteRequest): Promise<ChatRouteResult> {
    this.startedResolve();
    return new Promise<ChatRouteResult>((_resolve, reject) => {
      const cancel = () => reject(new ChatRequestCancelledError());
      request.signal?.addEventListener("abort", cancel, { once: true });
      if (request.signal?.aborted) cancel();
    });
  }
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe("MERIDIAN API", () => {
  it("exposes the approved catalog and OpenAPI contract", async () => {
    const { app, cookie } = await fixture();
    const unauthorized = await app.inject({ method: "GET", url: "/api/v1/capabilities" });
    expect(unauthorized.statusCode).toBe(401);
    const catalog = await app.inject({ method: "GET", url: "/api/v1/capabilities", headers: { cookie } });
    expect(catalog.statusCode).toBe(200);
    const capabilities = catalog.json().capabilities as Array<Record<string, unknown>>;
    expect(capabilities).toHaveLength(8);
    expect(capabilities.find((item) => item.id === "account.place_hold")).toMatchObject({
      risk: "supervisor_only",
      supportsSupervisorHandoff: true,
    });
    expect(
      capabilities
        .filter((item) => item.id !== "account.place_hold")
        .every((item) => item.supportsSupervisorHandoff === false),
    ).toBe(true);
    const openapi = await app.inject({ method: "GET", url: "/api/v1/openapi.json" });
    expect(openapi.json()).toMatchObject({ openapi: "3.1.0" });
  });

  it("publishes responses and every required path parameter for all OpenAPI operations", async () => {
    const { app } = await fixture();
    const response = await app.inject({ method: "GET", url: "/api/v1/openapi.json" });
    expect(response.statusCode).toBe(200);
    const document = response.json() as { paths: Record<string, Record<string, unknown>> };
    const operationMethods = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

    for (const [pathTemplate, pathItem] of Object.entries(document.paths)) {
      const templateVariables = [...pathTemplate.matchAll(/\{([^{}]+)\}/gu)].map((match) => match[1]!);
      for (const method of operationMethods) {
        const operation = pathItem[method];
        if (!operation || typeof operation !== "object" || Array.isArray(operation)) continue;
        const operationRecord = operation as Record<string, unknown>;
        const responses = operationRecord.responses;
        expect(
          responses && typeof responses === "object" && !Array.isArray(responses)
            ? Object.keys(responses).length
            : 0,
          `${method.toUpperCase()} ${pathTemplate} must document at least one response`,
        ).toBeGreaterThan(0);

        const parameters = [pathItem.parameters, operationRecord.parameters]
          .filter(Array.isArray)
          .flat() as Array<Record<string, unknown>>;
        for (const name of templateVariables) {
          expect(
            parameters.some(
              (parameter) =>
                parameter.in === "path" &&
                parameter.name === name &&
                parameter.required === true,
            ),
            `${method.toUpperCase()} ${pathTemplate} must declare required path parameter ${name}`,
          ).toBe(true);
        }
      }
    }

    expect((document.paths["/api/v1/runs"]!.get as Record<string, unknown>).summary).toBe(
      "List identity-visible retained runs: owned runs plus active delegated handoffs",
    );
    expect(
      (document.paths["/api/v1/runs/{runId}/handoff/action"]!.post as Record<string, unknown>).summary,
    ).toBe("Restore the session or authenticate a supervisor using the server-selected action");
  });

  it("serves only authenticated, published discovery history with invocation values withheld", async () => {
    const publishedCatalog = await loadConfiguredCapabilityCatalog({
      environment: {
        CAPABILITY_ARTIFACT_ROOT: path.resolve("catalog", "meridian-v2", "artifacts"),
        CAPABILITY_LINEAGE_ROOT: path.resolve("catalog", "meridian-v2", "lineage"),
      },
    });
    const { app, cookie } = await fixture({ catalog: publishedCatalog });

    const unauthorized = await app.inject({ method: "GET", url: "/api/v1/discovery-runs" });
    expect(unauthorized.statusCode).toBe(401);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/discovery-runs",
      headers: { cookie },
    });
    expect(list.statusCode).toBe(200);
    const discoveryRuns = list.json().discoveryRuns as Array<Record<string, unknown>>;
    expect(discoveryRuns).toHaveLength(8);
    for (const record of discoveryRuns) {
      expect(record).toMatchObject({
        kind: "discovery",
        status: "approved",
        provider: "anthropic-messages",
      });
      const inputs = record.inputs as Array<Record<string, unknown>>;
      expect(inputs.every((input) => input.valueStatus === "withheld" && !("value" in input))).toBe(true);
    }
    const balances = discoveryRuns.find(
      (record) => record.capabilityId === "member.get_record_and_balances",
    );
    expect(balances).toMatchObject({
      kind: "discovery",
      id: expect.stringMatching(/^discovery\./u),
      discoveryRunId: expect.stringMatching(/^discovery\./u),
      capabilityId: "member.get_record_and_balances",
      capabilityVersion: "2.0.0",
      createdAt: expect.stringMatching(/^2026-/u),
      completedAt: expect.stringMatching(/^2026-/u),
      status: "approved",
      provider: "anthropic-messages",
      model: expect.any(String),
      goal: expect.any(String),
      inputs: [
        {
          name: "member_number",
          type: expect.objectContaining({ kind: "string", format: "member_number" }),
          classification: "restricted",
          required: true,
          valueStatus: "withheld",
        },
      ],
      outputContract: expect.arrayContaining([
        expect.objectContaining({
          name: "member_number",
          type: expect.objectContaining({ kind: "string", format: "member_number" }),
          classification: "restricted",
        }),
        expect.objectContaining({ name: "shares", classification: "restricted" }),
      ]),
      output: {
        traceDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        draftDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        reviewedDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        canaryRunId: expect.stringMatching(/^canary\./u),
        approvedDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
      timeline: [
        expect.objectContaining({ type: "draft_created", actor: "discovery_compiler" }),
        expect.objectContaining({ type: "reviewed", reviewDiffDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) }),
        expect.objectContaining({ type: "canary_passed", evidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) }),
        expect.objectContaining({ type: "approved" }),
      ],
      evidence: [
        expect.objectContaining({
          kind: "artifact",
          referenceId: "member.get_record_and_balances@2.0.0",
          url: "/api/v1/capabilities/member.get_record_and_balances/2.0.0",
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        }),
        expect.objectContaining({
          kind: "lineage",
          referenceId: expect.stringMatching(/^lineage\./u),
          url: expect.stringMatching(/^\/api\/v1\/discovery-runs\/discovery\./u),
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        }),
      ],
    });
    expect(balances?.id).toBe(balances?.discoveryRunId);
    expect(JSON.stringify(balances?.inputs)).not.toContain("100234");
    expect(JSON.stringify(balances)).not.toContain("catalog/meridian-v2");
    expect(balances).not.toHaveProperty("trace");

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/discovery-runs/${encodeURIComponent(String(balances?.id))}`,
      headers: { cookie },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().discoveryRun).toEqual(balances);

    const missing = await app.inject({
      method: "GET",
      url: "/api/v1/discovery-runs/discovery.missing",
      headers: { cookie },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({
      error: { code: "DISCOVERY_RUN_NOT_FOUND", message: "Discovery run not found" },
    });

    const openapi = await app.inject({ method: "GET", url: "/api/v1/openapi.json" });
    expect(openapi.json()).toMatchObject({
      components: {
        schemas: {
          DiscoveryRun: expect.objectContaining({
            required: expect.arrayContaining(["outputContract"]),
          }),
          DiscoveryRunOutputField: expect.any(Object),
        },
      },
      paths: {
        "/api/v1/discovery-runs": { get: expect.any(Object) },
        "/api/v1/discovery-runs/{id}": { get: expect.any(Object) },
        "/api/v1/chat": {
          post: {
            summary: "Return an Anthropic reply, exact capability proposal, or bounded sequence; never starts or approves a run.",
          },
        },
      },
    });
  });

  it("does not synthesize discovery history for artifacts without published lineage", async () => {
    const { app, cookie } = await fixture();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/discovery-runs",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ discoveryRuns: [] });
  });

  it("rejects cross-surface mutation calls, requires write idempotency, and gates supervisor work", async () => {
    const { app, catalog, cookie } = await fixture();
    const body = {
      capabilityId: "funds.transfer",
      artifactDigest: catalog.get("funds.transfer", "2.0.0")!.digest,
      inputs: {
        member_number: "100234",
        from_share: "100234-S0070",
        to_share: "100234-S0001-3",
        amount: { currency: "USD", amount: "1.00", minorUnits: 100 },
        memo: "test",
      },
    };
    const missingHeader = await app.inject({ method: "POST", url: "/api/v1/runs", headers: { cookie }, payload: body });
    expect(missingHeader.statusCode).toBe(403);
    const missingKey = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { cookie, "x-meridian-action": "operator" },
      payload: body,
    });
    expect(missingKey.statusCode).toBe(400);
    expect(missingKey.json()).toMatchObject({ error: { code: "IDEMPOTENCY_REQUIRED" } });

    const hold = catalog.get("account.place_hold", "2.0.0")!;
    const supervisorOnly = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: {
        cookie,
        "x-meridian-action": "operator",
        "idempotency-key": "hold-test-1",
      },
      payload: {
        capabilityId: hold.id,
        artifactDigest: hold.digest,
        inputs: {
          member_number: "100234",
          share: "100234-S0001",
          reason: "FRAUD",
          notes: "test hold",
        },
      },
    });
    expect(supervisorOnly.statusCode).toBe(202);
    const supervisorRunId = supervisorOnly.json().run.runId as string;
    await vi.waitFor(async () => {
      const gated = await app.inject({
        method: "GET",
        url: `/api/v1/runs/${supervisorRunId}`,
        headers: { cookie },
      });
      expect(gated.json().run).toMatchObject({
        phase: "awaiting_human",
        progress: {
          intervention: {
            action: "authenticate_supervisor",
            requiredRole: "supervisor",
            sameLiveSession: true,
          },
        },
      });
    });
  });

  it("queues read work with a server-resolved approved artifact digest", async () => {
    const { app, catalog, cookie } = await fixture();
    const entry = catalog.get("member.get_record_and_balances", "2.0.0")!;
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { cookie, "x-meridian-action": "operator" },
      payload: {
        capabilityId: "member.get_record_and_balances",
        artifactDigest: entry.digest,
        inputs: { member_number: "100234" },
      },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json().run).toMatchObject({
      capabilityId: "member.get_record_and_balances",
      artifactDigest: entry.digest,
    });
    expect(response.json().run).not.toHaveProperty("sessionRef");
  });

  it("starts a read-only reconciliation from EFFECT_UNKNOWN and classifies the real current snapshot", async () => {
    const { app, catalog, cookie } = await fixture({
      effectUnknownCapability: "member.update_information",
    });
    const capability = catalog.get("member.update_information", "2.0.0")!;
    const source = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: {
        cookie,
        "x-meridian-action": "operator",
        "idempotency-key": "effect-unknown-update-1",
      },
      payload: {
        capabilityId: capability.id,
        capabilityVersion: capability.version,
        artifactDigest: capability.digest,
        inputs: {
          member_number: "100234",
          email: "changed@example.test",
          phone: "555-0199",
          address: "200 Changed Street",
        },
      },
    });
    expect(source.statusCode).toBe(202);
    const sourceRunId = source.json().run.runId as string;
    await vi.waitFor(async () => {
      const current = await app.inject({ method: "GET", url: `/api/v1/runs/${sourceRunId}`, headers: { cookie } });
      expect(current.json().run.progress.result).toMatchObject({
        status: "failure",
        code: "EFFECT_UNKNOWN",
        effectUncertain: true,
      });
    });

    const started = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${sourceRunId}/reconciliation`,
      headers: { cookie, "x-meridian-action": "operator" },
      payload: {},
    });
    expect(started.statusCode).toBe(202);
    expect(started.json().run).toMatchObject({
      capabilityId: "member.get_record_and_balances",
      orchestration: { kind: "reconciliation", sourceRunId },
    });
    await vi.waitFor(async () => {
      const result = await app.inject({
        method: "GET",
        url: `/api/v1/runs/${sourceRunId}/reconciliation`,
        headers: { cookie },
      });
      expect(result.statusCode).toBe(200);
      expect(result.json().reconciliation).toMatchObject({
        sourceRunId,
        status: "complete",
        decision: {
          classification: "not_applied",
          checkedFields: ["email", "phone", "address", "pre_commit_values"],
        },
      });
      expect(result.body).not.toContain("changed@example.test");
      expect(result.body).not.toContain("200 Changed Street");
    });
  });

  it("keeps target credentials out of run-manager inputs and public digests", async () => {
    const requests: ManagedRunnerFactoryRequest[] = [];
    const { app, cookie, signOnRunId } = await fixture({
      onFactoryRequest: (request) => requests.push(request),
    });
    const signOnRequest = requests.find((request) => request.runId === signOnRunId);
    expect(signOnRequest?.inputs).toEqual({ operator: "teller1", branch: "MAIN-001" });
    expect(JSON.stringify(signOnRequest)).not.toContain("server-only-password");
    const signOn = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${signOnRunId}`,
      headers: { cookie },
    });
    expect(signOn.body).not.toContain("server-only-password");
    expect(signOn.json().run).not.toHaveProperty("inputDigest");
    expect(signOn.json().run.progress?.result).not.toHaveProperty("inputDigest");
  });

  it("requires a complete logout before changing console identity", async () => {
    const { app, cookie } = await fixture();
    const attemptedSwitch = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { cookie, "x-meridian-action": "operator" },
      payload: { accessCode: "supervisor-console-test-code-0001" },
    });
    expect(attemptedSwitch.statusCode).toBe(409);
    expect(attemptedSwitch.headers).not.toHaveProperty("set-cookie");
    expect(attemptedSwitch.json()).toMatchObject({
      error: { code: "IDENTITY_SWITCH_REQUIRES_LOGOUT" },
    });

    const stillTeller = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie },
    });
    expect(stillTeller.statusCode).toBe(200);
    expect(stillTeller.json().principal).toMatchObject({ subject: "test:teller", roles: ["teller"] });
  });

  it("blocks new work while logout is joining target-session teardown", async () => {
    const resource = new BlockingResource();
    const { app, cookie } = await fixture({ sessionResource: resource });
    const logout = app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { cookie, "x-meridian-action": "operator" },
    });
    await vi.waitFor(() => expect(resource.closeCount).toBe(1));

    const concurrentMutation = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: { cookie, "x-meridian-action": "operator" },
      payload: { profile: "teller", branch: "MAIN-001" },
    });
    expect(concurrentMutation.statusCode).toBe(409);
    expect(concurrentMutation.json()).toMatchObject({
      error: { code: "AUTH_SESSION_TERMINATING" },
    });

    resource.gate.resolve();
    expect((await logout).statusCode).toBe(200);
  });

  it("clears queued sign-on ownership immediately after safe cancellation", async () => {
    const { app, cookie, signOnRunId } = await fixture({ signOnPaused: true });
    await vi.waitFor(async () => {
      const run = await app.inject({
        method: "GET",
        url: `/api/v1/runs/${signOnRunId}`,
        headers: { cookie },
      });
      expect(run.json().run.phase).toBe("awaiting_approval");
    });
    const cancelled = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${signOnRunId}/cancel`,
      headers: { cookie, "x-meridian-action": "operator" },
      payload: {},
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().run).toMatchObject({
      phase: "completed",
      cancellation: { code: "CANCELLED" },
    });
    const me = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie } });
    expect(me.json().meridianSession).toBeNull();

    const replacement = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: { cookie, "x-meridian-action": "operator" },
      payload: { profile: "teller", branch: "MAIN-001" },
    });
    expect(replacement.statusCode).toBe(202);
  });

  it("rejects work immediately when the target session idle deadline has passed", async () => {
    let now = 0;
    const { app, catalog, cookie } = await fixture({ sessionNow: () => now });
    now = 5_000;
    const me = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie } });
    expect(me.json().meridianSession).toBeNull();

    const capability = catalog.get("member.get_record_and_balances", "2.0.0")!;
    const rejected = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { cookie, "x-meridian-action": "operator" },
      payload: {
        capabilityId: capability.id,
        artifactDigest: capability.digest,
        inputs: { member_number: "100234" },
      },
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json()).toMatchObject({ error: { code: "SESSION_NOT_ACTIVE" } });
  });

  it("returns a catalog-bound invocation and never exposes sign-on", async () => {
    const { app, cookie } = await fixture();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat",
      headers: { cookie, "x-meridian-action": "operator" },
      payload: {
        message: '/run member.get_record_and_balances {"member_number":"100234"}',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      route: { kind: "invoke", capabilityId: "member.get_record_and_balances" },
    });
    expect(response.json()).not.toHaveProperty("run");
  });

  it("executes a server-bound chat sequence in order and resolves typed outputs without trusting the model", async () => {
    const requests: ManagedRunnerFactoryRequest[] = [];
    const { app, cookie } = await fixture({
      chat: new SequenceChatRouter(),
      onFactoryRequest: (request) => requests.push(request),
    });
    const proposed = await app.inject({
      method: "POST",
      url: "/api/v1/chat",
      headers: { cookie, "x-meridian-action": "operator" },
      payload: { message: "Find Example and show the unique member balances" },
    });
    expect(proposed.statusCode).toBe(200);
    const plan = proposed.json().route;
    expect(plan).toMatchObject({
      kind: "sequence",
      failurePolicy: "stop_on_non_success",
      steps: [
        { stepId: "search", capabilityId: "member.search_by_last_name", artifactDigest: expect.any(String) },
        { stepId: "balances", capabilityId: "member.get_record_and_balances", artifactDigest: expect.any(String) },
      ],
    });
    expect(plan.sequenceId).toMatch(/^[a-f0-9-]{36}$/u);
    expect(proposed.body).not.toContain("private-sequence-tool-call-id");
    expect(proposed.body).not.toContain("private-provider-response-id");
    expect(proposed.body).not.toContain("private-model-id");

    const firstStep = plan.steps[0];
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { cookie, "x-meridian-action": "operator" },
      payload: {
        capabilityId: firstStep.capabilityId,
        capabilityVersion: firstStep.capabilityVersion,
        artifactDigest: firstStep.artifactDigest,
        inputs: firstStep.literalArguments,
        sequence: { sequenceId: plan.sequenceId, stepId: firstStep.stepId },
      },
    });
    expect(first.statusCode).toBe(202);
    const firstRunId = first.json().run.runId as string;
    await vi.waitFor(async () => {
      const current = await app.inject({ method: "GET", url: `/api/v1/runs/${firstRunId}`, headers: { cookie } });
      expect(current.json().run.phase).toBe("completed");
    });

    const secondStep = plan.steps[1];
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { cookie, "x-meridian-action": "operator" },
      payload: {
        capabilityId: secondStep.capabilityId,
        capabilityVersion: secondStep.capabilityVersion,
        artifactDigest: secondStep.artifactDigest,
        inputs: secondStep.literalArguments,
        sequence: { sequenceId: plan.sequenceId, stepId: secondStep.stepId },
      },
    });
    expect(second.statusCode).toBe(202);
    expect(second.json().run.orchestration).toMatchObject({
      kind: "chat_sequence",
      sequenceId: plan.sequenceId,
      stepId: "balances",
      stepIndex: 1,
      stepCount: 2,
      parentRunId: firstRunId,
    });
    await vi.waitFor(() => {
      const factoryRequest = requests.find((request) => request.runId === second.json().run.runId);
      expect(factoryRequest?.inputs).toEqual({ member_number: "100234" });
      expect(factoryRequest?.orchestration).toMatchObject({ parentRunId: firstRunId });
    });

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { cookie, "x-meridian-action": "operator" },
      payload: {
        capabilityId: secondStep.capabilityId,
        capabilityVersion: secondStep.capabilityVersion,
        artifactDigest: secondStep.artifactDigest,
        inputs: secondStep.literalArguments,
        sequence: { sequenceId: plan.sequenceId, stepId: secondStep.stepId },
      },
    });
    expect(duplicate.statusCode).toBe(202);
    expect(duplicate.json().run.runId).toBe(second.json().run.runId);
  });

  it("projects provider routes and structured errors without leaking provider internals", async () => {
    const exposed = await fixture({ chat: new ExposingChatRouter() });
    const proposal = await exposed.app.inject({
      method: "POST",
      url: "/api/v1/chat",
      headers: { cookie: exposed.cookie, "x-meridian-action": "operator" },
      payload: { message: "Show member 100234" },
    });
    expect(proposal.statusCode).toBe(200);
    expect(proposal.json()).toMatchObject({
      route: {
        kind: "invoke",
        capabilityId: "member.get_record_and_balances",
        arguments: { member_number: "100234" },
      },
    });
    expect(proposal.body).not.toContain("private-provider-tool-call-id");
    expect(proposal.body).not.toContain("private-provider-response-id");
    expect(proposal.body).not.toContain("private-model-id");

    const failed = await fixture({ chat: new FailingChatRouter() });
    const failure = await failed.app.inject({
      method: "POST",
      url: "/api/v1/chat",
      headers: { cookie: failed.cookie, "x-meridian-action": "operator" },
      payload: { message: "Route this request" },
    });
    expect(failure.statusCode).toBe(502);
    expect(failure.json()).toEqual({
      error: {
        code: "PROVIDER_REQUEST_FAILED",
        message: "The assistant provider rejected the routing request.",
      },
    });
    expect(failure.body).not.toContain("PROVIDER_PAYLOAD_CANARY");
    expect(failure.body).not.toContain("PRIVATE_CAUSE_CANARY");
    expect(failure.body).not.toContain("sk-ant");
  });

  it("rejects a chat deadline that would outlive the browser contract", async () => {
    await expect(fixture({ chat: new MisconfiguredSlowChatRouter() })).rejects.toMatchObject({
      code: "PROVIDER_CONFIGURATION_ERROR",
    });
  });

  it("allows only one in-flight assistant request per authenticated identity and aborts it on logout", async () => {
    const router = new BlockingChatRouter();
    const { app, cookie } = await fixture({ chat: router });
    const first = app.inject({
      method: "POST",
      url: "/api/v1/chat",
      headers: { cookie, "x-meridian-action": "operator" },
      payload: { message: "First request" },
    });
    await router.started;
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/v1/chat",
      headers: { cookie, "x-meridian-action": "operator" },
      payload: { message: "Second request" },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ error: { code: "CHAT_IN_PROGRESS" } });

    const signedOut = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { cookie, "x-meridian-action": "operator" },
    });
    expect(signedOut.statusCode).toBe(200);
    const cancelled = await first;
    expect(cancelled.statusCode).toBe(408);
    expect(cancelled.json()).toMatchObject({ error: { code: "REQUEST_CANCELLED" } });
  });

  it("normalizes money and binds approval to the exact current challenge", async () => {
    const { app, catalog, cookie } = await fixture({ approvalForWrites: true });
    const transfer = catalog.get("funds.transfer", "2.0.0")!;
    const queued = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: {
        cookie,
        "x-meridian-action": "operator",
        "idempotency-key": "transfer-test-1",
      },
      payload: {
        capabilityId: transfer.id,
        capabilityVersion: transfer.version,
        artifactDigest: transfer.digest,
        inputs: {
          member_number: "100234",
          from_share: "100234-S0070",
          to_share: "100234-S0001-3",
          amount: "1.25",
          memo: "test",
        },
      },
    });
    expect(queued.statusCode).toBe(202);
    const runId = queued.json().run.runId as string;
    await vi.waitFor(async () => {
      const response = await app.inject({ method: "GET", url: `/api/v1/runs/${runId}`, headers: { cookie } });
      expect(response.json().run.phase).toBe("awaiting_approval");
    });

    const stale = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${runId}/approve`,
      headers: { cookie, "x-meridian-action": "operator" },
      payload: { challengeId: "22222222-2222-4222-8222-222222222222", decision: "approve" },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: "RUN_NOT_APPROVABLE" } });

    const current = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${runId}/approve`,
      headers: { cookie, "x-meridian-action": "operator" },
      payload: { challengeId: CURRENT_CHALLENGE, decision: "approve" },
    });
    expect(current.statusCode).toBe(202);
  });

  it("binds same-session handoff to one opaque intervention and a fixed server action", async () => {
    const { app, catalog, cookie } = await fixture({ handoffForReads: true });
    const capability = catalog.get("member.get_record_and_balances", "2.0.0")!;
    const queued = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { cookie, "x-meridian-action": "operator" },
      payload: {
        capabilityId: capability.id,
        artifactDigest: capability.digest,
        inputs: { member_number: "100234" },
      },
    });
    const runId = queued.json().run.runId as string;
    let intervention: Record<string, unknown> = {};
    await vi.waitFor(async () => {
      const response = await app.inject({ method: "GET", url: `/api/v1/runs/${runId}`, headers: { cookie } });
      expect(response.json().run.phase).toBe("awaiting_human");
      intervention = response.json().run.progress.intervention;
    });
    expect(intervention).toMatchObject({
      interventionId: CURRENT_INTERVENTION,
      runId,
      reasonCode: "SESSION_EXPIRED",
      action: "restore_session",
      state: "awaiting_human",
      sameLiveSession: true,
    });
    const publicRun = await app.inject({ method: "GET", url: `/api/v1/runs/${runId}`, headers: { cookie } });
    expect(publicRun.body).not.toContain("RAW_TARGET_SESSION_CANARY");
    expect(publicRun.body).not.toContain("sessionRef");

    const arbitraryAction = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${runId}/handoff/action`,
      headers: { cookie, "x-meridian-action": "operator" },
      payload: {
        interventionId: CURRENT_INTERVENTION,
        action: "restore_session",
        locator: "#unreviewed",
      },
    });
    expect(arbitraryAction.statusCode).toBe(400);

    const staleTake = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${runId}/handoff/take`,
      headers: { cookie, "x-meridian-action": "operator" },
      payload: { interventionId: "33333333-3333-4333-8333-333333333333" },
    });
    expect(staleTake.statusCode).toBe(409);
    const taken = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${runId}/handoff/take`,
      headers: { cookie, "x-meridian-action": "operator" },
      payload: { interventionId: CURRENT_INTERVENTION },
    });
    expect(taken.statusCode).toBe(202);
    expect(taken.json().run.progress.intervention.state).toBe("human_active");

    const prematureResume = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${runId}/handoff/resume`,
      headers: { cookie, "x-meridian-action": "operator" },
      payload: { interventionId: CURRENT_INTERVENTION },
    });
    expect(prematureResume.statusCode).toBe(409);
    expect(prematureResume.json()).toMatchObject({ error: { code: "RUN_NOT_HANDOFFABLE" } });

    const blockedLogout = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { cookie, "x-meridian-action": "operator" },
    });
    expect(blockedLogout.statusCode).toBe(409);
    expect(blockedLogout.json()).toMatchObject({ error: { code: "RUN_IN_PROGRESS" } });

    const acted = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${runId}/handoff/action`,
      headers: { cookie, "x-meridian-action": "operator" },
      payload: { interventionId: CURRENT_INTERVENTION, action: "restore_session" },
    });
    expect(acted.statusCode).toBe(202);
    expect(acted.json().run.progress.intervention.state).toBe("action_completed");
    const resumed = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${runId}/handoff/resume`,
      headers: { cookie, "x-meridian-action": "operator" },
      payload: { interventionId: CURRENT_INTERVENTION },
    });
    expect(resumed.statusCode).toBe(202);
    await vi.waitFor(async () => {
      const response = await app.inject({ method: "GET", url: `/api/v1/runs/${runId}`, headers: { cookie } });
      expect(response.json().run.phase).toBe("completed");
      expect(response.json().run.progress.result.status).toBe("success");
    });

    const openapi = await app.inject({ method: "GET", url: "/api/v1/openapi.json" });
    expect(openapi.json().paths).toHaveProperty("/api/v1/runs/{runId}/handoff/action");
    expect(openapi.json().components.schemas.HandoffActionRequest).toMatchObject({
      additionalProperties: false,
      properties: { action: { enum: ["restore_session", "authenticate_supervisor"] } },
    });
  });

  it("uses a one-time scoped invitation for supervisor takeover of the retained session", async () => {
    const { app, catalog, cookie, signOnRunId } = await fixture();
    const hold = catalog.get("account.place_hold", "2.0.0")!;
    const queued = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: {
        cookie,
        "x-meridian-action": "operator",
        "idempotency-key": "delegated-hold-1",
      },
      payload: {
        capabilityId: hold.id,
        artifactDigest: hold.digest,
        inputs: {
          member_number: "100234",
          share: "100234-S0001",
          reason: "FRAUD",
          notes: "delegated test hold",
        },
      },
    });
    expect(queued.statusCode).toBe(202);
    const runId = queued.json().run.runId as string;
    let interventionId = "";
    await vi.waitFor(async () => {
      const response = await app.inject({ method: "GET", url: `/api/v1/runs/${runId}`, headers: { cookie } });
      expect(response.json().run.phase).toBe("awaiting_human");
      interventionId = response.json().run.progress.intervention.interventionId;
    });

    const tellerClaim = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${runId}/handoff/take`,
      headers: { cookie, "x-meridian-action": "operator" },
      payload: { interventionId },
    });
    expect(tellerClaim.statusCode).toBe(403);
    expect(tellerClaim.json()).toMatchObject({ error: { code: "ROLE_REQUIRED" } });

    const invitationResponse = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${runId}/handoff/invitations`,
      headers: { cookie, "x-meridian-action": "operator" },
      payload: { interventionId },
    });
    expect(invitationResponse.statusCode).toBe(201);
    expect(invitationResponse.json().invitation).toMatchObject({
      runId,
      interventionId,
      requiredRole: "supervisor",
      oneTime: true,
    });
    const token = invitationResponse.json().invitation.token as string;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    const supervisorLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { "x-meridian-action": "operator" },
      payload: { accessCode: "supervisor-console-test-code-0001" },
    });
    const supervisorCookie = String(supervisorLogin.headers["set-cookie"]).split(";", 1)[0]!;
    expect((await app.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}`,
      headers: { cookie: supervisorCookie },
    })).statusCode).toBe(404);
    const beforeRedeem = await app.inject({
      method: "GET",
      url: "/api/v1/runs",
      headers: { cookie: supervisorCookie },
    });
    expect(beforeRedeem.statusCode).toBe(200);
    expect(beforeRedeem.json().runs.map((run: { runId: string }) => run.runId)).not.toContain(runId);

    const redeemed = await app.inject({
      method: "POST",
      url: "/api/v1/handoff/invitations/redeem",
      headers: { cookie: supervisorCookie, "x-meridian-action": "operator" },
      payload: { token },
    });
    expect(redeemed.statusCode).toBe(200);
    expect(redeemed.json().delegation).toMatchObject({ runId, interventionId, requiredRole: "supervisor" });
    const delegationExpiresAt = Date.parse(redeemed.json().delegation.expiresAt as string);
    const afterRedeem = await app.inject({
      method: "GET",
      url: "/api/v1/runs",
      headers: { cookie: supervisorCookie },
    });
    expect(afterRedeem.statusCode).toBe(200);
    const delegatedRuns = afterRedeem.json().runs as Array<Record<string, unknown>>;
    const delegatedRunIds = delegatedRuns.map((run) => run.runId);
    expect(delegatedRunIds).toContain(runId);
    expect(delegatedRunIds).not.toContain(signOnRunId);
    expect(new Set(delegatedRunIds).size).toBe(delegatedRunIds.length);
    expect(delegatedRuns.find((run) => run.runId === runId)).not.toHaveProperty("sessionRef");
    const replayed = await app.inject({
      method: "POST",
      url: "/api/v1/handoff/invitations/redeem",
      headers: { cookie: supervisorCookie, "x-meridian-action": "operator" },
      payload: { token },
    });
    expect(replayed.statusCode).toBe(409);
    expect(replayed.json()).toMatchObject({ error: { code: "HANDOFF_INVITATION_INVALID" } });

    expect((await app.inject({
      method: "POST",
      url: `/api/v1/runs/${runId}/handoff/take`,
      headers: { cookie: supervisorCookie, "x-meridian-action": "operator" },
      payload: { interventionId },
    })).statusCode).toBe(202);
    const acted = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${runId}/handoff/action`,
      headers: { cookie: supervisorCookie, "x-meridian-action": "operator" },
      payload: { interventionId, action: "authenticate_supervisor" },
    });
    expect(acted.statusCode).toBe(202);
    expect(acted.json().run.progress.intervention.state).toBe("action_completed");
    expect((await app.inject({
      method: "POST",
      url: `/api/v1/runs/${runId}/handoff/resume`,
      headers: { cookie: supervisorCookie, "x-meridian-action": "operator" },
      payload: { interventionId },
    })).statusCode).toBe(202);
    let challengeId = "";
    await vi.waitFor(async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/runs/${runId}`,
        headers: { cookie: supervisorCookie },
      });
      expect(response.json().run).not.toHaveProperty("sessionRef");
      expect(response.json().run).toMatchObject({
        phase: "awaiting_approval",
        progress: {
          challenge: {
            requirement: "supervisor_confirmation",
            authorizedRoles: ["supervisor"],
          },
        },
      });
      challengeId = response.json().run.progress.challenge.challengeId;
    });
    const approved = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${runId}/approve`,
      headers: { cookie: supervisorCookie, "x-meridian-action": "operator" },
      payload: { challengeId, decision: "approve" },
    });
    expect(approved.statusCode).toBe(202);
    await vi.waitFor(async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/runs/${runId}`,
        headers: { cookie: supervisorCookie },
      });
      expect(response.json().run.phase).toBe("completed");
    });

    const expiryClock = vi.spyOn(Date, "now").mockReturnValue(delegationExpiresAt + 1);
    try {
      const expiredList = await app.inject({
        method: "GET",
        url: "/api/v1/runs",
        headers: { cookie: supervisorCookie },
      });
      expect(expiredList.statusCode).toBe(200);
      expect(expiredList.json().runs.map((run: { runId: string }) => run.runId)).not.toContain(runId);
      expect((await app.inject({
        method: "GET",
        url: `/api/v1/runs/${runId}`,
        headers: { cookie: supervisorCookie },
      })).statusCode).toBe(404);
    } finally {
      expiryClock.mockRestore();
    }
    const ownerList = await app.inject({ method: "GET", url: "/api/v1/runs", headers: { cookie } });
    expect(ownerList.json().runs.map((run: { runId: string }) => run.runId)).toContain(runId);
  });

  it("ends an expired delegated SSE stream before emitting later run events while the owner stream continues", async () => {
    const { app, catalog, cookie } = await fixture();
    const hold = catalog.get("account.place_hold", "2.0.0")!;
    const queued = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: {
        cookie,
        "x-meridian-action": "operator",
        "idempotency-key": "delegated-sse-expiry-1",
      },
      payload: {
        capabilityId: hold.id,
        artifactDigest: hold.digest,
        inputs: {
          member_number: "100234",
          share: "100234-S0001",
          reason: "FRAUD",
          notes: "delegated SSE expiry test",
        },
      },
    });
    expect(queued.statusCode).toBe(202);
    const runId = queued.json().run.runId as string;
    let interventionId = "";
    await vi.waitFor(async () => {
      const response = await app.inject({ method: "GET", url: `/api/v1/runs/${runId}`, headers: { cookie } });
      expect(response.json().run.phase).toBe("awaiting_human");
      interventionId = response.json().run.progress.intervention.interventionId;
    });

    const invitation = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${runId}/handoff/invitations`,
      headers: { cookie, "x-meridian-action": "operator" },
      payload: { interventionId },
    });
    expect(invitation.statusCode).toBe(201);
    const supervisorLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { "x-meridian-action": "operator" },
      payload: { accessCode: "supervisor-console-test-code-0001" },
    });
    expect(supervisorLogin.statusCode).toBe(200);
    const supervisorCookie = String(supervisorLogin.headers["set-cookie"]).split(";", 1)[0]!;
    const redeemed = await app.inject({
      method: "POST",
      url: "/api/v1/handoff/invitations/redeem",
      headers: { cookie: supervisorCookie, "x-meridian-action": "operator" },
      payload: { token: invitation.json().invitation.token },
    });
    expect(redeemed.statusCode).toBe(200);
    const expiresAtMs = Date.parse(redeemed.json().delegation.expiresAt as string);

    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const delegatedAbort = new AbortController();
    const ownerAbort = new AbortController();
    const commonHeaders = { "last-event-id": "9007199254740991" };
    const [delegatedResponse, ownerResponse] = await Promise.all([
      fetch(`${origin}/api/v1/runs/${runId}/events`, {
        headers: { ...commonHeaders, cookie: supervisorCookie },
        signal: delegatedAbort.signal,
      }),
      fetch(`${origin}/api/v1/runs/${runId}/events`, {
        headers: { ...commonHeaders, cookie },
        signal: ownerAbort.signal,
      }),
    ]);
    expect(delegatedResponse.status).toBe(200);
    expect(ownerResponse.status).toBe(200);
    const delegatedReader = delegatedResponse.body!.getReader();
    const ownerReader = ownerResponse.body!.getReader();
    expect((await readSseUntil(delegatedReader, "retry: 2000")).done).toBe(false);
    expect((await readSseUntil(ownerReader, "retry: 2000")).done).toBe(false);

    const expiryClock = vi.spyOn(Date, "now").mockReturnValue(expiresAtMs + 1);
    try {
      const cancelled = await app.inject({
        method: "POST",
        url: `/api/v1/runs/${runId}/cancel`,
        headers: { cookie, "x-meridian-action": "operator" },
      });
      expect(cancelled.statusCode).toBe(200);

      const delegatedClosure = await readSseUntil(delegatedReader, "event: auth.expired");
      const delegatedEnd = await readSseUntil(delegatedReader, "__stream_end__");
      const delegatedText = delegatedClosure.text + delegatedEnd.text;
      expect(delegatedText).toContain('data: {"reason":"reauthenticate"}');
      expect(delegatedText).not.toContain("event: run.cancelled");
      expect(delegatedText).not.toContain("delegation");
      expect(delegatedEnd.done).toBe(true);

      const ownerEvent = await readSseUntil(ownerReader, "event: run.cancelled");
      expect(ownerEvent.text).toContain("event: run.cancelled");
      expect(ownerEvent.done).toBe(false);
    } finally {
      expiryClock.mockRestore();
      delegatedAbort.abort();
      ownerAbort.abort();
    }
  });

  it("lets only the owner cancel approval-paused work and removes the stale challenge", async () => {
    const { app, catalog, cookie } = await fixture({ approvalForWrites: true });
    const transfer = catalog.get("funds.transfer", "2.0.0")!;
    const queued = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { cookie, "x-meridian-action": "operator", "idempotency-key": "cancel-transfer-1" },
      payload: {
        capabilityId: transfer.id,
        artifactDigest: transfer.digest,
        inputs: {
          member_number: "100234",
          from_share: "100234-S0070",
          to_share: "100234-S0001-3",
          amount: "1.25",
          memo: "cancel test",
        },
      },
    });
    const runId = queued.json().run.runId as string;
    await vi.waitFor(async () => {
      const run = await app.inject({ method: "GET", url: `/api/v1/runs/${runId}`, headers: { cookie } });
      expect(run.json().run.phase).toBe("awaiting_approval");
    });

    const supervisorLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { "x-meridian-action": "operator" },
      payload: { accessCode: "supervisor-console-test-code-0001" },
    });
    const otherCookie = String(supervisorLogin.headers["set-cookie"]).split(";", 1)[0]!;
    const otherCancel = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${runId}/cancel`,
      headers: { cookie: otherCookie, "x-meridian-action": "operator" },
      payload: {},
    });
    expect(otherCancel.statusCode).toBe(404);

    const cancelled = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${runId}/cancel`,
      headers: { cookie, "x-meridian-action": "operator" },
      payload: {},
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().run).toMatchObject({
      phase: "completed",
      cancellation: { code: "CANCELLED" },
    });
    expect(cancelled.json().run.progress).not.toHaveProperty("challenge");
  });

  it("keeps run ownership private and projects only declared output fields", async () => {
    const { app, catalog, cookie, evidenceRoot } = await fixture();
    const capability = catalog.get("member.get_record_and_balances", "2.0.0")!;
    const queued = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { cookie, "x-meridian-action": "operator" },
      payload: {
        capabilityId: capability.id,
        artifactDigest: capability.digest,
        inputs: { member_number: "100234" },
      },
    });
    const runId = queued.json().run.runId as string;
    await vi.waitFor(async () => {
      const response = await app.inject({ method: "GET", url: `/api/v1/runs/${runId}`, headers: { cookie } });
      expect(response.json().run.phase).toBe("completed");
    });
    const ownerView = await app.inject({ method: "GET", url: `/api/v1/runs/${runId}`, headers: { cookie } });
    const serialized = ownerView.body;
    expect(serialized).not.toContain("must-not-leak");
    expect(ownerView.json().run.inputs).toEqual({ member_number: "[Protected]" });
    expect(ownerView.json().run.progress.result.outputsDisplaySafe).toBe(true);
    expect(ownerView.json().run.progress.result.outputs.shares[0]).not.toHaveProperty("password");
    await mkdir(path.join(evidenceRoot, runId), { recursive: true });
    const domEvidence = Buffer.from("<script>throw new Error('active')</script>", "utf8");
    await writeFile(path.join(evidenceRoot, runId, "dom.html"), domEvidence);
    await writeFile(path.join(evidenceRoot, runId, ".manifest.abc.tmp"), "partial-secret", "utf8");
    await writeFile(path.join(evidenceRoot, runId, "manifest.json"), "{}", "utf8");
    const partialListing = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}/evidence`,
      headers: { cookie },
    });
    expect(partialListing.json()).toEqual({ evidence: [], finalized: false });
    const unmanifestedEvidence = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}/evidence/dom.html`,
      headers: { cookie },
    });
    expect(unmanifestedEvidence.statusCode).toBe(404);

    const evidenceReference = {
      id: "11111111-1111-4111-8111-111111111111",
      kind: "dom",
      path: "dom.html",
      mimeType: "text/html; charset=utf-8",
      sha256: createHash("sha256").update(domEvidence).digest("hex"),
      bytes: domEvidence.byteLength,
      createdAt: "2026-08-20T12:00:00.000Z",
      redacted: true,
    } as const;
    const manifest = (reference: Record<string, unknown>, evidenceCompleteness = "complete") => JSON.stringify({
      schemaVersion: 1,
      runId,
      createdAt: "2026-08-20T12:00:00.000Z",
      metadata: { status: "success", evidenceCompleteness },
      evidence: [reference],
    });
    await writeFile(
      path.join(evidenceRoot, runId, "manifest.json"),
      manifest(evidenceReference, "incomplete"),
      "utf8",
    );
    expect((await app.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}/evidence`,
      headers: { cookie },
    })).json()).toEqual({ evidence: [], finalized: false });
    await writeFile(
      path.join(evidenceRoot, runId, "manifest.json"),
      manifest({ ...evidenceReference, kind: "screenshot", redacted: undefined, masked: false }),
      "utf8",
    );
    expect((await app.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}/evidence`,
      headers: { cookie },
    })).json()).toEqual({ evidence: [], finalized: false });
    await writeFile(
      path.join(evidenceRoot, runId, "manifest.json"),
      manifest({ ...evidenceReference, redacted: false }),
      "utf8",
    );
    expect((await app.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}/evidence`,
      headers: { cookie },
    })).json()).toEqual({ evidence: [], finalized: false });

    await writeFile(path.join(evidenceRoot, runId, "manifest.json"), manifest(evidenceReference), "utf8");
    const listedEvidence = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}/evidence`,
      headers: { cookie },
    });
    expect(listedEvidence.json()).toMatchObject({ finalized: true });
    expect(listedEvidence.body).not.toContain(".tmp");
    expect(listedEvidence.body).not.toContain("partial-secret");
    const temporaryEvidence = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}/evidence/.manifest.abc.tmp`,
      headers: { cookie },
    });
    expect(temporaryEvidence.statusCode).toBe(404);
    const htmlEvidence = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}/evidence/dom.html`,
      headers: { cookie },
    });
    expect(htmlEvidence.statusCode).toBe(200);
    expect(htmlEvidence.headers["content-type"]).toMatch(/^text\/plain/u);
    expect(htmlEvidence.headers["content-disposition"]).toBe('attachment; filename="dom.html"');
    const manifestEvidence = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}/evidence/manifest.json`,
      headers: { cookie },
    });
    expect(manifestEvidence.statusCode).toBe(200);
    await writeFile(path.join(evidenceRoot, runId, "dom.html"), "tampered", "utf8");
    const tamperedEvidence = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}/evidence/dom.html`,
      headers: { cookie },
    });
    expect(tamperedEvidence.statusCode).toBe(404);
    const missingEvidence = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}/evidence/missing.json`,
      headers: { cookie },
    });
    expect(missingEvidence.statusCode).toBe(404);
    expect(missingEvidence.json()).toMatchObject({ error: { code: "EVIDENCE_NOT_FOUND" } });
    expect(missingEvidence.body).not.toContain("meridian-api-");

    const supervisorLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { "x-meridian-action": "operator" },
      payload: { accessCode: "supervisor-console-test-code-0001" },
    });
    const supervisorCookie = String(supervisorLogin.headers["set-cookie"]).split(";", 1)[0]!;
    const otherView = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}`,
      headers: { cookie: supervisorCookie },
    });
    expect(otherView.statusCode).toBe(404);
  });

  it("clears failed sign-on metadata instead of reporting phantom provisioning", async () => {
    const { app, cookie, signOnRunId } = await fixture({ signOnFails: true });
    await vi.waitFor(async () => {
      const run = await app.inject({ method: "GET", url: `/api/v1/runs/${signOnRunId}`, headers: { cookie } });
      expect(run.json().run.phase).toBe("completed");
    });
    const me = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().meridianSession).toBeNull();
    expect(me.body).not.toContain("SIGNON_SECRET_CANARY");
    expect(me.body).not.toContain("browser-profile");
  });

  it("projects runner failures without raw browser paths, credentials, or member identifiers", async () => {
    const { app, catalog, cookie } = await fixture({ failCapability: "member.get_record_and_balances" });
    const capability = catalog.get("member.get_record_and_balances", "2.0.0")!;
    const queued = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { cookie, "x-meridian-action": "operator" },
      payload: {
        capabilityId: capability.id,
        artifactDigest: capability.digest,
        inputs: { member_number: "100234" },
      },
    });
    const runId = queued.json().run.runId as string;
    let body = "";
    await vi.waitFor(async () => {
      const response = await app.inject({ method: "GET", url: `/api/v1/runs/${runId}`, headers: { cookie } });
      body = response.body;
      expect(response.json().run.phase).toBe("completed");
    });
    expect(body).not.toContain("RUNNER_SECRET_CANARY");
    expect(body).not.toContain("member-100234");
    expect(body).not.toContain("C:\\private");
  });
});
