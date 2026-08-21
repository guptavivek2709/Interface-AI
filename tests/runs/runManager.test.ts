import { afterEach, describe, expect, it } from "vitest";
import type { ReplayProgressV2, TerminalRunResultV2 } from "../../src/domain/index.js";
import {
  RunManager,
  RunManagerError,
  type ManagedReplayRunnerV2,
  type ManagedRunnerFactory,
  type ManagedRunnerFactoryContext,
  type ManagedRunnerFactoryRequest,
} from "../../src/runs/index.js";

const managers: RunManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map(async (manager) => manager.shutdown()));
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function terminal(request: ManagedRunnerFactoryRequest, status: "success" = "success"): ReplayProgressV2 {
  const result: TerminalRunResultV2 = {
    status,
    runId: request.runId,
    capabilityId: request.capabilityId,
    capabilityVersion: request.capabilityVersion,
    artifactDigest: request.artifactDigest,
    inputDigest: request.inputDigest,
    sessionRef: request.sessionRef,
    startedAt: "2026-08-20T12:00:00.000Z",
    completedAt: "2026-08-20T12:00:01.000Z",
    journal: [],
    incidents: [],
    evidencePaths: [],
    outputs: {},
  };
  return { status: "terminal", phase: "completed", result };
}

function approval(request: ManagedRunnerFactoryRequest, supervisor = false): ReplayProgressV2 {
  return {
    status: "awaiting_approval",
    phase: "awaiting_approval",
    challenge: {
      challengeId: "11111111-1111-4111-8111-111111111111",
      runId: request.runId,
      stepId: "post",
      stepTitle: "Post transaction",
      requirement: supervisor ? "supervisor_confirmation" : "user_confirmation",
      expiresInMs: 60_000,
      createdAt: "2099-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:01:00.000Z",
      summary: [],
    },
    journal: [],
    incidents: [],
  };
}

function handoff(request: ManagedRunnerFactoryRequest): Extract<ReplayProgressV2, { status: "awaiting_human" }> {
  return {
    status: "awaiting_human",
    phase: "awaiting_human",
    intervention: {
      interventionId: "22222222-2222-4222-8222-222222222222",
      runId: request.runId,
      stepId: "open_member",
      reasonCode: "SESSION_EXPIRED",
      action: "restore_session",
      state: "awaiting_human",
      createdAt: "2099-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:02:00.000Z",
      sameLiveSession: true,
    },
    journal: [],
    incidents: [{
      code: "SESSION_EXPIRED",
      category: "intervention",
      message: "Restore the retained session",
      stepId: "open_member",
      occurredAt: "2099-01-01T00:00:00.000Z",
    }],
  };
}

class FakeRunner implements ManagedReplayRunnerV2 {
  readonly initial = deferred<ReplayProgressV2>();
  readonly resumed = deferred<ReplayProgressV2>();
  closeCount = 0;
  approvalActors: Array<{ id: string; roles: readonly string[] }> = [];
  approvalTokens: string[] = [];
  runStarted = false;
  resumeStarted = false;

  run(): Promise<ReplayProgressV2> {
    this.runStarted = true;
    return this.initial.promise;
  }

  issueApproval(actor: { id: string; roles: readonly string[] }): string {
    this.approvalActors.push(actor);
    return "signed-by-runner";
  }

  resume(approvalToken: string): Promise<ReplayProgressV2> {
    this.resumeStarted = true;
    this.approvalTokens.push(approvalToken);
    return this.resumed.promise;
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    if (this.runStarted) this.initial.reject(new Error("Fake runtime closed"));
    if (this.resumeStarted) this.resumed.reject(new Error("Fake runtime closed"));
  }
}

class BlockingCloseRunner extends FakeRunner {
  readonly closeGate = deferred<void>();

  override async close(): Promise<void> {
    this.closeCount += 1;
    await this.closeGate.promise;
  }
}

class HandoffRunner extends FakeRunner {
  readonly humanResumed = deferred<ReplayProgressV2>();
  progress!: Extract<ReplayProgressV2, { status: "awaiting_human" }>;
  humanActors: Array<{ id: string; roles: readonly string[] }> = [];
  actions: string[] = [];
  humanResumeStarted = false;

