import { describe, expect, it, vi } from "vitest";
import { ApiError, cancelRun, CHAT_REQUEST_TIMEOUT_MS, createSession, evidenceFinalizationStatus, evidenceUrl, getAuthState, getRun, normalizeAuthState, normalizeCapability, normalizeEvidenceList, normalizeEvidenceListing, normalizeLiveEvent, normalizeRun, postChat } from "./api";
import { containsCredentialMaterial, containsProtectedMaterial, contractValues, isProtectedField, redactForDisplay } from "./security";

describe("frontend wire normalization", () => {
  it("normalizes V2 catalog metadata without coupling to server classes", () => {
    expect(
      normalizeCapability({
        id: "member.lookup",
        name: "Find member",
        version: "2.1.0",
        schemaVersion: "2.0",
        approval: "approved",
        risk: "read",
        digest: "a".repeat(64),
        inputs: [
          {
            name: "memberNumber",
            description: "Exact member number",
            type: { kind: "string", format: "member_number" },
            required: true,
            classification: "restricted",
          },
        ],
        outputs: [],
      }),
    ).toEqual(
      expect.objectContaining({
        id: "member.lookup",
        risk: "read",
        contractValid: true,
        inputs: [expect.objectContaining({ name: "memberNumber", type: { kind: "string", format: "member_number" } })],
      }),
    );
  });

  it("defaults incomplete catalog metadata to a fail-closed state", () => {
    expect(normalizeCapability({ id: "untrusted.entry", name: "Untrusted" })).toEqual(
      expect.objectContaining({
        schemaVersion: "unknown",
        approval: "unknown",
        risk: "supervisor_only",
        digest: "",
        contractValid: false,
      }),
    );
  });

  it("rejects malformed money contracts and duplicate field names", () => {
    const base = {
      id: "funds.transfer",
      name: "Transfer funds",
      version: "2.0.0",
      schemaVersion: "2.0",
      approval: "approved",
      risk: "write",
      digest: "b".repeat(64),
      outputs: [],
    };
    expect(normalizeCapability({
      ...base,
      inputs: [{ name: "amount", description: "Amount", type: { kind: "money" }, required: true, classification: "restricted" }],
    })?.contractValid).toBe(false);
    const field = { name: "memo", description: "Memo", type: { kind: "string" }, required: false, classification: "internal" };
    expect(normalizeCapability({ ...base, inputs: [field, field] })?.contractValid).toBe(false);
    expect(normalizeCapability({
      ...base,
      inputs: [{ name: "amount", description: "Amount", type: "money", required: true, classification: "restricted" }],
    })?.contractValid).toBe(false);
    expect(normalizeCapability({
      ...base,
      schemaVersion: "1.0",
      inputs: [{ name: "memo", description: "Memo", type: "string", required: false, classification: "internal" }],
      outputs: [{ name: "balance", description: "Balance", type: "money", classification: "restricted" }],
    })?.contractValid).toBe(true);
  });

  it("restores only projected owned-session metadata", () => {
    expect(normalizeAuthState({
      principal: { subject: "console:supervisor", displayName: "Supervisor", roles: ["teller", "supervisor"] },
      meridianSession: { state: "active", role: "supervisor", branch: "WEST-014" },
    })).toEqual({
      principal: { id: "console:supervisor", displayName: "Supervisor", role: "supervisor" },
      meridianSession: { status: "active", profile: "supervisor", branch: "WEST-014" },
    });
    expect(normalizeAuthState({
      principal: { subject: "console:teller", displayName: "Teller", roles: ["teller"] },
      meridianSession: { state: "provisioning" },
    })).toEqual({
      principal: { id: "console:teller", displayName: "Teller", role: "teller" },
      meridianSession: { status: "provisioning" },
    });
  });

  it("normalizes approval and terminal envelopes", () => {
    const approval = normalizeRun({
      runId: "run-1",
      capabilityId: "funds.transfer",
      phase: "awaiting_approval",
      challenge: {
        challengeId: "challenge-1",
        runId: "run-1",
        stepId: "commit",
        stepTitle: "Post transfer",
        requirement: "user_confirmation",
        createdAt: "2026-08-20T00:00:00.000Z",
        expiresAt: "2026-08-20T00:05:00.000Z",
        summary: [{ targetId: "amount", value: "$10.00", sensitive: true }],
      },
    });
    expect(approval).toEqual(expect.objectContaining({ id: "run-1", phase: "awaiting_approval" }));
    expect(approval?.challenge?.summary[0]?.value).toBe("[Protected]");
    expect(approval?.challenge?.summary[0]?.reviewable).toBe(false);

    const terminal = normalizeRun({
      status: "terminal",
      phase: "completed",
      result: {
        runId: "run-2",
        capabilityId: "member.lookup",
        status: "success",
        outputs: { memberName: "Example Member" },
        journal: [],
        incidents: [],
      },
    });
    expect(terminal).toEqual(
      expect.objectContaining({ id: "run-2", phase: "completed", terminalStatus: "success" }),
    );
  });

  it("accepts only authorized approval projections and known requirements", () => {
    const projected = normalizeRun({
      runId: "run-projected",
      capabilityId: "share.open",
      phase: "awaiting_approval",
      challenge: {
        challengeId: "challenge-projected",
        runId: "run-projected",
        stepId: "review",
        requirement: "user_confirmation",
        createdAt: "2026-08-20T00:00:00.000Z",
        expiresAt: "2026-08-20T00:05:00.000Z",
        summary: [
          { targetId: "shareType", sensitive: false, displaySafe: true, displayValue: "Savings" },
          { targetId: "member", sensitive: true, displaySafe: true, displayValue: "Member ••42" },
        ],
      },
    });
    expect(projected?.challenge?.summary).toEqual([
      expect.objectContaining({ value: "Savings", reviewable: true }),
      expect.objectContaining({ value: "Member ••42", reviewable: true }),
    ]);
    const unsafeProjection = normalizeRun({
      runId: "run-unsafe-projection",
      capabilityId: "share.open",
      phase: "awaiting_approval",
      challenge: {
        challengeId: "challenge-unsafe",
        runId: "run-unsafe-projection",
        stepId: "review",
        requirement: "user_confirmation",
        createdAt: "2026-08-20T00:00:00.000Z",
        expiresAt: "2026-08-20T00:05:00.000Z",
        summary: [{ targetId: "memo", sensitive: false, displaySafe: true, displayValue: "password is canary" }],
      },
    });
    expect(unsafeProjection?.challenge?.summary[0]).toEqual(expect.objectContaining({ value: "[Protected]", reviewable: false }));
    const futureGate = normalizeRun({
      runId: "run-future",
      capabilityId: "share.open",
      phase: "awaiting_approval",
      challenge: {
        challengeId: "challenge-future",
        runId: "run-future",
        stepId: "review",
        requirement: "executive_confirmation",
        createdAt: "2026-08-20T00:00:00.000Z",
        expiresAt: "2026-08-20T00:05:00.000Z",
        summary: [],
      },
    });
    expect(futureGate).toEqual(expect.objectContaining({ phase: "awaiting_human" }));
    expect(futureGate?.challenge).toBeUndefined();
  });

  it("blocks malformed, duplicate, and truncated approval summaries", () => {
    const challenge = {
      challengeId: "challenge-strict",
      runId: "run-strict",
      stepId: "review",
      requirement: "user_confirmation",
      createdAt: "2026-08-20T00:00:00.000Z",
      expiresAt: "2026-08-20T00:05:00.000Z",
    };
    const malformed = normalizeRun({
      runId: "run-strict",
      capabilityId: "funds.transfer",
      phase: "awaiting_approval",
      challenge: { ...challenge, summary: [{ sensitive: false, displaySafe: true, displayValue: "10.00" }] },
    });
    expect(malformed?.phase).toBe("awaiting_human");
    expect(malformed?.challenge).toBeUndefined();
    const duplicate = normalizeRun({
      runId: "run-strict",
      capabilityId: "funds.transfer",
      phase: "awaiting_approval",
      challenge: { ...challenge, summary: [
        { targetId: "amount", sensitive: false, displaySafe: true, displayValue: "10.00" },
        { targetId: "amount", sensitive: false, displaySafe: true, displayValue: "20.00" },
      ] },
    });
    expect(duplicate?.challenge).toBeUndefined();
    const truncated = normalizeRun({
      runId: "run-strict",
      capabilityId: "funds.transfer",
      phase: "awaiting_approval",
      challenge: { ...challenge, summary: [{ targetId: "rows", sensitive: false, displaySafe: true, displayValue: Array.from({ length: 101 }, (_, index) => index) }] },
    });
    expect(truncated?.challenge?.summary[0]?.reviewable).toBe(false);
  });

  it("maps manager terminal failures and display-safe output flags", () => {
    expect(normalizeRun({
      runId: "run-manager-failure",
      capabilityId: "member.lookup",
      phase: "completed",
      submittedAt: "2026-08-20T00:00:00.000Z",
      managerFailure: { code: "RUNNER_FAILED", message: "Safe failure" },
    })).toEqual(expect.objectContaining({
      terminalStatus: "failure",
      code: "RUNNER_FAILED",
      createdAt: "2026-08-20T00:00:00.000Z",
    }));
    expect(normalizeRun({
      runId: "run-output",
      capabilityId: "member.lookup",
      progress: { result: { status: "success", outputs: { rows: [] }, outputsDisplaySafe: true } },
    })).toEqual(expect.objectContaining({ outputsDisplaySafe: true }));
    const mixed = normalizeRun({
      runId: "run-mixed-output",
      capabilityId: "member.lookup",
      outputsDisplaySafe: true,
      result: { status: "success", outputs: { untrusted: "value" } },
    });
    expect(mixed?.outputs).toEqual({ untrusted: "value" });
    expect(mixed?.outputsDisplaySafe).toBeUndefined();
  });

  it("never revives a retained approval challenge after cancellation or expiry", () => {
    const challenge = {
      challengeId: "11111111-1111-4111-8111-111111111111",
      runId: "run-expired",
      stepId: "commit",
      stepTitle: "Commit transfer",
      requirement: "user_confirmation",
      createdAt: "2026-08-20T00:00:00.000Z",
      expiresAt: "2026-08-20T00:01:00.000Z",
      summary: [],
    };
    const expired = normalizeRun({
      runId: "run-expired",
      capabilityId: "funds.transfer",
      phase: "completed",
      cancellation: { code: "TTL_EXPIRED", reason: "Approval expired" },
      progress: { status: "awaiting_approval", challenge, journal: [], incidents: [] },
    });
    expect(expired).toEqual(expect.objectContaining({
      phase: "completed",
      terminalStatus: "failure",
      code: "TTL_EXPIRED",
    }));
    expect(expired?.challenge).toBeUndefined();

    const inconsistent = normalizeRun({
      runId: "run-inconsistent",
      capabilityId: "funds.transfer",
      phase: "awaiting_approval",
      status: "failure",
      challenge: { ...challenge, runId: "run-inconsistent" },
    });
    expect(inconsistent).toEqual(expect.objectContaining({
      phase: "completed",
      terminalStatus: "failure",
    }));
    expect(inconsistent?.challenge).toBeUndefined();
  });

  it("retains only recognized evidence-finalization status from run snapshots", () => {
    const failed = normalizeRun({
      runId: "run-evidence-failed",
      capabilityId: "member.lookup",
      phase: "completed",
      status: "failure",
      evidenceFinalization: { status: "failed", code: "EVIDENCE_FINALIZATION_FAILED", detail: "omit" },
    });
    expect(failed && evidenceFinalizationStatus(failed)).toBe("failed");
    const unsupported = normalizeRun({
      runId: "run-evidence-unsupported",
      capabilityId: "member.lookup",
      phase: "completed",
      status: "success",
      evidenceFinalization: { status: "publishing" },
    });
    expect(unsupported && evidenceFinalizationStatus(unsupported)).toBeUndefined();
  });

  it("accepts only relative display-safe evidence paths and builds encoded owner URLs", () => {
    expect(normalizeEvidenceList({ evidence: [
      { path: "step-1/dom.html", bytes: 512 },
      { path: "../escape.txt", bytes: 10 },
      { path: "authorization.json", bytes: 10 },
      { path: "bad file.png", bytes: 10 },
      { path: ".manifest.json.a1b2.tmp", bytes: 10 },
      { path: "dom/completion.partial", bytes: 10 },
    ] })).toEqual([{ path: "step-1/dom.html", bytes: 512 }]);
    expect(evidenceUrl("run:1", "step-1/dom.html")).toBe("/api/v1/runs/run%3A1/evidence/step-1/dom.html");
  });

  it("requires both the finality flag and retained manifest before exposing finalized evidence", () => {
    const staged = { evidence: [{ path: "events.ndjson", bytes: 42 }], finalized: true };
    expect(normalizeEvidenceListing(staged)).toEqual({
      items: [{ path: "events.ndjson", bytes: 42 }],
      finalized: false,
    });
    expect(normalizeEvidenceListing({
      evidence: [
        { path: "events.ndjson", bytes: 42 },
        { path: ".manifest.json.pending.tmp", bytes: 10 },
        { path: "manifest.json", bytes: 100 },
      ],
      finalized: true,
    })).toEqual({
      items: [
        { path: "events.ndjson", bytes: 42 },
        { path: "manifest.json", bytes: 100 },
      ],
      finalized: true,
    });
    expect(normalizeEvidenceListing({
      evidence: [{ path: "manifest.json", bytes: 100 }],
      finalized: false,
    }).finalized).toBe(false);
  });

  it("classifies live errors without retaining arbitrary payload fields", () => {
    expect(normalizeLiveEvent({ type: "step.failed", message: "Safe failure", rawDom: "omit" })).toEqual(
      expect.objectContaining({ type: "step.failed", tone: "critical", summary: "Safe failure" }),
    );
    expect(normalizeLiveEvent({ type: "step.started", title: "password is canary" }).title).toBe("[Protected content withheld]");
  });

  it("rejects a detail response that is not bound to the requested run", async () => {
    vi.stubGlobal("window", { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      runId: "run-other",
      capabilityId: "member.lookup",
      phase: "running",
    }), { status: 200, headers: { "content-type": "application/json" } })));
    await expect(getRun("run-expected")).rejects.toEqual(expect.objectContaining<ApiError>({
      code: "RUN_BINDING_MISMATCH",
    }));
    vi.unstubAllGlobals();
  });

  it("accepts a digest-bound sign-on response whose public inputs are protected", async () => {
    vi.stubGlobal("window", { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ run: {
      runId: "run-sign-on",
      capabilityId: "session.sign_on",
      capabilityVersion: "2.0.0",
      artifactDigest: "c".repeat(64),
      phase: "queued",
      inputs: { branch: "[Protected]", password: "[Protected]" },
    } }), { status: 202, headers: { "content-type": "application/json" } })));
    await expect(createSession("teller", "MAIN-001")).resolves.toEqual({
      run: expect.objectContaining({ id: "run-sign-on", capabilityId: "session.sign_on" }),
    });
    vi.unstubAllGlobals();
  });

  it("binds cancellation to the requested run and retains terminal semantics", async () => {
    vi.stubGlobal("window", { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
    const fetchMock = vi.fn().mockImplementation(async (input: string, init: RequestInit) => {
      expect(input).toBe("/api/v1/runs/run-cancel/cancel");
      expect(init.method).toBe("POST");
      expect(init.headers).toMatchObject({ "x-meridian-action": "operator" });
      return new Response(JSON.stringify({ run: {
        runId: "run-cancel",
        capabilityId: "funds.transfer",
        phase: "completed",
        cancellation: { code: "CANCELLED", reason: "Cancelled by operator" },
      } }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(cancelRun("run-cancel")).resolves.toEqual(expect.objectContaining({
      id: "run-cancel",
      phase: "completed",
      code: "CANCELLED",
    }));
    vi.unstubAllGlobals();
  });

  it("rejects a cancellation response bound to a different run", async () => {
    vi.stubGlobal("window", { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ run: {
      runId: "run-other",
      capabilityId: "funds.transfer",
      phase: "completed",
      cancellation: { code: "CANCELLED", reason: "Cancelled by operator" },
    } }), { status: 200, headers: { "content-type": "application/json" } })));
    await expect(cancelRun("run-expected")).rejects.toEqual(expect.objectContaining<ApiError>({
      code: "RUN_BINDING_MISMATCH",
    }));
    vi.unstubAllGlobals();
  });

  it("marks only an explicit operator activity check as idle-session activity", async () => {
    vi.stubGlobal("window", { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
    const fetchMock = vi.fn().mockImplementation(async (_input: string, init: RequestInit) => {
      expect(init.headers).toMatchObject({ "x-meridian-activity": "operator" });
      return new Response(JSON.stringify({
        principal: { subject: "test:teller", displayName: "Teller", roles: ["teller"] },
        meridianSession: null,
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(getAuthState(undefined, true)).resolves.toMatchObject({
      principal: { id: "test:teller", role: "teller" },
    });
    vi.unstubAllGlobals();
  });

  it("uses a bounded chat deadline beyond the server budget and distinguishes cancellation", async () => {
    expect(CHAT_REQUEST_TIMEOUT_MS).toBe(20_000);
    expect(CHAT_REQUEST_TIMEOUT_MS).toBeGreaterThan(12_000);
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_input: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      }),
    ));

    const timedRequest = postChat("Prepare a balance lookup", []);
    const timedAssertion = expect(timedRequest).rejects.toEqual(expect.objectContaining<ApiError>({
      code: "REQUEST_TIMEOUT",
    }));
    await vi.advanceTimersByTimeAsync(CHAT_REQUEST_TIMEOUT_MS);
    await timedAssertion;

    const controller = new AbortController();
    const cancelledRequest = postChat("Prepare a transfer", [], controller.signal);
    const cancelledAssertion = expect(cancelledRequest).rejects.toEqual(expect.objectContaining<ApiError>({
      code: "REQUEST_CANCELLED",
    }));
    controller.abort("operator_cancelled");
    await cancelledAssertion;

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("retains explicit fallback routing metadata without claiming Anthropic handled it", async () => {
    vi.stubGlobal("window", { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ route: {
      kind: "reply",
      text: "Deterministic guidance",
      metadata: { provider: "deterministic", model: null, fallbackFrom: "anthropic" },
    } }), { status: 200, headers: { "content-type": "application/json" } })));
    await expect(postChat("Show safe capabilities", [])).resolves.toEqual(expect.objectContaining({
      routing: { provider: "deterministic", fallbackFrom: "anthropic" },
    }));
    vi.unstubAllGlobals();
  });

  it("withholds credential-shaped server prose", () => {
    expect(
      normalizeRun({
        runId: "run-secret",
        capabilityId: "safe.read",
        status: "failure",
        message: "password is server-canary",
      })?.message,
    ).toBe("[Protected content withheld]");
  });
});

describe("frontend credential guard", () => {
  it("blocks assigned secrets while allowing ordinary policy questions", () => {
    expect(containsCredentialMaterial("my password is hunter-example")).toBe(true);
    expect(containsCredentialMaterial("pin: 1234")).toBe(true);
    expect(containsCredentialMaterial("https://operator:secret@example.test/")).toBe(true);
    expect(containsCredentialMaterial("-----BEGIN PRIVATE KEY-----\ncanary\n-----END PRIVATE KEY-----")).toBe(true);
    expect(containsCredentialMaterial("How does the password policy work?")).toBe(false);
    expect(containsProtectedMaterial({ memo: "password is canary" })).toBe(true);
  });

  it("never exposes secret-classified fields or secret-shaped response keys", () => {
    expect(
      isProtectedField({
        name: "operatorPassword",
        description: "Managed credential",
        type: { kind: "string" },
        required: true,
        classification: "secret",
      }),
    ).toBe(true);
    expect(redactForDisplay({ accessToken: "token-canary", balance: "$10.00" })).toEqual({
      accessToken: "[Protected]",
      balance: "$10.00",
    });
    expect(
      contractValues(
        { operator: "secret-canary", balance: "$10.00", undeclared: "omit-me" },
        [
          { name: "operator", description: "Operator", type: { kind: "string" }, required: false, classification: "secret" },
          { name: "balance", description: "Balance", type: { kind: "money" }, required: false, classification: "restricted" },
        ],
      ),
    ).toEqual({ operator: "[Protected]", balance: "$10.00" });
  });
});
