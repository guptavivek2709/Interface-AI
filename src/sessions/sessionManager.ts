export interface SessionResource {
  close(): Promise<void>;
}

export interface SessionPrincipal {
  operatorId: string;
  role: "teller" | "supervisor";
  branch: string;
}

export interface SessionSnapshot {
  sessionRef: string;
  state: "provisioning" | "active" | "busy" | "closed";
  principal?: SessionPrincipal;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  activeRunId?: string;
  queuedLeases: number;
}

export interface SessionLease<T extends SessionResource> {
  readonly sessionRef: string;
  readonly resource: T;
  readonly principal: SessionPrincipal;
  release(): Promise<void>;
}

export class SessionManagerError extends Error {
  readonly code:
    | "SESSION_EXISTS"
    | "SESSION_NOT_FOUND"
    | "SESSION_NOT_ACTIVE"
    | "SESSION_EXPIRED"
    | "SESSION_QUEUE_FULL"
    | "SESSION_ACQUIRE_CANCELLED"
    | "SESSION_ACQUIRE_TIMEOUT";

  constructor(code: SessionManagerError["code"], message: string) {
    super(message);
    this.name = "SessionManagerError";
    this.code = code;
  }
}

interface Waiter<T extends SessionResource> {
  runId: string;
  resolve: (lease: SessionLease<T>) => void;
  reject: (error: unknown) => void;
  cleanup: () => void;
}

interface SessionRecord<T extends SessionResource> {
  ref: string;
  resource: T;
  state: "provisioning" | "active" | "busy" | "closed";
  principal?: SessionPrincipal;
  createdAtMs: number;
  lastUsedAtMs: number;
  activeRunId?: string;
  waiters: Waiter<T>[];
  closePromise?: Promise<void>;
}

export interface SessionManagerOptions {
  idleTtlMs?: number;
  maxQueuedLeasesPerSession?: number;
  leaseWaitTimeoutMs?: number;
  now?: () => number;
}

export interface SessionAcquireOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Owns opaque, memory-only authenticated browser sessions. It serializes every
 * session so two runs can never control the same browser concurrently and does
 * not persist cookies or credentials.
 */
export class SessionManager<T extends SessionResource> {
  readonly #records = new Map<string, SessionRecord<T>>();
  readonly #idleTtlMs: number;
  readonly #maxQueued: number;
  readonly #leaseWaitTimeoutMs: number;
  readonly #now: () => number;

