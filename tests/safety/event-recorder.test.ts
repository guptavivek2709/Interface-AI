import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { EventRecorder, type RecordedEvent } from "../../src/evidence/event-recorder.js";
import { Redactor } from "../../src/safety/redactor.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("EventRecorder", () => {
  it("serializes concurrent records with monotonic sequence/timestamps and redaction", async () => {
    const directory = await mkdtemp(join(tmpdir(), "event-recorder-test-"));
    cleanup.push(directory);
    const filePath = join(directory, "events.jsonl");
    const canary = "SENSITIVE_CANARY_b370";
    let tick = 0;
    const recorder = await EventRecorder.create({
      filePath,
      runId: "run-123",
      runMetadata: { apiKey: canary, mode: "test" },
      actor: { type: "agent", id: "discovery" },
      redactor: new Redactor({ sensitiveValues: [canary] }),
      now: () => new Date(1_700_000_000_000 + tick++),
      syncEachWrite: false,
    });

    await Promise.all([
      recorder.recordAction({ label: "Next", value: canary }),
      recorder.recordNavigation({ url: `https://example.test/?token=${canary}` }),
      recorder.recordError(new Error(`Bearer ${canary}`)),
    ]);
    await recorder.close();

    const raw = await readFile(filePath, "utf8");
    expect(raw).not.toContain(canary);
    const lines = raw.trimEnd().split("\n");
    const events = lines.map((line) => JSON.parse(line) as RecordedEvent);
    expect(events.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4]);
    expect(events.map(({ type }) => type)).toEqual([
      "run.started",
      "action",
      "navigation",
      "error",
    ]);
    expect(events.every(({ run }) => run.id === "run-123")).toBe(true);
    expect(events.every(({ actor }) => actor.type === "agent")).toBe(true);
    expect(
      events.every((event, index) => index === 0 || event.timestamp > events[index - 1]!.timestamp),
    ).toBe(true);
  });

  it("refuses invalid event types and writes exactly one JSON object per line", async () => {
    const directory = await mkdtemp(join(tmpdir(), "event-recorder-test-"));
    cleanup.push(directory);
    const filePath = join(directory, "events.jsonl");
    const recorder = await EventRecorder.create({ filePath, syncEachWrite: false });
    expect(() => recorder.record("bad event name", {})).toThrow(TypeError);
    await recorder.record("action.completed", { ok: true });
    await recorder.close();
    const lines = (await readFile(filePath, "utf8")).trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line))).toHaveLength(2);
  });
});