  async takeHumanControl(
    interventionId: string,
    actor: { id: string; roles: readonly string[] },
  ): Promise<ReplayProgressV2> {
    expect(interventionId).toBe(this.progress.intervention.interventionId);
    this.humanActors.push(actor);
    this.progress = {
      ...this.progress,
      intervention: { ...this.progress.intervention, state: "human_active" },
    };
    return this.progress;
  }

  async performHumanAction(
    interventionId: string,
    actor: { id: string; roles: readonly string[] },
    action: "restore_session",
  ): Promise<ReplayProgressV2> {
    expect(interventionId).toBe(this.progress.intervention.interventionId);
    expect(actor.id).toBe(this.humanActors.at(-1)?.id);
    this.actions.push(action);
    this.progress = {
      ...this.progress,
      intervention: { ...this.progress.intervention, state: "action_completed" },
    };
    return this.progress;
  }

  resumeHuman(
    interventionId: string,
    actor: { id: string; roles: readonly string[] },
  ): Promise<ReplayProgressV2> {
    expect(interventionId).toBe(this.progress.intervention.interventionId);
    expect(actor.id).toBe(this.humanActors.at(-1)?.id);
    expect(this.progress.intervention.state).toBe("action_completed");
    this.humanResumeStarted = true;
    return this.humanResumed.promise;
  }

  override async close(): Promise<void> {
    this.closeCount += 1;
    if (this.runStarted) this.initial.reject(new Error("Fake runtime closed"));
    if (this.resumeStarted) this.resumed.reject(new Error("Fake runtime closed"));
    if (this.humanResumeStarted) this.humanResumed.reject(new Error("Fake runtime closed"));
  }
}

function request(sessionRef: string, input = "one", idempotencyKey?: string) {
  return {
    capabilityId: "member.balance",
    capabilityVersion: "2.0.0",
    artifactDigest: "a".repeat(64),
    sessionRef,
    inputs: { memberNumber: input },
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  };
}

async function eventually(assertion: () => void, attempts = 100): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastError;
}

function managerWithFactory(
  factory: ManagedRunnerFactory,
  options: Partial<ConstructorParameters<typeof RunManager>[0]> = {},
): RunManager {
  const manager = new RunManager({
    runnerFactory: factory,
    cleanupIntervalMs: false,
    ...options,
  });
  managers.push(manager);
  return manager;
}

describe("RunManager scheduling", () => {
  it("bounds global concurrency while serializing runs that share a session", async () => {
    const runners = new Map<string, FakeRunner>();
    const starts: ManagedRunnerFactoryRequest[] = [];
    const manager = managerWithFactory((factoryRequest) => {
      starts.push(factoryRequest);
      const runner = new FakeRunner();
      runners.set(factoryRequest.runId, runner);
      return runner;
    }, { maxConcurrentRuns: 2 });

    const first = manager.submit(request("session-a", "one"));
    const second = manager.submit(request("session-a", "two"));
    const third = manager.submit(request("session-b", "three"));
    expect(first.phase).toBe("queued");

    await eventually(() => expect(starts.map((item) => item.runId).sort()).toEqual([first.runId, third.runId].sort()));
    expect(manager.get(second.runId)?.phase).toBe("queued");

    runners.get(first.runId)!.initial.resolve(terminal(starts.find((item) => item.runId === first.runId)!));
    await eventually(() => expect(starts.some((item) => item.runId === second.runId)).toBe(true));
    runners.get(second.runId)!.initial.resolve(terminal(starts.find((item) => item.runId === second.runId)!));
    runners.get(third.runId)!.initial.resolve(terminal(starts.find((item) => item.runId === third.runId)!));
    await eventually(() => expect(manager.list().every((item) => item.phase === "completed")).toBe(true));
  });

  it("reports runner recovery phases without changing the ReplayProgressV2 boundary", async () => {
    const runner = new FakeRunner();
    let context!: ManagedRunnerFactoryContext;
    let factoryRequest!: ManagedRunnerFactoryRequest;
    const manager = managerWithFactory((requestValue, contextValue) => {
      factoryRequest = requestValue;
      context = contextValue;
      return runner;
    });
    const submitted = manager.submit(request("recovery-session"));
    await eventually(() => expect(manager.get(submitted.runId)?.phase).toBe("running"));
    context.reportPhase("recovering", { code: "MAINTENANCE" });
    expect(manager.get(submitted.runId)?.phase).toBe("recovering");
    context.reportPhase("running");
    runner.initial.resolve(terminal(factoryRequest));
    await eventually(() => expect(manager.get(submitted.runId)?.phase).toBe("completed"));
  });

  it("rejects new work when the bounded waiting queue is full", async () => {
    let activeRunner!: FakeRunner;
    const manager = managerWithFactory(() => {
      activeRunner = new FakeRunner();
      return activeRunner;
    }, { maxConcurrentRuns: 1, maxQueuedRuns: 1 });
    const active = manager.submit(request("active-session"));
    await eventually(() => expect(manager.get(active.runId)?.phase).toBe("running"));

    manager.submit(request("waiting-session"));
    expect(() => manager.submit(request("overflow-session"))).toThrowError(
      expect.objectContaining({ code: "QUEUE_FULL" }),
    );
  });
});

