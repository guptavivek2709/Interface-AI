import { describe, expect, it } from "vitest";
import { ApprovalAuthority, ApprovalError, type ApprovalBinding } from "../../src/approval/index.js";

const secret = Buffer.alloc(32, 7);
const binding: ApprovalBinding = {
  challengeId: "1d67fd62-aef1-47f8-b47a-233be29e70d8",
  runId: "run-1",
  artifactDigest: "a".repeat(64),
  inputDigest: "b".repeat(64),
  sessionRef: "session-ref",
  stepId: "commit",
  kind: "supervisor_confirmation",
  reviewDigest: "c".repeat(64),
  stateNonceDigest: "d".repeat(64),
};

describe("ApprovalAuthority", () => {
  it("binds and consumes a supervisor approval exactly once", () => {
    let time = 10_000;
    const authority = new ApprovalAuthority({ secret, now: () => time });
    const token = authority.issue(binding, { id: "supervisor-7", roles: ["supervisor"] }, 30_000);
    const claims = authority.consume(token, binding);
    expect(claims.actorId).toBe("supervisor-7");
    expect(() => authority.consume(token, binding)).toThrowError(
      expect.objectContaining({ code: "APPROVAL_REUSED" }),
    );
    time += 1;
  });

  it("rejects a teller for a supervisor confirmation", () => {
    const authority = new ApprovalAuthority({ secret });
    expect(() => authority.issue(binding, { id: "teller-1", roles: ["teller"] }, 30_000)).toThrowError(
      expect.objectContaining({ code: "ROLE_REQUIRED" }),
    );
  });

  it("rejects tampering, mismatched binding, and expiry", () => {
    let time = 100;
    const authority = new ApprovalAuthority({ secret, now: () => time });
    const token = authority.issue(binding, { id: "supervisor-7", roles: ["supervisor"] }, 100);
    expect(() => authority.consume(`${token}x`, binding)).toThrow(ApprovalError);
    expect(() => authority.consume(token, { ...binding, runId: "another-run" })).toThrowError(
      expect.objectContaining({ code: "APPROVAL_MISMATCH" }),
    );
    expect(() => authority.consume(token, { ...binding, reviewDigest: "e".repeat(64) })).toThrowError(
      expect.objectContaining({ code: "APPROVAL_MISMATCH" }),
    );
    expect(() => authority.consume(token, { ...binding, stateNonceDigest: "f".repeat(64) })).toThrowError(
      expect.objectContaining({ code: "APPROVAL_MISMATCH" }),
    );
    time = 200;
    expect(() => authority.consume(token, binding)).toThrowError(
      expect.objectContaining({ code: "APPROVAL_EXPIRED" }),
    );
  });
});
