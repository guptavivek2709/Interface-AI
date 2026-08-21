import { describe, expect, it, vi } from "vitest";
import { ApiError, approveRun, cancelRun, CHAT_REQUEST_TIMEOUT_MS, createRun, createSession, evidenceFinalizationStatus, evidenceUrl, getAuthState, getReconciliation, getRun, normalizeAuthState, normalizeCapability, normalizeEvidenceList, normalizeEvidenceListing, normalizeLiveEvent, normalizeRun, postChat, startReconciliation, takeHumanControl } from "./api";
import { containsCredentialMaterial, containsProtectedMaterial, contractValues, isProtectedField, redactForDisplay } from "./security";
import type { Capability } from "./types";

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
        targetProfileDigest: "9".repeat(64),
        lineage: {
          lineageId: "lineage.member.lookup",
          discoveryRunId: "discovery.11111111-1111-4111-8111-111111111111",
          provider: "anthropic-messages",
          model: "claude-sonnet-5",
          traceDigest: "1".repeat(64),
          draftDigest: "2".repeat(64),
          reviewedDigest: "3".repeat(64),
          approvedDigest: "a".repeat(64),
          canaryRunId: "canary.22222222-2222-4222-8222-222222222222",
        },
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
        lineage: expect.objectContaining({
          discoveryRunId: "discovery.11111111-1111-4111-8111-111111111111",
          provider: "anthropic-messages",
          model: "claude-sonnet-5",
          draftDigest: "2".repeat(64),
          approvedDigest: "a".repeat(64),
        }),
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
        targetProfileDigest: "",
        contractValid: false,
      }),
    );
  });

  it("does not launch approved metadata without an exact published discovery lineage", () => {
    const digest = "a".repeat(64);
    const metadata = {
      id: "member.lookup",
      name: "Find member",
      description: "Read a member record",
      version: "2.0.0",
      schemaVersion: "2.0",
      approval: "approved",
      risk: "read",
      digest,
      targetProfileDigest: "9".repeat(64),
      inputs: [],
      outputs: [],
    };
    expect(normalizeCapability(metadata)?.contractValid).toBe(false);
    expect(normalizeCapability({
      ...metadata,
      lineage: {
        lineageId: "lineage.member.lookup",
        discoveryRunId: "discovery.11111111-1111-4111-8111-111111111111",
        provider: "anthropic-messages",
        model: "claude-sonnet-5",
        traceDigest: "1".repeat(64),
        draftDigest: "2".repeat(64),
        reviewedDigest: "3".repeat(64),
        approvedDigest: "b".repeat(64),
        canaryRunId: "canary.22222222-2222-4222-8222-222222222222",
      },
    })?.contractValid).toBe(false);
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
      targetProfileDigest: "8".repeat(64),
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
    })?.contractValid).toBe(false);
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

  it("derives delegated approval solely from server-projected authorized roles", () => {
    const challenge = {
      challengeId: "challenge-authority",
      runId: "run-authority",
      stepId: "commit",
      requirement: "supervisor_confirmation",
      createdAt: "2026-08-20T00:00:00.000Z",
      expiresAt: "2099-08-20T00:05:00.000Z",
      summary: [{ targetId: "amount", sensitive: false, displaySafe: true, displayValue: "$1.00" }],
    };
    const tellerOnly = normalizeRun({
      runId: "run-authority",
      capabilityId: "account.place_hold",
      phase: "awaiting_approval",
      challenge: { ...challenge, authorized: true, authorizedRoles: ["teller"] },
    });
    expect(tellerOnly?.challenge?.authorized).toBe(false);

    const delegatedSupervisor = normalizeRun({
      runId: "run-authority",
      capabilityId: "account.place_hold",
      phase: "awaiting_approval",
      challenge: { ...challenge, authorized: false, authorizedRoles: ["supervisor"] },
    });
    expect(delegatedSupervisor?.challenge?.authorized).toBe(true);
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
      targetProfileDigest: "7".repeat(64),
      phase: "queued",
      inputs: { branch: "[Protected]", password: "[Protected]" },
    } }), { status: 202, headers: { "content-type": "application/json" } })));
    await expect(createSession("teller", "MAIN-001")).resolves.toEqual({
      run: expect.objectContaining({ id: "run-sign-on", capabilityId: "session.sign_on" }),
    });
    vi.unstubAllGlobals();
  });

  it("submits an authenticated chat proposal through the digest-bound run API", async () => {
    vi.stubGlobal("window", { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
    const capability: Capability = {
      id: "member.get_record_and_balances",
      name: "Get balances",
      description: "Read a member record",
      version: "2.0.0",
      schemaVersion: "2.0",
      approval: "approved",
      risk: "read",
      tags: [],
      inputs: [],
      outputs: [],
      digest: "d".repeat(64),
      targetProfileDigest: "6".repeat(64),
      contractValid: true,
    };
    const fetchMock = vi.fn().mockImplementation(async (input: string, init: RequestInit) => {
      expect(input).toBe("/api/v1/runs");
      expect(init.method).toBe("POST");
      expect(init.headers).toMatchObject({
        "idempotency-key": "chat-request-key",
        "x-meridian-action": "operator",
      });
      expect(JSON.parse(String(init.body))).toEqual({
        capabilityId: capability.id,
        capabilityVersion: capability.version,
        artifactDigest: capability.digest,
        targetProfileDigest: capability.targetProfileDigest,
        inputs: { member_number: "100234" },
      });
      return new Response(JSON.stringify({ run: {
        runId: "run-from-chat",
        capabilityId: capability.id,
        capabilityVersion: capability.version,
        artifactDigest: capability.digest,
        targetProfileDigest: capability.targetProfileDigest,
        phase: "queued",
      } }), { status: 202, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(createRun({
      capability,
      inputs: { member_number: "100234" },
      idempotencyKey: "chat-request-key",
    })).resolves.toEqual(expect.objectContaining({ id: "run-from-chat", phase: "queued" }));
    vi.unstubAllGlobals();
  });

  it("rejects a run response that changes a proposal's approved digest binding", async () => {
    vi.stubGlobal("window", { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
    const capability: Capability = {
      id: "member.get_record_and_balances",
      name: "Get balances",
      description: "Read a member record",
      version: "2.0.0",
      schemaVersion: "2.0",
      approval: "approved",
      risk: "read",
      tags: [],
      inputs: [],
      outputs: [],
      digest: "e".repeat(64),
      targetProfileDigest: "5".repeat(64),
      contractValid: true,
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ run: {
      runId: "run-mismatched",
      capabilityId: capability.id,
      capabilityVersion: capability.version,
      artifactDigest: "f".repeat(64),
      targetProfileDigest: capability.targetProfileDigest,
      phase: "queued",
    } }), { status: 202, headers: { "content-type": "application/json" } })));
    await expect(createRun({ capability, inputs: {}, idempotencyKey: "chat-request-key" })).rejects.toEqual(
      expect.objectContaining<ApiError>({ code: "RUN_BINDING_MISMATCH" }),
    );
    vi.unstubAllGlobals();
  });

  it("submits only the exact server challenge ID when a chat run reaches approval", async () => {
    vi.stubGlobal("window", { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
    const fetchMock = vi.fn().mockImplementation(async (input: string, init: RequestInit) => {
      expect(input).toBe("/api/v1/runs/run-from-chat/approve");
      expect(init.method).toBe("POST");
      expect(init.headers).toMatchObject({ "x-meridian-action": "operator" });
      expect(JSON.parse(String(init.body))).toEqual({ challengeId: "challenge-from-run", decision: "approve" });
      return new Response(JSON.stringify({ run: {
        runId: "run-from-chat",
        capabilityId: "member.update_contact",
        capabilityVersion: "2.0.0",
        artifactDigest: "a".repeat(64),
        phase: "running",
      } }), { status: 202, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(approveRun("run-from-chat", "challenge-from-run")).resolves.toEqual(expect.objectContaining({
      id: "run-from-chat",
      phase: "running",
    }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it("retains Anthropic routing metadata", async () => {
    vi.stubGlobal("window", { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ route: {
      kind: "reply",
      text: "Anthropic guidance",
      metadata: { provider: "anthropic-messages", model: null },
    } }), { status: 200, headers: { "content-type": "application/json" } })));
    await expect(postChat("Show safe capabilities", [])).resolves.toEqual(expect.objectContaining({
      routing: { provider: "anthropic-messages" },
    }));
    vi.unstubAllGlobals();
  });

  it("never promotes model-supplied approval material into a chat proposal", async () => {
    vi.stubGlobal("window", { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      artifactDigest: "b".repeat(64),
      targetProfileDigest: "4".repeat(64),
      route: {
        kind: "invoke",
        text: "Starting the validated lookup.",
        capabilityId: "member.get_record_and_balances",
        capabilityVersion: "2.0.0",
        arguments: { member_number: "100234" },
        approvalToken: "model-forged-token",
        challengeId: "model-forged-challenge",
      },
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const response = await postChat("Look up member 100234", []);
    expect(response.proposal).toEqual({
      capabilityId: "member.get_record_and_balances",
      capabilityVersion: "2.0.0",
      artifactDigest: "b".repeat(64),
      targetProfileDigest: "4".repeat(64),
      arguments: { member_number: "100234" },
    });
    expect(response).not.toHaveProperty("approvalToken");
    expect(response).not.toHaveProperty("challengeId");
    vi.unstubAllGlobals();
  });

  it("parses only an exact bounded sequence with server-bound profile digests", async () => {
    vi.stubGlobal("window", { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ route: {
      kind: "sequence",
      sequenceId: "11111111-1111-4111-8111-111111111111",
      failurePolicy: "stop_on_non_success",
      assistantText: "I will find the member and then read balances.",
      expiresAt: "2099-08-20T00:15:00.000Z",
      metadata: { provider: "anthropic-messages" },
      steps: [
        {
          stepId: "find_member",
          toolName: "member_search",
          capabilityId: "member.search_by_last_name",
          capabilityVersion: "2.0.0",
          literalArguments: { last_name: "Rivera" },
          bindings: [],
          artifactDigest: "1".repeat(64),
          targetProfileDigest: "2".repeat(64),
        },
        {
          stepId: "read_balances",
          toolName: "member_balances",
          capabilityId: "member.get_record_and_balances",
          capabilityVersion: "2.0.0",
          literalArguments: {},
          bindings: [{
            sourceStepId: "find_member",
            sourceCollectionPath: ["candidates"],
            valuePath: ["member_number"],
            targetInput: "member_number",
            selection: "exactly_one",
            onZero: "stop_no_match",
            onMany: "pause_for_authenticated_selection",
          }],
          artifactDigest: "3".repeat(64),
          targetProfileDigest: "2".repeat(64),
        },
      ],
    } }), { status: 200, headers: { "content-type": "application/json" } })));
    const response = await postChat("Find Rivera and show balances", []);
    expect(response.sequence).toEqual(expect.objectContaining({
      sequenceId: "11111111-1111-4111-8111-111111111111",
      failurePolicy: "stop_on_non_success",
      steps: [
        expect.objectContaining({ stepId: "find_member", targetProfileDigest: "2".repeat(64) }),
        expect.objectContaining({ stepId: "read_balances", bindings: [expect.objectContaining({ selection: "exactly_one" })] }),
      ],
    }));
    vi.unstubAllGlobals();
  });

  it("submits sequence lineage without any browser idempotency key", async () => {
    vi.stubGlobal("window", { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
    const capability: Capability = {
      id: "member.search_by_last_name", name: "Search", description: "Search members", version: "2.0.0",
      schemaVersion: "2.0", approval: "approved", risk: "read", tags: [], inputs: [], outputs: [],
      digest: "1".repeat(64), targetProfileDigest: "2".repeat(64), contractValid: true,
    };
    const fetchMock = vi.fn().mockImplementation(async (input: string, init: RequestInit) => {
      expect(input).toBe("/api/v1/runs");
      expect(init.headers).toEqual(expect.objectContaining({ "x-meridian-action": "operator" }));
      expect(init.headers).not.toEqual(expect.objectContaining({ "idempotency-key": expect.anything() }));
      expect(JSON.parse(String(init.body))).toEqual({
        capabilityId: capability.id,
        capabilityVersion: capability.version,
        artifactDigest: capability.digest,
        targetProfileDigest: capability.targetProfileDigest,
        inputs: { last_name: "Rivera" },
        sequence: { sequenceId: "11111111-1111-4111-8111-111111111111", stepId: "find_member" },
      });
      return new Response(JSON.stringify({ run: {
        runId: "run-sequence-1", capabilityId: capability.id, capabilityVersion: capability.version,
        artifactDigest: capability.digest, targetProfileDigest: capability.targetProfileDigest, phase: "queued",
        orchestration: { kind: "chat_sequence", sequenceId: "11111111-1111-4111-8111-111111111111", stepId: "find_member", stepIndex: 0, stepCount: 2 },
      } }), { status: 202, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(createRun({
      capability,
      inputs: { last_name: "Rivera" },
      sequence: { sequenceId: "11111111-1111-4111-8111-111111111111", stepId: "find_member" },
    })).resolves.toEqual(expect.objectContaining({ id: "run-sequence-1", orchestration: expect.objectContaining({ stepIndex: 0 }) }));
    vi.unstubAllGlobals();
  });

  it("retains only strict authenticated sequence-selection details", async () => {
    vi.stubGlobal("window", { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
    const capability: Capability = {
      id: "member.get_record_and_balances", name: "Balances", description: "Read balances", version: "2.0.0",
      schemaVersion: "2.0", approval: "approved", risk: "read", tags: [], inputs: [], outputs: [],
      digest: "3".repeat(64), targetProfileDigest: "2".repeat(64), contractValid: true,
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: {
      code: "SEQUENCE_SELECTION_REQUIRED",
      message: "Choose one row.",
      details: { sourceStepId: "find_member", sourceCollectionPath: ["candidates"], count: 3, rawRows: [{ password: "omit" }] },
    } }), { status: 409, headers: { "content-type": "application/json" } })));
    await expect(createRun({
      capability,
      inputs: {},
      sequence: { sequenceId: "11111111-1111-4111-8111-111111111111", stepId: "read_balances" },
    })).rejects.toEqual(expect.objectContaining<ApiError>({
      code: "SEQUENCE_SELECTION_REQUIRED",
      details: { sourceStepId: "find_member", sourceCollectionPath: ["candidates"], count: 3 },
    }));
    vi.unstubAllGlobals();
  });

  it("normalizes and mutates only the current same-session intervention", async () => {
    vi.stubGlobal("window", { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
    const intervention = {
      interventionId: "22222222-2222-4222-8222-222222222222",
      runId: "run-handoff",
      stepId: "restore_checkpoint",
      reasonCode: "SESSION_EXPIRED",
      action: "restore_session",
      state: "human_active",
      createdAt: "2026-08-20T00:00:00.000Z",
      expiresAt: "2099-08-20T00:05:00.000Z",
      sameLiveSession: true,
    };
    const fetchMock = vi.fn().mockImplementation(async (input: string, init: RequestInit) => {
      expect(input).toBe("/api/v1/runs/run-handoff/handoff/take");
      expect(JSON.parse(String(init.body))).toEqual({ interventionId: intervention.interventionId });
      return new Response(JSON.stringify({ run: {
        runId: "run-handoff", capabilityId: "member.update_contact", phase: "awaiting_human", intervention,
      } }), { status: 202, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(takeHumanControl("run-handoff", intervention.interventionId)).resolves.toEqual(expect.objectContaining({
      phase: "awaiting_human",
      intervention: expect.objectContaining({ state: "human_active", sameLiveSession: true }),
    }));
    vi.unstubAllGlobals();
  });

  it("preserves action-completed handoffs and intervention incidents", () => {
    const normalized = normalizeRun({
      runId: "run-action-completed",
      capabilityId: "account.place_hold",
      capabilityVersion: "2.0.0",
      phase: "awaiting_human",
      intervention: {
        interventionId: "22222222-2222-4222-8222-222222222222",
        runId: "run-action-completed",
        stepId: "supervisor_checkpoint",
        reasonCode: "SUPERVISOR_AUTH_REQUIRED",
        action: "authenticate_supervisor",
        state: "action_completed",
        createdAt: "2026-08-20T00:00:00.000Z",
        expiresAt: "2099-08-20T00:05:00.000Z",
        sameLiveSession: true,
        requiredRole: "supervisor",
      },
      incidents: [{
        code: "SUPERVISOR_AUTH_REQUIRED",
        category: "intervention",
        message: "A supervisor must authenticate in the retained session.",
        occurredAt: "2026-08-20T00:01:00.000Z",
      }],
    });
    expect(normalized?.intervention?.state).toBe("action_completed");
    expect(normalized?.incidents[0]?.category).toBe("intervention");
  });

  it("starts and reads only a server-authored reconciliation lineage", async () => {
    vi.stubGlobal("window", { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        reconciliation: { sourceRunId: "run-write", runId: "run-read", status: "running" },
        run: { runId: "run-read", capabilityId: "member.get_record_and_balances", phase: "queued", orchestration: { kind: "reconciliation", sourceRunId: "run-write" } },
      }), { status: 202, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        reconciliation: { sourceRunId: "run-write", runId: "run-read", status: "complete", decision: { classification: "applied", reason: "Current state matches the intended change.", checkedFields: ["phone"] } },
        run: { runId: "run-read", capabilityId: "member.get_record_and_balances", phase: "completed", status: "success", orchestration: { kind: "reconciliation", sourceRunId: "run-write" } },
      }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(startReconciliation("run-write")).resolves.toEqual(expect.objectContaining({
      run: expect.objectContaining({ id: "run-read", orchestration: { kind: "reconciliation", sourceRunId: "run-write" } }),
    }));
    await expect(getReconciliation("run-write")).resolves.toEqual(expect.objectContaining({
      reconciliation: expect.objectContaining({ status: "complete", decision: expect.objectContaining({ classification: "applied" }) }),
    }));
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({});
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
