import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

interface FileRef {
  path: string;
  sha256: string;
  bytes: number;
  kind?: string;
  masked?: boolean;
  redacted?: boolean;
}

interface ReplayIndex {
  id: string;
  runId: string;
  session: { referenceSha256: string; operatorSurfaceMatched?: boolean };
  result: { status: string; code?: string };
  replayContract: {
    plannerCallsAllowed: boolean;
    plannerCallCount: number;
    modelDecisionEventCount: number;
  };
  eventLog: FileRef;
  resultEvidence: FileRef;
  manifest: FileRef;
  evidence: FileRef[];
}

interface EvidenceIndex {
  schemaVersion: number;
  discovery: {
    provenanceClass: string;
    genuineModel: boolean;
    testDouble: boolean;
    provider: string;
    model: string;
    plannerCallCount: number;
    eventLog: FileRef;
    observations: { path: string; fileCount: number; bytes: number; sha256: string };
  };
  artifact: FileRef & { discoveryRunId: string };
  replays: ReplayIndex[];
}

interface EventLine {
  type: string;
  run: { id: string };
  data: Record<string, unknown>;
}

const EVIDENCE_ROOT = path.resolve("evidence");

async function loadIndex(): Promise<EvidenceIndex> {
  return JSON.parse(await readFile(path.join(EVIDENCE_ROOT, "index.json"), "utf8")) as EvidenceIndex;
}

async function verifyFile(reference: FileRef): Promise<void> {
  const bytes = await readFile(path.join(EVIDENCE_ROOT, reference.path));
  expect(bytes.byteLength, reference.path).toBe(reference.bytes);
  expect(createHash("sha256").update(bytes).digest("hex"), reference.path).toBe(reference.sha256);
}

async function verifyDirectory(reference: {
  path: string;
  fileCount: number;
  bytes: number;
  sha256: string;
}): Promise<void> {
  const root = path.join(EVIDENCE_ROOT, reference.path);
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  };
  await visit(root);
  files.sort((left, right) => left.localeCompare(right));
  const digest = createHash("sha256");
  let bytes = 0;
  for (const absolute of files) {
    const contents = await readFile(absolute);
    bytes += contents.byteLength;
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    const itemHash = createHash("sha256").update(contents).digest("hex");
    digest.update(`${relative}\0${itemHash}\n`, "utf8");
  }
  expect(files.length).toBe(reference.fileCount);
  expect(bytes).toBe(reference.bytes);
  expect(digest.digest("hex")).toBe(reference.sha256);
}

async function events(reference: FileRef): Promise<EventLine[]> {
  const log = await readFile(path.join(EVIDENCE_ROOT, reference.path), "utf8");
  return log
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as EventLine);
}

function persistedVariants(value: string): string[] {
  return [
    value,
    encodeURIComponent(value),
    new URLSearchParams([["value", value]]).toString().slice("value=".length),
  ];
}

