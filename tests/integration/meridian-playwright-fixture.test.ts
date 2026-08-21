import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalAuthority, type ApprovalActor } from "../../src/approval/index.js";
import {
  meridianOpenShareArtifact,
  meridianPlaceHoldArtifact,
  meridianRecordAndBalancesArtifact,
  meridianSignOnArtifact,
  meridianTransferArtifact,
  meridianUpdateMemberArtifact,
} from "../../src/capabilities/index.js";
import { canonicalArtifactDigest } from "../../src/catalog/index.js";
import { startMeridianFixture, type MeridianFixtureServer } from "../fixtures/meridianFixture.js";
import type { CapabilityArtifactV2 } from "../../src/domain/index.js";
import {
  bindArtifactToTargetProfile,
  TargetInstanceProfileV2Schema,
} from "../../src/profiles/targetProfileV2.js";
import { createMeridianSurfaceOptions } from "../../src/profiles/meridianCore.js";
import { ReplayRunnerV2 } from "../../src/replay/replayRunnerV2.js";
import type { RuntimeValue } from "../../src/surface/replayRuntimeV2.js";
import { PlaywrightSurface } from "../../src/surface/playwright/playwrightSurface.js";
import { PlaywrightReplayRuntimeV2 } from "../../src/surface/playwright/runtimeV2.js";

function materialize(artifact: CapabilityArtifactV2, origin: string) {
  return bindArtifactToTargetProfile(
    artifact,
    canonicalArtifactDigest(artifact),
    TargetInstanceProfileV2Schema.parse({
      schemaVersion: "1.0",
      id: "fixture",
      vendorProduct: artifact.compatibility.vendorProduct,
      surfaceAdapter: artifact.compatibility.surfaceAdapter,
      appVersion: artifact.compatibility.appVersion,
      origin,
      createdAt: "2026-08-20T18:00:00.000Z",
    }),
  );
}

async function signOn(
  surface: PlaywrightSurface,
  origin: string,
  authority: ApprovalAuthority,
  operator: "teller1" | "super1",
): Promise<void> {
  const binding = materialize(meridianSignOnArtifact, origin);
  const result = await new ReplayRunnerV2({
    artifact: binding.artifact,
    artifactDigest: binding.baseArtifactDigest,
    targetProfileDigest: binding.targetProfileDigest,
    inputs: { operator, password: "password", branch: "MAIN-001" },
    runtime: new PlaywrightReplayRuntimeV2(surface, binding.artifact),
    approvalAuthority: authority,
  }).run();
  if (result.status !== "terminal" || result.result.status !== "success") {
    throw new Error(`Fixture sign-on failed: ${JSON.stringify(result)}`);
  }
}

async function runApprovedWrite(
  surface: PlaywrightSurface,
  origin: string,
  authority: ApprovalAuthority,
  artifact: CapabilityArtifactV2,
  inputs: Readonly<Record<string, RuntimeValue>>,
  actor: ApprovalActor,
  currentPrincipalRole: "teller" | "supervisor",
) {
  const binding = materialize(artifact, origin);
  const runner = new ReplayRunnerV2({
    artifact: binding.artifact,
    artifactDigest: binding.baseArtifactDigest,
    targetProfileDigest: binding.targetProfileDigest,
    inputs,
    runtime: new PlaywrightReplayRuntimeV2(surface, binding.artifact),
    approvalAuthority: authority,
    currentPrincipalRole: () => currentPrincipalRole,
  });
  const paused = await runner.run();
  if (paused.status !== "awaiting_approval") {
    throw new Error(`Expected approval-bound write: ${JSON.stringify(paused)}`);
  }
  const completed = await runner.resume(runner.issueApproval(actor));
  return { binding, completed, paused };
}

