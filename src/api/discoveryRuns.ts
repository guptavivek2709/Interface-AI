import { z } from "zod";
import type { CapabilityCatalog, CapabilityDiscoveryRecord } from "../catalog/index.js";
import { FieldSpecV2Schema, TypeSpecV2Schema } from "../domain/index.js";
import { ArtifactLineageEventV2Schema } from "../discovery/artifactPromotionV2.js";
import { sha256Digest } from "../security/digest.js";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const TimestampSchema = z.iso.datetime({ offset: true });
export const DiscoveryRunIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

export const DiscoveryRunInputSchema = z
  .object({
    name: z.string().min(1).max(160),
    type: TypeSpecV2Schema,
    classification: z.enum(["public", "internal", "confidential", "restricted", "secret"]),
    required: z.boolean(),
    valueStatus: z.literal("withheld"),
  })
  .strict();

export const DiscoveryRunOutputFieldSchema = FieldSpecV2Schema.omit({ required: true });

export const DiscoveryRunOutputSchema = z
  .object({
    traceDigest: DigestSchema,
    draftDigest: DigestSchema,
    reviewedDigest: DigestSchema,
    canaryRunId: DiscoveryRunIdSchema,
    approvedDigest: DigestSchema,
  })
  .strict();

export const DiscoveryEvidenceReferenceSchema = z
  .object({
    kind: z.enum(["artifact", "lineage"]),
    referenceId: z.string().min(1).max(300),
    url: z.string().startsWith("/api/v1/"),
    /** SHA-256 of the canonical persisted source record, not of the API projection. */
    sha256: DigestSchema,
  })
  .strict();

export const DiscoveryRunSchema = z
  .object({
    kind: z.literal("discovery"),
    id: DiscoveryRunIdSchema,
    discoveryRunId: DiscoveryRunIdSchema,
    capabilityId: z.string().min(1).max(160),
    capabilityVersion: z.string().regex(/^\d+\.\d+\.\d+$/u),
    createdAt: TimestampSchema,
    completedAt: TimestampSchema.optional(),
    status: z.literal("approved"),
    provider: z.string().trim().min(1).max(200),
    model: z.string().trim().min(1).max(300),
    goal: z.string().trim().min(1).max(20_000).optional(),
    inputs: z.array(DiscoveryRunInputSchema).max(200),
    outputContract: z.array(DiscoveryRunOutputFieldSchema).max(200),
    output: DiscoveryRunOutputSchema,
    timeline: z.array(ArtifactLineageEventV2Schema).min(1).max(20),
    evidence: z.array(DiscoveryEvidenceReferenceSchema).min(2).max(2),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.id !== record.discoveryRunId) {
      context.addIssue({
        code: "custom",
        path: ["discoveryRunId"],
        message: "Discovery identifiers must match",
      });
    }
  });

export type DiscoveryRun = z.infer<typeof DiscoveryRunSchema>;

export const DiscoveryRunListResponseSchema = z
  .object({ discoveryRuns: z.array(DiscoveryRunSchema) })
  .strict();
export const DiscoveryRunDetailResponseSchema = z
  .object({ discoveryRun: DiscoveryRunSchema })
  .strict();

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function projectPublishedRecord(record: CapabilityDiscoveryRecord): DiscoveryRun {
  const { artifact, lineage } = record;
  const canary = lineage.events.find((event) => event.type === "canary_passed");
  const approval = lineage.events.find((event) => event.type === "approved");
  if (
    lineage.stage !== "approved" ||
    lineage.discovery.mode !== "model" ||
    !lineage.reviewedDigest ||
    !lineage.approvedDigest ||
    canary?.type !== "canary_passed" ||
    approval?.type !== "approved"
  ) {
    throw new Error("Published discovery history requires exact approved model lineage");
  }

  const discoveryRunId = lineage.discovery.runId;
  return deepFreeze(DiscoveryRunSchema.parse({
    kind: "discovery",
    id: discoveryRunId,
    discoveryRunId,
    capabilityId: artifact.capability.id,
    capabilityVersion: artifact.capability.version,
    createdAt: artifact.provenance.createdAt,
    completedAt: approval.at,
    status: "approved",
    provider: lineage.discovery.provider,
    model: lineage.discovery.model,
    goal: artifact.provenance.goal,
    inputs: artifact.inputs.map((input) => ({
      name: input.name,
      type: input.type,
      classification: input.classification,
      required: input.required,
      valueStatus: "withheld",
    })),
    outputContract: artifact.outputs,
    output: {
      traceDigest: lineage.discovery.traceDigest,
      draftDigest: lineage.draftDigest,
      reviewedDigest: lineage.reviewedDigest,
      canaryRunId: canary.canaryRunId,
      approvedDigest: lineage.approvedDigest,
    },
    timeline: lineage.events,
    evidence: [
      {
        kind: "artifact",
        referenceId: `${artifact.capability.id}@${artifact.capability.version}`,
        url: `/api/v1/capabilities/${encodeURIComponent(artifact.capability.id)}/${encodeURIComponent(artifact.capability.version)}`,
        sha256: lineage.approvedDigest,
      },
      {
        kind: "lineage",
        referenceId: lineage.lineageId,
        url: `/api/v1/discovery-runs/${encodeURIComponent(discoveryRunId)}`,
        sha256: sha256Digest(lineage),
      },
    ],
  }));
}

/** Immutable API view over exact published artifact/lineage pairs. */
export class PublishedDiscoveryHistory {
  readonly #records: readonly DiscoveryRun[];
  readonly #byId: ReadonlyMap<string, DiscoveryRun>;

  constructor(catalog: CapabilityCatalog) {
    const records = catalog
      .listDiscoveryRecords()
      .map(projectPublishedRecord)
      .sort((left, right) => {
        const timeOrder = Date.parse(right.createdAt) - Date.parse(left.createdAt);
        return timeOrder || left.id.localeCompare(right.id);
      });
    const byId = new Map<string, DiscoveryRun>();
    for (const record of records) {
      if (byId.has(record.id)) {
        throw new Error(`Published discovery run ${record.id} is duplicated`);
      }
      byId.set(record.id, record);
    }
    this.#records = Object.freeze(records);
    this.#byId = byId;
  }

  list(): readonly DiscoveryRun[] {
    return this.#records;
  }

  get(id: string): DiscoveryRun | undefined {
    return this.#byId.get(id);
  }
}
