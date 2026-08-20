import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export interface IdempotencyLedgerRecord {
  readonly key: string;
  readonly binding: string;
  readonly runId: string;
  readonly createdAt: string;
}

/**
 * Durable safety boundary for risky-operation retries. Implementations must
 * persist a new record before put() returns; display-history retention must not
 * remove it. A database-backed implementation can replace this file seam.
 */
export interface IdempotencyLedger {
  get(key: string): IdempotencyLedgerRecord | undefined;
  put(record: IdempotencyLedgerRecord): void;
}

function validatedRecord(value: unknown): IdempotencyLedgerRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Idempotency ledger contains an invalid record");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.key !== "string" || !record.key || record.key.length > 512) {
    throw new TypeError("Idempotency ledger key is invalid");
  }
  if (typeof record.binding !== "string" || !/^[a-f0-9]{64}$/u.test(record.binding)) {
    throw new TypeError("Idempotency ledger binding is invalid");
  }
  if (typeof record.runId !== "string" || !/^[A-Za-z0-9._-]{1,160}$/u.test(record.runId)) {
    throw new TypeError("Idempotency ledger run ID is invalid");
  }
  if (typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt))) {
    throw new TypeError("Idempotency ledger timestamp is invalid");
  }
  return Object.freeze({
    key: record.key,
    binding: record.binding,
    runId: record.runId,
    createdAt: record.createdAt,
  });
}

export class MemoryIdempotencyLedger implements IdempotencyLedger {
  readonly #records = new Map<string, IdempotencyLedgerRecord>();

  get(key: string): IdempotencyLedgerRecord | undefined {
    const record = this.#records.get(key);
    return record ? { ...record } : undefined;
  }

  put(record: IdempotencyLedgerRecord): void {
    const safe = validatedRecord(record);
    const existing = this.#records.get(safe.key);
    if (existing) {
      if (existing.binding !== safe.binding || existing.runId !== safe.runId) {
        throw new Error("Idempotency ledger key is already bound");
      }
      return;
    }
    this.#records.set(safe.key, safe);
  }
}

export interface FileIdempotencyLedgerOptions {
  readonly maximumRecords?: number;
}

/**
 * Small, fail-closed local deployment ledger. Writes are atomic and fsynced.
 * Multi-instance deployments should provide a transactional shared ledger.
 */
export class FileIdempotencyLedger implements IdempotencyLedger {
  readonly filePath: string;
  readonly #maximumRecords: number;
  readonly #records = new Map<string, IdempotencyLedgerRecord>();

  constructor(filePath: string, options: FileIdempotencyLedgerOptions = {}) {
    this.filePath = path.resolve(filePath);
    this.#maximumRecords = options.maximumRecords ?? 100_000;
    if (!Number.isInteger(this.#maximumRecords) || this.#maximumRecords < 1) {
      throw new TypeError("Idempotency ledger record bound must be a positive integer");
    }
    if (existsSync(this.filePath)) {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
      if (!Array.isArray(parsed)) throw new TypeError("Idempotency ledger root must be an array");
      if (parsed.length > this.#maximumRecords) throw new TypeError("Idempotency ledger exceeds its configured bound");
      for (const value of parsed) {
        const record = validatedRecord(value);
        const existing = this.#records.get(record.key);
        if (existing && (existing.binding !== record.binding || existing.runId !== record.runId)) {
          throw new TypeError("Idempotency ledger contains conflicting bindings");
        }
        this.#records.set(record.key, record);
      }
    }
  }

  get(key: string): IdempotencyLedgerRecord | undefined {
    const record = this.#records.get(key);
    return record ? { ...record } : undefined;
  }

  put(record: IdempotencyLedgerRecord): void {
    const safe = validatedRecord(record);
    const existing = this.#records.get(safe.key);
    if (existing) {
      if (existing.binding !== safe.binding || existing.runId !== safe.runId) {
        throw new Error("Idempotency ledger key is already bound");
      }
      return;
    }
    if (this.#records.size >= this.#maximumRecords) {
      throw new Error("Idempotency ledger is full; reconcile retained operations before accepting more work");
    }

    const next = [...this.#records.values(), safe];
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = path.join(
      path.dirname(this.filePath),
      `.${path.basename(this.filePath)}.${randomBytes(6).toString("hex")}.tmp`,
    );
    try {
      writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      // Windows does not permit fsync on a read-only descriptor; r+ is safe
      // here because the fully written temporary is private to this process.
      const descriptor = openSync(temporary, "r+");
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      renameSync(temporary, this.filePath);
      this.#records.set(safe.key, safe);
    } catch (error) {
      try {
        rmSync(temporary, { force: true });
      } catch {
        // The ledger remains fail-closed because the new record was not made
        // visible in memory and the caller receives the persistence failure.
      }
      throw error;
    }
  }
}
