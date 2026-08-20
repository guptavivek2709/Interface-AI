import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ApprovalAuthority } from "../../src/approval/index.js";
import {
  meridianSearchByNumberArtifact,
  meridianTransferArtifact,
} from "../../src/capabilities/index.js";
import {
  CapabilityArtifactV2Schema,
  type CapabilityArtifactV2,
  type ConditionV2,
  type RuntimeStateRuleV2,
  type StepEffectV2,
  type TargetV2,
} from "../../src/domain/index.js";
import { EventRecorder } from "../../src/evidence/event-recorder.js";
import { EvidenceStore } from "../../src/evidence/store.js";
import { ReplayRunnerV2 } from "../../src/replay/replayRunnerV2.js";
import { Redactor } from "../../src/safety/redactor.js";
import type {
  ReplayRuntimeV2,
  RuntimeActionResultV2,
  RuntimeConditionResultV2,
  RuntimeContextV2,
  RuntimePageStateV2,
} from "../../src/surface/replayRuntimeV2.js";

const targets: TargetV2[] = [
  {
    id: "review_summary",
    description: "Reviewed transaction summary",
    framePath: [],
    strategies: [{ kind: "name", name: "review" }],
    cardinality: "exactly_one",
    sensitive: false,
  },
  {
    id: "observed_value",
    description: "Read-only value observed after a write",
    framePath: [],
    strategies: [{ kind: "name", name: "observed" }],
    cardinality: "exactly_one",
    sensitive: false,
  },
  {
    id: "state_nonce",
    description: "Per-transaction state nonce",
    framePath: [],
    strategies: [{ kind: "name", name: "_token" }],
    cardinality: "exactly_one",
    sensitive: true,
  },
  {
    id: "confirm",
    description: "Final confirmation control",
    framePath: [],
    strategies: [{ kind: "role", role: "button", name: "Confirm", exact: true }],
    cardinality: "exactly_one",
    sensitive: false,
  },
];

function artifact(overrides: {
  approval?: "draft" | "approved" | "retired";
  risk?: "write" | "irreversible" | "supervisor_only";
  approvalKind?: "user_confirmation" | "supervisor_confirmation";
  runtimeStates?: RuntimeStateRuleV2[];
  effect?: Extract<StepEffectV2, "reversible_write" | "irreversible_commit">;
} = {}): CapabilityArtifactV2 {
  const effect = overrides.effect ?? "irreversible_commit";
  return CapabilityArtifactV2Schema.parse({
    schemaVersion: "2.0",
    capability: {
      id: "funds.transfer",
      name: "Transfer funds",
      description: "Transfer funds after a reviewed confirmation",
      version: "2.0.0",
      approval: overrides.approval ?? "approved",
      risk: overrides.risk ?? (effect === "reversible_write" ? "write" : "irreversible"),
      tags: ["transaction"],
    },
    provenance: {
      source: "authored",
      createdAt: "2026-08-20T12:00:00.000Z",
      goal: "Test an approval-bound commit",
    },
    compatibility: {
      surfaceAdapter: "test",
      vendorProduct: "fixture",
      entryPoint: "https://bank.test/review",
    },
    inputs: [],
    outputs: [],
    policy: {
      routes: [
        { origin: "https://bank.test", pathPattern: "^/review$", methods: ["GET"] },
        { origin: "https://bank.test", pathPattern: "^/done$", methods: ["POST"] },
      ],
      allowedActions: ["click", "extract"],
      maxEffect: effect,
    },
    targets,
    steps: [
      {
        id: "commit",
        title: "Confirm transfer",
        action: { kind: "click", targetId: "confirm" },
        preconditions: [{ kind: "target_present", targetId: "confirm", present: true }],
        postcondition: { kind: "route", pattern: "^/done$" },
        timeoutMs: 500,
        retry: { maxAttempts: 3, backoffMs: 0 },
        effect,
        approval: {
          kind: overrides.approvalKind ?? "user_confirmation",
          summaryTargets: ["review_summary"],
          stateNonceTarget: "state_nonce",
          expiresInMs: 30_000,
        },
      },
    ],
    runtimeStates: overrides.runtimeStates ?? [],
    checkpoint: { kind: "route", pattern: "^/done$" },
  });
}

