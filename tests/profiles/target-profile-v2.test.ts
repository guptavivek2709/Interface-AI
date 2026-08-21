import { describe, expect, it } from "vitest";
import { meridianTransferArtifact } from "../../src/capabilities/index.js";
import { canonicalArtifactDigest } from "../../src/catalog/index.js";
import {
  bindArtifactToTargetProfile,
  targetExecutionDigest,
  targetProfileDigest,
  TargetInstanceProfileV2Schema,
} from "../../src/profiles/targetProfileV2.js";

const profile = (origin: string) => TargetInstanceProfileV2Schema.parse({
  schemaVersion: "1.0",
  id: "meridian.training",
  vendorProduct: "Meridian Core",
  surfaceAdapter: "playwright-web-meridian-v2",
  origin,
  appVersion: "4.2.1",
  createdAt: "2026-08-20T18:00:00.000Z",
});

describe("target instance profiles", () => {
  it("materializes only deployment origins without changing the approved base artifact", () => {
    const before = structuredClone(meridianTransferArtifact);
    const baseArtifactDigest = canonicalArtifactDigest(meridianTransferArtifact);
    const bound = bindArtifactToTargetProfile(
      meridianTransferArtifact,
      baseArtifactDigest,
      profile("https://tenant-a.example"),
    );

    expect(meridianTransferArtifact).toEqual(before);
    expect(bound.baseArtifactDigest).toBe(baseArtifactDigest);
    expect(bound.artifact.compatibility.entryPoint).toBe("https://tenant-a.example/signon");
    expect(bound.artifact.policy.routes.every((route) => route.origin === "https://tenant-a.example")).toBe(true);
    expect(bound.artifact.targets).toEqual(meridianTransferArtifact.targets);
    expect(bound.artifact.steps).toEqual(meridianTransferArtifact.steps);
  });

  it("binds identical vendor capabilities to distinct target profile digests", () => {
    const first = profile("https://tenant-a.example");
    const second = profile("https://tenant-b.example");
    expect(targetProfileDigest(first)).not.toBe(targetProfileDigest(second));
    expect(targetExecutionDigest({
      baseArtifactDigest: "a".repeat(64),
      targetProfileDigest: targetProfileDigest(first),
    })).not.toBe(targetExecutionDigest({
      baseArtifactDigest: "a".repeat(64),
      targetProfileDigest: targetProfileDigest(second),
    }));
  });

  it("rejects secrets, paths, and incompatible profiles", () => {
    expect(TargetInstanceProfileV2Schema.safeParse({
      ...profile("https://tenant-a.example"),
      password: "must-not-be-representable",
    }).success).toBe(false);
    expect(TargetInstanceProfileV2Schema.safeParse({
      ...profile("https://tenant-a.example"),
      origin: "https://tenant-a.example/meridian",
    }).success).toBe(false);
    expect(() => bindArtifactToTargetProfile(
      meridianTransferArtifact,
      canonicalArtifactDigest(meridianTransferArtifact),
      { ...profile("https://tenant-a.example"), vendorProduct: "Other Core" },
    )).toThrow(/incompatible/u);
  });
});