describe("MERIDIAN artifacts in the real Playwright runtime", () => {
  let fixture: MeridianFixtureServer | undefined;
  let surface: PlaywrightSurface | undefined;
  let scratch: string | undefined;

  afterEach(async () => {
    await surface?.close();
    await fixture?.close();
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it("signs on and resolves the exact member row among duplicate Select links", async () => {
    fixture = await startMeridianFixture();
    scratch = await mkdtemp(path.join(tmpdir(), "meridian-browser-fixture-"));
    const signOnBinding = materialize(meridianSignOnArtifact, fixture.baseUrl);
    const signOn = signOnBinding.artifact;
    surface = new PlaywrightSurface(createMeridianSurfaceOptions(scratch, {
      origin: fixture.baseUrl,
      headless: true,
    }));
    await surface.start(signOn.compatibility.entryPoint);
    const approvalAuthority = new ApprovalAuthority({ secret: Buffer.alloc(32, 19) });
    const signOnResult = await new ReplayRunnerV2({
      artifact: signOn,
      artifactDigest: signOnBinding.baseArtifactDigest,
      targetProfileDigest: signOnBinding.targetProfileDigest,
      inputs: { operator: "teller1", password: "password", branch: "MAIN-001" },
      runtime: new PlaywrightReplayRuntimeV2(surface, signOn),
      approvalAuthority,
    }).run();
    expect(signOnResult).toMatchObject({ status: "terminal", result: { status: "success" } });

    const balancesBinding = materialize(meridianRecordAndBalancesArtifact, fixture.baseUrl);
    const balances = balancesBinding.artifact;
    const result = await new ReplayRunnerV2({
      artifact: balances,
      artifactDigest: balancesBinding.baseArtifactDigest,
      targetProfileDigest: balancesBinding.targetProfileDigest,
      inputs: { member_number: "100234" },
      runtime: new PlaywrightReplayRuntimeV2(surface, balances),
      approvalAuthority,
    }).run();

    expect(result, JSON.stringify(result, null, 2)).toMatchObject({
      status: "terminal",
      result: {
        status: "success",
        artifactDigest: balancesBinding.baseArtifactDigest,
        targetProfileDigest: balancesBinding.targetProfileDigest,
        outputs: {
          member_number: "100234",
          shares: [
            { share_id: "100234-S0001", balance: { currency: "USD", minorUnits: 25_000 } },
            { share_id: "100234-S0070", balance: { currency: "USD", minorUnits: 15_000 } },
          ],
        },
      },
    });
  });

  it("posts a transfer and extracts the exact receipt plus dynamic resulting balances", async () => {
    fixture = await startMeridianFixture();
    scratch = await mkdtemp(path.join(tmpdir(), "meridian-transfer-fixture-"));
    surface = new PlaywrightSurface(createMeridianSurfaceOptions(scratch, {
      origin: fixture.baseUrl,
      headless: true,
    }));
    await surface.start(new URL("/signon", fixture.baseUrl).toString());
    const authority = new ApprovalAuthority({ secret: Buffer.alloc(32, 23) });
    await signOn(surface, fixture.baseUrl, authority, "teller1");

    const inputs = {
      member_number: "100234",
      from_share: "100234-S0001",
      to_share: "100234-S0070",
      amount: { currency: "USD", amount: "5.00", minorUnits: 500 },
      memo: "Fixture verification",
    };
    const { binding, completed, paused } = await runApprovedWrite(
      surface,
      fixture.baseUrl,
      authority,
      meridianTransferArtifact,
      inputs,
      { id: "fixture-teller", roles: ["teller"] },
      "teller",
    );

    expect(paused.challenge.summary).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetId: "review_from", value: inputs.from_share }),
      expect.objectContaining({ targetId: "review_to", value: inputs.to_share }),
      expect.objectContaining({ targetId: "review_amount", value: "5.00" }),
    ]));
    expect(completed, JSON.stringify(completed, null, 2)).toMatchObject({
      status: "terminal",
      result: {
        status: "success",
        artifactDigest: binding.baseArtifactDigest,
        targetProfileDigest: binding.targetProfileDigest,
        outputs: {
          confirmation: expect.stringMatching(/^TR-[A-F0-9]+$/u),
          posted_at: expect.any(String),
          amount: { currency: "USD", amount: "5.00", minorUnits: 500 },
          source_balance: { currency: "USD", amount: "245.00", minorUnits: 24_500 },
          destination_balance: { currency: "USD", amount: "155.00", minorUnits: 15_500 },
        },
      },
    });
    const snapshot = fixture.snapshot();
    expect(snapshot.commits).toHaveLength(1);
    expect(snapshot.commits[0]).toMatchObject({ kind: "transfer", memberNumber: "100234" });
    const shares = snapshot.members.find((member) => member.number === "100234")?.shares;
    expect(shares?.find((share) => share.id === inputs.from_share)?.balanceMinor).toBe(24_500);
    expect(shares?.find((share) => share.id === inputs.to_share)?.balanceMinor).toBe(15_500);
  });

  it("opens a share and returns the assigned ID, type, and opening balance", async () => {
    fixture = await startMeridianFixture();
    scratch = await mkdtemp(path.join(tmpdir(), "meridian-open-share-fixture-"));
    surface = new PlaywrightSurface(createMeridianSurfaceOptions(scratch, {
      origin: fixture.baseUrl,
      headless: true,
    }));
    await surface.start(new URL("/signon", fixture.baseUrl).toString());
    const authority = new ApprovalAuthority({ secret: Buffer.alloc(32, 29) });
    await signOn(surface, fixture.baseUrl, authority, "teller1");

    const { binding, completed } = await runApprovedWrite(
      surface,
      fixture.baseUrl,
      authority,
      meridianOpenShareArtifact,
      {
        member_number: "100234",
        share_type: "S0001",
        initial_deposit: { currency: "USD", amount: "25.00", minorUnits: 2_500 },
      },
      { id: "fixture-teller", roles: ["teller"] },
      "teller",
    );

    expect(completed, JSON.stringify(completed, null, 2)).toMatchObject({
      status: "terminal",
      result: {
        status: "success",
        artifactDigest: binding.baseArtifactDigest,
        targetProfileDigest: binding.targetProfileDigest,
        outputs: {
          confirmation: expect.stringMatching(/^NS-[A-F0-9]+$/u),
          new_share_id: "100234-S0001-0003",
          share_type: "Regular Shares",
          opening_balance: { currency: "USD", amount: "25.00", minorUnits: 2_500 },
        },
      },
    });
    const snapshot = fixture.snapshot();
    expect(snapshot.commits[0]).toMatchObject({ kind: "open_share", memberNumber: "100234" });
    expect(snapshot.members.find((member) => member.number === "100234")?.shares).toContainEqual({
      id: "100234-S0001-0003",
      type: "S0001",
      balanceMinor: 2_500,
      status: "OPEN",
    });
  });

  it("updates member information through the receipt page and verifies the saved record", async () => {
    fixture = await startMeridianFixture();
    scratch = await mkdtemp(path.join(tmpdir(), "meridian-update-fixture-"));
    surface = new PlaywrightSurface(createMeridianSurfaceOptions(scratch, {
      origin: fixture.baseUrl,
      headless: true,
    }));
    await surface.start(new URL("/signon", fixture.baseUrl).toString());
    const authority = new ApprovalAuthority({ secret: Buffer.alloc(32, 30) });
    await signOn(surface, fixture.baseUrl, authority, "teller1");

    const inputs = {
      member_number: "100234",
      email: "alex.updated@example.test",
      phone: "+1 (206) 555-0177",
      address: "77 Updated Avenue",
    };
    const { binding, completed, paused } = await runApprovedWrite(
      surface,
      fixture.baseUrl,
      authority,
      meridianUpdateMemberArtifact,
      inputs,
      { id: "fixture-teller", roles: ["teller"] },
      "teller",
    );

    expect(paused.challenge.summary).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetId: "email", value: inputs.email }),
      expect.objectContaining({ targetId: "phone", value: inputs.phone }),
      expect.objectContaining({ targetId: "address", value: inputs.address }),
    ]));
    expect(completed, JSON.stringify(completed, null, 2)).toMatchObject({
      status: "terminal",
      result: {
        status: "success",
        artifactDigest: binding.baseArtifactDigest,
        targetProfileDigest: binding.targetProfileDigest,
        outputs: {
          email_before: "alex.smith@example.test",
          phone_before: "+1 (206) 555-0142",
          address_before: "10 Main Street",
          email: inputs.email,
          phone: inputs.phone,
          address: inputs.address,
        },
      },
    });
    const snapshot = fixture.snapshot();
    expect(snapshot.commits).toHaveLength(1);
    expect(snapshot.commits[0]).toMatchObject({ kind: "update_member", memberNumber: "100234" });
    expect(snapshot.members.find((member) => member.number === "100234")).toMatchObject({
      email: inputs.email,
      phone: inputs.phone,
      address: inputs.address,
    });
  });

  it("applies a supervisor hold and extracts its exact applied-state receipt", async () => {
    fixture = await startMeridianFixture();
    scratch = await mkdtemp(path.join(tmpdir(), "meridian-hold-fixture-"));
    surface = new PlaywrightSurface(createMeridianSurfaceOptions(scratch, {
      origin: fixture.baseUrl,
      headless: true,
    }));
    await surface.start(new URL("/signon", fixture.baseUrl).toString());
    const authority = new ApprovalAuthority({ secret: Buffer.alloc(32, 31) });
    await signOn(surface, fixture.baseUrl, authority, "super1");

    const { binding, completed } = await runApprovedWrite(
      surface,
      fixture.baseUrl,
      authority,
      meridianPlaceHoldArtifact,
      {
        member_number: "100234",
        share: "100234-S0001",
        reason: "FRAUD",
        notes: "Fixture verification",
      },
      { id: "fixture-supervisor", roles: ["supervisor"] },
      "supervisor",
    );

    expect(completed, JSON.stringify(completed, null, 2)).toMatchObject({
      status: "terminal",
      result: {
        status: "success",
        artifactDigest: binding.baseArtifactDigest,
        targetProfileDigest: binding.targetProfileDigest,
        outputs: {
          confirmation: expect.stringMatching(/^HD-[A-F0-9]+$/u),
          share_status: "100234-S0001 is now HOLD",
          applied_at: expect.any(String),
        },
      },
    });
    const snapshot = fixture.snapshot();
    expect(snapshot.commits[0]).toMatchObject({ kind: "place_hold", memberNumber: "100234" });
    expect(snapshot.members.find((member) => member.number === "100234")?.shares[0]?.status).toBe("HOLD");
  });
});
