import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalAuthority } from "../../src/approval/index.js";
import {
  meridianRecordAndBalancesArtifact,
  meridianSignOnArtifact,
} from "../../src/capabilities/index.js";
import { CapabilityArtifactV2Schema } from "../../src/domain/index.js";
import { canonicalArtifactDigest } from "../../src/catalog/index.js";
import {
  bootstrapRetainedMeridianSessionV2,
  meridianBootstrapCredentialsFromEnvironmentV2,
  type RetainedMeridianSessionV2,
} from "../../src/discovery/retainedSessionBootstrapV2.js";
import {
  bindArtifactToTargetProfile,
  createMeridianSurfaceOptions,
  TargetInstanceProfileV2Schema,
} from "../../src/profiles/index.js";
import { ReplayRunnerV2 } from "../../src/replay/replayRunnerV2.js";
import { Redactor } from "../../src/safety/redactor.js";
import { SessionManager } from "../../src/sessions/index.js";
import { PlaywrightSurface } from "../../src/surface/playwright/playwrightSurface.js";
import { PlaywrightReplayRuntimeV2 } from "../../src/surface/playwright/runtimeV2.js";
import { startMeridianFixture, type MeridianFixtureServer } from "../fixtures/meridianFixture.js";

describe("retained V2 discovery authentication", () => {
  let fixture: MeridianFixtureServer | undefined;
  let scratch: string | undefined;
  let surface: PlaywrightSurface | undefined;
  let retained: RetainedMeridianSessionV2 | undefined;

  const discoveredSignOn = CapabilityArtifactV2Schema.parse({
    ...structuredClone(meridianSignOnArtifact),
    provenance: {
      source: "discovery",
      createdAt: "2026-08-20T18:00:00.000Z",
      goal: "Test-only discovered sign-on contract",
      discoveryRunId: "test-discovery.sign-on",
      planner: { provider: "anthropic-messages", model: "test-model" },
    },
  });
  const discoveredSignOnDigest = canonicalArtifactDigest(discoveredSignOn);

  afterEach(async () => {
    await retained?.close();
    await surface?.close();
    await fixture?.close();
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it("resolves only the existing role-scoped environment profile", () => {
    expect(() =>
      meridianBootstrapCredentialsFromEnvironmentV2("teller", "MAIN-001", {
        MERIDIAN_PASSWORD: "must-not-be-used",
      }),
    ).toThrowError(expect.objectContaining({ code: "CREDENTIAL_PROFILE_MISSING" }));

    expect(
      meridianBootstrapCredentialsFromEnvironmentV2("supervisor", "WEST-014", {
        MERIDIAN_SUPERVISOR_OPERATOR: "supervisor-7",
        MERIDIAN_SUPERVISOR_PASSWORD: "server-owned-secret",
      }),
    ).toEqual({
      operator: "supervisor-7",
      password: "server-owned-secret",
      branch: "WEST-014",
      role: "supervisor",
    });
  });

  it("retains the exact authenticated browser context for a non-signon recipe", async () => {
    fixture = await startMeridianFixture();
    scratch = await mkdtemp(path.join(tmpdir(), "retained-discovery-v2-"));
    surface = new PlaywrightSurface(createMeridianSurfaceOptions(scratch, {
      origin: fixture.baseUrl,
      headless: true,
    }));
    const sessions = new SessionManager<PlaywrightSurface>();
    const redactor = new Redactor();
    retained = await bootstrapRetainedMeridianSessionV2({
      surface,
      origin: fixture.baseUrl,
      role: "teller",
      signOnArtifact: discoveredSignOn,
      signOnArtifactDigest: discoveredSignOnDigest,
      environment: {
        MERIDIAN_TELLER_OPERATOR: "teller1",
        MERIDIAN_TELLER_PASSWORD: "password",
      },
      sessions,
      redactor,
    });

    expect(retained.surface).toBe(surface);
    expect(retained.principal).toEqual({
      operatorId: "teller1",
      role: "teller",
      branch: "MAIN-001",
    });
    expect(sessions.get(retained.sessionRef)).toMatchObject({ state: "busy" });
    expect(new URL((await retained.surface.observe()).url).pathname).toBe("/menu");

    const binding = bindArtifactToTargetProfile(
      meridianRecordAndBalancesArtifact,
      canonicalArtifactDigest(meridianRecordAndBalancesArtifact),
      TargetInstanceProfileV2Schema.parse({
        schemaVersion: "1.0",
        id: "retained-fixture",
        vendorProduct: meridianRecordAndBalancesArtifact.compatibility.vendorProduct,
        surfaceAdapter: meridianRecordAndBalancesArtifact.compatibility.surfaceAdapter,
        appVersion: meridianRecordAndBalancesArtifact.compatibility.appVersion,
        origin: fixture.baseUrl,
        createdAt: "2026-08-20T18:00:00.000Z",
      }),
    );
    const result = await new ReplayRunnerV2({
      artifact: binding.artifact,
      artifactDigest: binding.baseArtifactDigest,
      targetProfileDigest: binding.targetProfileDigest,
      inputs: { member_number: "100234" },
      runtime: new PlaywrightReplayRuntimeV2(retained.surface, binding.artifact),
      approvalAuthority: new ApprovalAuthority({ secret: Buffer.alloc(32, 31) }),
      redactor,
      currentPrincipalRole: () => retained?.principal.role ?? "teller",
    }).run();
    expect(result).toMatchObject({
      status: "terminal",
      result: {
        status: "success",
        outputs: { member_number: "100234" },
      },
    });
    expect(fixture.snapshot().commits).toHaveLength(0);

    const sessionRef = retained.sessionRef;
    await retained.close();
    retained = undefined;
    expect(sessions.get(sessionRef)).toBeUndefined();
  });

  it("revokes the browser session when sign-on does not authenticate", async () => {
    fixture = await startMeridianFixture();
    scratch = await mkdtemp(path.join(tmpdir(), "failed-retained-discovery-v2-"));
    surface = new PlaywrightSurface(createMeridianSurfaceOptions(scratch, {
      origin: fixture.baseUrl,
      headless: true,
    }));
    const sessions = new SessionManager<PlaywrightSurface>();

    await expect(
      bootstrapRetainedMeridianSessionV2({
        surface,
        origin: fixture.baseUrl,
        role: "teller",
        signOnArtifact: discoveredSignOn,
        signOnArtifactDigest: discoveredSignOnDigest,
        environment: {
          MERIDIAN_TELLER_OPERATOR: "teller1",
          MERIDIAN_TELLER_PASSWORD: "wrong-password",
        },
        sessions,
      }),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
    expect(sessions.get(surface.sessionRef)).toBeUndefined();
  });
});
