import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApiServer } from "../../src/api/index.js";
import { StaticConsoleIdentityProvider } from "../../src/api/index.js";
import { meridianArtifacts } from "../../src/capabilities/index.js";
import { CapabilityCatalog } from "../../src/catalog/index.js";
import {
  ChatRequestCancelledError,
  ChatRoutingError,
  DeterministicChatRouter,
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
          this.#request.capabilityId === "member.get_record_and_balances"
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
  constructor(request: ManagedRunnerFactoryRequest) {
    this.#request = request;
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
        requirement: "user_confirmation",
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
  async resume(): Promise<ReplayProgressV2> {
    return new SuccessRunner(this.#request).run();
  }
  async close(): Promise<void> {}
}

const apps: Array<ReturnType<typeof buildApiServer>> = [];

async function fixture(options: {
  approvalForWrites?: boolean;
  chat?: ChatRouter;
  failCapability?: string;
  signOnFails?: boolean;
  signOnPaused?: boolean;
  sessionResource?: Resource;
  onFactoryRequest?: (request: ManagedRunnerFactoryRequest) => void;
  sessionNow?: () => number;
} = {}) {
  const catalog = CapabilityCatalog.fromArtifacts(meridianArtifacts);
  const sessions = new SessionManager<PlaywrightSurface>({
    ...(options.sessionNow ? { now: options.sessionNow, idleTtlMs: 5_000 } : {}),
  });
  const pending = new Map<string, { operatorId: string; role: "teller" | "supervisor"; branch: string }>();
  const runs = new RunManager({
    runnerFactory: (request) => {
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
      if (options.approvalForWrites && request.capabilityId === "funds.transfer") {
        return new ApprovalRunner(request);
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
    chat: options.chat ?? new DeterministicChatRouter(),
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
    fallbackFrom: null,
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
    expect(catalog.json().capabilities).toHaveLength(8);
    const openapi = await app.inject({ method: "GET", url: "/api/v1/openapi.json" });
    expect(openapi.json()).toMatchObject({ openapi: "3.1.0" });
  });

  it("rejects cross-surface mutation calls and requires idempotency for writes", async () => {
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
    expect(supervisorOnly.statusCode).toBe(403);
    expect(supervisorOnly.json()).toMatchObject({ error: { code: "SUPERVISOR_REQUIRED" } });
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

  it("keeps offline chat proposal-only and never exposes sign-on", async () => {
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
