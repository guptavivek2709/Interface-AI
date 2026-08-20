import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CapabilityCatalog,
  CapabilityCatalogError,
  canonicalArtifactDigest,
} from "../../src/catalog/index.js";
import {
  CapabilityArtifactSchema,
  CapabilityArtifactV2Schema,
  type CapabilityArtifact,
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

async function v1Artifact(options: {
  id?: string;
  version?: string;
  approval?: "draft" | "approved" | "retired";
} = {}): Promise<CapabilityArtifact> {
  const checked = JSON.parse(await readFile(path.resolve("evidence/artifact.json"), "utf8")) as unknown;
  const artifact = CapabilityArtifactSchema.parse(checked);
  artifact.capability.id = options.id ?? "v1-capability";
  artifact.capability.name = `Capability ${artifact.capability.id}`;
  artifact.capability.version = options.version ?? "1.0.0";
  artifact.capability.approval = options.approval ?? "approved";
  return artifact;
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

describe("CapabilityCatalog", () => {
  it("loads validated V1 and V2 artifacts and returns immutable approved metadata", async () => {
    const directory = await scratchDirectory();
    await save(directory, "legacy.json", await v1Artifact());
    await save(directory, "current.json", v2Artifact({ risk: "supervisor_only" }));

    const catalog = await CapabilityCatalog.load({ directories: [directory] });
    const metadata = catalog.list();

    expect(metadata.map((item) => `${item.id}@${item.version}`)).toEqual([
      "v1-capability@1.0.0",
      "v2-capability@2.0.0",
    ]);
    expect(metadata[0]).toMatchObject({
      schemaVersion: "1.0",
      approval: "approved",
      risk: "write",
      digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(metadata[1]).toMatchObject({
      schemaVersion: "2.0",
      risk: "supervisor_only",
      inputs: [expect.objectContaining({ name: "memberNumber" })],
      outputs: [expect.objectContaining({ name: "memberName" })],
    });
    expect(Object.isFrozen(metadata)).toBe(true);
    expect(Object.isFrozen(metadata[1])).toBe(true);
    expect(Object.isFrozen(metadata[1]!.inputs)).toBe(true);
    expect(Object.isFrozen(metadata[1]!.inputs[0])).toBe(true);
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