describe("RunManager idempotency and events", () => {
  it("binds idempotency keys to session, capability version, artifact, and canonical input digest", () => {
    const manager = managerWithFactory(() => new FakeRunner(), { maxConcurrentRuns: 1 });
    const first = manager.submit(request("session-a", "100234", "same-request"));
    const repeated = manager.submit(request("session-a", "100234", "same-request"));

    expect(repeated.runId).toBe(first.runId);
    expect(() => manager.submit(request("session-b", "100234", "same-request"))).toThrowError(
      expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }),
    );
    expect(repeated.inputDigest).toBe(first.inputDigest);
    expect(() => manager.submit(request("session-a", "100987", "same-request"))).toThrowError(
      expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }),
    );
    expect(() => manager.submit({
      ...request("session-a", "100234", "same-request"),
      capabilityVersion: "2.1.0",
    })).toThrowError(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }));
    expect(() => manager.submit({
      ...request("session-a", "100234", "same-request"),
      artifactDigest: "b".repeat(64),
    })).toThrowError(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }));
    expect(Object.isFrozen(first)).toBe(true);
  });

  it("uses a validated server audit digest without weakening the private idempotency binding", () => {
    const manager = managerWithFactory(() => new FakeRunner(), { maxConcurrentRuns: 1 });
    const override = "c".repeat(64);
    const first = manager.submit({
      ...request("credential-session", "server-managed"),
      inputDigestOverride: override,
      idempotencyKey: "credential-key",
    });
    expect(first.inputDigest).toBe(override);
    expect(() => manager.submit({
      ...request("credential-session", "different-secret"),
      inputDigestOverride: override,
      idempotencyKey: "credential-key",
    })).toThrowError(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }));
    expect(() => manager.submit({
      ...request("credential-session"),
      inputDigestOverride: "not-a-digest",
    })).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
  });

  it("provides monotonic buffered replay followed by live subscription events", async () => {
    let runner!: FakeRunner;
    let factoryRequest!: ManagedRunnerFactoryRequest;
    const manager = managerWithFactory((requestValue) => {
      factoryRequest = requestValue;
      runner = new FakeRunner();
      return runner;
    }, { eventBufferSize: 3 });
    const submitted = manager.submit(request("event-session"));
    const received: number[] = [];
    const unsubscribe = manager.subscribe(submitted.runId, (event) => received.push(event.id));
    await eventually(() => expect(runner).toBeDefined());
    runner.initial.resolve(terminal(factoryRequest));
    await eventually(() => expect(manager.get(submitted.runId)?.phase).toBe("completed"));
    unsubscribe();

    expect(received).toEqual([...received].sort((left, right) => left - right));
    expect(new Set(received).size).toBe(received.length);
    const buffered = manager.replayEvents(submitted.runId);
    expect(buffered).toHaveLength(3);
    expect(buffered.every((event, index) => index === 0 || event.id > buffered[index - 1]!.id)).toBe(true);
    expect(Object.isFrozen(buffered[0])).toBe(true);
    expect(Object.isFrozen(buffered[0]!.snapshot)).toBe(true);
  });

  it("does not publish terminal completion before runner evidence finalization closes", async () => {
    const runner = new BlockingCloseRunner();
    let factoryRequest!: ManagedRunnerFactoryRequest;
    const manager = managerWithFactory((requestValue) => {
      factoryRequest = requestValue;
      return runner;
    });
    const submitted = manager.submit(request("finalization-session"));
    await eventually(() => expect(runner.runStarted).toBe(true));
    runner.initial.resolve(terminal(factoryRequest));
    await eventually(() => expect(runner.closeCount).toBe(1));

    expect(manager.get(submitted.runId)).toMatchObject({ phase: "running" });
    expect(manager.replayEvents(submitted.runId).some((event) => event.type === "run.completed")).toBe(false);

    runner.closeGate.resolve();
    await eventually(() => expect(manager.get(submitted.runId)).toMatchObject({
      phase: "completed",
      evidenceFinalization: { status: "complete" },
    }));
    expect(manager.replayEvents(submitted.runId).at(-1)?.type).toBe("run.completed");
  });

  it("never exposes raw runner exception text in snapshots or events", async () => {
    const manager = managerWithFactory(() => {
      throw new Error("PASSWORD_CANARY C:\\secret\\target.html?member=100234");
    });
    const submitted = manager.submit(request("failure-session"));
    await eventually(() => expect(manager.get(submitted.runId)?.phase).toBe("completed"));
    const serialized = JSON.stringify({
      snapshot: manager.get(submitted.runId),
      events: manager.replayEvents(submitted.runId),
    });
    expect(serialized).not.toContain("PASSWORD_CANARY");
    expect(serialized).not.toContain("target.html");
    expect(manager.get(submitted.runId)).toMatchObject({
      managerFailure: { code: "RUNNER_FAILED" },
    });
  });
});

