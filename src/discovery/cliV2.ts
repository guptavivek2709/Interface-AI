import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { CapabilityCatalog, canonicalArtifactDigest } from "../catalog/index.js";
import { collectInputAssignment, readInvocationInputs } from "../cli/inputs.js";
import {
  CapabilityArtifactV2Schema,
  type CapabilityArtifactV2,
  type FieldSpecV2,
} from "../domain/index.js";
import { EventRecorder } from "../evidence/event-recorder.js";
import type { Planner } from "../model/planner.js";
import { createMeridianSurfaceOptions } from "../profiles/index.js";
import { PolicyEngine } from "../safety/policy.js";
import { Redactor } from "../safety/redactor.js";
import { sha256Digest } from "../security/digest.js";
import { PlaywrightSurface } from "../surface/playwright/playwrightSurface.js";
import { PlaywrightReplayRuntimeV2 } from "../surface/playwright/runtimeV2.js";
import { compileArtifactV2 } from "./artifactCompilerV2.js";
import {
  ArtifactLineageV2Schema,
  approveDiscoveredArtifactV2,
  createArtifactLineageV2,
  recordArtifactCanaryPassedV2,
  reviewDiscoveredArtifactV2,
} from "./artifactPromotionV2.js";
import { DiscoveryRunner } from "./discoveryRunner.js";
import { projectDiscoveryTraceV2 } from "./discoveryTraceV2.js";
import { runReadOnlyCanaryV2 } from "./readOnlyCanaryV2.js";
import { integrateReviewedMeridianContractV2 } from "./reviewedMeridianCandidateV2.js";
import {
  bootstrapRetainedMeridianSessionV2,
  meridianBootstrapCredentialsFromEnvironmentV2,
  type MeridianBootstrapCredentialsV2,
  type MeridianBootstrapRoleV2,
  type RetainedMeridianSessionV2,
} from "./retainedSessionBootstrapV2.js";

interface InputOptions {
  inputs?: string;
  input: string[];
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse((await readFile(path.resolve(filePath), "utf8")).replace(/^\uFEFF/u, "")) as unknown;
}

async function writeJson(filePath: string, value: unknown): Promise<string> {
  const destination = path.resolve(filePath);
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporary, destination);
  return destination;
}

