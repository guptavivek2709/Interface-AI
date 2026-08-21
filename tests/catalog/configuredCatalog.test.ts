import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { meridianSignOnArtifact } from "../../src/capabilities/index.js";
import { canonicalArtifactDigest } from "../../src/catalog/capabilityCatalog.js";
import { loadConfiguredCapabilityCatalog } from "../../src/catalog/configuredCatalog.js";
import { CapabilityArtifactV2Schema } from "../../src/domain/index.js";

const PUBLISHED_ARTIFACT = path.resolve(
  "catalog",
  "meridian-v2",
  "artifacts",
  "session.sign_on@2.0.0.json",
);
const PUBLISHED_LINEAGE = path.resolve(
  "catalog",
  "meridian-v2",
  "lineage",
  "session.sign_on@2.0.0.lineage.json",
);

describe("configured production capability catalog", () => {
  let scratch: string | undefined;

  afterEach(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  async function roots() {
    scratch = await mkdtemp(path.join(tmpdir(), "configured-catalog-"));
    const artifactRoot = path.join(scratch, "artifacts");
    const lineageRoot = path.join(scratch, "lineage");
    await mkdir(artifactRoot);
    await mkdir(lineageRoot);
    return { artifactRoot, lineageRoot };
  }

  it("requires artifact and lineage roots to be separate", async () => {
    scratch = await mkdtemp(path.join(tmpdir(), "configured-catalog-roots-"));
    await expect(
      loadConfiguredCapabilityCatalog({
        environment: {
          CAPABILITY_ARTIFACT_ROOT: scratch,
          CAPABILITY_LINEAGE_ROOT: scratch,
        },
        requiredCapabilityIds: ["session.sign_on"],
      }),
    ).rejects.toMatchObject({ code: "CATALOG_ROOTS_NOT_SEPARATE" });
  });

  it("loads an approved discovery artifact with its exact external lineage", async () => {
    const { artifactRoot, lineageRoot } = await roots();
    await writeFile(
      path.join(artifactRoot, "session.sign_on@2.0.0.json"),
      await readFile(PUBLISHED_ARTIFACT),
    );
    await writeFile(
      path.join(lineageRoot, "session.sign_on@2.0.0.lineage.json"),
      await readFile(PUBLISHED_LINEAGE),
    );

    const catalog = await loadConfiguredCapabilityCatalog({
      environment: {
        CAPABILITY_ARTIFACT_ROOT: artifactRoot,
        CAPABILITY_LINEAGE_ROOT: lineageRoot,
      },
      requiredCapabilityIds: ["session.sign_on"],
    });
    expect(catalog.list()).toEqual([
      expect.objectContaining({
        id: "session.sign_on",
        approval: "approved",
        lineage: expect.objectContaining({
          provider: "anthropic-messages",
          model: "claude-sonnet-5",
          approvedDigest: expect.any(String),
        }),
      }),
    ]);
  });

  it("rejects an otherwise valid published catalog from a non-Anthropic discovery provider", async () => {
    const { artifactRoot, lineageRoot } = await roots();
    const artifactJson = JSON.parse(await readFile(PUBLISHED_ARTIFACT, "utf8")) as Record<string, any>;
    artifactJson.provenance.planner.provider = "other-model-service";
    const artifact = CapabilityArtifactV2Schema.parse(artifactJson);
    const approvedDigest = canonicalArtifactDigest(artifact);
    const lineage = JSON.parse(await readFile(PUBLISHED_LINEAGE, "utf8")) as Record<string, any>;
    lineage.discovery.provider = "other-model-service";
    lineage.approvedDigest = approvedDigest;
    const approvedEvent = lineage.events.find((event: Record<string, unknown>) => event.type === "approved");
    approvedEvent.artifactDigest = approvedDigest;
    await writeFile(
      path.join(artifactRoot, "session.sign_on@2.0.0.json"),
      `${JSON.stringify(artifact, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      path.join(lineageRoot, "session.sign_on@2.0.0.lineage.json"),
      `${JSON.stringify(lineage, null, 2)}\n`,
      "utf8",
    );

    await expect(
      loadConfiguredCapabilityCatalog({
        environment: {
          CAPABILITY_ARTIFACT_ROOT: artifactRoot,
          CAPABILITY_LINEAGE_ROOT: lineageRoot,
        },
        requiredCapabilityIds: ["session.sign_on"],
      }),
    ).rejects.toMatchObject({ code: "CATALOG_CONTENT_INVALID" });
  });

  it("rejects approved discovery artifacts without exact lineage", async () => {
    const { artifactRoot, lineageRoot } = await roots();
    await writeFile(
      path.join(artifactRoot, "session.sign_on@2.0.0.json"),
      await readFile(PUBLISHED_ARTIFACT),
    );

    await expect(
      loadConfiguredCapabilityCatalog({
        environment: {
          CAPABILITY_ARTIFACT_ROOT: artifactRoot,
          CAPABILITY_LINEAGE_ROOT: lineageRoot,
        },
        requiredCapabilityIds: ["session.sign_on"],
      }),
    ).rejects.toMatchObject({ code: "LINEAGE_MISSING" });
  });

  it("rejects authored artifacts from the application runtime", async () => {
    const { artifactRoot, lineageRoot } = await roots();
    await writeFile(
      path.join(artifactRoot, "session.sign_on@2.0.0.json"),
      `${JSON.stringify(meridianSignOnArtifact, null, 2)}\n`,
      "utf8",
    );

    await expect(
      loadConfiguredCapabilityCatalog({
        environment: {
          CAPABILITY_ARTIFACT_ROOT: artifactRoot,
          CAPABILITY_LINEAGE_ROOT: lineageRoot,
        },
        requiredCapabilityIds: ["session.sign_on"],
      }),
    ).rejects.toMatchObject({ code: "CATALOG_CONTENT_INVALID" });
  });
});
