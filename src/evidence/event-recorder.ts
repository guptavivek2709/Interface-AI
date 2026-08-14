import { mkdir, open, type FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Redactor } from "../safety/redactor.js";

export interface EventActor {
  type: "agent" | "operator" | "system" | "runtime" | string;
  id?: string;
  name?: string;
}

export interface RunDescriptor {
  id: string;
  startedAt: string;
  metadata: Readonly<Record<string, unknown>>;
}

export interface RecordedEvent {
  schemaVersion: 1;
  sequence: number;
  timestamp: string;
  elapsedMs: number;
  run: RunDescriptor;
  actor: EventActor;
  type: string;
  data: unknown;
}

export interface EventRecorderOptions {
  filePath: string;
  runId?: string;
  runMetadata?: Readonly<Record<string, unknown>>;
  actor?: EventActor | string;
  redactor?: Redactor;
  /** Injectable only for deterministic tests. */
  now?: () => Date;
  /** fsync after each line. Defaults to true for crash-resilient evidence. */
  syncEachWrite?: boolean;
  /** Emit a run.started envelope before the first caller event. Defaults to true. */
  recordRunStart?: boolean;
}

export interface RecordEventOptions {
  actor?: EventActor | string;
}

function normalizeActor(actor: EventActor | string | undefined): EventActor {
  if (typeof actor === "string") return { type: actor };
  return actor ?? { type: "runtime" };
}

function assertEventType(type: string): void {
  if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(type)) {
    throw new TypeError(`Invalid event type "${type}".`);
  }
}

function safeJsonLine(value: unknown): string {
  const seen = new WeakSet<object>();
  return `${JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "bigint") return item.toString();
    if (typeof item === "number" && !Number.isFinite(item)) return String(item);
    if (typeof item === "object" && item !== null) {
      if (seen.has(item)) return "[Circular]";
      seen.add(item);
    }
    return item;
  })}\n`;
}

/**
 * Append-only, newline-delimited run evidence. All writes are serialized and
 * issued as one append call per line; fsync makes acknowledged records durable.
 */
export class EventRecorder {
  readonly filePath: string;
  readonly runId: string;
  readonly redactor: Redactor;

  private readonly actor: EventActor;
  private readonly now: () => Date;
  private readonly syncEachWrite: boolean;
  private readonly recordRunStart: boolean;
  private readonly metadata: Readonly<Record<string, unknown>>;
  private handle: FileHandle | undefined;
  private queue: Promise<void> = Promise.resolve();
  private sequence = 0;
  private startedAt?: Date;
  private lastTimestampMs = -1;
  private startWritten = false;
  private closing = false;
  private closed = false;

  constructor(options: EventRecorderOptions) {
    this.filePath = resolve(options.filePath);
    this.runId = options.runId ?? randomUUID();
    this.metadata = options.runMetadata ?? {};
    this.actor = normalizeActor(options.actor);
    this.redactor = options.redactor ?? new Redactor();
    this.now = options.now ?? (() => new Date());
    this.syncEachWrite = options.syncEachWrite ?? true;
    this.recordRunStart = options.recordRunStart ?? true;
  }

  static async create(options: EventRecorderOptions): Promise<EventRecorder> {
    const recorder = new EventRecorder(options);
    await recorder.initialize();
    return recorder;
  }

  async initialize(): Promise<void> {
    this.assertWritable();
    await this.enqueue(async () => {
      await this.ensureOpen();
      await this.ensureRunStarted();
    });
  }

  record(type: string, data: unknown = {}, options: RecordEventOptions = {}): Promise<RecordedEvent> {
    assertEventType(type);
    this.assertWritable();
    let result: RecordedEvent | undefined;
    return this.enqueue(async () => {
      await this.ensureOpen();
      await this.ensureRunStarted();
      result = await this.appendEvent(type, data, normalizeActor(options.actor ?? this.actor));
    }).then(() => result as RecordedEvent);
  }

  recordAction(data: unknown, options?: RecordEventOptions): Promise<RecordedEvent> {
    return this.record("action", data, options);
  }

  recordObservation(data: unknown, options?: RecordEventOptions): Promise<RecordedEvent> {
    return this.record("observation", data, options);
  }

  recordNavigation(data: unknown, options?: RecordEventOptions): Promise<RecordedEvent> {
    return this.record("navigation", data, options);
  }

  recordPolicyDecision(data: unknown, options?: RecordEventOptions): Promise<RecordedEvent> {
    return this.record("policy.decision", data, options);
  }

  recordEvidence(data: unknown, options?: RecordEventOptions): Promise<RecordedEvent> {
    return this.record("evidence", data, options);
  }

  recordError(error: unknown, context: unknown = {}, options?: RecordEventOptions): Promise<RecordedEvent> {
    return this.record("error", { error, context }, options);
  }

  recordRunFinished(data: unknown = {}, options?: RecordEventOptions): Promise<RecordedEvent> {
    return this.record("run.finished", data, options);
  }

  async flush(): Promise<void> {
    await this.queue;
    if (this.handle !== undefined) await this.handle.sync();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    await this.queue;
    if (this.handle !== undefined) {
      await this.handle.sync();
      await this.handle.close();
      this.handle = undefined;
    }
    this.closed = true;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  private assertWritable(): void {
    if (this.closing || this.closed) throw new Error("EventRecorder is closed.");
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.queue.then(operation);
    // Keep the internal tail usable after a failed operation while returning the
    // actual failure to the caller who enqueued it.
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async ensureOpen(): Promise<void> {
    if (this.handle !== undefined) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    // O_APPEND plus one write call per line prevents this instance from exposing
    // partial logical records to concurrent readers.
    this.handle = await open(this.filePath, "a", 0o600);
  }

  private nextTimestamp(): Date {
    const candidate = this.now();
    if (!Number.isFinite(candidate.getTime())) throw new TypeError("Clock returned an invalid date.");
    const timestampMs = Math.max(candidate.getTime(), this.lastTimestampMs + 1);
    this.lastTimestampMs = timestampMs;
    return new Date(timestampMs);
  }

  private async ensureRunStarted(): Promise<void> {
    if (this.startWritten) return;
    const timestamp = this.nextTimestamp();
    this.startedAt = timestamp;
    if (this.recordRunStart) {
      await this.appendEventAt("run.started", { metadata: this.metadata }, this.actor, timestamp);
    }
    this.startWritten = true;
  }

  private appendEvent(type: string, data: unknown, actor: EventActor): Promise<RecordedEvent> {
    return this.appendEventAt(type, data, actor, this.nextTimestamp());
  }

  private async appendEventAt(
    type: string,
    data: unknown,
    actor: EventActor,
    timestamp: Date,
  ): Promise<RecordedEvent> {
    if (this.handle === undefined || this.startedAt === undefined) {
      throw new Error("EventRecorder was not initialized.");
    }
    this.sequence += 1;
    const event: RecordedEvent = {
      schemaVersion: 1,
      sequence: this.sequence,
      timestamp: timestamp.toISOString(),
      elapsedMs: timestamp.getTime() - this.startedAt.getTime(),
      run: {
        id: this.runId,
        startedAt: this.startedAt.toISOString(),
        metadata: this.redactor.redact(this.metadata) as Readonly<Record<string, unknown>>,
      },
      actor: this.redactor.redact(actor) as EventActor,
      type,
      data: this.redactor.redact(data),
    };
    await this.handle.write(safeJsonLine(event), undefined, "utf8");
    if (this.syncEachWrite) await this.handle.sync();
    return event;
  }
}
