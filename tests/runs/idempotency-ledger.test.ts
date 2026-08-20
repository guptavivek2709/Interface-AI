import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileIdempotencyLedger,
  RunManager,
  type ManagedReplayRunnerV2,
} from "../../src/runs/index.js";
import type { ReplayProgressV2 } from "../../src/domain/index.js";

const cleanup: string[] = [];
const managers: RunManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map(async (manager) => manager.shutdown()));
  await Promise.all(cleanup.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })));
});

class PendingRunner implements ManagedReplayRunnerV2 {
  run(): Promise<ReplayProgressV2> {
    return new Promise<ReplayProgressV2>(() => undefined);
  }
  issueApproval(): string {
    throw new Error("not approvable");
  }
  resume(): Promise<ReplayProgressV2> {
    throw new Error("not approvable");
  }
  async close(): Promise<void> {}
}

describe("FileIdempotencyLedger", () => {
  it("fails closed across run-history eviction and process-manager restart", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "meridian-idempotency-"));
    cleanup.push(directory);
    const filePath = path.join(directory, "ledger.json");
    const request = {
      capabilityId: "funds.transfer",
      capabilityVersion: "2.0.0",
      artifactDigest: "a".repeat(64),
      sessionRef: "opaque-session",
      inputs: { amount: "1.00" },
      idempotencyKey: "owner-scoped-key",
    };
    const first = new RunManager({
      runnerFactory: () => new PendingRunner(),
      idempotencyLedger: new FileIdempotencyLedger(filePath),
      cleanupIntervalMs: false,
    });
    managers.push(first);
    const submitted = first.submit(request);
    expect(submitted.runId).toBeTruthy();
    await first.shutdown();
    managers.splice(managers.indexOf(first), 1);

    const restarted = new RunManager({
      runnerFactory: () => new PendingRunner(),
      idempotencyLedger: new FileIdempotencyLedger(filePath),
      cleanupIntervalMs: false,
    });
    managers.push(restarted);
    expect(() => restarted.submit(request)).toThrowError(
      expect.objectContaining({ code: "IDEMPOTENCY_RETAINED" }),
    );
  });
});
