import { describe, expect, it, vi } from "vitest";
import { SessionManager, SessionManagerError } from "../../src/sessions/index.js";

class Resource {
  closed = false;
  closeCount = 0;
  async close(): Promise<void> {
    this.closed = true;
    this.closeCount += 1;
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class BlockingResource extends Resource {
  readonly closeGate = deferred();

  override async close(): Promise<void> {
    this.closeCount += 1;
    await this.closeGate.promise;
    this.closed = true;
  }
}

const ref = "a".repeat(64);

describe("SessionManager", () => {
  it("keeps provisioning sessions unavailable until authentication succeeds", async () => {
    const manager = new SessionManager<Resource>();
    manager.registerProvisioning(ref, new Resource());
    await expect(manager.acquire(ref, "run-1")).rejects.toMatchObject({ code: "SESSION_NOT_ACTIVE" });
    expect(manager.activate(ref, { operatorId: "teller1", role: "teller", branch: "001" }).state).toBe("active");
  });

  it("serializes leases for the same live browser", async () => {
    const manager = new SessionManager<Resource>();
    manager.registerProvisioning(ref, new Resource());
    manager.activate(ref, { operatorId: "teller1", role: "teller", branch: "001" });
    const first = await manager.acquire(ref, "run-1");
    let secondResolved = false;
    const secondPromise = manager.acquire(ref, "run-2").then((lease) => {
      secondResolved = true;
      return lease;
    });
    await Promise.resolve();
    expect(secondResolved).toBe(false);
    await first.release();
    const second = await secondPromise;
    expect(manager.get(ref)).toMatchObject({ state: "busy", activeRunId: "run-2" });
    await second.release();
  });

  it("rebinds the principal only for the run holding the same live-session lease", async () => {
    const manager = new SessionManager<Resource>();
    manager.registerProvisioning(ref, new Resource());
    const teller = { operatorId: "teller1", role: "teller" as const, branch: "001" };
    const supervisor = { operatorId: "super1", role: "supervisor" as const, branch: "001" };
    manager.activate(ref, teller);
    const lease = await manager.acquire(ref, "run-1");

    expect(() => manager.rebindPrincipal(ref, "other-run", teller, supervisor)).toThrowError(
      expect.objectContaining({ code: "SESSION_NOT_ACTIVE" }),
    );
    expect(manager.rebindPrincipal(ref, "run-1", teller, supervisor)).toMatchObject({
      state: "busy",
      activeRunId: "run-1",
      principal: supervisor,
    });
    expect(lease.principal).toEqual(teller);
    await lease.release();
    const reboundLease = await manager.acquire(ref, "run-2");
    expect(reboundLease.principal).toEqual(supervisor);
    await reboundLease.release();
  });

  it("expires only idle sessions and closes their resource", async () => {
    let time = 0;
    const resource = new Resource();
    const manager = new SessionManager<Resource>({ idleTtlMs: 5_000, now: () => time });
    manager.registerProvisioning(ref, resource);
    manager.activate(ref, { operatorId: "super1", role: "supervisor", branch: "001" });
    time = 5_000;
    expect(await manager.sweepExpired()).toBe(1);
    expect(resource.closed).toBe(true);
    expect(resource.closeCount).toBe(1);
    expect(manager.get(ref)).toBeUndefined();
    await expect(manager.acquire(ref, "run-1")).rejects.toBeInstanceOf(SessionManagerError);
  });

  it("fails closed on a synchronous read as soon as the idle deadline passes", async () => {
    let time = 0;
    const resource = new Resource();
    const manager = new SessionManager<Resource>({ idleTtlMs: 5_000, now: () => time });
    manager.registerProvisioning(ref, resource);
    manager.activate(ref, { operatorId: "teller1", role: "teller", branch: "001" });
    time = 5_000;

    expect(manager.get(ref)).toBeUndefined();
    await vi.waitFor(() => expect(resource.closeCount).toBe(1));
    await expect(manager.acquire(ref, "run-after-expiry")).rejects.toMatchObject({
      code: "SESSION_NOT_FOUND",
    });
  });

  it("rejects queued lease waiters on revoke and prunes the closed resource", async () => {
    const resource = new Resource();
    const manager = new SessionManager<Resource>();
    manager.registerProvisioning(ref, resource);
    manager.activate(ref, { operatorId: "teller1", role: "teller", branch: "001" });
    const active = await manager.acquire(ref, "run-active");
    const waiting = manager.acquire(ref, "run-waiting");
    const waitingRejected = expect(waiting).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    await Promise.resolve();
    await manager.revoke(ref);
    await waitingRejected;
    expect(manager.get(ref)).toBeUndefined();
    expect(resource.closeCount).toBe(1);
    await active.release();
    expect(resource.closeCount).toBe(1);
  });

  it("makes concurrent revocation join the same resource close", async () => {
    const resource = new BlockingResource();
    const manager = new SessionManager<Resource>();
    manager.registerProvisioning(ref, resource);
    manager.activate(ref, { operatorId: "teller1", role: "teller", branch: "001" });

    let firstResolved = false;
    let secondResolved = false;
    const first = manager.revoke(ref).then(() => { firstResolved = true; });
    const second = manager.revoke(ref).then(() => { secondResolved = true; });
    await Promise.resolve();
    expect(resource.closeCount).toBe(1);
    expect(firstResolved).toBe(false);
    expect(secondResolved).toBe(false);

    resource.closeGate.resolve();
    await Promise.all([first, second]);
    expect(firstResolved).toBe(true);
    expect(secondResolved).toBe(true);
    expect(manager.get(ref)).toBeUndefined();
  });

  it("bounds and cancels queued lease acquisition without stranding waiters", async () => {
    vi.useFakeTimers();
    try {
      const manager = new SessionManager<Resource>({ leaseWaitTimeoutMs: 1_000 });
      manager.registerProvisioning(ref, new Resource());
      manager.activate(ref, { operatorId: "teller1", role: "teller", branch: "001" });
      const active = await manager.acquire(ref, "run-active");
      const timedOut = manager.acquire(ref, "run-timeout");
      const timeoutRejected = expect(timedOut).rejects.toMatchObject({ code: "SESSION_ACQUIRE_TIMEOUT" });
      await vi.advanceTimersByTimeAsync(1_000);
      await timeoutRejected;
      expect(manager.get(ref)?.queuedLeases).toBe(0);

      const controller = new AbortController();
      const cancelled = manager.acquire(ref, "run-cancelled", { signal: controller.signal });
      const cancelledRejected = expect(cancelled).rejects.toMatchObject({ code: "SESSION_ACQUIRE_CANCELLED" });
      controller.abort();
      await cancelledRejected;
      expect(manager.get(ref)?.queuedLeases).toBe(0);
      await active.release();
      await manager.closeAll();
    } finally {
      vi.useRealTimers();
    }
  });
});