describe("RunManager approval, cancellation, and cleanup", () => {
  it("retains session ownership across human handoff while releasing the global execution slot", async () => {
    const runners = new Map<string, FakeRunner>();
    const requests = new Map<string, ManagedRunnerFactoryRequest>();
    const manager = managerWithFactory((factoryRequest) => {
      requests.set(factoryRequest.runId, factoryRequest);
      const runner = factoryRequest.inputs.memberNumber === "handoff"
        ? new HandoffRunner()
        : new FakeRunner();
      runners.set(factoryRequest.runId, runner);
      return runner;
    }, { maxConcurrentRuns: 1 });

    const pausedRun = manager.submit(request("retained-session", "handoff"));
    const sameSession = manager.submit(request("retained-session", "queued-same"));
    const otherSession = manager.submit(request("other-session", "other"));
    await eventually(() => expect(runners.has(pausedRun.runId)).toBe(true));
    const handoffRunner = runners.get(pausedRun.runId) as HandoffRunner;
    handoffRunner.progress = handoff(requests.get(pausedRun.runId)!);
    handoffRunner.initial.resolve(handoffRunner.progress);

    await eventually(() => expect(manager.get(pausedRun.runId)?.phase).toBe("awaiting_human"));
    await eventually(() => expect(runners.has(otherSession.runId)).toBe(true));
    expect(manager.get(sameSession.runId)?.phase).toBe("queued");
    expect(manager.replayEvents(pausedRun.runId).at(-1)).toMatchObject({
      type: "intervention.requested",
      data: { action: "restore_session", sameLiveSession: true },
    });

    const interventionId = handoffRunner.progress.intervention.interventionId;
    const actor = { source: "operator" as const, id: "operator-1", roles: ["teller"] };
    await expect(
      manager.takeHumanControl(pausedRun.runId, "33333333-3333-4333-8333-333333333333", actor),
    ).rejects.toMatchObject({ code: "RUN_NOT_HANDOFFABLE" });
    const claimed = await manager.takeHumanControl(pausedRun.runId, interventionId, actor);
    expect(claimed).toMatchObject({
      phase: "awaiting_human",
      progress: { status: "awaiting_human", intervention: { state: "human_active" } },
    });
    await expect(manager.cancel(pausedRun.runId)).rejects.toMatchObject({ code: "RUN_NOT_CANCELLABLE" });
    expect(() => manager.resumeHuman(pausedRun.runId, interventionId, actor)).toThrowError(
      expect.objectContaining({ code: "RUN_NOT_HANDOFFABLE" }),
    );
    const acted = await manager.performHumanAction(pausedRun.runId, interventionId, actor, "restore_session");
    expect(acted).toMatchObject({
      phase: "awaiting_human",
      progress: { status: "awaiting_human", intervention: { state: "action_completed" } },
    });
    expect(handoffRunner.actions).toEqual(["restore_session"]);
    manager.resumeHuman(pausedRun.runId, interventionId, actor);

    const otherRunner = runners.get(otherSession.runId)!;
    otherRunner.initial.resolve(terminal(requests.get(otherSession.runId)!));
    await eventually(() => expect(handoffRunner.humanResumeStarted).toBe(true));
    expect(manager.get(sameSession.runId)?.phase).toBe("queued");
    handoffRunner.humanResumed.resolve(terminal(requests.get(pausedRun.runId)!));
    await eventually(() => expect(runners.has(sameSession.runId)).toBe(true));
    runners.get(sameSession.runId)!.initial.resolve(terminal(requests.get(sameSession.runId)!));
    await eventually(() => expect(manager.get(sameSession.runId)?.phase).toBe("completed"));
  });

  it("delegates supervisor approval to the runner and never accepts model approval", async () => {
    const runners = new Map<string, FakeRunner>();
    const requests = new Map<string, ManagedRunnerFactoryRequest>();
    const manager = managerWithFactory((factoryRequest) => {
      requests.set(factoryRequest.runId, factoryRequest);
      const runner = new FakeRunner();
      runners.set(factoryRequest.runId, runner);
      return runner;
    }, { maxConcurrentRuns: 1 });
    const submitted = manager.submit(request("approval-session"));
    await eventually(() => expect(runners.has(submitted.runId)).toBe(true));
    runners.get(submitted.runId)!.initial.resolve(approval(requests.get(submitted.runId)!, true));
    await eventually(() => expect(manager.get(submitted.runId)?.phase).toBe("awaiting_approval"));

    expect(() => manager.approve(submitted.runId, {
      source: "model" as "user",
      id: "router",
      roles: ["supervisor"],
    })).toThrowError(expect.objectContaining({ code: "MODEL_APPROVAL_FORBIDDEN" }));
    expect(() => manager.approve(submitted.runId, {
      source: "user",
      id: "teller-user",
      roles: ["teller"],
    })).toThrowError(expect.objectContaining({ code: "ROLE_REQUIRED" }));

    manager.approve(submitted.runId, {
      source: "operator",
      id: "supervisor-user",
      roles: ["supervisor"],
    });
    await eventually(() => expect(runners.get(submitted.runId)!.approvalTokens).toEqual(["signed-by-runner"]));
    expect(runners.get(submitted.runId)!.approvalActors).toEqual([
      { id: "supervisor-user", roles: ["supervisor"] },
    ]);
    runners.get(submitted.runId)!.resumed.resolve(terminal(requests.get(submitted.runId)!));
    await eventually(() => expect(manager.get(submitted.runId)?.phase).toBe("completed"));
  });

  it("cancels queued and approval-paused work safely and releases its session", async () => {
    const runners = new Map<string, FakeRunner>();
    const requests = new Map<string, ManagedRunnerFactoryRequest>();
    const manager = managerWithFactory((factoryRequest) => {
      requests.set(factoryRequest.runId, factoryRequest);
      const runner = new FakeRunner();
      runners.set(factoryRequest.runId, runner);
      return runner;
    }, { maxConcurrentRuns: 1 });

    const active = manager.submit(request("busy-session", "active"));
    const queued = manager.submit(request("queued-session", "queued"));
    await eventually(() => expect(runners.has(active.runId)).toBe(true));
    const cancelledQueued = await manager.cancel(queued.runId);
    expect(cancelledQueued).toMatchObject({ phase: "completed", cancellation: { code: "CANCELLED" } });
    expect(runners.has(queued.runId)).toBe(false);

    runners.get(active.runId)!.initial.resolve(approval(requests.get(active.runId)!));
    await eventually(() => expect(manager.get(active.runId)?.phase).toBe("awaiting_approval"));
    const nextSameSession = manager.submit(request("busy-session", "next"));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(manager.get(nextSameSession.runId)?.phase).toBe("queued");
    await manager.cancel(active.runId, "Operator declined");
    expect(runners.get(active.runId)!.closeCount).toBe(1);
    await eventually(() => expect(runners.has(nextSameSession.runId)).toBe(true));
    runners.get(nextSameSession.runId)!.initial.resolve(terminal(requests.get(nextSameSession.runId)!));
  });

  it("serializes cancellation finalization against duplicate cancel and approval requests", async () => {
    const runner = new BlockingCloseRunner();
    let factoryRequest!: ManagedRunnerFactoryRequest;
    const manager = managerWithFactory((requestValue) => {
      factoryRequest = requestValue;
      return runner;
    });
    const submitted = manager.submit(request("cancellation-race-session"));
    await eventually(() => expect(runner.runStarted).toBe(true));
    runner.initial.resolve(approval(factoryRequest));
    await eventually(() => expect(manager.get(submitted.runId)?.phase).toBe("awaiting_approval"));

    const firstCancellation = manager.cancel(submitted.runId);
    await eventually(() => expect(runner.closeCount).toBe(1));
    expect(() => manager.approve(submitted.runId, {
      source: "operator",
      id: "operator",
      roles: ["teller"],
    })).toThrowError(expect.objectContaining({ code: "RUN_NOT_APPROVABLE" }));
    const duplicateCancellation = manager.cancel(submitted.runId);
    expect(runner.closeCount).toBe(1);

    runner.closeGate.resolve();
    await expect(Promise.all([firstCancellation, duplicateCancellation])).resolves.toEqual([
      expect.objectContaining({
        phase: "completed",
        cancellation: expect.objectContaining({ code: "CANCELLED" }),
      }),
      expect.objectContaining({
        phase: "completed",
        cancellation: expect.objectContaining({ code: "CANCELLED" }),
      }),
    ]);
    expect(manager.replayEvents(submitted.runId).filter((event) => event.type === "run.cancelled")).toHaveLength(1);
    expect(runner.closeCount).toBe(1);
  });

  it("retains an expired approval outcome, then evicts history without recycling idempotency", async () => {
    let current = Date.parse("2026-08-20T12:00:00.000Z");
    let runner!: FakeRunner;
    let factoryRequest!: ManagedRunnerFactoryRequest;
    const manager = managerWithFactory((requestValue) => {
      factoryRequest = requestValue;
      runner = new FakeRunner();
      return runner;
    }, {
      now: () => current,
      retentionTtlMs: 1_000,
    });
    const submitted = manager.submit(request("ttl-session", "100234", "ttl-key"));
    await eventually(() => expect(runner).toBeDefined());
    runner.initial.resolve(approval(factoryRequest));
    await eventually(() => expect(manager.get(submitted.runId)?.phase).toBe("awaiting_approval"));
    current += 1_001;

    expect(await manager.cleanupExpired()).toBe(1);
    expect(runner.closeCount).toBe(1);
    expect(manager.get(submitted.runId)).toMatchObject({
      phase: "completed",
      cancellation: { code: "TTL_EXPIRED" },
    });
    expect(manager.get(submitted.runId)?.progress).toBeDefined();
    expect(manager.submit(request("ttl-session", "100234", "ttl-key")).runId).toBe(submitted.runId);

    current += 1_001;
    expect(await manager.cleanupExpired()).toBe(1);
    expect(manager.get(submitted.runId)).toBeUndefined();
    expect(() => manager.submit(request("ttl-session", "100234", "ttl-key"))).toThrowError(
      expect.objectContaining({ code: "IDEMPOTENCY_RETAINED" }),
    );
  });

  it("rejects an approval after its exact challenge expiry", async () => {
    let current = Date.parse("2099-01-01T00:01:00.000Z");
    let runner!: FakeRunner;
    let factoryRequest!: ManagedRunnerFactoryRequest;
    const manager = managerWithFactory((requestValue) => {
      factoryRequest = requestValue;
      runner = new FakeRunner();
      return runner;
    }, { now: () => current });
    const submitted = manager.submit(request("expired-approval-session"));
    await eventually(() => expect(runner).toBeDefined());
    runner.initial.resolve(approval(factoryRequest));
    await eventually(() => expect(manager.get(submitted.runId)?.phase).toBe("awaiting_approval"));
    expect(() => manager.approve(submitted.runId, {
      source: "operator",
      id: "operator",
      roles: ["teller"],
    })).toThrowError(expect.objectContaining({ code: "RUN_NOT_APPROVABLE" }));
  });

  it("rejects unsafe cancellation of a running browser action", async () => {
    const manager = managerWithFactory(() => new FakeRunner());
    const submitted = manager.submit(request("running-session"));
    await eventually(() => expect(manager.get(submitted.runId)?.phase).toBe("running"));
    await expect(manager.cancel(submitted.runId)).rejects.toMatchObject({
      code: "RUN_NOT_CANCELLABLE",
    } satisfies Partial<RunManagerError>);
  });
});
