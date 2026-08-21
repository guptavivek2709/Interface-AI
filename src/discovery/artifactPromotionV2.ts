import { z } from "zod";
import {
  CapabilityArtifactV2Schema,
  type CapabilityArtifactV2,
} from "../domain/index.js";
import { sha256Digest } from "../security/digest.js";
import {
  DiscoveryTraceV2Schema,
  assertNoRawDiscoveryInputLeak,
  discoveryTraceDigestV2,
  type DiscoveryTraceV2,
} from "./discoveryTraceV2.js";

const canonicalArtifactDigest = (artifact: CapabilityArtifactV2): string => sha256Digest(artifact);

const IdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const TimestampSchema = z.iso.datetime({ offset: true });

const DraftCreatedEventSchema = z
  .object({
    type: z.literal("draft_created"),
    at: TimestampSchema,
    actor: z.literal("discovery_compiler"),
    artifactDigest: DigestSchema,
    traceDigest: DigestSchema,
  })
  .strict();
const ReviewedEventSchema = z
  .object({
    type: z.literal("reviewed"),
    at: TimestampSchema,
    actor: IdSchema,
    artifactDigest: DigestSchema,
    parentArtifactDigest: DigestSchema,
    reviewDiffDigest: DigestSchema,
    changedPathCount: z.number().int().nonnegative(),
  })
  .strict();
const CanaryPassedEventSchema = z
  .object({
    type: z.literal("canary_passed"),
    at: TimestampSchema,
    actor: z.literal("canary_runner"),
    artifactDigest: DigestSchema,
    canaryRunId: IdSchema,
    evidenceDigest: DigestSchema,
  })
  .strict();
const ApprovedEventSchema = z
  .object({
    type: z.literal("approved"),
    at: TimestampSchema,
    actor: IdSchema,
    artifactDigest: DigestSchema,
    parentArtifactDigest: DigestSchema,
  })
  .strict();

export const ArtifactLineageEventV2Schema = z.discriminatedUnion("type", [
  DraftCreatedEventSchema,
  ReviewedEventSchema,
  CanaryPassedEventSchema,
  ApprovedEventSchema,
]);
export type ArtifactLineageEventV2 = z.infer<typeof ArtifactLineageEventV2Schema>;

export const ArtifactLineageV2Schema = z
  .object({
    schemaVersion: z.literal("1.0"),
    lineageId: IdSchema,
    capabilityId: IdSchema,
    capabilityVersion: z.string().regex(/^\d+\.\d+\.\d+$/u),
    stage: z.enum(["draft", "reviewed", "canary_passed", "approved"]),
    discovery: z
      .object({
        runId: IdSchema,
        provider: z.string().trim().min(1),
        model: z.string().trim().min(1),
        mode: z.enum(["model", "test_double"]),
        traceDigest: DigestSchema,
      })
      .strict(),
    draftDigest: DigestSchema,
    reviewedDigest: DigestSchema.optional(),
    approvedDigest: DigestSchema.optional(),
    events: z.array(ArtifactLineageEventV2Schema).min(1).max(20),
  })
  .strict()
  .superRefine((lineage, context) => {
    const expectedTypes = {
      draft: ["draft_created"],
      reviewed: ["draft_created", "reviewed"],
      canary_passed: ["draft_created", "reviewed", "canary_passed"],
      approved: ["draft_created", "reviewed", "canary_passed", "approved"],
    }[lineage.stage];
    const actualTypes = lineage.events.map((event) => event.type);
    if (JSON.stringify(actualTypes) !== JSON.stringify(expectedTypes)) {
      context.addIssue({
        code: "custom",
        path: ["events"],
        message: `Lifecycle events do not match ${lineage.stage} stage`,
      });
      return;
    }
    const draft = lineage.events[0];
    if (draft?.type !== "draft_created" || draft.artifactDigest !== lineage.draftDigest) {
      context.addIssue({ code: "custom", path: ["draftDigest"], message: "Draft digest is inconsistent" });
    }
    if (draft?.type === "draft_created" && draft.traceDigest !== lineage.discovery.traceDigest) {
      context.addIssue({
        code: "custom",
        path: ["discovery", "traceDigest"],
        message: "Trace digest is inconsistent",
      });
    }
    const review = lineage.events.find((event) => event.type === "reviewed");
    if (lineage.stage === "draft") {
      if (lineage.reviewedDigest !== undefined || lineage.approvedDigest !== undefined) {
        context.addIssue({ code: "custom", path: [], message: "Draft lineage cannot contain later digests" });
      }
    } else if (
      !review ||
      lineage.reviewedDigest !== review.artifactDigest ||
      review.parentArtifactDigest !== lineage.draftDigest
    ) {
      context.addIssue({ code: "custom", path: ["reviewedDigest"], message: "Reviewed digest is inconsistent" });
    }
    const canary = lineage.events.find((event) => event.type === "canary_passed");
    if (canary && canary.artifactDigest !== lineage.reviewedDigest) {
      context.addIssue({ code: "custom", path: ["events"], message: "Canary did not bind the reviewed digest" });
    }
    const approval = lineage.events.find((event) => event.type === "approved");
    if (lineage.stage === "approved") {
      if (
        !approval ||
        lineage.approvedDigest !== approval.artifactDigest ||
        approval.parentArtifactDigest !== lineage.reviewedDigest
      ) {
        context.addIssue({ code: "custom", path: ["approvedDigest"], message: "Approved digest is inconsistent" });
      }
    } else if (lineage.approvedDigest !== undefined) {
      context.addIssue({ code: "custom", path: ["approvedDigest"], message: "Artifact is not approved" });
    }
  });
