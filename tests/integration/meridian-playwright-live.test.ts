import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalAuthority, type ApprovalActor } from "../../src/approval/index.js";
import {
  meridianOpenShareArtifact,
  meridianPlaceHoldArtifact,
  meridianSignOnArtifact,
  meridianTransferArtifact,
} from "../../src/capabilities/index.js";
import { canonicalArtifactDigest } from "../../src/catalog/index.js";
import type { CapabilityArtifactV2 } from "../../src/domain/index.js";
import {
  bindArtifactToTargetProfile,
  TargetInstanceProfileV2Schema,
} from "../../src/profiles/targetProfileV2.js";
import { createMeridianSurfaceOptions } from "../../src/profiles/meridianCore.js";
import { ReplayRunnerV2 } from "../../src/replay/replayRunnerV2.js";
import { PlaywrightSurface } from "../../src/surface/playwright/playwrightSurface.js";
import { PlaywrightReplayRuntimeV2 } from "../../src/surface/playwright/runtimeV2.js";
import type { RuntimeValue } from "../../src/surface/replayRuntimeV2.js";

const REQUIRED_LIVE_ENV = [
  "MERIDIAN_LIVE_ORIGIN",
  "MERIDIAN_LIVE_TELLER_ID",
  "MERIDIAN_LIVE_TELLER_PASSWORD",
  "MERIDIAN_LIVE_SUPERVISOR_ID",
  "MERIDIAN_LIVE_SUPERVISOR_PASSWORD",
  "MERIDIAN_LIVE_BRANCH",
  "MERIDIAN_LIVE_MEMBER_NUMBER",
  "MERIDIAN_LIVE_FROM_SHARE",
  "MERIDIAN_LIVE_TO_SHARE",
] as const;

const liveWriteEnabled = process.env.MERIDIAN_LIVE_WRITE === "1" &&
  REQUIRED_LIVE_ENV.every((name) => Boolean(process.env[name]?.trim()));
const liveWrite = liveWriteEnabled ? it : it.skip;