class FakeRuntime implements ReplayRuntimeV2 {
  readonly sessionId = "session-id";
  readonly sessionRef = "session-ref";
  readonly #targets = new Map(targets.map((target) => [target.id, target]));
  state: RuntimePageStateV2 = {
    url: "https://bank.test/review",
    title: "Review",
    httpStatus: 200,
    method: "GET",
  };
  clickCount = 0;
  throwAfterCommit = false;
  commitStatus = 200;
  reviewSummary = "From S-1 to S-2: USD 25.00";
  stateNonce = "token-a";
  readonly visibleTexts = new Set<string>();
  visibleTextAfterCommit: string | undefined;
  clearStatusAfterMatch: number | undefined;
  statusAfterWritePostcondition: number | undefined;
  statusAfterObservedPostcondition: number | undefined;
  readonly observedValues: string[] = [];
  screenshotBytes = Buffer.from("masked screenshot [REDACTED]");
  domSnapshot = "<html><body>[REDACTED]</body></html>";
  #observedPostconditionTriggered = false;
  closed = false;

  getTarget(id: string): TargetV2 {
    const target = this.#targets.get(id);
    if (!target) throw new Error(`Unknown target ${id}`);
    return target;
  }

  resolveValue(expression: Parameters<ReplayRuntimeV2["resolveValue"]>[0], context: RuntimeContextV2) {
    if (expression.kind === "literal") return expression.value;
    const source = expression.kind === "input" ? context.inputs : context.bindings;
    if (!Object.hasOwn(source, expression.name)) throw new Error(`Missing ${expression.kind} ${expression.name}`);
    return source[expression.name]!;
  }

  async act(
    action: Parameters<ReplayRuntimeV2["act"]>[0],
    context: RuntimeContextV2,
  ): Promise<RuntimeActionResultV2> {
    const startedAt = new Date().toISOString();
    if (action.kind === "extract") {
      const value = action.targetId === "state_nonce"
        ? this.stateNonce
        : action.targetId === "observed_value"
          ? this.observedValues.shift() ?? "observed"
          : this.reviewSummary;
      if (action.bindingName) context.bindings[action.bindingName] = value;
      return {
        startedAt,
        completedAt: new Date().toISOString(),
        targetId: action.targetId,
        ...(action.bindingName ? { bindingName: action.bindingName } : {}),
        value,
        attempts: [],
      };
    }
    if (action.kind === "click") {
      this.clickCount += 1;
      this.state = {
        url: "https://bank.test/done",
        title: "Complete",
        httpStatus: this.commitStatus,
        method: "POST",
      };
      if (this.visibleTextAfterCommit) this.visibleTexts.add(this.visibleTextAfterCommit);
      if (this.throwAfterCommit) throw new Error("Connection closed after submit");
    }
    return { startedAt, completedAt: new Date().toISOString(), attempts: [] };
  }

  async evaluate(condition: ConditionV2, context: RuntimeContextV2): Promise<RuntimeConditionResultV2> {
    if (condition.kind === "all" || condition.kind === "any") {
      const results = [];
      for (const child of condition.conditions) results.push(await this.evaluate(child, context));
      const matched = condition.kind === "all"
        ? results.every((result) => result.matched)
        : results.some((result) => result.matched);
      return { matched, summary: `${condition.kind} matched=${matched}` };
    }
    if (condition.kind === "not") {
      const result = await this.evaluate(condition.condition, context);
      return { matched: !result.matched, summary: `not matched=${!result.matched}` };
    }
    if (condition.kind === "route") {
      const matched = new RegExp(condition.pattern, "u").test(new URL(this.state.url).pathname);
      return { matched, summary: `route matched=${matched}` };
    }
    if (condition.kind === "target_present") return { matched: condition.present, summary: "target present" };
    if (condition.kind === "target_value") {
      const actual = condition.targetId === "state_nonce" ? this.stateNonce : this.reviewSummary;
      const expected = String(this.resolveValue(condition.value, context));
      const matched = condition.operator === "equals"
        ? actual === expected
        : condition.operator === "contains"
          ? actual.includes(expected)
          : new RegExp(expected, "u").test(actual);
      return { matched, summary: `target value matched=${matched}` };
    }
    if (condition.kind === "text_visible") {
      return { matched: this.visibleTexts.has(condition.text), summary: "text marker evaluated" };
    }
    if (condition.kind === "page_title") {
      const matched = condition.exact ? this.state.title === condition.title : this.state.title.includes(condition.title);
      return { matched, summary: `title matched=${matched}` };
    }
    if (condition.kind === "http_status") {
      const matched = this.state.httpStatus === condition.status;
      if (matched && this.clearStatusAfterMatch === condition.status) {
        this.clearStatusAfterMatch = undefined;
        this.state.httpStatus = 200;
      }
      return { matched, summary: "HTTP status evaluated" };
    }
    return { matched: false, summary: "fixture condition did not match" };
  }

