#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { collectInputAssignment, readInvocationInputs } from "./cli/inputs.js";
import { compileArtifact } from "./discovery/artifactCompiler.js";
import { DiscoveryRunner } from "./discovery/discoveryRunner.js";
import { CapabilityArtifactSchema, type CapabilityArtifact } from "./domain/index.js";
import { EventRecorder } from "./evidence/event-recorder.js";
import { EvidenceStore } from "./evidence/store.js";
import { performDemoOperatorHandoff } from "./handoff/operatorServer.js";
import type { Planner } from "./model/planner.js";
import { createLegacyBankProfile } from "./profiles/index.js";
import { ReplayRunner } from "./replay/replayRunner.js";
import { PolicyEngine } from "./safety/policy.js";
import { Redactor } from "./safety/redactor.js";
import { JsonArtifactStore } from "./storage/jsonStore.js";
import { PlaywrightSurface } from "./surface/playwright/playwrightSurface.js";

const program = new Command();
const artifactStore = new JsonArtifactStore<CapabilityArtifact>(CapabilityArtifactSchema);

program
  .name("capability-engine")
  .description("Discover a UI capability with a model, then replay it deterministically.")
  .version("1.0.0");

interface CommonOptions {
  target: string;
  inputs?: string;
  input: string[];
  evidence: string;
  headful?: boolean;
}

async function plannerFor(name: string): Promise<Planner> {
  switch (name) {
    case "anthropic": {
      const { AnthropicPlanner } = await import("./model/anthropicPlanner.js");
      return new AnthropicPlanner();
    }
    case "openai": {
      const { OpenAIPlanner } = await import("./model/openaiPlanner.js");
      return new OpenAIPlanner();
    }
    case "codex": {
      const { CodexPlanner } = await import("./model/codexPlanner.js");
      return new CodexPlanner();
    }
    case "offline": {
      const { ScriptedPlanner } = await import("./model/scriptedPlanner.js");
      return new ScriptedPlanner();
    }
    default:
      throw new Error(
        `Unknown planner ${JSON.stringify(name)}; choose anthropic, openai, codex, or offline`,
      );
  }
}