function requiredEnv(name: (typeof REQUIRED_LIVE_ENV)[number]): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the gated live MERIDIAN test`);
  return value;
}

function bind(artifact: CapabilityArtifactV2, origin: string) {
  return bindArtifactToTargetProfile(
    artifact,
    canonicalArtifactDigest(artifact),
    TargetInstanceProfileV2Schema.parse({
      schemaVersion: "1.0",
      id: "live-integration",
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
  operator: string,
  password: string,
  branch: string,
): Promise<void> {
  const binding = bind(meridianSignOnArtifact, origin);
  const progress = await new ReplayRunnerV2({
    artifact: binding.artifact,
    artifactDigest: binding.baseArtifactDigest,
    targetProfileDigest: binding.targetProfileDigest,
    inputs: { operator, password, branch },
    runtime: new PlaywrightReplayRuntimeV2(surface, binding.artifact),
    approvalAuthority: authority,
  }).run();
  if (progress.status !== "terminal" || progress.result.status !== "success") {
    throw new Error("Live MERIDIAN sign-on did not reach its reviewed success checkpoint");
  }
}

async function runApprovedWrite(
  surface: PlaywrightSurface,
  origin: string,
  authority: ApprovalAuthority,
  artifact: CapabilityArtifactV2,
  inputs: Readonly<Record<string, RuntimeValue>>,
  actor: ApprovalActor,
  principalRole: "teller" | "supervisor",
) {
  const binding = bind(artifact, origin);
  const runner = new ReplayRunnerV2({
    artifact: binding.artifact,
    artifactDigest: binding.baseArtifactDigest,
    targetProfileDigest: binding.targetProfileDigest,
    inputs,
    runtime: new PlaywrightReplayRuntimeV2(surface, binding.artifact),
    approvalAuthority: authority,
    currentPrincipalRole: () => principalRole,
  });
  const paused = await runner.run();
  if (paused.status !== "awaiting_approval") {
    const detail = paused.status === "terminal"
      ? {
          status: paused.result.status,
          ...(paused.result.status === "failure"
            ? { code: paused.result.code, message: paused.result.message, stepId: paused.result.stepId }
            : paused.result.status === "business_outcome" || paused.result.status === "escalation"
              ? { code: paused.result.code, message: paused.result.message }
              : {}),
          title: await surface.page.title(),
          lastStep: paused.result.journal.at(-1)?.stepId,
        }
      : { status: paused.status };
    throw new Error(`Live MERIDIAN write did not stop at its approval boundary: ${JSON.stringify(detail)}`);
  }
  const completed = await runner.resume(runner.issueApproval(actor));
  if (completed.status !== "terminal" || completed.result.status !== "success") {
    const lastJournal = completed.status === "terminal" ? completed.result.journal.at(-1) : undefined;
    const detail = completed.status === "terminal"
      ? {
          status: completed.result.status,
          ...(completed.result.status === "failure"
            ? { code: completed.result.code, message: completed.result.message, stepId: completed.result.stepId }
            : completed.result.status === "business_outcome" || completed.result.status === "escalation"
              ? { code: completed.result.code, message: completed.result.message }
              : {}),
          title: await surface.page.title(),
          ...(lastJournal
            ? { journal: { stepId: lastJournal.stepId, status: lastJournal.status } }
            : {}),
        }
      : { status: completed.status };
    throw new Error(`Live MERIDIAN write did not satisfy its exact receipt contract: ${JSON.stringify(detail)}`);
  }
  expect(completed.result).toMatchObject({
    artifactDigest: binding.baseArtifactDigest,
    targetProfileDigest: binding.targetProfileDigest,
  });
  return completed.result.outputs;
}

describe("MERIDIAN production Playwright contracts against the configured live target", () => {
  const surfaces: PlaywrightSurface[] = [];
  let scratch: string | undefined;

  afterEach(async () => {
    await Promise.allSettled(surfaces.splice(0).map((surface) => surface.close()));
    if (scratch) await rm(scratch, { recursive: true, force: true });
    scratch = undefined;
  });

  liveWrite("extracts real transfer, new-share, and supervisor-hold receipts", async () => {
    const origin = new URL(requiredEnv("MERIDIAN_LIVE_ORIGIN")).origin;
    const branch = requiredEnv("MERIDIAN_LIVE_BRANCH");
    const memberNumber = requiredEnv("MERIDIAN_LIVE_MEMBER_NUMBER");
    scratch = await mkdtemp(path.join(tmpdir(), "meridian-live-contract-"));
    const authority = new ApprovalAuthority({ secret: Buffer.alloc(32, 37) });

    const tellerSurface = new PlaywrightSurface(createMeridianSurfaceOptions(path.join(scratch, "teller"), {
      origin,
      headless: true,
    }));
    surfaces.push(tellerSurface);
    await tellerSurface.start(new URL("/signon", origin).toString());
    await signOn(
      tellerSurface,
      origin,
      authority,
      requiredEnv("MERIDIAN_LIVE_TELLER_ID"),
      requiredEnv("MERIDIAN_LIVE_TELLER_PASSWORD"),
      branch,
    );

    const transfer = await runApprovedWrite(
      tellerSurface,
      origin,
      authority,
      meridianTransferArtifact,
      {
        member_number: memberNumber,
        from_share: requiredEnv("MERIDIAN_LIVE_FROM_SHARE"),
        to_share: requiredEnv("MERIDIAN_LIVE_TO_SHARE"),
        amount: { currency: "USD", amount: "1.00", minorUnits: 100 },
        memo: "Automated contract verification",
      },
      { id: "live-teller", roles: ["teller"] },
      "teller",
    );
    expect(transfer).toMatchObject({
      confirmation: expect.any(String),
      posted_at: expect.any(String),
      amount: { currency: "USD", amount: "1.00", minorUnits: 100 },
      source_balance: { currency: "USD", minorUnits: expect.any(Number) },
      destination_balance: { currency: "USD", minorUnits: expect.any(Number) },
    });

    const opened = await runApprovedWrite(
      tellerSurface,
      origin,
      authority,
      meridianOpenShareArtifact,
      {
        member_number: memberNumber,
        share_type: "S0001",
        initial_deposit: { currency: "USD", amount: "5.00", minorUnits: 500 },
      },
      { id: "live-teller", roles: ["teller"] },
      "teller",
    );
    expect(opened).toMatchObject({
      confirmation: expect.any(String),
      new_share_id: expect.any(String),
      share_type: "Regular Shares",
      opening_balance: { currency: "USD", amount: "5.00", minorUnits: 500 },
    });
    if (typeof opened.new_share_id !== "string") {
      throw new Error("Live new-share receipt omitted its stable share ID");
    }

    const supervisorSurface = new PlaywrightSurface(createMeridianSurfaceOptions(path.join(scratch, "supervisor"), {
      origin,
      headless: true,
    }));
    surfaces.push(supervisorSurface);
    await supervisorSurface.start(new URL("/signon", origin).toString());
    await signOn(
      supervisorSurface,
      origin,
      authority,
      requiredEnv("MERIDIAN_LIVE_SUPERVISOR_ID"),
      requiredEnv("MERIDIAN_LIVE_SUPERVISOR_PASSWORD"),
      branch,
    );
    const held = await runApprovedWrite(
      supervisorSurface,
      origin,
      authority,
      meridianPlaceHoldArtifact,
      {
        member_number: memberNumber,
        share: opened.new_share_id,
        reason: "FRAUD",
        notes: "Automated contract verification",
      },
      { id: "live-supervisor", roles: ["supervisor"] },
      "supervisor",
    );
    expect(held).toMatchObject({
      confirmation: expect.any(String),
      share_status: `${opened.new_share_id} is now HOLD`,
      applied_at: expect.any(String),
    });
  }, 180_000);
});
