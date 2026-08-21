import { createHash } from "node:crypto";
import { z } from "zod";
import {
  CapabilityArtifactV2Schema,
  type CapabilityArtifactV2,
} from "../domain/index.js";

const IdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

const OriginSchema = z.string().url().transform((value, context) => {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    context.addIssue({ code: "custom", message: "Target origin must use HTTP(S)" });
    return z.NEVER;
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    context.addIssue({
      code: "custom",
      message: "Target origin must not contain credentials, a path, query, or fragment",
    });
    return z.NEVER;
  }
  return url.origin;
});

/**
 * Non-secret deployment data bound independently from an approved vendor
 * capability. Credentials and cookies are deliberately not representable.
 */
export const TargetInstanceProfileV2Schema = z
  .object({
    schemaVersion: z.literal("1.0"),
    id: IdSchema,
    vendorProduct: z.string().trim().min(1).max(200),
    surfaceAdapter: z.string().trim().min(1).max(200),
    origin: OriginSchema,
    appVersion: z.string().trim().min(1).max(100).optional(),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export type TargetInstanceProfileV2 = z.infer<typeof TargetInstanceProfileV2Schema>;

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON cannot encode a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  throw new TypeError(`Canonical JSON cannot encode ${typeof value}`);
}

export function targetProfileDigest(profile: TargetInstanceProfileV2): string {
  const validated = TargetInstanceProfileV2Schema.parse(profile);
  return createHash("sha256").update(canonicalJson(validated), "utf8").digest("hex");
}

export interface TargetBoundArtifactV2 {
  /** Digest of the immutable, approved vendor artifact in the catalog. */
  readonly baseArtifactDigest: string;
  /** Digest of the non-secret deployment profile selected by the server. */
  readonly targetProfileDigest: string;
  /** Runtime copy with only entry-point and route origins materialized. */
  readonly artifact: CapabilityArtifactV2;
}

function pathWithQuery(value: string): string {
  const url = new URL(value);
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Materialize an approved vendor contract for one deployment. The base object
 * is never mutated and target overrides cannot change targets, actions,
 * effects, conditions, or data classifications.
 */
export function bindArtifactToTargetProfile(
  artifactValue: CapabilityArtifactV2,
  baseArtifactDigest: string,
  profileValue: TargetInstanceProfileV2,
): TargetBoundArtifactV2 {
  if (!/^[a-f0-9]{64}$/u.test(baseArtifactDigest)) {
    throw new Error("baseArtifactDigest must be a lowercase SHA-256 digest");
  }
  const artifact = CapabilityArtifactV2Schema.parse(structuredClone(artifactValue));
  const actualBaseDigest = createHash("sha256").update(canonicalJson(artifact), "utf8").digest("hex");
  if (actualBaseDigest !== baseArtifactDigest) {
    throw new Error("baseArtifactDigest does not identify the supplied approved capability");
  }
  const profile = TargetInstanceProfileV2Schema.parse(profileValue);
  if (artifact.compatibility.vendorProduct !== profile.vendorProduct) {
    throw new Error("Target profile vendor product is incompatible with the capability");
  }
  if (artifact.compatibility.surfaceAdapter !== profile.surfaceAdapter) {
    throw new Error("Target profile surface adapter is incompatible with the capability");
  }
  if (
    artifact.compatibility.appVersion &&
    profile.appVersion &&
    artifact.compatibility.appVersion !== profile.appVersion
  ) {
    throw new Error("Target profile application version is incompatible with the capability");
  }

  artifact.compatibility.entryPoint = new URL(
    pathWithQuery(artifact.compatibility.entryPoint),
    profile.origin,
  ).toString();
  artifact.policy.routes = artifact.policy.routes.map((route) => ({
    ...route,
    origin: profile.origin,
  }));

  return Object.freeze({
    baseArtifactDigest,
    targetProfileDigest: targetProfileDigest(profile),
    artifact: CapabilityArtifactV2Schema.parse(artifact),
  });
}

export function targetExecutionDigest(binding: {
  readonly baseArtifactDigest: string;
  readonly targetProfileDigest: string;
}): string {
  if (!/^[a-f0-9]{64}$/u.test(binding.baseArtifactDigest)) {
    throw new Error("baseArtifactDigest must be a lowercase SHA-256 digest");
  }
  if (!/^[a-f0-9]{64}$/u.test(binding.targetProfileDigest)) {
    throw new Error("targetProfileDigest must be a lowercase SHA-256 digest");
  }
  return createHash("sha256")
    .update(canonicalJson({
      baseArtifactDigest: binding.baseArtifactDigest,
      targetProfileDigest: binding.targetProfileDigest,
    }), "utf8")
    .digest("hex");
}
