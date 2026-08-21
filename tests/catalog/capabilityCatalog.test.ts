import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CapabilityCatalog,
  CapabilityCatalogError,
  canonicalArtifactDigest,
} from "../../src/catalog/index.js";
import {
  CapabilityArtifactV2Schema,
  type CapabilityArtifactV2,
} from "../../src/domain/index.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function scratchDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "capability-catalog-test-"));
  cleanup.push(directory);
  return directory;
}

function v2Artifact(options: {
  id?: string;
  version?: string;
  approval?: "draft" | "approved" | "retired";
  risk?: "read" | "write" | "irreversible" | "supervisor_only";
} = {}): CapabilityArtifactV2 {
  return CapabilityArtifactV2Schema.parse({
    schemaVersion: "2.0",
    capability: {
      id: options.id ?? "v2-capability",
      name: `Capability ${options.id ?? "v2-capability"}`,
      description: "Reads a stable value from a synthetic target.",
      version: options.version ?? "2.0.0",
      approval: options.approval ?? "approved",
      risk: options.risk ?? "read",
      tags: ["test"],
    },
    provenance: {
      source: "authored",
      createdAt: "2026-08-20T12:00:00.000Z",
      goal: "Read a stable synthetic value.",
    },
    compatibility: {
      surfaceAdapter: "playwright-web-v2",
      vendorProduct: "synthetic-target",
      appVersion: "1",
      entryPoint: "https://example.test/menu",
    },
    inputs: [
      {
        name: "memberNumber",
        description: "Synthetic member number.",
        type: { kind: "string", format: "member_number" },
        required: true,
        classification: "restricted",
      },
    ],
    outputs: [
      {
        name: "memberName",
        description: "Synthetic member name.",
        type: { kind: "string" },
        classification: "restricted",
      },
    ],
    policy: {
      routes: [
        {
          origin: "https://example.test",
          pathPattern: "^/menu$",
          methods: ["GET"],
        },
      ],
      allowedActions: ["extract"],
      maxEffect: "read",
    },
    targets: [
      {
        id: "memberName",
        description: "Member name value.",
        framePath: [],
        strategies: [{ kind: "label_value", label: "Member name" }],
        cardinality: "exactly_one",
        sensitive: true,
      },
    ],
    steps: [
      {
        id: "extract-member-name",
        title: "Extract member name",
        action: { kind: "extract", targetId: "memberName", outputName: "memberName" },
        preconditions: [{ kind: "target_present", targetId: "memberName", present: true }],
        postcondition: { kind: "target_present", targetId: "memberName", present: true },
        timeoutMs: 5_000,
        retry: { maxAttempts: 1, backoffMs: 0 },
        effect: "read",
      },
    ],
    runtimeStates: [],
    checkpoint: { kind: "target_present", targetId: "memberName", present: true },
  });
}

