import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const ApprovalKindSchema = z.enum(["user_confirmation", "supervisor_confirmation"]);
export type ApprovalKind = z.infer<typeof ApprovalKindSchema>;

const ApprovalClaimsSchema = z
  .object({
    version: z.literal(2),
    approvalId: z.string().uuid(),
    challengeId: z.string().uuid(),
    runId: z.string().min(1),
    artifactDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    inputDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    sessionRef: z.string().min(1),
    stepId: z.string().min(1),
    kind: ApprovalKindSchema,
    reviewDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    stateNonceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    actorId: z.string().min(1).max(200),
    actorRoles: z.array(z.string().min(1).max(100)).min(1),
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type ApprovalClaims = z.infer<typeof ApprovalClaimsSchema>;

export interface ApprovalBinding {
  challengeId: string;
  runId: string;
  artifactDigest: string;
  inputDigest: string;
  sessionRef: string;
  stepId: string;
  kind: ApprovalKind;
  reviewDigest: string;
  stateNonceDigest: string;
}

export interface ApprovalActor {
  id: string;
  roles: readonly string[];
}

export class ApprovalError extends Error {
  readonly code:
    | "APPROVAL_INVALID"
    | "APPROVAL_EXPIRED"
    | "APPROVAL_MISMATCH"
    | "APPROVAL_REUSED"
    | "ROLE_REQUIRED";

  constructor(code: ApprovalError["code"], message: string) {
    super(message);
    this.name = "ApprovalError";
    this.code = code;
  }
}

function encode(value: Uint8Array | string): string {
  return Buffer.from(value).toString("base64url");
}

function decode(value: string): Buffer {
  try {
    return Buffer.from(value, "base64url");
  } catch {
    throw new ApprovalError("APPROVAL_INVALID", "Approval token is not valid base64url");
  }
}

/**
 * Issues short-lived, one-time approval tokens bound to one reviewed step.
 * The authority is deliberately provider-neutral; production deployments can
 * replace it with an external signer while retaining the same verifier seam.
 */
export class ApprovalAuthority {
  readonly #secret: Buffer;
  readonly #now: () => number;
  readonly #consumed = new Set<string>();

  constructor(options: { secret?: Uint8Array; now?: () => number } = {}) {
    this.#secret = Buffer.from(options.secret ?? randomBytes(32));
    if (this.#secret.byteLength < 32) throw new TypeError("Approval signing secret must be at least 32 bytes");
    this.#now = options.now ?? Date.now;
  }

  issue(binding: ApprovalBinding, actor: ApprovalActor, expiresInMs: number): string {
    if (!actor.id.trim() || actor.roles.length === 0) {
      throw new ApprovalError("ROLE_REQUIRED", "An authenticated actor and role are required");
    }
    if (binding.kind === "supervisor_confirmation" && !actor.roles.includes("supervisor")) {
      throw new ApprovalError("ROLE_REQUIRED", "Supervisor approval is required for this step");
    }
    const issuedAt = this.#now();
    const claims = ApprovalClaimsSchema.parse({
      version: 2,
      approvalId: randomUUID(),
      ...binding,
      actorId: actor.id,
      actorRoles: [...actor.roles],
      issuedAt,
      expiresAt: issuedAt + expiresInMs,
    });
    const payload = encode(JSON.stringify(claims));
    return `${payload}.${encode(this.#sign(payload))}`;
  }

  consume(token: string, expected: ApprovalBinding): ApprovalClaims {
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra !== undefined) {
      throw new ApprovalError("APPROVAL_INVALID", "Approval token has an invalid envelope");
    }
    const actual = decode(signature);
    const wanted = this.#sign(payload);
    if (actual.byteLength !== wanted.byteLength || !timingSafeEqual(actual, wanted)) {
      throw new ApprovalError("APPROVAL_INVALID", "Approval token signature is invalid");
    }
    let claims: ApprovalClaims;
    try {
      claims = ApprovalClaimsSchema.parse(JSON.parse(decode(payload).toString("utf8")) as unknown);
    } catch {
      throw new ApprovalError("APPROVAL_INVALID", "Approval token payload is invalid");
    }
    if (claims.expiresAt <= this.#now()) {
      throw new ApprovalError("APPROVAL_EXPIRED", "Approval token has expired");
    }
    const fields: Array<keyof ApprovalBinding> = [
      "challengeId",
      "runId",
      "artifactDigest",
      "inputDigest",
      "sessionRef",
      "stepId",
      "kind",
      "reviewDigest",
      "stateNonceDigest",
    ];
    if (fields.some((field) => claims[field] !== expected[field])) {
      throw new ApprovalError("APPROVAL_MISMATCH", "Approval token does not match this run and reviewed step");
    }
    if (this.#consumed.has(claims.approvalId)) {
      throw new ApprovalError("APPROVAL_REUSED", "Approval token has already been consumed");
    }
    this.#consumed.add(claims.approvalId);
    return claims;
  }

  #sign(payload: string): Buffer {
    return createHmac("sha256", this.#secret).update(payload, "utf8").digest();
  }
}
