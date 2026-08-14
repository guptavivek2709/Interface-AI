#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { compileArtifact } from "../src/discovery/artifactCompiler.js";
import { DiscoveryRunner, type DiscoverySuccess } from "../src/discovery/discoveryRunner.js";
import { CapabilityArtifactSchema, type CapabilityArtifact, type RunResult } from "../src/domain/index.js";
import { EventRecorder, type RecordedEvent } from "../src/evidence/event-recorder.js";
import { EvidenceStore, type EvidenceRef } from "../src/evidence/store.js";
import { performDemoOperatorHandoff } from "../src/handoff/operatorServer.js";
import type { Planner } from "../src/model/planner.js";
import { createLegacyBankProfile } from "../src/profiles/index.js";
import { ReplayRunner } from "../src/replay/replayRunner.js";
import { PolicyEngine } from "../src/safety/policy.js";
import { Redactor } from "../src/safety/redactor.js";
import { JsonArtifactStore } from "../src/storage/jsonStore.js";
import { PlaywrightSurface } from "../src/surface/playwright/playwrightSurface.js";
import { startDemoServer } from "../src/demo/index.js";

type DiscoveryProvider = "offline" | "codex" | "openai";

interface CliOptions {
  provider: DiscoveryProvider;
  port: string;
}

interface JsonEvent extends Omit<RecordedEvent, "data"> {
  data: Record<string, unknown>;
}

interface FileRef {
  path: string;
  sha256: string;
  bytes: number;
}

interface Scenario {
  id: string;
  purpose: string;
  memberId: string;
  tenant: string;
  expectedStatus: RunResult["status"];
  expectedCode?: string;
  autoHandoff?: boolean;
}

const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));
const EVIDENCE_ROOT = path.join(REPOSITORY_ROOT, "evidence");
const DISCOVERY_DIRECTORY = path.join(EVIDENCE_ROOT, "discovery");
const RUNS_DIRECTORY = path.join(EVIDENCE_ROOT, "runs");
const ARTIFACT_PATH = path.join(EVIDENCE_ROOT, "artifact.json");
const INDEX_PATH = path.join(EVIDENCE_ROOT, "index.json");
const GOAL =
  "Look up member {{memberId}}, prepare a {{accountType}} sub-account named {{nickname}} with {{initialDeposit}}, " +
  "stop at review, then extract exactly memberName (string), memberId (string), accountType (string), " +
  "nickname (string), and initialDeposit (money), with no other output. Finish when those five outputs and " +
  "the Review ready checkpoint are visible. Do not extract banner or status prose as an output.";

const DISCOVERY_INPUTS = {
  memberId: "MBR-1001",
  accountType: "Savings",
  nickname: "Rainy Day",
  initialDeposit: "250.00",
} as const;

const REPLAY_INPUTS = {
  accountType: "Money market",
  nickname: "Future Fund",
  initialDeposit: "725.50",
} as const;

const SCENARIOS: readonly Scenario[] = [
  {
    id: "success-harbor",
    purpose: "Different member and inputs on the reordered Harbor tenant variant.",
    memberId: "MBR-1002",
    tenant: "harbor",
    expectedStatus: "success",
  },
  {
    id: "member-not-found",
    purpose: "A normal empty lookup is returned as a typed business outcome.",
    memberId: "MISSING-0000",
    tenant: "summit",
    expectedStatus: "business_outcome",
    expectedCode: "MEMBER_NOT_FOUND",
  },
  {
    id: "training-notice",
    purpose: "A declared transient notice is dismissed by one bounded recovery.",
    memberId: "NOTICE-1001",
    tenant: "summit",
    expectedStatus: "success",
  },
  {
    id: "permission-denied",
    purpose: "Permission denial fails closed and captures masked screenshot plus redacted DOM.",
    memberId: "DENIED-1001",
    tenant: "summit",
    expectedStatus: "failure",
    expectedCode: "PERMISSION_DENIED",
  },
  {
    id: "same-session-handoff",
    purpose: "A human restores the same live browser session, then deterministic replay resumes.",
    memberId: "HANDOFF-1001",
    tenant: "summit",
    expectedStatus: "success",
    autoHandoff: true,
  },
] as const;

function relativePath(absolutePath: string): string {
  return path.relative(EVIDENCE_ROOT, absolutePath).split(path.sep).join("/");
}