export type ArtifactLineageV2 = z.infer<typeof ArtifactLineageV2Schema>;

export interface CanaryAttestationV2 {
  readonly status: "passed" | "failed";
  readonly artifactDigest: string;
  readonly canaryRunId: string;
  readonly evidenceDigest: string;
  readonly completedAt: string;
}

export type ArtifactPromotionErrorCode =
  | "INVALID_STAGE"
  | "DIGEST_MISMATCH"
  | "PROVENANCE_MISMATCH"
  | "TEST_DOUBLE_FORBIDDEN"
  | "CANARY_FAILED"
  | "INPUT_LEAK";

export class ArtifactPromotionError extends Error {
  readonly code: ArtifactPromotionErrorCode;

  constructor(code: ArtifactPromotionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ArtifactPromotionError";
    this.code = code;
  }
}

function timestamp(value?: string): string {
  return TimestampSchema.parse(value ?? new Date().toISOString());
}

function actor(value: string, label: string): string {
  try {
    return IdSchema.parse(value);
  } catch (error) {
    throw new ArtifactPromotionError("PROVENANCE_MISMATCH", `${label} is not a valid audit actor`, {
      cause: error,
    });
  }
}

function assertNoLeak(
  value: unknown,
  forbiddenInputValues: Iterable<string | number | boolean>,
): void {
  try {
    assertNoRawDiscoveryInputLeak(value, forbiddenInputValues);
  } catch (error) {
    throw new ArtifactPromotionError(
      "INPUT_LEAK",
      "Artifact promotion rejected raw discovery input material",
      { cause: error },
    );
  }
}

function assertStage(lineage: ArtifactLineageV2, expected: ArtifactLineageV2["stage"]): void {
  if (lineage.stage !== expected) {
    throw new ArtifactPromotionError(
      "INVALID_STAGE",
      `Expected artifact lifecycle stage ${expected}; received ${lineage.stage}`,
    );
  }
}

function assertArtifactDiscoveryBinding(
  artifact: CapabilityArtifactV2,
  lineage: ArtifactLineageV2,
): void {
  if (
    artifact.capability.id !== lineage.capabilityId ||
    artifact.capability.version !== lineage.capabilityVersion ||
    artifact.provenance.source !== "discovery" ||
    artifact.provenance.discoveryRunId !== lineage.discovery.runId ||
    artifact.provenance.planner?.provider !== lineage.discovery.provider ||
    artifact.provenance.planner.model !== lineage.discovery.model
  ) {
    throw new ArtifactPromotionError(
      "PROVENANCE_MISMATCH",
      "Artifact no longer matches its discovery lineage",
    );
  }
}