describe("checked-in evidence bundle", () => {
  it("binds its artifact, logs, manifests, and diagnostics to content hashes", async () => {
    const index = await loadIndex();
    expect(index.schemaVersion).toBe(1);
    await verifyFile(index.artifact);
    await verifyFile(index.discovery.eventLog);
    await verifyDirectory(index.discovery.observations);
    for (const replay of index.replays) {
      await verifyFile(replay.eventLog);
      await verifyFile(replay.resultEvidence);
      await verifyFile(replay.manifest);
      for (const reference of replay.evidence) await verifyFile(reference);
    }
  });

  it("contains no raw or URL-encoded registered values in any text evidence", async () => {
    const index = await loadIndex();
    const references = [
      index.discovery.eventLog,
      index.artifact,
      ...index.replays.flatMap((replay) => [
        replay.eventLog,
        replay.resultEvidence,
        replay.manifest,
        ...replay.evidence,
      ]),
    ];
    const sensitive = [
      "MBR-1001",
      "MBR-1002",
      "MISSING-0000",
      "NOTICE-1001",
      "DENIED-1001",
      "HANDOFF-1001",
      "Rainy Day",
      "Future Fund",
      "Savings",
      "Money market",
      "250.00",
      "725.50",
    ].flatMap(persistedVariants);
    for (const reference of references) {
      if (reference.kind === "screenshot" || reference.path.endsWith(".png")) continue;
      const contents = await readFile(path.join(EVIDENCE_ROOT, reference.path), "utf8");
      for (const value of sensitive) {
        expect(contents, `${reference.path} leaked ${value}`).not.toContain(value);
      }
    }
  });

  it("requires checked-in submission evidence to come from a genuine model", async () => {
    const { discovery } = await loadIndex();
    expect(discovery.plannerCallCount).toBeGreaterThan(0);
    expect(discovery.genuineModel).toBe(true);
    expect(discovery.testDouble).toBe(false);
    expect(discovery.provenanceClass).toBe("genuine-llm");
    expect(["openai-codex-cli", "openai-responses"]).toContain(discovery.provider);
    expect(discovery.model).not.toBe("none");
  });

  it("proves all five replays are model-free and have the expected typed outcome", async () => {
    const index = await loadIndex();
    const expected = new Map<string, { status: string; code?: string }>([
      ["success-harbor", { status: "success" }],
      ["member-not-found", { status: "business_outcome", code: "MEMBER_NOT_FOUND" }],
      ["training-notice", { status: "success" }],
      ["permission-denied", { status: "failure", code: "PERMISSION_DENIED" }],
      ["same-session-handoff", { status: "success" }],
    ]);
    expect(index.replays.map((item) => item.id).sort()).toEqual([...expected.keys()].sort());

    for (const replay of index.replays) {
      expect(replay.result, replay.id).toEqual(expected.get(replay.id));
      expect(replay.replayContract, replay.id).toEqual({
        plannerCallsAllowed: false,
        plannerCallCount: 0,
        modelDecisionEventCount: 0,
      });
      const log = await events(replay.eventLog);
      expect(log.every((event) => event.run.id === replay.runId), replay.id).toBe(true);
      expect(log.some((event) => event.type === "model.decision"), replay.id).toBe(false);
      const finished = log.findLast(
        (event) => event.type === "run.finished" && event.data["mode"] === "replay",
      );
      expect(finished?.data["plannerCallCount"], replay.id).toBe(0);
      const rawLog = await readFile(path.join(EVIDENCE_ROOT, replay.eventLog.path), "utf8");
      for (const sensitive of [
        "MBR-1002",
        "MISSING-0000",
        "NOTICE-1001",
        "DENIED-1001",
        "HANDOFF-1001",
        "Future Fund",
        "Future+Fund",
        "Future%20Fund",
        "Money market",
        "Money+market",
        "Money%20market",
        "Rainy Day",
        "Rainy+Day",
        "Rainy%20Day",
        "725.50",
      ]) {
        expect(rawLog, `${replay.id} leaked ${sensitive}`).not.toContain(sensitive);
      }
    }
  });

  it("records bounded recovery, failure diagnostics, and same-session handoff", async () => {
    const index = await loadIndex();
    const byId = new Map(index.replays.map((item) => [item.id, item]));

    const notice = byId.get("training-notice")!;
    expect(await events(notice.eventLog)).toContainEqual(
      expect.objectContaining({
        type: "recovery.attempted",
        data: expect.objectContaining({ code: "TRAINING_NOTICE", recovered: true }),
      }),
    );

    const denied = byId.get("permission-denied")!;
    expect(denied.evidence.some((item) => item.kind === "screenshot" && item.masked === true)).toBe(true);
    expect(denied.evidence.some((item) => item.kind === "dom" && item.redacted === true)).toBe(true);

    const handoff = byId.get("same-session-handoff")!;
    const handoffEvents = await events(handoff.eventLog);
    for (const eventType of ["intervention.requested", "control.transferred", "human.action.completed"]) {
      expect(handoffEvents.some((event) => event.type === eventType), eventType).toBe(true);
    }
    const intervention = handoffEvents.find((event) => event.type === "intervention.requested");
    expect(String(intervention?.data["observedState"] ?? "")).not.toMatch(
      /\bsession\s+[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu,
    );
    expect(handoff.session.referenceSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(handoff.session.operatorSurfaceMatched).toBe(true);
  });
});