async function fileRef(absolutePath: string): Promise<FileRef> {
  const bytes = await readFile(absolutePath);
  return {
    path: relativePath(absolutePath),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength,
  };
}

async function directoryDigest(absoluteDirectory: string): Promise<{
  path: string;
  fileCount: number;
  bytes: number;
  sha256: string;
}> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  };
  await visit(absoluteDirectory);
  files.sort((left, right) => left.localeCompare(right));
  let totalBytes = 0;
  const digest = createHash("sha256");
  for (const absolute of files) {
    const contents = await readFile(absolute);
    totalBytes += contents.byteLength;
    const itemPath = path.relative(absoluteDirectory, absolute).split(path.sep).join("/");
    const itemHash = createHash("sha256").update(contents).digest("hex");
    digest.update(`${itemPath}\0${itemHash}\n`, "utf8");
  }
  return {
    path: relativePath(absoluteDirectory),
    fileCount: files.length,
    bytes: totalBytes,
    sha256: digest.digest("hex"),
  };
}

async function parseEvents(filePath: string): Promise<JsonEvent[]> {
  const lines = (await readFile(filePath, "utf8"))
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0);
  return lines.map((line, index) => {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Invalid JSONL event at ${filePath}:${index + 1}`);
    }
    return parsed as JsonEvent;
  });
}

function persistedVariants(value: string): string[] {
  return [
    value,
    encodeURIComponent(value),
    new URLSearchParams([["value", value]]).toString().slice("value=".length),
  ];
}

async function assertPersistedTextIsRedacted(
  filePath: string,
  sensitiveValues: readonly string[],
): Promise<void> {
  const contents = await readFile(filePath, "utf8");
  for (const value of sensitiveValues.flatMap(persistedVariants)) {
    if (contents.includes(value)) {
      throw new Error(`${relativePath(filePath)} leaked registered sensitive text ${JSON.stringify(value)}`);
    }
  }
}

function assertNoDiscoveryLiterals(artifact: CapabilityArtifact): void {
  const serialized = JSON.stringify(artifact);
  for (const value of Object.values(DISCOVERY_INPUTS).flatMap(persistedVariants)) {
    if (value.length >= 3 && serialized.includes(value)) {
      throw new Error(`Artifact leaked a discovery-time input literal (${value}).`);
    }
  }
}

async function plannerFor(provider: DiscoveryProvider): Promise<Planner> {
  switch (provider) {
    case "offline": {
      const { ScriptedPlanner } = await import("../src/model/scriptedPlanner.js");
      return new ScriptedPlanner();
    }
    case "codex": {
      const { CodexPlanner } = await import("../src/model/codexPlanner.js");
      return new CodexPlanner({ timeoutMs: 600_000 });
    }
    case "openai": {
      const { OpenAIPlanner } = await import("../src/model/openaiPlanner.js");
      return new OpenAIPlanner();
    }
  }
}

async function discoverArtifact(
  provider: DiscoveryProvider,
  baseUrl: string,
): Promise<{
  artifact: CapabilityArtifact;
  artifactRef: FileRef;
  discovery: DiscoverySuccess;
  logRef: FileRef;
  observationDigest: Awaited<ReturnType<typeof directoryDigest>>;
}> {
  const runId = `discovery-${provider}`;
  const logPath = path.join(DISCOVERY_DIRECTORY, "events.jsonl");
  const observationDirectory = path.join(DISCOVERY_DIRECTORY, "observations");
  const redactor = new Redactor();
  redactor.registerMany(Object.values(DISCOVERY_INPUTS));
  const profile = createLegacyBankProfile(baseUrl);
  const policy = new PolicyEngine(profile.policy);
  const planner = await plannerFor(provider);
  const recorder = await EventRecorder.create({
    filePath: logPath,
    runId,
    runMetadata: {
      mode: "discovery",
      provenance:
        provider === "offline"
          ? { class: "offline-scripted-test-double", genuineModel: false }
          : { class: "genuine-llm", genuineModel: true },
    },
    redactor,
  });
  const surface = new PlaywrightSurface({
    observationDirectory,
    assertNavigationAllowed: (url, kind) => {
      policy.assertNavigationAllowed({ url, kind });
    },
    assertResourceAllowed: (url) => policy.assertResourceAllowed(url),
  });
  try {
    await surface.start(`${baseUrl}/?tenant=summit`);
    const result = await new DiscoveryRunner({
      surface,
      planner,
      policy,
      recorder,
      redactor,
      goal: GOAL,
      inputs: DISCOVERY_INPUTS,
      maxSteps: 24,
      timeoutMs: provider === "offline" ? 180_000 : 1_800_000,
    }).run();
    if (result.kind !== "success") {
      throw new Error(`Discovery failed: ${JSON.stringify(result, null, 2)}`);
    }
    const artifact = compileArtifact(result, {
      compatibility: {
        surfaceAdapter: profile.surfaceAdapter,
        vendorProduct: profile.id,
        appVersion: "7.x",
        tenantVariant: "summit",
        entryPoint: `${baseUrl}/?tenant=summit`,
      },
      policy: profile.policy,
      profile,
      sensitiveInvocationValues: Object.values(DISCOVERY_INPUTS),
    });
    assertNoDiscoveryLiterals(artifact);
    const stored = await new JsonArtifactStore<CapabilityArtifact>(CapabilityArtifactSchema).save(
      ARTIFACT_PATH,
      artifact,
    );
    await recorder.record(
      "artifact.saved",
      {
        path: path.basename(stored.path),
        sha256: stored.sha256,
        schemaVersion: artifact.schemaVersion,
        capabilityId: artifact.capability.id,
        targetCount: artifact.targets.length,
        stepCount: artifact.steps.length,
      },
      { actor: "system" },
    );
    await recorder.flush();
    await assertPersistedTextIsRedacted(logPath, [
      ...Object.values(DISCOVERY_INPUTS),
      surface.sessionId,
    ]);
    return {
      artifact,
      artifactRef: await fileRef(ARTIFACT_PATH),
      discovery: result,
      logRef: await fileRef(logPath),
      observationDigest: await directoryDigest(observationDirectory),
    };
  } finally {
    await recorder.close();
    await surface.close();
  }
}

function resultCode(result: RunResult): string | undefined {
  if (result.status === "failure" || result.status === "business_outcome") return result.code;
  return undefined;
}

function verifyExpectedResult(scenario: Scenario, result: RunResult): void {
  if (result.status !== scenario.expectedStatus) {
    throw new Error(
      `${scenario.id}: expected ${scenario.expectedStatus}, received ${result.status}: ${JSON.stringify(result)}`,
    );
  }
  if (scenario.expectedCode && resultCode(result) !== scenario.expectedCode) {
    throw new Error(`${scenario.id}: expected code ${scenario.expectedCode}, received ${resultCode(result)}`);
  }
  if (scenario.id === "success-harbor") {
    if (result.status !== "success") throw new Error("success-harbor did not succeed");
    const expected = {
      memberName: "Malcolm Reed",
      memberId: "MBR-1002",
      accountType: REPLAY_INPUTS.accountType,
      nickname: REPLAY_INPUTS.nickname,
      initialDeposit: "$725.50",
    };
    if (JSON.stringify(result.outputs) !== JSON.stringify(expected)) {
      throw new Error(`success-harbor returned unexpected outputs: ${JSON.stringify(result.outputs)}`);
    }
  }
}

function verifyNoPlannerCalls(runId: string, events: JsonEvent[]): void {
  if (events.some((event) => event.type === "model.decision")) {
    throw new Error(`${runId}: deterministic replay emitted a model.decision event`);
  }
  if (events.some((event) => event.run.id !== runId)) {
    throw new Error(`${runId}: event log contains a different run ID`);
  }
  const replayStarted = events.find((event) => event.type === "replay.started");
  if (!replayStarted || replayStarted.data["plannerCallsAllowed"] !== false) {
    throw new Error(`${runId}: replay.started did not explicitly disable planner calls`);
  }
  const replayActions = events.filter(
    (event) => event.type === "action" && event.data["mode"] === "replay",
  );
  if (replayActions.some((event) => event.data["plannerCallCount"] !== 0)) {
    throw new Error(`${runId}: a replay action did not prove plannerCallCount=0`);
  }
  const finished = events.findLast(
    (event) => event.type === "run.finished" && event.data["mode"] === "replay",
  );
  if (!finished || finished.data["plannerCallCount"] !== 0) {
    throw new Error(`${runId}: run.finished did not prove plannerCallCount=0`);
  }
}

async function runScenario(
  scenario: Scenario,
  artifact: CapabilityArtifact,
  artifactSha256: string,
  baseUrl: string,
): Promise<Record<string, unknown>> {
  const runDirectory = path.join(RUNS_DIRECTORY, scenario.id);
  const logPath = path.join(runDirectory, "events.jsonl");
  const redactor = new Redactor();
  const inputs = { memberId: scenario.memberId, ...REPLAY_INPUTS };
  redactor.registerMany(Object.values(inputs));
  const evidence = await EvidenceStore.create({
    rootDirectory: RUNS_DIRECTORY,
    runId: scenario.id,
    redactor,
  });
  const recorder = await EventRecorder.create({
    filePath: logPath,
    runId: scenario.id,
    runMetadata: { mode: "replay", artifactSha256, scenario: scenario.id },
    redactor,
  });
  const policy = new PolicyEngine(artifact.policy);
  const surface = new PlaywrightSurface({
    observationDirectory: path.join(runDirectory, "observations"),
    assertNavigationAllowed: (url, kind) => {
      policy.assertNavigationAllowed({ url, kind });
    },
    assertResourceAllowed: (url) => policy.assertResourceAllowed(url),
  });
  let result: RunResult | undefined;
  let resultEvidence: EvidenceRef | undefined;
  let manifestEvidence: EvidenceRef | undefined;
  const sessionId = surface.sessionId;
  const sessionRefSha256 = surface.sessionRef;
  const handoffVerification = { matched: false };
  try {
    await surface.start(`${baseUrl}/?tenant=${encodeURIComponent(scenario.tenant)}`);
    result = await new ReplayRunner({
      artifact,
      inputs,
      surface,
      recorder,
      evidence,
      redactor,
      runId: scenario.id,
      ...(scenario.autoHandoff
        ? {
            autoHandoff: async (operatorUrl: string) => {
              const response = await fetch(`${operatorUrl}/api/intervention`);
              if (!response.ok) throw new Error("Unable to inspect the operator handoff session");
              const body = (await response.json()) as {
                sameSessionRef?: unknown;
              };
              if (body.sameSessionRef !== surface.sessionRef) {
                throw new Error("Operator surface was not bound to the replay browser session");
              }
              handoffVerification.matched = true;
              await performDemoOperatorHandoff(operatorUrl);
            },
          }
        : {}),
    }).run();
    verifyExpectedResult(scenario, result);
    resultEvidence = await evidence.saveJson("result", result);
    manifestEvidence = await evidence.writeManifest({
      scenario: scenario.id,
      status: result.status,
      artifactSha256,
      sessionId,
      plannerCallCount: 0,
    });
  } finally {
    await recorder.close();
    await surface.close();
  }
  if (!result || !resultEvidence || !manifestEvidence) {
    throw new Error(`${scenario.id}: replay did not produce its evidence envelope`);
  }

  const events = await parseEvents(logPath);
  verifyNoPlannerCalls(scenario.id, events);
  const registeredValues = [
    ...Object.values(DISCOVERY_INPUTS),
    ...Object.values(REPLAY_INPUTS),
    ...SCENARIOS.map((item) => item.memberId),
    sessionId,
  ];
  await assertPersistedTextIsRedacted(logPath, registeredValues);
  await assertPersistedTextIsRedacted(evidence.resolve(resultEvidence), registeredValues);
  await assertPersistedTextIsRedacted(evidence.resolve(manifestEvidence), registeredValues);
  for (const reference of evidence.list()) {
    if (reference.kind !== "screenshot") {
      await assertPersistedTextIsRedacted(evidence.resolve(reference), registeredValues);
    }
  }
  if (scenario.id === "training-notice") {
    const recovery = events.find(
      (event) =>
        event.type === "recovery.attempted" &&
        event.data["code"] === "TRAINING_NOTICE" &&
        event.data["recovered"] === true,
    );
    if (!recovery) throw new Error("training-notice: no successful bounded recovery was recorded");
  }
  if (scenario.id === "permission-denied") {
    if (result.status !== "failure") throw new Error("permission-denied did not fail");
    const extensions = new Set(result.evidencePaths.map((item) => path.extname(item).toLowerCase()));
    if (!extensions.has(".png") || !extensions.has(".html")) {
      throw new Error("permission-denied: masked screenshot and redacted DOM evidence are both required");
    }
    for (const item of result.evidencePaths) await stat(path.join(runDirectory, item));
  }
  if (scenario.id === "same-session-handoff") {
    for (const type of ["intervention.requested", "control.transferred", "human.action.completed"]) {
      if (!events.some((event) => event.type === type)) {
        throw new Error(`same-session-handoff: missing ${type} event`);
      }
    }
    if (!handoffVerification.matched) {
      throw new Error("same-session-handoff: operator endpoint was not bound to the replay session");
    }
  }

  const evidenceFiles = evidence.list().map((reference) => ({
    ...reference,
    path: `${relativePath(runDirectory)}/${reference.path}`,
  }));
  return {
    id: scenario.id,
    purpose: scenario.purpose,
    runId: scenario.id,
    session: {
      referenceSha256: sessionRefSha256,
      ...(scenario.autoHandoff ? { operatorSurfaceMatched: handoffVerification.matched } : {}),
    },
    tenant: scenario.tenant,
    result: {
      status: result.status,
      ...(resultCode(result) ? { code: resultCode(result) } : {}),
    },
    replayContract: {
      plannerCallsAllowed: false,
      plannerCallCount: 0,
      modelDecisionEventCount: 0,
    },
    eventLog: await fileRef(logPath),
    resultEvidence: {
      ...resultEvidence,
      path: `${relativePath(runDirectory)}/${resultEvidence.path}`,
    },
    manifest: {
      ...manifestEvidence,
      path: `${relativePath(runDirectory)}/${manifestEvidence.path}`,
    },
    evidence: evidenceFiles,
  };
}

async function cleanGeneratedBundle(): Promise<void> {
  // These are the only paths owned by this generator; evidence/README.md and
  // any reviewer-added material are deliberately preserved.
  await rm(DISCOVERY_DIRECTORY, { recursive: true, force: true });
  await rm(RUNS_DIRECTORY, { recursive: true, force: true });
  await rm(ARTIFACT_PATH, { force: true });
  await rm(INDEX_PATH, { force: true });
  await mkdir(EVIDENCE_ROOT, { recursive: true });
}

async function main(): Promise<void> {
  const program = new Command()
    .name("generate-evidence")
    .description("Generate discovery provenance and five deterministic replay evidence runs.")
    .option(
      "--provider <provider>",
      "discovery provider: offline (explicit test double), codex, or openai",
      process.env["EVIDENCE_DISCOVERY_PROVIDER"] ?? "codex",
    )
    .option("--port <port>", "fixed local demo port", process.env["EVIDENCE_DEMO_PORT"] ?? "4317");
  program.parse(process.argv);
  const options = program.opts<CliOptions>();
  if (!["offline", "codex", "openai"].includes(options.provider)) {
    throw new Error(`Unsupported provider ${JSON.stringify(options.provider)}`);
  }
  const port = Number(options.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`--port must be an integer from 1 through 65535; received ${options.port}`);
  }

  await cleanGeneratedBundle();
  const demo = await startDemoServer({ host: "127.0.0.1", port });
  try {
    process.stdout.write(`Discovery (${options.provider}) against ${demo.baseUrl}\n`);
    const discovered = await discoverArtifact(options.provider, demo.baseUrl);
    const replays: Record<string, unknown>[] = [];
    for (const scenario of SCENARIOS) {
      process.stdout.write(`Replay ${scenario.id}\n`);
      replays.push(
        await runScenario(
          scenario,
          discovered.artifact,
          discovered.artifactRef.sha256,
          demo.baseUrl,
        ),
      );
    }
    const genuineModel = options.provider !== "offline";
    const index = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      generator: {
        command: `npm run evidence -- --provider ${options.provider}`,
        demoOrigin: demo.baseUrl,
      },
      discovery: {
        runId: discovered.discovery.runId,
        provenanceClass: genuineModel ? "genuine-llm" : "offline-scripted-test-double",
        genuineModel,
        testDouble: !genuineModel,
        provider: discovered.discovery.planner.provider,
        model: discovered.discovery.planner.model,
        plannerCallCount: discovered.discovery.planner.callCount,
        eventLog: discovered.logRef,
        observations: discovered.observationDigest,
      },
      artifact: {
        ...discovered.artifactRef,
        schemaVersion: discovered.artifact.schemaVersion,
        capabilityId: discovered.artifact.capability.id,
        discoveryRunId: discovered.artifact.provenance.discoveryRunId,
      },
      replayGuarantee:
        "Every replay is artifact-driven. The verifier rejects model.decision events and requires plannerCallCount=0 at run completion.",
      replays,
    };
    await writeFile(INDEX_PATH, `${JSON.stringify(index, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    process.stdout.write(`Evidence index: ${INDEX_PATH}\n`);
  } finally {
    await demo.close();
  }
}

await main();