function changedPaths(before: unknown, after: unknown, path = ""): string[] {
  if (Object.is(before, after)) return [];
  if (
    before === null ||
    after === null ||
    typeof before !== "object" ||
    typeof after !== "object" ||
    Array.isArray(before) !== Array.isArray(after)
  ) {
    return [path || "/"];
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const paths: string[] = [];
    for (let index = 0; index < Math.max(before.length, after.length); index += 1) {
      paths.push(...changedPaths(before[index], after[index], `${path}/${index}`));
    }
    return paths;
  }
  const left = before as Record<string, unknown>;
  const right = after as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys]
    .sort((a, b) => a.localeCompare(b, "en-US"))
    .flatMap((key) =>
      changedPaths(
        left[key],
        right[key],
        `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
      ),
    );
}

export function createArtifactLineageV2(
  traceValue: DiscoveryTraceV2,
  draftValue: CapabilityArtifactV2,
  options: {
    readonly forbiddenInputValues?: Iterable<string | number | boolean>;
    readonly createdAt?: string;
    readonly lineageId?: string;
  } = {},
): ArtifactLineageV2 {
  const trace = DiscoveryTraceV2Schema.parse(traceValue);
  const draft = CapabilityArtifactV2Schema.parse(draftValue);
  if (draft.capability.approval !== "draft") {
    throw new ArtifactPromotionError("INVALID_STAGE", "Discovery compiler output must begin as a draft");
  }
  if (
    draft.provenance.source !== "discovery" ||
    draft.provenance.discoveryRunId !== trace.runId ||
    draft.provenance.planner?.provider !== trace.planner.provider ||
    draft.provenance.planner.model !== trace.planner.model
  ) {
    throw new ArtifactPromotionError(
      "PROVENANCE_MISMATCH",
      "Draft provenance does not match the projected discovery trace",
    );
  }
  assertNoLeak(trace, options.forbiddenInputValues ?? []);
  assertNoLeak(draft, options.forbiddenInputValues ?? []);
  const traceDigest = discoveryTraceDigestV2(trace);
  const draftDigest = canonicalArtifactDigest(draft);
  const createdAt = timestamp(options.createdAt);
  return ArtifactLineageV2Schema.parse({
    schemaVersion: "1.0",
    lineageId:
      options.lineageId ??
      `lineage.${draft.capability.id}.${sha256Digest({ traceDigest, draftDigest }).slice(0, 16)}`,
    capabilityId: draft.capability.id,
    capabilityVersion: draft.capability.version,
    stage: "draft",
    discovery: {
      runId: trace.runId,
      provider: trace.planner.provider,
      model: trace.planner.model,
      mode: trace.planner.mode,
      traceDigest,
    },
    draftDigest,
    events: [
      {
        type: "draft_created",
        at: createdAt,
        actor: "discovery_compiler",
        artifactDigest: draftDigest,
        traceDigest,
      },
    ],
  });
}

export function reviewDiscoveredArtifactV2(
  lineageValue: ArtifactLineageV2,
  draftValue: CapabilityArtifactV2,
  reviewedValue: CapabilityArtifactV2,
  options: {
    readonly reviewer: string;
    readonly reviewedAt?: string;
    readonly forbiddenInputValues?: Iterable<string | number | boolean>;
  },
): ArtifactLineageV2 {
  const lineage = ArtifactLineageV2Schema.parse(lineageValue);
  assertStage(lineage, "draft");
  const draft = CapabilityArtifactV2Schema.parse(draftValue);
  const reviewed = CapabilityArtifactV2Schema.parse(reviewedValue);
  if (canonicalArtifactDigest(draft) !== lineage.draftDigest) {
    throw new ArtifactPromotionError("DIGEST_MISMATCH", "Draft digest does not match the lineage");
  }
  if (reviewed.capability.approval !== "draft") {
    throw new ArtifactPromotionError("INVALID_STAGE", "Reviewed candidate must remain non-executable");
  }
  assertArtifactDiscoveryBinding(draft, lineage);
  assertArtifactDiscoveryBinding(reviewed, lineage);
  if (JSON.stringify(reviewed.provenance) !== JSON.stringify(draft.provenance)) {
    throw new ArtifactPromotionError(
      "PROVENANCE_MISMATCH",
      "Human review cannot rewrite discovery provenance",
    );
  }
  assertNoLeak(reviewed, options.forbiddenInputValues ?? []);
  const reviewedDigest = canonicalArtifactDigest(reviewed);
  const paths = changedPaths(draft, reviewed);
  const event: ArtifactLineageEventV2 = {
    type: "reviewed",
    at: timestamp(options.reviewedAt),
    actor: actor(options.reviewer, "Reviewer"),
    artifactDigest: reviewedDigest,
    parentArtifactDigest: lineage.draftDigest,
    reviewDiffDigest: sha256Digest({ paths, reviewedDigest }),
    changedPathCount: paths.length,
  };
  return ArtifactLineageV2Schema.parse({
    ...lineage,
    stage: "reviewed",
    reviewedDigest,
    events: [...lineage.events, event],
  });
}

export function recordArtifactCanaryPassedV2(
  lineageValue: ArtifactLineageV2,
  reviewedValue: CapabilityArtifactV2,
  canary: CanaryAttestationV2,
  options: { readonly forbiddenInputValues?: Iterable<string | number | boolean> } = {},
): ArtifactLineageV2 {
  const lineage = ArtifactLineageV2Schema.parse(lineageValue);
  assertStage(lineage, "reviewed");
  const reviewed = CapabilityArtifactV2Schema.parse(reviewedValue);
  assertArtifactDiscoveryBinding(reviewed, lineage);
  assertNoLeak(reviewed, options.forbiddenInputValues ?? []);
  const reviewedDigest = canonicalArtifactDigest(reviewed);
  if (reviewedDigest !== lineage.reviewedDigest || canary.artifactDigest !== reviewedDigest) {
    throw new ArtifactPromotionError(
      "DIGEST_MISMATCH",
      "Canary attestation does not bind the reviewed artifact digest",
    );
  }
  if (canary.status !== "passed") {
    throw new ArtifactPromotionError("CANARY_FAILED", "Failed canary cannot advance artifact promotion");
  }
  const event: ArtifactLineageEventV2 = CanaryPassedEventSchema.parse({
    type: "canary_passed",
    at: canary.completedAt,
    actor: "canary_runner",
    artifactDigest: reviewedDigest,
    canaryRunId: canary.canaryRunId,
    evidenceDigest: canary.evidenceDigest,
  });
  return ArtifactLineageV2Schema.parse({
    ...lineage,
    stage: "canary_passed",
    events: [...lineage.events, event],
  });
}

export function approveDiscoveredArtifactV2(
  lineageValue: ArtifactLineageV2,
  reviewedValue: CapabilityArtifactV2,
  options: {
    readonly approver: string;
    readonly approvedAt?: string;
    readonly forbiddenInputValues?: Iterable<string | number | boolean>;
  },
): { readonly artifact: CapabilityArtifactV2; readonly lineage: ArtifactLineageV2 } {
  const lineage = ArtifactLineageV2Schema.parse(lineageValue);
  assertStage(lineage, "canary_passed");
  if (lineage.discovery.mode !== "model") {
    throw new ArtifactPromotionError(
      "TEST_DOUBLE_FORBIDDEN",
      "Test-double discovery provenance cannot be promoted to the approved catalog",
    );
  }
  const reviewed = CapabilityArtifactV2Schema.parse(reviewedValue);
  assertArtifactDiscoveryBinding(reviewed, lineage);
  const reviewedDigest = canonicalArtifactDigest(reviewed);
  if (reviewed.capability.approval !== "draft" || reviewedDigest !== lineage.reviewedDigest) {
    throw new ArtifactPromotionError(
      "DIGEST_MISMATCH",
      "Approval candidate does not match the reviewed artifact digest",
    );
  }
  assertNoLeak(reviewed, options.forbiddenInputValues ?? []);
  const artifact = CapabilityArtifactV2Schema.parse({
    ...structuredClone(reviewed),
    capability: {
      ...reviewed.capability,
      approval: "approved",
    },
  });
  assertNoLeak(artifact, options.forbiddenInputValues ?? []);
  const approvedDigest = canonicalArtifactDigest(artifact);
  const event: ArtifactLineageEventV2 = {
    type: "approved",
    at: timestamp(options.approvedAt),
    actor: actor(options.approver, "Approver"),
    artifactDigest: approvedDigest,
    // The external lineage owns this link because CapabilityArtifactV2's
    // current strict provenance schema has no parent-digest field.
    parentArtifactDigest: reviewedDigest,
  };
  const approvedLineage = ArtifactLineageV2Schema.parse({
    ...lineage,
    stage: "approved",
    approvedDigest,
    events: [...lineage.events, event],
  });
  return { artifact, lineage: approvedLineage };
}