async function save(directory: string, name: string, artifact: unknown): Promise<void> {
  await writeFile(path.join(directory, name), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}

function discoveredApprovedArtifact(): CapabilityArtifactV2 {
  const base = v2Artifact({ id: "discovered-v2", version: "3.0.0", approval: "approved" });
  return CapabilityArtifactV2Schema.parse({
    ...base,
    provenance: {
      source: "discovery",
      createdAt: "2026-08-20T12:00:00.000Z",
      goal: "Read a stable synthetic value.",
      discoveryRunId: "catalog-discovery-run",
      planner: { provider: "anthropic-messages", model: "claude-sonnet-5" },
    },
  });
}

function approvedLineage(artifact: CapabilityArtifactV2, mode: "model" | "test_double" = "model") {
  const approvedDigest = canonicalArtifactDigest(artifact);
  const draftDigest = "a".repeat(64);
  const reviewedDigest = "b".repeat(64);
  const traceDigest = "c".repeat(64);
  return {
    schemaVersion: "1.0",
    lineageId: "lineage.discovered-v2",
    capabilityId: artifact.capability.id,
    capabilityVersion: artifact.capability.version,
    stage: "approved",
    discovery: {
      runId: "catalog-discovery-run",
      provider: "anthropic-messages",
      model: "claude-sonnet-5",
      mode,
      traceDigest,
    },
    draftDigest,
    reviewedDigest,
    approvedDigest,
    events: [
      { type: "draft_created", at: "2026-08-20T12:00:00.000Z", actor: "discovery_compiler", artifactDigest: draftDigest, traceDigest },
      { type: "reviewed", at: "2026-08-20T12:01:00.000Z", actor: "reviewer-1", artifactDigest: reviewedDigest, parentArtifactDigest: draftDigest, reviewDiffDigest: "d".repeat(64), changedPathCount: 0 },
      { type: "canary_passed", at: "2026-08-20T12:02:00.000Z", actor: "canary_runner", artifactDigest: reviewedDigest, canaryRunId: "canary-1", evidenceDigest: "e".repeat(64) },
      { type: "approved", at: "2026-08-20T12:03:00.000Z", actor: "approver-1", artifactDigest: approvedDigest, parentArtifactDigest: reviewedDigest },
    ],
  };
}

describe("CapabilityCatalog", () => {
  it("loads validated V2 artifacts and returns immutable approved metadata", async () => {
    const directory = await scratchDirectory();
    await save(directory, "current.json", v2Artifact({ risk: "supervisor_only" }));

    const catalog = await CapabilityCatalog.load({ directories: [directory] });
    const metadata = catalog.list();

    expect(metadata.map((item) => `${item.id}@${item.version}`)).toEqual(["v2-capability@2.0.0"]);
    expect(metadata[0]).toMatchObject({
      schemaVersion: "2.0",
      approval: "approved",
      risk: "supervisor_only",
      digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      inputs: [expect.objectContaining({ name: "memberNumber" })],
      outputs: [expect.objectContaining({ name: "memberName" })],
    });
    expect(Object.isFrozen(metadata)).toBe(true);
    expect(Object.isFrozen(metadata[0])).toBe(true);
    expect(Object.isFrozen(metadata[0]!.inputs)).toBe(true);
    expect(Object.isFrozen(metadata[0]!.inputs[0])).toBe(true);
    expect(Object.isFrozen(catalog.resolve("v2-capability", "2.0.0")!.artifact)).toBe(true);
  });

  it("hides draft and retired capabilities by default and exposes them only via all visibility", async () => {
    const directory = await scratchDirectory();
    await save(directory, "approved.json", v2Artifact({ id: "approved", approval: "approved" }));
    await save(directory, "draft.json", v2Artifact({ id: "draft", approval: "draft" }));
    await save(directory, "retired.json", v2Artifact({ id: "retired", approval: "retired" }));

    const catalog = await CapabilityCatalog.load({ directories: [directory] });

    expect(catalog.list().map((item) => item.id)).toEqual(["approved"]);
    expect(catalog.get("draft", "2.0.0")).toBeUndefined();
    expect(catalog.resolve("retired", "2.0.0")).toBeUndefined();
    expect(catalog.list({ visibility: "all" }).map((item) => [item.id, item.approval])).toEqual([
      ["approved", "approved"],
      ["draft", "draft"],
      ["retired", "retired"],
    ]);
    expect(catalog.get("draft", "2.0.0", { visibility: "all" })?.approval).toBe("draft");
  });

  it("rejects duplicate capability id and version across configured directories", async () => {
    const first = await scratchDirectory();
    const second = await scratchDirectory();
    await save(first, "first.json", v2Artifact({ id: "duplicate", version: "3.1.4" }));
    await save(second, "second.json", v2Artifact({ id: "duplicate", version: "3.1.4" }));

    await expect(CapabilityCatalog.load({ directories: [first, second] })).rejects.toMatchObject({
      code: "DUPLICATE_CAPABILITY",
    });
  });

  it("rejects legacy capability contracts at the catalog boundary", async () => {
    const directory = await scratchDirectory();
    await save(directory, "legacy.json", {
      schemaVersion: "1.0",
      capability: {
        id: "legacy-capability",
        name: "Legacy capability",
        description: "An obsolete compatibility contract.",
        version: "1.0.0",
        approval: "approved",
      },
    });

    await expect(CapabilityCatalog.load({ directories: [directory] })).rejects.toMatchObject({
      code: "ARTIFACT_INVALID",
      message: expect.stringContaining("unsupported capability schema version"),
    });
  });

  it("uses canonical validated JSON for stable digests", async () => {
    const artifact = v2Artifact();
    const differentlyOrdered = {
      checkpoint: artifact.checkpoint,
      runtimeStates: artifact.runtimeStates,
      steps: artifact.steps,
      targets: artifact.targets,
      policy: artifact.policy,
      outputs: artifact.outputs,
      inputs: artifact.inputs,
      compatibility: artifact.compatibility,
      provenance: artifact.provenance,
      capability: artifact.capability,
      schemaVersion: artifact.schemaVersion,
    };

    expect(canonicalArtifactDigest(artifact)).toBe(
      canonicalArtifactDigest(CapabilityArtifactV2Schema.parse(differentlyOrdered)),
    );
  });

  it("validates approved discovery lineage and exposes only digest-safe metadata", async () => {
    const artifacts = await scratchDirectory();
    const lineages = await scratchDirectory();
    const artifact = discoveredApprovedArtifact();
    await save(artifacts, "discovered.json", artifact);
    await save(lineages, "discovered.lineage.json", approvedLineage(artifact));

    const catalog = await CapabilityCatalog.load({
      directories: [artifacts],
      lineageDirectories: [lineages],
      requireDiscoveryLineage: true,
    });
    expect(catalog.get(artifact.capability.id, artifact.capability.version)?.lineage).toEqual({
      lineageId: "lineage.discovered-v2",
      discoveryRunId: "catalog-discovery-run",
      provider: "anthropic-messages",
      model: "claude-sonnet-5",
      traceDigest: "c".repeat(64),
      draftDigest: "a".repeat(64),
      reviewedDigest: "b".repeat(64),
      approvedDigest: canonicalArtifactDigest(artifact),
      canaryRunId: "canary-1",
    });
  });

  it("rejects missing, test-double, and digest-mismatched discovery lineage", async () => {
    const artifacts = await scratchDirectory();
    const lineages = await scratchDirectory();
    const artifact = discoveredApprovedArtifact();
    await save(artifacts, "discovered.json", artifact);
    await expect(CapabilityCatalog.load({
      directories: [artifacts],
      lineageDirectories: [],
      requireDiscoveryLineage: true,
    })).rejects.toMatchObject({ code: "LINEAGE_MISSING" });

    await save(lineages, "test-double.json", approvedLineage(artifact, "test_double"));
    await expect(CapabilityCatalog.load({
      directories: [artifacts],
      lineageDirectories: [lineages],
    })).rejects.toMatchObject({ code: "LINEAGE_INVALID" });

    await rm(lineages, { recursive: true, force: true });
    const replacement = await scratchDirectory();
    const mismatch = approvedLineage(artifact) as { approvedDigest: string; events: Array<Record<string, unknown>> };
    mismatch.approvedDigest = "f".repeat(64);
    mismatch.events[3]!.artifactDigest = mismatch.approvedDigest;
    await save(replacement, "mismatch.json", mismatch);
    await expect(CapabilityCatalog.load({
      directories: [artifacts],
      lineageDirectories: [replacement],
    })).rejects.toMatchObject({ code: "LINEAGE_INVALID" });
  });

  it("rejects invalid artifacts and configured file paths without exposing a path lookup API", async () => {
    const directory = await scratchDirectory();
    const invalidPath = path.join(directory, "invalid.json");
    await writeFile(invalidPath, '{"schemaVersion":"9.0"}\n', "utf8");

    await expect(CapabilityCatalog.load({ directories: [directory] })).rejects.toBeInstanceOf(
      CapabilityCatalogError,
    );
    await expect(CapabilityCatalog.load({ directories: [invalidPath] })).rejects.toMatchObject({
      code: "DIRECTORY_INVALID",
    });
    expect("loadPath" in CapabilityCatalog.prototype).toBe(false);
  });
});