async function publishJsonImmutable(filePath: string, value: unknown): Promise<string> {
  const destination = path.resolve(filePath);
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  try {
    try {
      // A hard-link install is atomic and cannot replace an existing version.
      await link(temporary, destination);
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) {
        throw error;
      }
      const existing = await readJson(destination);
      if (sha256Digest(existing) !== sha256Digest(value)) {
        throw new Error(`Refusing to overwrite immutable published file ${destination}`);
      }
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  return destination;
}

async function inputsFor(
  options: InputOptions,
  allowEmpty = false,
): Promise<Record<string, string | number | boolean>> {
  if (allowEmpty && !options.inputs && (options.input?.length ?? 0) === 0) return {};
  return readInvocationInputs({
    ...(options.inputs ? { inputs: options.inputs } : {}),
    input: options.input ?? [],
  });
}

async function anthropicPlanner(): Promise<Planner> {
  const { AnthropicPlanner } = await import("../model/anthropicPlanner.js");
  return new AnthropicPlanner();
}

function addInputs(command: Command): Command {
  return command
    .option("--inputs <json-or-path>", "Input JSON object or UTF-8 file path")
    .option("--input <name=value>", "Scalar input; repeat as needed", collectInputAssignment, []);
}

function bootstrapRole(value: string): MeridianBootstrapRoleV2 {
  if (value === "teller" || value === "supervisor") return value;
  throw new Error("--role must be teller or supervisor");
}

function assertCapabilityRole(
  capabilityId: string,
  risk: CapabilityArtifactV2["capability"]["risk"] | undefined,
  role: MeridianBootstrapRoleV2,
): void {
  if ((capabilityId === "account.place_hold" || risk === "supervisor_only") && role !== "supervisor") {
    throw new Error("The selected MERIDIAN capability requires --role supervisor");
  }
}

function credentialFreeHttpOrigin(value: string): string {
  const target = new URL(value);
  if (
    (target.protocol !== "http:" && target.protocol !== "https:") ||
    target.username.length > 0 ||
    target.password.length > 0
  ) {
    throw new Error("MERIDIAN target must be a credential-free HTTP(S) URL");
  }
  return target.origin;
}

async function publishedDiscoveredSignOn(): Promise<{
  artifact: CapabilityArtifactV2;
  digest: string;
}> {
  const artifactRoot = process.env.CAPABILITY_ARTIFACT_ROOT?.trim();
  const lineageRoot = process.env.CAPABILITY_LINEAGE_ROOT?.trim();
  if (!artifactRoot || !lineageRoot) {
    throw new Error(
      "CAPABILITY_ARTIFACT_ROOT and CAPABILITY_LINEAGE_ROOT are required after sign-on publication",
    );
  }
  const catalog = await CapabilityCatalog.load({
    directories: [path.resolve(artifactRoot)],
    lineageDirectories: [path.resolve(lineageRoot)],
    requireDiscoveryLineage: true,
  });
  const entry = catalog.resolve("session.sign_on", "2.0.0");
  if (!entry || entry.artifact.provenance.source !== "discovery") {
    throw new Error("The published catalog does not contain an approved discovered session.sign_on");
  }
  return {
    artifact: CapabilityArtifactV2Schema.parse(structuredClone(entry.artifact)),
    digest: entry.metadata.digest,
  };
}

export function createMeridianDiscoveryPolicyV2(origin: string): PolicyEngine {
  return new PolicyEngine({
    allowedOrigins: [origin],
    allowedRoutes: [{ origin, path: "/", match: "prefix" }],
    allowedActions: ["click", "fill", "select", "extract", "press"],
    // Transaction-entry links are conservatively keyword-classified critical
    // even though they only open a draft form. Discovery may observe those
    // prefixes; the reviewed recipe remains the hard boundary and rejects any
    // trace containing the first persistent mutation step.
    maxRisk: "critical",
  });
}

function signOnInputsFromCredentials(
  supplied: Readonly<Record<string, string | number | boolean>>,
  credentials: MeridianBootstrapCredentialsV2,
): Record<string, string> {
  if (Object.keys(supplied).length > 0) {
    throw new Error(
      "session.sign_on credentials must come from the role-scoped MERIDIAN environment profile, not CLI inputs",
    );
  }
  return {
    operator: credentials.operator,
    password: credentials.password,
    branch: credentials.branch,
  };
}

/**
 * Values already present as reviewed public contract vocabulary are not
 * meaningful leak canaries. This matters for the public demo credential
 * `password`, which is also the stable field name, and for branch enum values.
 * All other invocation values remain fail-closed denylist material.
 */
function privateInvocationValues(
  inputs: Readonly<Record<string, string | number | boolean>>,
  fields: readonly FieldSpecV2[],
): Array<string | number | boolean> {
  const publicContractValues = new Set<string | number | boolean>();
  for (const field of fields) {
    publicContractValues.add(field.name);
    if ("enum" in field.type && Array.isArray(field.type.enum)) {
      for (const value of field.type.enum) publicContractValues.add(value);
    }
  }
  return Object.values(inputs).filter((value) => !publicContractValues.has(value));
}

/** Register the production discovery and promotion lifecycle on the main CLI. */
export function registerDiscoveryV2Commands(program: Command): void {

addInputs(
  program
    .command("discover")
    .requiredOption("--capability <id>", "One of the eight reviewed MERIDIAN recipe IDs")
    .requiredOption("--target <url>", "Live entry point; session.sign_on must use the /signon route")
    .requiredOption("--goal <text>", "Discovery goal; caller values should use {{input}} placeholders")
    .option("--role <role>", "Role-scoped MERIDIAN credential profile: teller or supervisor", "teller")
    .option("--branch <branch>", "MERIDIAN branch retained for the authenticated session", "MAIN-001")
    .option("--output <dir>", "Trace/draft/lineage output directory", "evidence/generated/discovery-v2")
    .option("--headful", "Show the controlled browser", false),
).action(async (options: InputOptions & {
  capability: string;
  target: string;
  goal: string;
  role: string;
  branch: string;
  output: string;
  headful: boolean;
}) => {
  const suppliedInputs = await inputsFor(options, options.capability === "session.sign_on");
  const role = bootstrapRole(options.role);
  assertCapabilityRole(options.capability, undefined, role);
  const bootstrapCredentials = meridianBootstrapCredentialsFromEnvironmentV2(role, options.branch);
  const inputs = options.capability === "session.sign_on"
    ? signOnInputsFromCredentials(suppliedInputs, bootstrapCredentials)
    : suppliedInputs;
  const forbiddenValues = [
    ...Object.values(inputs),
    ...(bootstrapCredentials
      ? [bootstrapCredentials.operator, bootstrapCredentials.password, bootstrapCredentials.branch]
      : []),
  ];
  const redactor = new Redactor();
  redactor.registerMany(forbiddenValues.map(String));
  const runId = `discovery.${randomUUID()}`;
  const root = path.resolve(options.output, runId);
  const recorder = await EventRecorder.create({
    filePath: path.join(root, "discovery.jsonl"),
    runId,
    runMetadata: { mode: "discovery-v2", planner: "anthropic" },
    redactor,
  });
  const origin = credentialFreeHttpOrigin(options.target);
  const surface = new PlaywrightSurface(createMeridianSurfaceOptions(path.join(root, "screenshots"), {
    origin,
    headless: !options.headful,
  }));
  const policy = createMeridianDiscoveryPolicyV2(origin);
  let retained: RetainedMeridianSessionV2 | undefined;
  try {
    if (options.capability === "session.sign_on") {
      await surface.start(options.target);
    } else {
      const signOn = await publishedDiscoveredSignOn();
      retained = await bootstrapRetainedMeridianSessionV2({
        surface,
        origin,
        role,
        branch: options.branch,
        redactor,
        signOnArtifact: signOn.artifact,
        signOnArtifactDigest: signOn.digest,
      });
    }
    const result = await new DiscoveryRunner({
      surface,
      planner: await anthropicPlanner(),
      policy,
      recorder,
      redactor,
      goal: options.goal,
      inputs,
      runId,
    }).run();
    if (result.kind !== "success") {
      throw new Error(JSON.stringify(redactor.redact({ code: result.code, message: result.message })));
    }
    const trace = projectDiscoveryTraceV2(result, { inputs, plannerMode: "model" });
    const { meridianDiscoveryRecipeV2 } = await import("./recipes/index.js");
    const recipe = meridianDiscoveryRecipeV2(options.capability, trace);
    const privateValues = privateInvocationValues(inputs, recipe.inputs);
    const artifact = compileArtifactV2(trace, recipe, {
      forbiddenInputValues: privateValues,
    });
    const lineage = createArtifactLineageV2(trace, artifact, {
      forbiddenInputValues: privateValues,
    });
    const tracePath = await writeJson(path.join(root, "trace.json"), trace);
    const artifactPath = await writeJson(path.join(root, "draft.json"), artifact);
    const lineagePath = await writeJson(path.join(root, "lineage.json"), lineage);
    process.stdout.write(`${JSON.stringify({ runId, trace: tracePath, artifact: artifactPath, lineage: lineagePath, artifactDigest: canonicalArtifactDigest(artifact) }, null, 2)}\n`);
  } finally {
    try {
      await recorder.close();
    } finally {
      if (retained) await retained.close();
      else await surface.close();
    }
  }
});

addInputs(
  program
    .command("review")
    .requiredOption("--lineage <path>")
    .requiredOption("--draft <path>")
    .option(
      "--candidate <path>",
      "Human-edited candidate; defaults to the checked MERIDIAN contract integrated with the discovered prefix",
    )
    .requiredOption("--reviewer <id>")
    .requiredOption("--out-artifact <path>")
    .requiredOption("--out-lineage <path>"),
).action(async (options: InputOptions & {
  lineage: string;
  draft: string;
  candidate?: string;
  reviewer: string;
  outArtifact: string;
  outLineage: string;
}) => {
  const lineage = ArtifactLineageV2Schema.parse(await readJson(options.lineage));
  const draft = CapabilityArtifactV2Schema.parse(await readJson(options.draft));
  const inputs = await inputsFor(options, draft.capability.id === "session.sign_on");
  const candidate = options.candidate
    ? CapabilityArtifactV2Schema.parse(await readJson(options.candidate))
    : integrateReviewedMeridianContractV2(draft);
  const reviewed = reviewDiscoveredArtifactV2(lineage, draft, candidate, {
    reviewer: options.reviewer,
    forbiddenInputValues: privateInvocationValues(inputs, draft.inputs),
  });
  process.stdout.write(`${JSON.stringify({ artifact: await writeJson(options.outArtifact, candidate), lineage: await writeJson(options.outLineage, reviewed), reviewedDigest: reviewed.reviewedDigest }, null, 2)}\n`);
});

addInputs(
  program
    .command("canary")
    .requiredOption("--lineage <path>")
    .requiredOption("--artifact <path>")
    .option("--target <url>", "Override artifact entry point")
    .option("--role <role>", "Role-scoped MERIDIAN credential profile: teller or supervisor", "teller")
    .option("--branch <branch>", "MERIDIAN branch retained for the authenticated session", "MAIN-001")
    .option("--evidence <dir>", "Masked canary observations", "evidence/generated/canary-v2")
    .option("--headful", "Show the controlled browser", false)
    .requiredOption("--out-attestation <path>")
    .requiredOption("--out-lineage <path>"),
).action(async (options: InputOptions & {
  lineage: string;
  artifact: string;
  target?: string;
  role: string;
  branch: string;
  evidence: string;
  headful: boolean;
  outAttestation: string;
  outLineage: string;
}) => {
  const lineage = ArtifactLineageV2Schema.parse(await readJson(options.lineage));
  const artifact = CapabilityArtifactV2Schema.parse(await readJson(options.artifact));
  const suppliedInputs = await inputsFor(options, artifact.capability.id === "session.sign_on");
  const target = options.target ?? artifact.compatibility.entryPoint;
  const role = bootstrapRole(options.role);
  assertCapabilityRole(artifact.capability.id, artifact.capability.risk, role);
  const inputs = artifact.capability.id === "session.sign_on"
    ? signOnInputsFromCredentials(
        suppliedInputs,
        meridianBootstrapCredentialsFromEnvironmentV2(role, options.branch),
      )
    : suppliedInputs;
  const redactor = new Redactor();
  redactor.registerMany(Object.values(inputs).map(String));
  const surface = new PlaywrightSurface(createMeridianSurfaceOptions(path.resolve(options.evidence), {
    origin: credentialFreeHttpOrigin(target),
    headless: !options.headful,
  }));
  let retained: RetainedMeridianSessionV2 | undefined;
  try {
    if (artifact.capability.id === "session.sign_on") {
      await surface.start(target);
    } else {
      const signOn = await publishedDiscoveredSignOn();
      retained = await bootstrapRetainedMeridianSessionV2({
        surface,
        origin: credentialFreeHttpOrigin(target),
        role,
        branch: options.branch,
        redactor,
        signOnArtifact: signOn.artifact,
        signOnArtifactDigest: signOn.digest,
      });
    }
    const attestation = await runReadOnlyCanaryV2(artifact, {
      artifactDigest: lineage.reviewedDigest ?? "",
      inputs,
      runtime: new PlaywrightReplayRuntimeV2(surface, { targets: artifact.targets }),
    });
    await writeJson(options.outAttestation, attestation);
    if (attestation.status !== "passed") {
      process.exitCode = 2;
      process.stdout.write(`${JSON.stringify(attestation, null, 2)}\n`);
      return;
    }
    const advanced = recordArtifactCanaryPassedV2(lineage, artifact, attestation, {
      forbiddenInputValues: privateInvocationValues(inputs, artifact.inputs),
    });
    process.stdout.write(`${JSON.stringify({ status: "passed", attestation: path.resolve(options.outAttestation), lineage: await writeJson(options.outLineage, advanced) }, null, 2)}\n`);
  } finally {
    if (retained) await retained.close();
    else await surface.close();
  }
});

addInputs(
  program
    .command("approve")
    .requiredOption("--lineage <path>")
    .requiredOption("--artifact <path>")
    .requiredOption("--approver <id>")
    .requiredOption("--out-artifact <path>")
    .requiredOption("--out-lineage <path>"),
).action(async (options: InputOptions & {
  lineage: string;
  artifact: string;
  approver: string;
  outArtifact: string;
  outLineage: string;
}) => {
  const artifact = CapabilityArtifactV2Schema.parse(await readJson(options.artifact));
  const inputs = await inputsFor(options, artifact.capability.id === "session.sign_on");
  const promoted = approveDiscoveredArtifactV2(
    ArtifactLineageV2Schema.parse(await readJson(options.lineage)),
    artifact,
    { approver: options.approver, forbiddenInputValues: privateInvocationValues(inputs, artifact.inputs) },
  );
  process.stdout.write(`${JSON.stringify({ artifact: await writeJson(options.outArtifact, promoted.artifact), lineage: await writeJson(options.outLineage, promoted.lineage), approvedDigest: promoted.lineage.approvedDigest }, null, 2)}\n`);
});

program
  .command("publish")
  .requiredOption("--artifact <path>")
  .requiredOption("--lineage <path>")
  .requiredOption("--catalog-dir <dir>")
  .requiredOption("--lineage-dir <dir>")
  .action(async (options: { artifact: string; lineage: string; catalogDir: string; lineageDir: string }) => {
    const artifact = CapabilityArtifactV2Schema.parse(await readJson(options.artifact));
    const lineage = ArtifactLineageV2Schema.parse(await readJson(options.lineage));
    const digest = canonicalArtifactDigest(artifact);
    if (
      artifact.capability.approval !== "approved" ||
      artifact.provenance.source !== "discovery" ||
      lineage.stage !== "approved" ||
      lineage.discovery.mode !== "model" ||
      lineage.capabilityId !== artifact.capability.id ||
      lineage.capabilityVersion !== artifact.capability.version ||
      lineage.discovery.runId !== artifact.provenance.discoveryRunId ||
      lineage.approvedDigest !== digest
    ) {
      throw new Error("Publish requires exact approved artifact/lineage/digest binding from model discovery");
    }
    const catalogDirectory = path.resolve(options.catalogDir);
    const lineageDirectory = path.resolve(options.lineageDir);
    if (catalogDirectory.toLocaleLowerCase("en-US") === lineageDirectory.toLocaleLowerCase("en-US")) {
      throw new Error("Publish requires separate artifact and lineage directories");
    }
    const stem = `${artifact.capability.id}@${artifact.capability.version}`;
    const artifactPath = await publishJsonImmutable(path.join(catalogDirectory, `${stem}.json`), artifact);
    const lineagePath = await publishJsonImmutable(path.join(lineageDirectory, `${stem}.lineage.json`), lineage);
    await CapabilityCatalog.load({
      directories: [catalogDirectory],
      lineageDirectories: [lineageDirectory],
      requireDiscoveryLineage: true,
    });
    process.stdout.write(`${JSON.stringify({ status: "published", artifact: artifactPath, lineage: lineagePath, digest }, null, 2)}\n`);
  });
}