  constructor(options: SessionManagerOptions = {}) {
    this.#idleTtlMs = options.idleTtlMs ?? 10 * 60_000;
    this.#maxQueued = options.maxQueuedLeasesPerSession ?? 8;
    this.#leaseWaitTimeoutMs = options.leaseWaitTimeoutMs ?? 30_000;
    this.#now = options.now ?? Date.now;
    if (this.#idleTtlMs < 5_000) throw new TypeError("Session idle TTL must be at least five seconds");
    if (!Number.isInteger(this.#maxQueued) || this.#maxQueued < 0) {
      throw new TypeError("Session queue bound must be a non-negative integer");
    }
    if (!Number.isInteger(this.#leaseWaitTimeoutMs) || this.#leaseWaitTimeoutMs < 1_000) {
      throw new TypeError("Session lease wait timeout must be at least one second");
    }
  }

  registerProvisioning(sessionRef: string, resource: T): SessionSnapshot {
    this.#assertRef(sessionRef);
    if (this.#records.has(sessionRef)) {
      throw new SessionManagerError("SESSION_EXISTS", "A session with this reference already exists");
    }
    const timestamp = this.#now();
    const record: SessionRecord<T> = {
      ref: sessionRef,
      resource,
      state: "provisioning",
      createdAtMs: timestamp,
      lastUsedAtMs: timestamp,
      waiters: [],
    };
    this.#records.set(sessionRef, record);
    return this.#snapshot(record);
  }

  activate(sessionRef: string, principal: SessionPrincipal): SessionSnapshot {
    const record = this.#required(sessionRef);
    if (record.state !== "provisioning") {
      throw new SessionManagerError("SESSION_NOT_ACTIVE", "Only a provisioning session can be activated");
    }
    if (!principal.operatorId.trim() || !principal.branch.trim()) {
      throw new TypeError("Session principal requires operator and branch identifiers");
    }
    record.principal = { ...principal };
    record.state = "active";
    record.lastUsedAtMs = this.#now();
    return this.#snapshot(record);
  }

  async acquire(
    sessionRef: string,
    runId: string,
    options: SessionAcquireOptions = {},
  ): Promise<SessionLease<T>> {
    const record = this.#required(sessionRef);
    await this.#expireIfIdle(record);
    if (record.state === "closed") throw new SessionManagerError("SESSION_EXPIRED", "Session has expired");
    if (!record.principal || record.state === "provisioning") {
      throw new SessionManagerError("SESSION_NOT_ACTIVE", "Session is not authenticated");
    }
    if (record.state === "active") return this.#grant(record, runId);
    if (record.waiters.length >= this.#maxQueued) {
      throw new SessionManagerError("SESSION_QUEUE_FULL", "Too many runs are waiting for this session");
    }
    if (options.signal?.aborted) {
      throw new SessionManagerError("SESSION_ACQUIRE_CANCELLED", "Session acquisition was cancelled");
    }
    const timeoutMs = options.timeoutMs ?? this.#leaseWaitTimeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 5 * 60_000) {
      throw new TypeError("Session acquisition timeout must be from one second through five minutes");
    }
    return new Promise<SessionLease<T>>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      let waiter!: Waiter<T>;
      const remove = () => {
        const index = record.waiters.indexOf(waiter);
        if (index >= 0) record.waiters.splice(index, 1);
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        remove();
        waiter.cleanup();
        reject(new SessionManagerError("SESSION_ACQUIRE_CANCELLED", "Session acquisition was cancelled"));
      };
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
      };
      waiter = {
        runId,
        cleanup,
        resolve: (lease) => {
          if (settled) {
            void lease.release();
            return;
          }
          settled = true;
          cleanup();
          resolve(lease);
        },
        reject: (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        },
      };
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        remove();
        cleanup();
        reject(new SessionManagerError("SESSION_ACQUIRE_TIMEOUT", "Timed out waiting for the target session"));
      }, timeoutMs);
      timer.unref();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      record.waiters.push(waiter);
      if (options.signal?.aborted) onAbort();
    });
  }

  get(sessionRef: string): SessionSnapshot | undefined {
    const record = this.#records.get(sessionRef);
    if (record?.state === "active" && this.#now() - record.lastUsedAtMs >= this.#idleTtlMs) {
      // Reads are synchronous, but expiry must still fail closed immediately.
      // Resource teardown remains joinable through #closeRecord.
      void this.#closeRecord(
        record,
        new SessionManagerError("SESSION_EXPIRED", "Session idle timeout expired"),
      ).catch(() => undefined);
      return undefined;
    }
    return record ? this.#snapshot(record) : undefined;
  }

  async revoke(sessionRef: string): Promise<void> {
    const record = this.#records.get(sessionRef);
    if (!record) return;
    await this.#closeRecord(record, new SessionManagerError("SESSION_EXPIRED", "Session was revoked"));
  }

  async sweepExpired(): Promise<number> {
    let count = 0;
    for (const record of this.#records.values()) {
      if (record.state === "active" && this.#now() - record.lastUsedAtMs >= this.#idleTtlMs) {
        await this.#closeRecord(record, new SessionManagerError("SESSION_EXPIRED", "Session idle timeout expired"));
        count += 1;
      }
    }
    return count;
  }

  async closeAll(): Promise<void> {
    await Promise.all(
      [...this.#records.values()].map((record) =>
        this.#closeRecord(record, new SessionManagerError("SESSION_EXPIRED", "Session manager closed")),
      ),
    );
  }

  #grant(record: SessionRecord<T>, runId: string): SessionLease<T> {
    if (!record.principal) throw new SessionManagerError("SESSION_NOT_ACTIVE", "Session is not authenticated");
    record.state = "busy";
    record.activeRunId = runId;
    record.lastUsedAtMs = this.#now();
    let released = false;
    const principal = { ...record.principal };
    return {
      sessionRef: record.ref,
      resource: record.resource,
      principal,
      release: async () => {
        if (released) return;
        released = true;
        if (record.state === "closed") return;
        record.lastUsedAtMs = this.#now();
        delete record.activeRunId;
        const next = record.waiters.shift();
        if (!next) {
          record.state = "active";
          return;
        }
        record.state = "active";
        try {
          next.resolve(this.#grant(record, next.runId));
        } catch (error) {
          next.reject(error);
        }
      },
    };
  }

  async #expireIfIdle(record: SessionRecord<T>): Promise<void> {
    if (record.state === "active" && this.#now() - record.lastUsedAtMs >= this.#idleTtlMs) {
      await this.#closeRecord(record, new SessionManagerError("SESSION_EXPIRED", "Session idle timeout expired"));
    }
  }

  async #closeRecord(record: SessionRecord<T>, reason: Error): Promise<void> {
    if (record.closePromise) return record.closePromise;

    let resolveClose!: () => void;
    let rejectClose!: (error: unknown) => void;
    const closePromise = new Promise<void>((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    });
    // Publish a joinable close marker before changing state or invoking any
    // resource hook so concurrent revoke/logout paths cannot return early.
    record.closePromise = closePromise;
    record.state = "closed";
    delete record.activeRunId;
    for (const waiter of record.waiters.splice(0)) {
      waiter.cleanup();
      waiter.reject(reason);
    }
    void (async () => {
      try {
        await record.resource.close();
        resolveClose();
      } catch (error) {
        rejectClose(error);
      } finally {
        // Browser/resource objects and principals must not be retained after the
        // session becomes unusable. Waiters have already received the stable
        // terminal reason before the record disappears.
        if (this.#records.get(record.ref) === record) this.#records.delete(record.ref);
      }
    })();
    return closePromise;
  }

  #required(ref: string): SessionRecord<T> {
    const record = this.#records.get(ref);
    if (!record) throw new SessionManagerError("SESSION_NOT_FOUND", "Session reference was not found");
    return record;
  }

  #snapshot(record: SessionRecord<T>): SessionSnapshot {
    return Object.freeze({
      sessionRef: record.ref,
      state: record.state,
      ...(record.principal ? { principal: Object.freeze({ ...record.principal }) } : {}),
      createdAt: new Date(record.createdAtMs).toISOString(),
      lastUsedAt: new Date(record.lastUsedAtMs).toISOString(),
      expiresAt: new Date(record.lastUsedAtMs + this.#idleTtlMs).toISOString(),
      ...(record.activeRunId ? { activeRunId: record.activeRunId } : {}),
      queuedLeases: record.waiters.length,
    });
  }

  #assertRef(ref: string): void {
    if (!/^[A-Za-z0-9_-]{32,128}$/u.test(ref)) throw new TypeError("Session reference is not a valid opaque identifier");
  }
}
