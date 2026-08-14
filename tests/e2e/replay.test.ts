import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDemoServer, type DemoServer } from "../../src/demo/index.js";
import { compileArtifact } from "../../src/discovery/artifactCompiler.js";
import { DiscoveryRunner } from "../../src/discovery/discoveryRunner.js";
import type { CapabilityArtifact, RunResult } from "../../src/domain/index.js";
import { EventRecorder } from "../../src/evidence/event-recorder.js";
import { EvidenceStore } from "../../src/evidence/store.js";
import { performDemoOperatorHandoff } from "../../src/handoff/operatorServer.js";
import { ScriptedPlanner } from "../../src/model/scriptedPlanner.js";
import { createLegacyBankProfile } from "../../src/profiles/index.js";
import { ReplayRunner } from "../../src/replay/replayRunner.js";
import { PolicyEngine } from "../../src/safety/policy.js";
import { Redactor } from "../../src/safety/redactor.js";
import { PlaywrightSurface } from "../../src/surface/playwright/playwrightSurface.js";

interface ReplayExecution {
  result: RunResult;
  log: string;
  evidenceRoot: string;
  sessionId: string;
}

describe("deterministic replay vertical slice", () => {
  let demo: DemoServer;
  let scratch: string;
  let artifact: CapabilityArtifact;

  beforeAll(async () => {
    demo = await startDemoServer();
    scratch = await mkdtemp(path.join(tmpdir(), "capability-replay-test-"));
    const discoveryDirectory = path.join(scratch, "discovery");
    const redactor = new Redactor();
    const profile = createLegacyBankProfile(demo.baseUrl);
    const policy = new PolicyEngine({ ...profile.policy, maxRisk: "high" });
    const recorder = await EventRecorder.create({
      filePath: path.join(discoveryDirectory, "events.jsonl"),
      runId: "compile-fixture",
      redactor,
      syncEachWrite: false,
    });
    const surface = new PlaywrightSurface({
      observationDirectory: path.join(discoveryDirectory, "observations"),
      assertNavigationAllowed: (url, kind) => {
        policy.assertNavigationAllowed({ url, kind });
      },
      assertResourceAllowed: (url) => policy.assertResourceAllowed(url),
    });
    try {
      await surface.start(`${demo.baseUrl}/?tenant=summit`);
      const result = await new DiscoveryRunner({
        surface,
        planner: new ScriptedPlanner(),
        policy,
        recorder,
        redactor,
        goal:
          "Look up member {{memberId}}, prepare a {{accountType}} sub-account named {{nickname}} with {{initialDeposit}}, stop at Review ready, and return exactly memberName, memberId, accountType, nickname, and initialDeposit.",
        inputs: {
          memberId: "MBR-1001",
          accountType: "Savings",
          nickname: "Rainy Day",
          initialDeposit: "250.00",
        },
      }).run();
      if (result.kind !== "success") throw new Error(JSON.stringify(result));
      artifact = compileArtifact(result, {
        compatibility: {
          surfaceAdapter: "playwright-web",
          vendorProduct: "legacy-bank-training",
          appVersion: "7.x",
          tenantVariant: "base",
          entryPoint: `${demo.baseUrl}/?tenant=summit`,
        },
        policy: profile.policy,
        profile,
        sensitiveInvocationValues: ["MBR-1001", "Savings", "Rainy Day", "250.00"],
      });
    } finally {
      await recorder.close();
      await surface.close();
    }
  }, 30_000);

  afterAll(async () => {
    await demo.close();
    await rm(scratch, { recursive: true, force: true });
  });

  async function replay(options: {
    name: string;
    memberId: string;
    tenant?: string;
    autoHandoff?: boolean;
    artifactOverride?: CapabilityArtifact;
    inputsOverride?: Record<string, string | number | boolean>;
  }): Promise<ReplayExecution> {
    const directory = path.join(scratch, options.name);
    const redactor = new Redactor();
    const policy = new PolicyEngine(artifact.policy);
    const recorder = await EventRecorder.create({
      filePath: path.join(directory, "events.jsonl"),
      runId: options.name,
      redactor,
      syncEachWrite: false,
    });
    const evidence = await EvidenceStore.create({
      rootDirectory: path.join(directory, "evidence"),
      runId: options.name,
      redactor,
    });
    const surface = new PlaywrightSurface({
      observationDirectory: path.join(directory, "observations"),
      assertNavigationAllowed: (url, kind) => {
        policy.assertNavigationAllowed({ url, kind });
      },
      assertResourceAllowed: (url) => policy.assertResourceAllowed(url),
    });
    try {
      await surface.start(`${demo.baseUrl}/?tenant=${options.tenant ?? "summit"}`);
      const result = await new ReplayRunner({
        artifact: options.artifactOverride ?? artifact,
        inputs: options.inputsOverride ?? {
          memberId: options.memberId,
          accountType: "Money market",
          nickname: "Future Fund",
          initialDeposit: "725.50",
        },
        surface,
        recorder,
        evidence,
        redactor,
        ...(options.autoHandoff ? { autoHandoff: performDemoOperatorHandoff } : {}),
      }).run();
      await evidence.writeManifest({ status: result.status, sessionId: surface.sessionId });
      await recorder.flush();
      return {
        result,
        log: await readFile(path.join(directory, "events.jsonl"), "utf8"),
        evidenceRoot: evidence.runDirectory,
        sessionId: surface.sessionId,
      };
    } finally {
      await recorder.close();
      await surface.close();
    }
  }

  it("replays with different inputs on a reordered tenant variant and makes zero model calls", async () => {
    const execution = await replay({
      name: "success-harbor",
      memberId: "MBR-1002",
      tenant: "harbor",
    });
    expect(execution.result.status, JSON.stringify(execution.result, null, 2)).toBe("success");
    if (execution.result.status !== "success") return;
    expect(execution.result.outputs).toEqual({
      memberName: "Malcolm Reed",
      memberId: "MBR-1002",
      accountType: "Money market",
      nickname: "Future Fund",
      initialDeposit: "$725.50",
    });
    expect(execution.log).toContain('"plannerCallCount":0');
    expect(execution.log).not.toContain("scripted-offline-test-double");
    expect(execution.log).not.toContain("MBR-1002");
    expect(execution.log).not.toContain("Future Fund");
  });

  it("returns member-not-found as a typed business outcome", async () => {
    const execution = await replay({ name: "member-not-found", memberId: "MISSING-0000" });
    expect(execution.result.status).toBe("business_outcome");
    if (execution.result.status === "business_outcome") {
      expect(execution.result.code).toBe("MEMBER_NOT_FOUND");
    }
    expect(execution.log).toContain('"state.business-outcome"');
  });

  it("dismisses a declared notice with a bounded deterministic recovery", async () => {
    const execution = await replay({ name: "training-notice", memberId: "NOTICE-1001" });
    expect(execution.result.status, JSON.stringify(execution.result, null, 2)).toBe("success");
    expect(execution.log).toContain('"recovery.attempted"');
    expect(execution.log).toContain('"code":"TRAINING_NOTICE"');
  });

  it("waits through a transient busy page and continues after its deterministic redirect", async () => {
    const execution = await replay({ name: "slow-load", memberId: "SLOW-1001" });
    expect(execution.result.status, JSON.stringify(execution.result, null, 2)).toBe("success");
    expect(execution.log).toContain('"plannerCallCount":0');
  });

  it("surfaces permission denial as a hard failure with screenshot and DOM evidence", async () => {
    const execution = await replay({ name: "permission-denied", memberId: "DENIED-1001" });
    expect(execution.result.status).toBe("failure");
    if (execution.result.status === "failure") {
      expect(execution.result.code).toBe("PERMISSION_DENIED");
      expect(execution.result.evidencePaths.some((item) => item.endsWith(".png"))).toBe(true);
      expect(execution.result.evidencePaths.some((item) => item.endsWith(".html"))).toBe(true);
    }
    expect(execution.log).toContain('"plannerCallCount":0');
  });

  it("pauses, gives a human exclusive control of the same session, and resumes", async () => {
    const execution = await replay({
      name: "same-session-handoff",
      memberId: "HANDOFF-1001",
      autoHandoff: true,
    });
    expect(execution.result.status, JSON.stringify(execution.result, null, 2)).toBe("success");
    expect(execution.log).toContain('"intervention.requested"');
    expect(execution.log).toContain('"human.action.completed"');
    expect(execution.log).toContain('"control.transferred"');
    expect(execution.log).not.toContain(execution.sessionId);
    expect(execution.log).toContain(
      createHash("sha256").update(execution.sessionId).digest("hex"),
    );
  });

  it("fails closed when an extracted value violates its declared output type", async () => {
    const mismatch = structuredClone(artifact);
    const memberName = mismatch.outputs.find((output) => output.name === "memberName")!;
    memberName.type = "number";
    const execution = await replay({
      name: "output-type-mismatch",
      memberId: "MBR-1002",
      artifactOverride: mismatch,
    });
    expect(execution.result.status).toBe("failure");
    if (execution.result.status === "failure") {
      expect(execution.result.code).toBe("OUTPUT_TYPE_MISMATCH");
      expect(execution.result.observed).not.toContain("Malcolm Reed");
      expect(execution.result.journal.at(-1)).toEqual(
        expect.objectContaining({ status: "failed", evidencePaths: expect.any(Array) }),
      );
      expect(execution.result.journal.at(-1)!.evidencePaths.length).toBeGreaterThan(0);
    }
  });

  it("records a complete lifecycle when invocation validation fails before any UI action", async () => {
    const execution = await replay({
      name: "invalid-input",
      memberId: "MBR-1002",
      inputsOverride: { memberId: "MBR-1002" },
    });
    expect(execution.result.status).toBe("failure");
    if (execution.result.status === "failure") {
      expect(execution.result.code).toBe("INPUT_INVALID");
      expect(execution.result.journal).toEqual([]);
    }
    expect(execution.log).toContain('"type":"replay.started"');
    expect(execution.log).toContain('"type":"run.finished"');
    expect(execution.log).toContain('"code":"INPUT_INVALID"');
    expect(execution.log).not.toContain('"type":"action.executed"');
  });
});