  async waitFor(condition: ConditionV2, context: RuntimeContextV2): Promise<RuntimeConditionResultV2> {
    const result = await this.evaluate(condition, context);
    if (
      result.matched &&
      condition.kind === "route" &&
      this.clickCount > 0 &&
      this.statusAfterWritePostcondition !== undefined
    ) {
      this.state.httpStatus = this.statusAfterWritePostcondition;
      this.statusAfterWritePostcondition = undefined;
    }
    if (
      result.matched &&
      condition.kind === "target_present" &&
      condition.targetId === "observed_value" &&
      !this.#observedPostconditionTriggered &&
      this.statusAfterObservedPostcondition !== undefined
    ) {
      this.#observedPostconditionTriggered = true;
      this.state.httpStatus = this.statusAfterObservedPostcondition;
    }
    return result;
  }

  async pageState(): Promise<RuntimePageStateV2> {
    return { ...this.state };
  }

  async captureMaskedScreenshot(): Promise<Buffer> {
    return this.screenshotBytes;
  }

  async sanitizedDomSnapshot(): Promise<string> {
    return this.domSnapshot;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class WrongMemberRuntime implements ReplayRuntimeV2 {
  readonly sessionId = "member-session";
  readonly sessionRef = "member-session-ref";
  readonly #targets = new Map(meridianSearchByNumberArtifact.targets.map((target) => [target.id, target]));
  readonly #values = new Map<string, string>();
  readonly origin = new URL(meridianSearchByNumberArtifact.compatibility.entryPoint).origin;
  state: RuntimePageStateV2 = {
    url: `${this.origin}/members/100234`,
    title: "Member Record",
    httpStatus: 200,
    method: "GET",
  };
  selectedWrongMember = false;

  getTarget(id: string): TargetV2 {
    const target = this.#targets.get(id);
    if (!target) throw new Error(`Unknown target ${id}`);
    return target;
  }

  resolveValue(expression: Parameters<ReplayRuntimeV2["resolveValue"]>[0], context: RuntimeContextV2) {
    if (expression.kind === "literal") return expression.value;
    const source = expression.kind === "input" ? context.inputs : context.bindings;
    if (!Object.hasOwn(source, expression.name)) throw new Error(`Missing ${expression.kind} ${expression.name}`);
    return source[expression.name]!;
  }

  async act(
    action: Parameters<ReplayRuntimeV2["act"]>[0],
    context: RuntimeContextV2,
  ): Promise<RuntimeActionResultV2> {
    const startedAt = new Date().toISOString();
    if (action.kind === "fill" || action.kind === "select") {
      this.#values.set(action.targetId, String(this.resolveValue(action.value, context)));
    } else if (action.kind === "click") {
      if (action.targetId === "main_menu") this.state.url = `${this.origin}/menu`;
      if (action.targetId === "member_inquiry") this.state.url = `${this.origin}/members`;
      if (action.targetId === "search") this.state.url = `${this.origin}/members?by=number&q=100234`;
      if (action.targetId === "select_member") {
        this.state.url = `${this.origin}/members/100987`;
        this.selectedWrongMember = true;
      }
    } else if (action.kind === "extract") {
      const value = action.targetId === "member_number_value" ? "100987" : "Wrong Member";
      if (action.bindingName) context.bindings[action.bindingName] = value;
      return { startedAt, completedAt: new Date().toISOString(), targetId: action.targetId, value, attempts: [] };
    }
    return { startedAt, completedAt: new Date().toISOString(), attempts: [] };
  }

  async evaluate(condition: ConditionV2, context: RuntimeContextV2): Promise<RuntimeConditionResultV2> {
    if (condition.kind === "all" || condition.kind === "any") {
      const results = [];
      for (const child of condition.conditions) results.push(await this.evaluate(child, context));
      const matched = condition.kind === "all"
        ? results.every((result) => result.matched)
        : results.some((result) => result.matched);
      return { matched, summary: `${condition.kind} matched=${matched}` };
    }
    if (condition.kind === "not") {
      const result = await this.evaluate(condition.condition, context);
      return { matched: !result.matched, summary: "not evaluated" };
    }
    if (condition.kind === "route") {
      const matched = new RegExp(condition.pattern, "u").test(new URL(this.state.url).pathname);
      return { matched, summary: `route matched=${matched}` };
    }
    if (condition.kind === "target_present" || condition.kind === "target_visible") {
      return { matched: condition.kind === "target_present" ? condition.present : condition.visible, summary: "target exists" };
    }
    if (condition.kind === "target_value") {
      const actual = condition.targetId === "member_number_value"
        ? "100987"
        : this.#values.get(condition.targetId) ?? "";
      const expected = String(this.resolveValue(condition.value, context));
      const matched = condition.operator === "equals"
        ? actual === expected
        : condition.operator === "contains"
          ? actual.includes(expected)
          : new RegExp(expected, "u").test(actual);
      return { matched, summary: `target value matched=${matched}` };
    }
    if (condition.kind === "http_status") return { matched: condition.status === 200, summary: "status evaluated" };
    return { matched: false, summary: "marker absent" };
  }

  waitFor(condition: ConditionV2, context: RuntimeContextV2): Promise<RuntimeConditionResultV2> {
    return this.evaluate(condition, context);
  }

  async pageState(): Promise<RuntimePageStateV2> {
    return { ...this.state };
  }

  async captureMaskedScreenshot(): Promise<Buffer> {
    return Buffer.from("masked");
  }

  async sanitizedDomSnapshot(): Promise<string> {
    return "<html><body>[REDACTED]</body></html>";
  }

  async close(): Promise<void> {}
}

function injectedState(
  status: 400 | 403 | 404 | 440 | 500 | 503,
): RuntimeStateRuleV2 {
  const definitions = {
    400: { code: "VALIDATION_REJECTED", category: "business_outcome", effectCertainty: "not_applied" },
    403: { code: "SUPERVISOR_REQUIRED", category: "escalation", requiredRole: "supervisor" },
    404: { code: "RECORD_NOT_FOUND", category: "business_outcome", effectCertainty: "not_applied" },
    440: { code: "SESSION_EXPIRED", category: "escalation" },
    500: { code: "APPLICATION_ERROR", category: "failure" },
    503: { code: "MAINTENANCE", category: "recoverable" },
  } as const;
  const definition = definitions[status];
  return {
    code: definition.code,
    description: `Injected ${status}`,
    category: definition.category,
    priority: 100,
    condition: { kind: "http_status", status },
    ...("effectCertainty" in definition ? { effectCertainty: definition.effectCertainty } : {}),
    ...("requiredRole" in definition ? { requiredRole: definition.requiredRole } : {}),
    ...(status === 503
      ? { recovery: { kind: "restart_run", maxAttempts: 1, waitMs: 0 } as const }
      : {}),
  };
}

function recoverableAfterWriteArtifact(safeRestart: boolean): CapabilityArtifactV2 {
  const candidate = structuredClone(artifact({ effect: "reversible_write", risk: "write" }));
  candidate.outputs = [{
    name: "observed",
    description: "Value read after the write",
    type: { kind: "string" },
    classification: "internal",
  }];
  candidate.policy.allowedActions.push("press");
  if (safeRestart) candidate.steps[0]!.safeRestartStepId = "extract_observed";
  candidate.steps.push(
    {
      id: "extract_observed",
      title: "Verify the written state",
      action: { kind: "extract", targetId: "observed_value", outputName: "observed", source: "text" },
      preconditions: [],
      postcondition: { kind: "target_present", targetId: "observed_value", present: true },
      timeoutMs: 500,
      retry: { maxAttempts: 1, backoffMs: 0 },
      effect: "read",
    },
    {
      id: "finish_read",
      title: "Finish read-only verification",
      action: { kind: "press", key: "F5" },
      preconditions: [],
      postcondition: { kind: "route", pattern: "^/done$" },
      timeoutMs: 500,
      retry: { maxAttempts: 1, backoffMs: 0 },
      effect: "read",
    },
  );
  candidate.runtimeStates = [injectedState(503)];
  return CapabilityArtifactV2Schema.parse(candidate);
}

describe("ReplayRunnerV2", () => {
  it("pauses before the commit and resumes only with a bound approval", async () => {
    const runtime = new FakeRuntime();
    const runner = new ReplayRunnerV2({
      artifact: artifact(),
      inputs: {},
      runtime,
      approvalAuthority: new ApprovalAuthority({ secret: Buffer.alloc(32, 3) }),
    });
    const paused = await runner.run();
    expect(paused.status).toBe("awaiting_approval");
    expect(runtime.clickCount).toBe(0);
    if (paused.status !== "awaiting_approval") throw new Error("Expected approval pause");
    expect(paused.challenge.summary[0]?.value).toContain("USD 25.00");
    const binding = runner.approvalBinding();
    expect(binding?.reviewDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(binding?.stateNonceDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(binding)).not.toContain(runtime.reviewSummary);
    expect(JSON.stringify(binding)).not.toContain(runtime.stateNonce);

    const token = runner.issueApproval({ id: "operator-1", roles: ["teller"] });
    const completed = await runner.resume(token);
    expect(completed.status).toBe("terminal");
    if (completed.status !== "terminal") throw new Error("Expected terminal result");
    expect(completed.result.status).toBe("success");
    expect(runtime.clickCount).toBe(1);
  });

  it("requires a supervisor actor for supervisor-only commits", async () => {
    const runner = new ReplayRunnerV2({
      artifact: artifact({ risk: "supervisor_only", approvalKind: "supervisor_confirmation" }),
      inputs: {},
      runtime: new FakeRuntime(),
      approvalAuthority: new ApprovalAuthority({ secret: Buffer.alloc(32, 4) }),
    });
    await runner.run();
    expect(() => runner.issueApproval({ id: "teller-1", roles: ["teller"] })).toThrowError(
      expect.objectContaining({ code: "ROLE_REQUIRED" }),
    );
  });

  it("never retries a commit whose effect is uncertain", async () => {
    const runtime = new FakeRuntime();
    runtime.throwAfterCommit = true;
    const runner = new ReplayRunnerV2({
      artifact: artifact(),
      inputs: {},
      runtime,
      approvalAuthority: new ApprovalAuthority({ secret: Buffer.alloc(32, 5) }),
    });
    await runner.run();
    const token = runner.issueApproval({ id: "operator-1", roles: ["teller"] });
    const completed = await runner.resume(token);
    if (completed.status !== "terminal") throw new Error("Expected terminal result");
    expect(completed.result).toMatchObject({
      status: "failure",
      code: "EFFECT_UNKNOWN",
      retryable: false,
      effectUncertain: true,
    });
    expect(runtime.clickCount).toBe(1);
  });

  it("treats a declared application error after the commit click as an unknown effect", async () => {
    const runtime = new FakeRuntime();
    runtime.commitStatus = 500;
    const runner = new ReplayRunnerV2({
      artifact: artifact({
        runtimeStates: [{
          code: "APPLICATION_ERROR",
          description: "The target returned an application error.",
          category: "failure",
          priority: 100,
          condition: { kind: "http_status", status: 500 },
        }],
      }),
      inputs: {},
      runtime,
      approvalAuthority: new ApprovalAuthority({ secret: Buffer.alloc(32, 7) }),
    });
    await runner.run();
    const token = runner.issueApproval({ id: "operator-1", roles: ["teller"] });
    const completed = await runner.resume(token);
    if (completed.status !== "terminal") throw new Error("Expected terminal result");
    expect(completed.result).toMatchObject({
      status: "failure",
      code: "EFFECT_UNKNOWN",
      retryable: false,
      effectUncertain: true,
    });
    expect(runtime.clickCount).toBe(1);
  });

  it("rejects draft artifacts before any browser action", async () => {
    const runtime = new FakeRuntime();
    const runner = new ReplayRunnerV2({
      artifact: artifact({ approval: "draft" }),
      inputs: {},
      runtime,
      approvalAuthority: new ApprovalAuthority({ secret: Buffer.alloc(32, 6) }),
    });
    const completed = await runner.run();
    if (completed.status !== "terminal") throw new Error("Expected terminal result");
    expect(completed.result).toMatchObject({ status: "failure", code: "ARTIFACT_NOT_APPROVED" });
    expect(runtime.clickCount).toBe(0);
  });

  it.each(["summary", "nonce"] as const)(
    "refuses to execute when the reviewed %s changes after approval",
    async (mutation) => {
      const runtime = new FakeRuntime();
      const runner = new ReplayRunnerV2({
        artifact: artifact(),
        inputs: {},
        runtime,
        approvalAuthority: new ApprovalAuthority({ secret: Buffer.alloc(32, 8) }),
      });
      const paused = await runner.run();
      expect(paused.status).toBe("awaiting_approval");
      const token = runner.issueApproval({ id: "operator-1", roles: ["teller"] });
      if (mutation === "summary") runtime.reviewSummary = "From S-1 to S-9: USD 900.00";
      else runtime.stateNonce = "token-b";

      const completed = await runner.resume(token);
      if (completed.status !== "terminal") throw new Error("Expected terminal result");
      expect(completed.result).toMatchObject({
        status: "failure",
        code: "REVIEW_STALE",
        effectUncertain: false,
      });
      expect(runtime.clickCount).toBe(0);
    },
  );

  it("rejects a supplied digest that does not match the validated artifact", () => {
    expect(() => new ReplayRunnerV2({
      artifact: artifact(),
      artifactDigest: "0".repeat(64),
      inputs: {},
      runtime: new FakeRuntime(),
      approvalAuthority: new ApprovalAuthority({ secret: Buffer.alloc(32, 9) }),
    })).toThrow(/digest does not match/u);
  });

  it("uses only a validated trusted input digest when inputs were hydrated inside the factory", () => {
    const safeDigest = "a".repeat(64);
    const runner = new ReplayRunnerV2({
      artifact: artifact(),
      inputDigest: safeDigest,
      inputs: {},
      runtime: new FakeRuntime(),
      approvalAuthority: new ApprovalAuthority({ secret: Buffer.alloc(32, 19) }),
    });
    expect(runner.inputDigest).toBe(safeDigest);
    expect(() => new ReplayRunnerV2({
      artifact: artifact(),
      inputDigest: "NOT-A-DIGEST",
      inputs: {},
      runtime: new FakeRuntime(),
      approvalAuthority: new ApprovalAuthority({ secret: Buffer.alloc(32, 20) }),
    })).toThrow(/lowercase SHA-256/u);
  });

  it("treats a lost response from a reversible write as uncertain", async () => {
    const runtime = new FakeRuntime();
    runtime.throwAfterCommit = true;
    const runner = new ReplayRunnerV2({
      artifact: artifact({ effect: "reversible_write", risk: "write" }),
      inputs: {},
      runtime,
      approvalAuthority: new ApprovalAuthority({ secret: Buffer.alloc(32, 10) }),
    });
    await runner.run();
    const token = runner.issueApproval({ id: "operator-1", roles: ["teller"] });
    const completed = await runner.resume(token);
    if (completed.status !== "terminal") throw new Error("Expected terminal result");
    expect(completed.result).toMatchObject({
      status: "failure",
      code: "EFFECT_UNKNOWN",
      retryable: false,
      effectUncertain: true,
    });
    expect(runtime.clickCount).toBe(1);
  });

  it.each([
    [400, "business_outcome", "VALIDATION_REJECTED"],
    [403, "escalation", "SUPERVISOR_REQUIRED"],
    [404, "business_outcome", "RECORD_NOT_FOUND"],
    [440, "escalation", "SESSION_EXPIRED"],
    [500, "failure", "APPLICATION_ERROR"],
    [503, "failure", "RECOVERY_EXHAUSTED"],
  ] as const)("classifies injected HTTP %i before any effect", async (status, resultStatus, code) => {
    const runtime = new FakeRuntime();
    runtime.state.httpStatus = status;
    const runner = new ReplayRunnerV2({
      artifact: artifact({ runtimeStates: [injectedState(status)] }),
      inputs: {},
      runtime,
      approvalAuthority: new ApprovalAuthority({ secret: Buffer.alloc(32, 11) }),
    });
    const completed = await runner.run();
    if (completed.status !== "terminal") throw new Error("Expected terminal result");
    expect(completed.result).toMatchObject({ status: resultStatus, code });
    if (status === 403 && completed.result.status === "escalation") {
      expect(completed.result.requiredRole).toBe("supervisor");
    }
    if (status === 503) {
      expect(completed.result.incidents.filter((incident) => incident.code === "MAINTENANCE")).toEqual([
        expect.objectContaining({ category: "recoverable", recoveryAttempt: 1 }),
      ]);
    }
    expect(runtime.clickCount).toBe(0);
  });

  it.each([403, 440, 500] as const)(
    "captures redacted screenshot, DOM, and event evidence for injected HTTP %i",
    async (status) => {
      const scratch = await mkdtemp(path.join(tmpdir(), `replay-v2-${status}-evidence-`));
      const canary = `FAULT_EVIDENCE_CANARY_${status}_7281`;
      const redactor = new Redactor({ sensitiveValues: [canary] });
      const evidence = await EvidenceStore.create({ rootDirectory: scratch, runId: `fault-${status}`, redactor });
      const recorder = await EventRecorder.create({
        filePath: path.join(evidence.runDirectory, "events.jsonl"),
        runId: `fault-${status}`,
        redactor,
        syncEachWrite: false,
      });
      const runtime = new FakeRuntime();
      runtime.state.httpStatus = status;
      runtime.domSnapshot = `<html><body><p>${canary}</p></body></html>`;
      runtime.screenshotBytes = Buffer.from("masked screenshot [REDACTED]", "utf8");
      await recorder.record("fixture.response", { status, body: canary });

      try {
        const runner = new ReplayRunnerV2({
          artifact: artifact({ runtimeStates: [injectedState(status)] }),
          inputs: {},
          runtime,
          approvalAuthority: new ApprovalAuthority({ secret: Buffer.alloc(32, 21) }),
          evidence,
          recorder,
          redactor,
          runId: `fault-${status}`,
        });
        const completed = await runner.run();
        if (completed.status !== "terminal") throw new Error("Expected terminal result");
        expect(completed.result.evidencePaths).toEqual(expect.arrayContaining([
          expect.stringMatching(/\.png$/u),
          expect.stringMatching(/\.html$/u),
        ]));

        for (const relative of completed.result.evidencePaths) {
          const persisted = await readFile(evidence.resolve(relative));
          expect(persisted.toString("utf8")).not.toContain(canary);
        }
        const domPath = completed.result.evidencePaths.find((item) => item.endsWith(".html"))!;
        const screenshotPath = completed.result.evidencePaths.find((item) => item.endsWith(".png"))!;
        expect(await readFile(evidence.resolve(domPath), "utf8")).toContain("[REDACTED]");
        expect(await readFile(evidence.resolve(screenshotPath), "utf8")).toContain("[REDACTED]");
      } finally {
        await recorder.close();
      }

      const eventLog = await readFile(path.join(evidence.runDirectory, "events.jsonl"), "utf8");
      expect(eventLog).not.toContain(canary);
      expect(eventLog).toContain("evidence.captured");
      await rm(scratch, { recursive: true, force: true });
    },
  );

  it.each([
    [400, "business_outcome", "VALIDATION_REJECTED", false],
    [403, "failure", "EFFECT_UNKNOWN", true],
    [404, "business_outcome", "RECORD_NOT_FOUND", false],
    [440, "failure", "EFFECT_UNKNOWN", true],
    [500, "failure", "EFFECT_UNKNOWN", true],
    [503, "failure", "EFFECT_UNKNOWN", true],
  ] as const)(
    "classifies injected HTTP %i conservatively after a write attempt",
    async (status, resultStatus, code, uncertain) => {
      const runtime = new FakeRuntime();
      runtime.commitStatus = status;
      const runner = new ReplayRunnerV2({
        artifact: artifact({ runtimeStates: [injectedState(status)] }),
        inputs: {},
        runtime,
        approvalAuthority: new ApprovalAuthority({ secret: Buffer.alloc(32, 12) }),
      });
      await runner.run();
      const token = runner.issueApproval({ id: "operator-1", roles: ["teller"] });
      const completed = await runner.resume(token);
      if (completed.status !== "terminal") throw new Error("Expected terminal result");
      expect(completed.result).toMatchObject({ status: resultStatus, code });
      if (completed.result.status === "failure") expect(completed.result.effectUncertain).toBe(uncertain);
      expect(runtime.clickCount).toBe(1);
    },
  );

  it("returns a contract-declared natural business outcome without claiming an uncertain effect", async () => {
    const runtime = new FakeRuntime();
    const marker = "Insufficient available balance in the source share.";
    runtime.visibleTextAfterCommit = marker;
    const runner = new ReplayRunnerV2({
      artifact: artifact({
        runtimeStates: [{
          code: "INSUFFICIENT_FUNDS",
          description: "Insufficient available balance",
          category: "business_outcome",
          priority: 100,
          effectCertainty: "not_applied",
          condition: { kind: "text_visible", text: marker, exact: true },
        }],
      }),
      inputs: {},
      runtime,
      approvalAuthority: new ApprovalAuthority({ secret: Buffer.alloc(32, 13) }),
    });
    await runner.run();
    const token = runner.issueApproval({ id: "operator-1", roles: ["teller"] });
    const completed = await runner.resume(token);
    if (completed.status !== "terminal") throw new Error("Expected terminal result");
    expect(completed.result).toMatchObject({ status: "business_outcome", code: "INSUFFICIENT_FUNDS" });
    expect("effectUncertain" in completed.result).toBe(false);
    expect(runtime.clickCount).toBe(1);
  });

  it("never restarts an earlier write when recovery is detected by a later step", async () => {
    const runtime = new FakeRuntime();
    runtime.statusAfterWritePostcondition = 503;
    runtime.clearStatusAfterMatch = 503;
    const runner = new ReplayRunnerV2({
      artifact: recoverableAfterWriteArtifact(false),
      inputs: {},
      runtime,
      approvalAuthority: new ApprovalAuthority({ secret: Buffer.alloc(32, 16) }),
    });
    await runner.run();
    const token = runner.issueApproval({ id: "operator-1", roles: ["teller"] });
    const completed = await runner.resume(token);
    if (completed.status !== "terminal") throw new Error("Expected terminal result");
    expect(completed.result).toMatchObject({
      status: "failure",
      code: "EFFECT_UNKNOWN",
      effectUncertain: true,
    });
    expect(runtime.clickCount).toBe(1);
  });

  it("uses a declared post-write safe boundary and discards stale outputs on recovery", async () => {
    const runtime = new FakeRuntime();
    runtime.observedValues.push("stale", "fresh");
    runtime.statusAfterObservedPostcondition = 503;
    runtime.clearStatusAfterMatch = 503;
    const runner = new ReplayRunnerV2({
      artifact: recoverableAfterWriteArtifact(true),
      inputs: {},
      runtime,
      approvalAuthority: new ApprovalAuthority({ secret: Buffer.alloc(32, 17) }),
    });
    await runner.run();
    const token = runner.issueApproval({ id: "operator-1", roles: ["teller"] });
    const completed = await runner.resume(token);
    if (completed.status !== "terminal") throw new Error("Expected terminal result");
    expect(completed.result).toMatchObject({
      status: "success",
      outputs: { observed: "fresh" },
    });
    expect(runtime.clickCount).toBe(1);
    expect(completed.result.journal.filter((entry) => entry.stepId === "extract_observed")).toHaveLength(2);
  });

  it("stops on a valid but wrong member detail page before any member operation", async () => {
    const runtime = new WrongMemberRuntime();
    const runner = new ReplayRunnerV2({
      artifact: meridianSearchByNumberArtifact,
      inputs: { member_number: "100234" },
      runtime,
      approvalAuthority: new ApprovalAuthority({ secret: Buffer.alloc(32, 14) }),
    });
    const completed = await runner.run();
    if (completed.status !== "terminal") throw new Error("Expected terminal result");
    expect(completed.result).toMatchObject({ status: "failure", code: "MEMBER_BINDING_MISMATCH" });
    expect(runtime.selectedWrongMember).toBe(true);
    expect(completed.result.journal.some((entry) => entry.stepId === "extract_member_number")).toBe(false);
  });

  it.each([
    {
      from_share: "100987-S0001",
      to_share: "100234-S0070",
      expected: "from_share must belong to member_number",
    },
    {
      from_share: "100234-S0001",
      to_share: "100234-S0001",
      expected: "from_share and to_share must be different",
    },
  ])("rejects invalid transfer share relationships before browser actions", async ({ from_share, to_share, expected }) => {
    const runtime = new FakeRuntime();
    const runner = new ReplayRunnerV2({
      artifact: meridianTransferArtifact,
      inputs: {
        member_number: "100234",
        from_share,
        to_share,
        amount: { currency: "USD", amount: "25.00", minorUnits: 2_500 },
        memo: "test",
      },
      runtime,
      approvalAuthority: new ApprovalAuthority({ secret: Buffer.alloc(32, 15) }),
    });
    const completed = await runner.run();
    if (completed.status !== "terminal") throw new Error("Expected terminal result");
    expect(completed.result).toMatchObject({ status: "failure", code: "INPUT_INVALID" });
    if (completed.result.status === "failure") expect(completed.result.message).toContain(expected);
    expect(runtime.clickCount).toBe(0);
  });
});
