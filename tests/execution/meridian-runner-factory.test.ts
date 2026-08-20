import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalAuthority } from "../../src/approval/index.js";
import {
  meridianRecordAndBalancesArtifact,
  meridianSignOnArtifact,
} from "../../src/capabilities/index.js";
import { CapabilityCatalog } from "../../src/catalog/index.js";
import type { CapabilityArtifactV2 } from "../../src/domain/index.js";
import { EventRecorder } from "../../src/evidence/event-recorder.js";
import { createMeridianRunnerFactory } from "../../src/execution/meridianRunnerFactory.js";
import { RunManager, type RunSnapshot } from "../../src/runs/index.js";
import { SessionManager } from "../../src/sessions/index.js";
import type { PlaywrightSurface } from "../../src/surface/playwright/playwrightSurface.js";

const cleanup: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function factoryFor(artifact: CapabilityArtifactV2, evidenceRoot: string) {
  const catalog = CapabilityCatalog.fromArtifacts([artifact]);
  const metadata = catalog.get(artifact.capability.id, artifact.capability.version)!;
  const sessions = new SessionManager<PlaywrightSurface>();
  return {
    factory: createMeridianRunnerFactory({
      catalog,
      sessions,
      approvalAuthority: new ApprovalAuthority({ secret: Buffer.alloc(32, 31) }),
      evidenceRoot,
      headless: true,
    }),
    metadata,
    sessions,
  };
}

describe("MERIDIAN runner evidence lifecycle", () => {
  it("removes the entire partial bundle when recorder initialization fails", async () => {
    const evidenceRoot = await mkdtemp(path.join(tmpdir(), "meridian-factory-recorder-"));
    cleanup.push(evidenceRoot);
    const { factory, metadata, sessions } = factoryFor(meridianSignOnArtifact, evidenceRoot);
    const runId = "recorder-start-failure";
    const partialCanary = "PARTIAL_EVENT_CANARY_4791";
    vi.spyOn(EventRecorder.prototype, "initialize").mockImplementation(async function initializeFailure(
      this: EventRecorder,
    ) {
      await writeFile(this.filePath, partialCanary, "utf8");
      throw new Error("raw recorder failure must stay internal");
    });

    await expect(factory({
      runId,
      capabilityId: meridianSignOnArtifact.capability.id,
      capabilityVersion: meridianSignOnArtifact.capability.version,
      artifactDigest: metadata.digest,
      inputDigest: "a".repeat(64),
      sessionRef: "recorder-failure-session",
      inputs: { operator: "teller", password: "not-persisted", branch: "MAIN-001" },
    }, { reportPhase: () => undefined })).rejects.toThrow("Runner recorder initialization failed");

    await expect(access(path.join(evidenceRoot, runId))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(evidenceRoot)).toEqual([]);
    expect(sessions.get("recorder-failure-session")).toBeUndefined();
  });

  it("closes and hashes a valid event log before marking a later initialization failure", async () => {
    const evidenceRoot = await mkdtemp(path.join(tmpdir(), "meridian-factory-init-"));
    cleanup.push(evidenceRoot);
    const { factory, metadata } = factoryFor(meridianRecordAndBalancesArtifact, evidenceRoot);
    const runId = "post-recorder-failure";

    const manager = new RunManager({
      runnerFactory: factory,
      cleanupIntervalMs: false,
      runIdFactory: () => runId,
    });
    const submitted = manager.submit({
      capabilityId: meridianRecordAndBalancesArtifact.capability.id,
      capabilityVersion: meridianRecordAndBalancesArtifact.capability.version,
      artifactDigest: metadata.digest,
      sessionRef: "missing-session-reference-0000001",
      inputs: { member_number: "100234" },
    });
    const completed = await new Promise<RunSnapshot>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Run did not complete")), 5_000);
      let unsubscribe: () => void = () => undefined;
      unsubscribe = manager.subscribe(submitted.runId, (event) => {
        if (event.snapshot.phase !== "completed") return;
        clearTimeout(timeout);
        queueMicrotask(unsubscribe);
        resolve(event.snapshot);
      });
    });

    expect(completed).toMatchObject({
      phase: "completed",
      evidenceFinalization: { status: "complete" },
      progress: {
        status: "terminal",
        result: { status: "failure", code: "RUNNER_INITIALIZATION_FAILED" },
      },
    });

    const runDirectory = path.join(evidenceRoot, runId);
    const manifest = JSON.parse(await readFile(path.join(runDirectory, "manifest.json"), "utf8")) as {
      metadata: Record<string, unknown>;
      evidence: Array<Record<string, unknown>>;
    };
    expect(manifest.metadata).toMatchObject({
      status: "failure",
      code: "RUNNER_INITIALIZATION_FAILED",
      evidenceCompleteness: "complete",
      plannerCallsAllowed: false,
    });
    expect(manifest.evidence).toContainEqual(expect.objectContaining({
      path: "events.jsonl",
      redacted: true,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    }));
    expect(await readFile(path.join(runDirectory, "events.jsonl"), "utf8")).not.toContain("100234");
    await manager.shutdown();
  });
});
