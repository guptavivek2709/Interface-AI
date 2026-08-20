import path from "node:path";
import { ApprovalAuthority } from "../src/approval/index.js";
import {
  meridianRecordAndBalancesArtifact,
  meridianSignOnArtifact,
} from "../src/capabilities/index.js";
import { ReplayRunnerV2 } from "../src/replay/replayRunnerV2.js";
import { createMeridianSurfaceOptions, meridianEntryPoint } from "../src/profiles/index.js";
import { PlaywrightSurface } from "../src/surface/playwright/playwrightSurface.js";
import { PlaywrightReplayRuntimeV2 } from "../src/surface/playwright/runtimeV2.js";

const operator = process.env.MERIDIAN_OPERATOR?.trim();
const password = process.env.MERIDIAN_PASSWORD;
const branch = process.env.MERIDIAN_BRANCH?.trim() || "MAIN-001";
const memberNumber = process.env.MERIDIAN_MEMBER_NUMBER?.trim() || "100234";
const expectedStatus = process.env.MERIDIAN_EXPECTED_STATUS?.trim() || "success";

if (expectedStatus !== "success" && expectedStatus !== "business_outcome") {
  throw new Error("MERIDIAN_EXPECTED_STATUS must be success or business_outcome");
}

if (!operator || !password) {
  throw new Error("MERIDIAN_OPERATOR and MERIDIAN_PASSWORD are required for the read-only live smoke test");
}

const observationDirectory = path.resolve("evidence", "generated", "meridian-readonly-smoke");
const surface = new PlaywrightSurface(createMeridianSurfaceOptions(observationDirectory));
const authority = new ApprovalAuthority();

try {
  await surface.start(meridianEntryPoint());
  const signOn = new ReplayRunnerV2({
    artifact: meridianSignOnArtifact,
    inputs: { operator, password, branch },
    runtime: new PlaywrightReplayRuntimeV2(surface, meridianSignOnArtifact),
    approvalAuthority: authority,
  });
  const signedIn = await signOn.run();
  if (signedIn.status !== "terminal" || signedIn.result.status !== "success") {
    throw new Error(`Sign-on smoke failed: ${JSON.stringify(signedIn)}`);
  }

  const balance = new ReplayRunnerV2({
    artifact: meridianRecordAndBalancesArtifact,
    inputs: { member_number: memberNumber },
    runtime: new PlaywrightReplayRuntimeV2(surface, meridianRecordAndBalancesArtifact),
    approvalAuthority: authority,
  });
  const result = await balance.run();
  if (result.status !== "terminal" || result.result.status !== expectedStatus) {
    throw new Error(`Balance smoke failed: ${JSON.stringify(result)}`);
  }
  const shares = result.result.status === "success" ? result.result.outputs.shares : undefined;
  process.stdout.write(`${JSON.stringify({
    status: result.result.status,
    capabilityId: result.result.capabilityId,
    ...(result.result.status === "success"
      ? { outputKeys: Object.keys(result.result.outputs) }
      : { outcomeCode: result.result.code }),
    shareCount: Array.isArray(shares) ? shares.length : null,
    plannerCallsAllowed: false,
  }, null, 2)}\n`);
} finally {
  await surface.close();
}