function boundedIntegerOption(value: string, label: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new InvalidArgumentError(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return parsed;
}

function profileFor(target: string) {
  const url = new URL(target);
  return createLegacyBankProfile(url.origin);
}

function assertArtifactDoesNotContainInputs(
  artifact: CapabilityArtifact,
  inputs: Record<string, string | number | boolean>,
): void {
  const serialized = JSON.stringify(artifact);
  for (const value of Object.values(inputs)) {
    const text = String(value);
    const variants = new Set([
      text,
      encodeURIComponent(text),
      new URLSearchParams([["value", text]]).toString().slice("value=".length),
    ]);
    if (text.length >= 3 && [...variants].some((variant) => serialized.includes(variant))) {
      throw new Error(
        "Refusing to persist the artifact because it contains a discovery input value. " +
          "Keep caller values as typed input references.",
      );
    }
  }
}

program
  .command("discover")
  .description("Run the iterative model-driven discovery loop and save a typed artifact.")
  .requiredOption("--target <url>", "Target UI entry point")
  .option("--inputs <json-or-path>", "Input JSON object or UTF-8 file path")
  .option("--input <name=value>", "Scalar string input; repeat for each input", collectInputAssignment, [])
  .option("--goal <text>", "Natural-language goal with {{inputName}} placeholders")
  .option("--planner <provider>", "anthropic, openai, codex, or offline", "openai")
  .option(
    "--max-steps <count>",
    "Maximum model decisions",
    (value) => boundedIntegerOption(value, "max steps", 1, 100),
    24,
  )
  .option(
    "--timeout-ms <ms>",
    "Overall discovery deadline in milliseconds",
    (value) => boundedIntegerOption(value, "timeout", 10_000, 3_600_000),
    1_800_000,
  )
  .option("--artifact <path>", "Artifact output path", "evidence/generated/artifact.json")
  .option("--evidence <dir>", "Discovery evidence directory", "evidence/generated/discovery")
  .option("--headful", "Show the controlled browser", false)
  .option("--auto-handoff-demo", "Automatically exercise the synthetic human handoff", false)
  .action(async (options: CommonOptions & {
    goal?: string;
    planner: string;
    maxSteps: number;
    timeoutMs: number;
    artifact: string;
    autoHandoffDemo?: boolean;
  }) => {
    const inputs = await readInvocationInputs(options);
    const goal =
      options.goal ??
      "Look up member {{memberId}}, prepare a {{accountType}} sub-account named {{nickname}} with {{initialDeposit}}, stop at the Review ready checkpoint without creating it, and return exactly five outputs: memberName (string), memberId (string), accountType (string), nickname (string), and initialDeposit (money). Do not extract banners or other status prose.";
    const profile = profileFor(options.target);
    const redactor = new Redactor();
    redactor.registerMany(Object.values(inputs).map(String));
    const evidenceRoot = path.resolve(options.evidence);
    const runId = `discovery-${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`;
    const evidenceDirectory = path.join(evidenceRoot, runId);
    const recorder = await EventRecorder.create({
      filePath: path.join(evidenceDirectory, "discovery.jsonl"),
      runId,
      runMetadata: { mode: "discovery", planner: options.planner },
      redactor,
    });
    const policy = new PolicyEngine(profile.policy);
    const surface = new PlaywrightSurface({
      headless: !options.headful,
      observationDirectory: path.join(evidenceDirectory, "screenshots"),
      assertNavigationAllowed: (url, kind) => {
        policy.assertNavigationAllowed({ url, kind });
      },
      assertResourceAllowed: (url) => policy.assertResourceAllowed(url),
    });
    try {
      await surface.start(options.target);
      const result = await new DiscoveryRunner({
        surface,
        planner: await plannerFor(options.planner),
        policy,
        recorder,
        redactor,
        goal,
        inputs,
        maxSteps: options.maxSteps,
        timeoutMs: options.timeoutMs,
        ...(options.autoHandoffDemo ? { autoHandoff: performDemoOperatorHandoff } : {}),
        onOperatorAvailable: (url) => {
          process.stdout.write(`Discovery paused. Operate the same live session at ${url}\n`);
        },
      }).run();
      if (result.kind !== "success") {
        process.stdout.write(`${JSON.stringify(redactor.redact(result), null, 2)}\n`);
        process.exitCode = 1;
        return;
      }
      const artifact = compileArtifact(result, {
        compatibility: {
          surfaceAdapter: profile.surfaceAdapter,
          vendorProduct: profile.id,
          appVersion: "7.x",
          tenantVariant: new URL(options.target).searchParams.get("tenant") ?? "base",
          entryPoint: options.target,
        },
        policy: profile.policy,
        profile,
        sensitiveInvocationValues: Object.values(inputs),
      });
      assertArtifactDoesNotContainInputs(artifact, inputs);
      const stored = await artifactStore.save(options.artifact, artifact);
      await recorder.record("artifact.saved", {
        path: path.basename(stored.path),
        sha256: stored.sha256,
        schemaVersion: artifact.schemaVersion,
        capabilityId: artifact.capability.id,
        targetCount: artifact.targets.length,
        stepCount: artifact.steps.length,
      }, { actor: "system" });
      process.stdout.write(
        `${JSON.stringify({
          status: "success",
          artifact: stored.path,
          sha256: stored.sha256,
          planner: result.planner,
          outputs: result.outputs,
        }, null, 2)}\n`,
      );
    } finally {
      await recorder.close();
      await surface.close();
    }
  });

program
  .command("replay")
  .description("Replay a validated artifact without importing or invoking a model.")
  .requiredOption("--artifact <path>", "Artifact JSON path")
  .option("--inputs <json-or-path>", "Input JSON object or UTF-8 file path")
  .option("--input <name=value>", "Scalar string input; repeat for each input", collectInputAssignment, [])
  .option("--target <url>", "Override target entry point")
  .option("--evidence <dir>", "Replay evidence root", "evidence/generated/replay")
  .option("--headful", "Show the controlled browser", false)
  .option("--auto-handoff-demo", "Automatically exercise the synthetic human handoff", false)
  .action(async (options: Omit<CommonOptions, "target"> & {
    target?: string;
    artifact: string;
    autoHandoffDemo?: boolean;
  }) => {
    const { artifact, sha256 } = await artifactStore.load(options.artifact);
    const inputs = await readInvocationInputs(options);
    const target = options.target ?? artifact.compatibility.entryPoint;
    const redactor = new Redactor();
    const evidence = await EvidenceStore.create({ rootDirectory: options.evidence, redactor });
    const recorder = await EventRecorder.create({
      filePath: path.join(evidence.runDirectory, "replay.jsonl"),
      runId: evidence.runId,
      runMetadata: { mode: "replay", artifactSha256: sha256 },
      redactor,
    });
    const policy = new PolicyEngine(artifact.policy);
    const surface = new PlaywrightSurface({
      headless: !options.headful,
      observationDirectory: path.join(evidence.runDirectory, "observations"),
      assertNavigationAllowed: (url, kind) => {
        policy.assertNavigationAllowed({ url, kind });
      },
      assertResourceAllowed: (url) => policy.assertResourceAllowed(url),
    });
    try {
      await surface.start(target);
      const result = await new ReplayRunner({
        artifact,
        inputs,
        surface,
        recorder,
        evidence,
        redactor,
        ...(options.autoHandoffDemo ? { autoHandoff: performDemoOperatorHandoff } : {}),
        onOperatorAvailable: (url) => {
          process.stdout.write(`Automation paused. Operate the same live session at ${url}\n`);
        },
      }).run();
      await evidence.writeManifest({ status: result.status, artifactSha256: sha256 });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (result.status === "failure") process.exitCode = 1;
    } finally {
      await recorder.close();
      await surface.close();
    }
  });

program
  .command("inspect")
  .description("Validate and print the agent-facing contract of a capability artifact.")
  .requiredOption("--artifact <path>", "Artifact JSON path")
  .action(async (options: { artifact: string }) => {
    const { artifact, sha256 } = await artifactStore.load(options.artifact);
    process.stdout.write(
      `${JSON.stringify({
        id: artifact.capability.id,
        name: artifact.capability.name,
        version: artifact.capability.version,
        approval: artifact.capability.approval,
        description: artifact.capability.description,
        inputs: artifact.inputs,
        outputs: artifact.outputs,
        businessOutcomes: artifact.businessOutcomes.map(({ code, description }) => ({ code, description })),
        sha256,
      }, null, 2)}\n`,
    );
  });

await program.parseAsync(process.argv);
