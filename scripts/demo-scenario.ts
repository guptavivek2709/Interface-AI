import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Route } from "playwright";
import { ApprovalAuthority } from "../src/approval/index.js";
import {
  canonicalArtifactDigest,
  loadConfiguredCapabilityCatalog,
  type CapabilityCatalog,
} from "../src/catalog/index.js";
import type {
  CapabilityArtifactV2,
  ReplayProgressV2,
  RunValueV2,
} from "../src/domain/index.js";
import { CapabilityArtifactV2Schema } from "../src/domain/index.js";
import { EventRecorder, EvidenceStore } from "../src/evidence/index.js";
import { restoreSameMeridianSession } from "../src/execution/index.js";
import {
  bindArtifactToTargetProfile,
  createMeridianSurfaceOptions,
  createMeridianTargetProfile,
  MERIDIAN_DEFAULT_ORIGIN,
  normalizeMeridianOrigin,
  targetProfileDigest,
  type TargetInstanceProfileV2,
} from "../src/profiles/index.js";
import { ReplayRunnerV2 } from "../src/replay/replayRunnerV2.js";
import { Redactor } from "../src/safety/redactor.js";
import { PlaywrightSurface } from "../src/surface/playwright/playwrightSurface.js";
import { PlaywrightReplayRuntimeV2 } from "../src/surface/playwright/runtimeV2.js";
import type { RuntimeValue } from "../src/surface/replayRuntimeV2.js";

export const HOSTED_DEMO_SCENARIOS = [
  "balance-success",
  "member-not-found",
  "maintenance-recovery",
  "session-timeout",
  "application-error",
  "supervisor-required",
  "transfer-success",
  "share-open-success",
  "member-update-success",
  "hold-supervisor-handoff",
  "validation-rejected",
] as const;

export type HostedDemoScenario = (typeof HOSTED_DEMO_SCENARIOS)[number];
type HostedReadScenario = Exclude<
  HostedDemoScenario,
  "transfer-success" | "share-open-success" | "member-update-success" | "hold-supervisor-handoff"
>;
export type MeridianInjectedFault =
  | "validation"
  | "notfound"
  | "permission"
  | "timeout"
  | "maintenance"
  | "server";

export interface HostedDemoEnvironment {
  readonly origin: string;
  readonly operator: string;
  readonly password: string;
  readonly supervisorOperator: string;
  readonly supervisorPassword: string;
  readonly branch: "MAIN-001" | "WEST-014" | "EAST-022";
  readonly memberNumber: string;
  readonly missingMemberNumber: string;
  readonly evidenceRoot: string;
  readonly headless: boolean;
}

interface BoundCapability {
  readonly artifact: CapabilityArtifactV2;
  readonly baseArtifactDigest: string;
  readonly targetProfileDigest: string;
}

interface ScenarioObservation {
  readonly status: "success" | "business_outcome" | "failure" | "escalation" | "awaiting_human";
  readonly code?: string;
  readonly capabilityId: string;
  readonly outputKeys?: readonly string[];
  readonly incidentCodes: readonly string[];
}

export interface HostedScenarioResult {
  readonly scenario: HostedDemoScenario;
  readonly status: "verified";
  readonly observation: ScenarioObservation;
  readonly assertion: Readonly<Record<string, RunValueV2>>;
  readonly artifactDigests: readonly string[];
  readonly targetProfileDigest: string;
  readonly evidenceDirectory: string;
  readonly manifestSha256: string;
  readonly plannerCallsAllowed: false;
}

const BRANCHES = ["MAIN-001", "WEST-014", "EAST-022"] as const;
const MEMBER_NUMBER = /^[0-9]{6}$/u;
const SHARE_ID = /^[0-9]{6}-[A-Z0-9-]{5,20}$/u;
const INJECTABLE_MEMBER_ROUTE = /^\/members\/[0-9]{6}$/u;
const ONE_DOLLAR = Object.freeze({ currency: "USD", amount: "1.00", minorUnits: 100 });
const FIVE_DOLLARS = Object.freeze({ currency: "USD", amount: "5.00", minorUnits: 500 });
const TRANSFER_MEMO = "Capability demo one-dollar transfer";
const HOLD_NOTES = "Capability demo verified hold";

function requiredEnvironmentValue(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is required for hosted MERIDIAN demo scenarios`);
  }
  return value;
}

export function parseHostedDemoScenario(value: string | undefined): HostedDemoScenario {
  if (value && (HOSTED_DEMO_SCENARIOS as readonly string[]).includes(value)) {
    return value as HostedDemoScenario;
  }
  throw new Error(`Scenario must be one of: ${HOSTED_DEMO_SCENARIOS.join(", ")}`);
}

/**
 * The demo command intentionally cannot be redirected to localhost or a test
 * server. Tests exercise only its pure configuration and URL-policy helpers;
 * execution always targets the assignment's hosted MERIDIAN instance.
 */
export function loadHostedDemoEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): HostedDemoEnvironment {
  if (environment.MERIDIAN_DEMO_SCENARIOS !== "1") {
    throw new Error("Set MERIDIAN_DEMO_SCENARIOS=1 to enable real hosted demo execution");
  }
  const origin = normalizeMeridianOrigin(environment.MERIDIAN_ORIGIN ?? MERIDIAN_DEFAULT_ORIGIN);
  if (origin !== MERIDIAN_DEFAULT_ORIGIN) {
    throw new Error(`Demo scenarios are restricted to ${MERIDIAN_DEFAULT_ORIGIN}`);
  }
  const operator = requiredEnvironmentValue(environment, "MERIDIAN_TELLER_OPERATOR").trim();
  const password = requiredEnvironmentValue(environment, "MERIDIAN_TELLER_PASSWORD");
  const supervisorOperator = requiredEnvironmentValue(environment, "MERIDIAN_SUPERVISOR_OPERATOR").trim();
  const supervisorPassword = requiredEnvironmentValue(environment, "MERIDIAN_SUPERVISOR_PASSWORD");
  const branch = (environment.MERIDIAN_DEMO_BRANCH?.trim() || "MAIN-001") as HostedDemoEnvironment["branch"];
  if (!(BRANCHES as readonly string[]).includes(branch)) {
    throw new Error(`MERIDIAN_DEMO_BRANCH must be one of: ${BRANCHES.join(", ")}`);
  }
  const memberNumber = environment.MERIDIAN_DEMO_MEMBER_NUMBER?.trim() || "100234";
  const missingMemberNumber = environment.MERIDIAN_DEMO_MISSING_MEMBER_NUMBER?.trim() || "999999";
  if (!MEMBER_NUMBER.test(memberNumber)) {
    throw new Error("MERIDIAN_DEMO_MEMBER_NUMBER must be a six-digit member number");
  }
  if (!MEMBER_NUMBER.test(missingMemberNumber) || missingMemberNumber === memberNumber) {
    throw new Error("MERIDIAN_DEMO_MISSING_MEMBER_NUMBER must be a different six-digit member number");
  }
  const headful = environment.MERIDIAN_HEADFUL ?? "0";
  if (headful !== "0" && headful !== "1") {
    throw new Error("MERIDIAN_HEADFUL must be 0 or 1");
  }
  return Object.freeze({
    origin,
    operator,
    password,
    supervisorOperator,
    supervisorPassword,
    branch,
    memberNumber,
    missingMemberNumber,
    evidenceRoot: path.resolve(environment.MERIDIAN_DEMO_EVIDENCE_ROOT ?? path.join("evidence", "v2")),
    headless: headful !== "1",
  });
}

/**
 * Return the one permitted demo rewrite. It never accepts a model/business
 * argument and cannot alter POST requests, transaction routes, or origins.
 */
export function injectedMemberNavigationUrl(options: {
  readonly rawUrl: string;
  readonly method: string;
  readonly origin: string;
  readonly fault: MeridianInjectedFault;
}): string | undefined {
  if (options.method.toUpperCase() !== "GET") return undefined;
  let url: URL;
  try {
    url = new URL(options.rawUrl);
  } catch {
    return undefined;
  }
  if (
    url.origin !== normalizeMeridianOrigin(options.origin) ||
    !INJECTABLE_MEMBER_ROUTE.test(url.pathname) ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return undefined;
  }
  url.searchParams.set("inject", options.fault);
  return url.toString();
}

async function installOneShotFaultAdapter(
  surface: PlaywrightSurface,
  origin: string,
  fault: MeridianInjectedFault,
  recorder: EventRecorder,
): Promise<{ readonly wasApplied: () => boolean; readonly remove: () => Promise<void> }> {
  let applied = false;
  const handler = async (route: Route): Promise<void> => {
    const request = route.request();
    const rewritten = !applied && request.isNavigationRequest() && request.resourceType() === "document"
      ? injectedMemberNavigationUrl({
          rawUrl: request.url(),
          method: request.method(),
          origin,
          fault,
        })
      : undefined;
    if (!rewritten) {
      await route.fallback();
      return;
    }
    applied = true;
    await recorder.record("demo.fault_injected", {
      fault,
      scope: "next_member_detail_get",
      target: "hosted_meridian",
    }, { actor: "system" });
    // fallback, rather than continue, deliberately preserves the production
    // surface's existing origin/route/query guard as the next route handler.
    await route.fallback({ url: rewritten });
  };
  await surface.context.route("**/*", handler);
  return {
    wasApplied: () => applied,
    remove: () => surface.context.unroute("**/*", handler),
  };
}

function bindCapability(
  artifact: CapabilityArtifactV2,
  profile: TargetInstanceProfileV2,
): BoundCapability {
  const binding = bindArtifactToTargetProfile(
    artifact,
    canonicalArtifactDigest(artifact),
    profile,
  );
  return {
    artifact: binding.artifact,
    baseArtifactDigest: binding.baseArtifactDigest,
    targetProfileDigest: binding.targetProfileDigest,
  };
}

function publishedCapability(
  catalog: CapabilityCatalog,
  capabilityId: string,
): CapabilityArtifactV2 {
  const entry = catalog.resolve(capabilityId, "2.0.0");
  if (!entry) throw new Error(`Published capability ${capabilityId}@2.0.0 is unavailable`);
  const artifact = CapabilityArtifactV2Schema.parse(entry.artifact);
  if (
    artifact.capability.approval !== "approved" ||
    artifact.provenance.source !== "discovery" ||
    !entry.metadata.lineage ||
    entry.metadata.lineage.approvedDigest !== entry.metadata.digest
  ) {
    throw new Error(`Published capability ${capabilityId}@2.0.0 lacks exact approved discovery lineage`);
  }
  return artifact;
}

function createRunner(options: {
  readonly bound: BoundCapability;
  readonly inputs: Record<string, RuntimeValue>;
  readonly surface: PlaywrightSurface;
  readonly authority: ApprovalAuthority;
  readonly recorder: EventRecorder;
  readonly evidence: EvidenceStore;
  readonly redactor: Redactor;
  readonly runId: string;
  readonly authenticateSupervisor?: () => Promise<void>;
  readonly currentPrincipalRole?: () => string | undefined;
}): ReplayRunnerV2 {
  return new ReplayRunnerV2({
    artifact: options.bound.artifact,
    artifactDigest: options.bound.baseArtifactDigest,
    targetProfileDigest: options.bound.targetProfileDigest,
    inputs: options.inputs,
    runtime: new PlaywrightReplayRuntimeV2(options.surface, options.bound.artifact),
    approvalAuthority: options.authority,
    recorder: options.recorder,
    evidence: options.evidence,
    redactor: options.redactor,
    runId: options.runId,
    ...(options.authenticateSupervisor
      ? { authenticateSupervisor: options.authenticateSupervisor }
      : {}),
    ...(options.currentPrincipalRole
      ? { currentPrincipalRole: options.currentPrincipalRole }
      : {}),
  });
}

function requireTerminalSuccess(progress: ReplayProgressV2, stage: string) {
  if (progress.status !== "terminal" || progress.result.status !== "success") {
    throw new Error(`${stage} did not reach its exact success checkpoint`);
  }
  return progress.result;
}

function observationFromProgress(
  progress: ReplayProgressV2,
  capabilityId: string,
): ScenarioObservation {
  if (progress.status === "awaiting_human") {
    return {
      status: "awaiting_human",
      code: progress.intervention.reasonCode,
      capabilityId,
      incidentCodes: progress.incidents.map((incident) => incident.code),
    };
  }
  if (progress.status === "awaiting_approval") {
    throw new Error("Scenario stopped at an unexpected approval checkpoint");
  }
  return {
    status: progress.result.status,
    ...(progress.result.status === "success" ? {} : { code: progress.result.code }),
    capabilityId,
    ...(progress.result.status === "success"
      ? { outputKeys: Object.keys(progress.result.outputs).sort() }
      : {}),
    incidentCodes: progress.result.incidents.map((incident) => incident.code),
  };
}

function assertReadScenario(
  scenario: HostedReadScenario,
  progress: ReplayProgressV2,
  injectionApplied: boolean,
): Readonly<Record<string, RunValueV2>> {
  if (scenario === "balance-success") {
    const result = requireTerminalSuccess(progress, scenario);
    if (!Array.isArray(result.outputs.shares) || result.outputs.shares.length === 0) {
      throw new Error("balance-success did not return a non-empty typed share set");
    }
    return { typedShareSet: true, shareCount: result.outputs.shares.length };
  }
  if (scenario === "member-not-found") {
    if (
      progress.status !== "terminal" ||
      progress.result.status !== "business_outcome" ||
      progress.result.code !== "MEMBER_NOT_FOUND"
    ) {
      throw new Error("member-not-found was not classified as the expected business outcome");
    }
    return { naturalBusinessOutcome: true, injectedFault: false };
  }
  if (!injectionApplied) throw new Error(`${scenario} did not exercise the hosted inject behavior`);
  if (scenario === "maintenance-recovery") {
    const result = requireTerminalSuccess(progress, scenario);
    const incidents = result.incidents.filter(
      (incident) => incident.code === "MAINTENANCE" && incident.category === "recoverable",
    );
    if (incidents.length !== 1 || incidents[0]?.recoveryAttempt !== 1) {
      throw new Error("maintenance-recovery did not perform exactly one bounded recovery");
    }
    return { injectedFault: true, boundedRecoveryAttempts: 1, eventualSuccess: true };
  }
  if (scenario === "session-timeout") {
    if (
      progress.status !== "awaiting_human" ||
      progress.intervention.reasonCode !== "SESSION_EXPIRED" ||
      progress.intervention.action !== "restore_session" ||
      progress.intervention.sameLiveSession !== true
    ) {
      throw new Error("session-timeout did not create a same-session restore intervention");
    }
    return { injectedFault: true, sameLiveSession: true, action: "restore_session" };
  }
  if (scenario === "supervisor-required") {
    if (
      progress.status !== "awaiting_human" ||
      progress.intervention.reasonCode !== "SUPERVISOR_REQUIRED" ||
      progress.intervention.action !== "authenticate_supervisor" ||
      progress.intervention.requiredRole !== "supervisor" ||
      progress.intervention.sameLiveSession !== true
    ) {
      throw new Error("supervisor-required did not create a same-session supervisor intervention");
    }
    return {
      injectedFault: true,
      sameLiveSession: true,
      action: "authenticate_supervisor",
      requiredRole: "supervisor",
    };
  }
  if (scenario === "validation-rejected") {
    if (
      progress.status !== "terminal" ||
      progress.result.status !== "business_outcome" ||
      progress.result.code !== "VALIDATION_REJECTED"
    ) {
      throw new Error("validation-rejected was not classified as a non-applied business outcome");
    }
    return { injectedFault: true, naturalBusinessOutcome: false, effectApplied: false };
  }
  if (
    progress.status !== "terminal" ||
    progress.result.status !== "failure" ||
    progress.result.code !== "APPLICATION_ERROR" ||
    progress.result.effectUncertain
  ) {
    throw new Error("application-error was not classified as a pre-write hard failure");
  }
  return { injectedFault: true, preWriteFailure: true, effectUncertain: false };
}

interface TypedShare {
  readonly shareId: string;
  readonly status: string;
  readonly balanceMinorUnits: number;
}

function moneyMinorUnits(value: RuntimeValue | undefined): number {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.currency !== "USD" ||
    typeof value.minorUnits !== "number" ||
    !Number.isSafeInteger(value.minorUnits)
  ) {
    throw new Error("MERIDIAN returned an invalid typed USD value");
  }
  return value.minorUnits;
}

function typedShares(value: RuntimeValue | undefined): TypedShare[] {
  if (!Array.isArray(value)) throw new Error("MERIDIAN did not return the declared share array");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("MERIDIAN returned a malformed share row");
    }
    if (
      typeof item.share_id !== "string" ||
      !SHARE_ID.test(item.share_id) ||
      typeof item.status !== "string"
    ) {
      throw new Error("MERIDIAN returned a share row without its typed identity/status");
    }
    return {
      shareId: item.share_id,
      status: item.status,
      balanceMinorUnits: moneyMinorUnits(item.balance),
    };
  });
}

function selectOneDollarTransfer(shares: readonly TypedShare[]): {
  readonly source: TypedShare;
  readonly destination: TypedShare;
} {
  const usable = shares
    .filter((share) => !share.status.toLocaleUpperCase("en-US").includes("HOLD"))
    .sort((left, right) => left.shareId.localeCompare(right.shareId, "en-US"));
  const source = [...usable]
    .filter((share) => share.balanceMinorUnits >= ONE_DOLLAR.minorUnits)
    .sort((left, right) => right.balanceMinorUnits - left.balanceMinorUnits || left.shareId.localeCompare(right.shareId, "en-US"))[0];
  const destination = usable.find((share) => share.shareId !== source?.shareId);
  if (!source || !destination) {
    throw new Error("The configured member needs two non-held shares for the one-dollar demo transfer");
  }
  return { source, destination };
}

function assertExactTransferReview(
  progress: Extract<ReplayProgressV2, { status: "awaiting_approval" }>,
  expected: { member: string; source: string; destination: string },
): void {
  if (progress.challenge.requirement !== "user_confirmation") {
    throw new Error("Transfer did not request the declared user confirmation");
  }
  const summary = Object.fromEntries(
    progress.challenge.summary.map((item) => [item.targetId, item.value]),
  );
  // MERIDIAN decorates member/share identifiers with human-readable names,
  // types, and balances on its review page. The stable identifiers must occur
  // in their exact, separately resolved fields; the signed approval remains
  // bound to the complete decorated values through reviewDigest.
  const containsIdentifier = (value: RunValueV2 | undefined, identifier: string) =>
    typeof value === "string" && value.includes(identifier);
  const mismatches = [
    ...(progress.challenge.summary.length === 5 ? [] : ["cardinality"]),
    ...(containsIdentifier(summary.review_member, expected.member) ? [] : ["member"]),
    ...(containsIdentifier(summary.review_from, expected.source) ? [] : ["source"]),
    ...(containsIdentifier(summary.review_to, expected.destination) ? [] : ["destination"]),
    ...(summary.review_memo === TRANSFER_MEMO ? [] : ["memo"]),
    ...(typeof summary.review_amount === "string" && /^\$?1\.00$/u.test(summary.review_amount)
      ? []
      : ["amount"]),
  ];
  if (mismatches.length > 0) {
    throw new Error(`Transfer approval summary mismatch: ${mismatches.join(",")}`);
  }
}

async function runBalanceStage(options: {
  readonly memberNumber: string;
  readonly bound: BoundCapability;
  readonly surface: PlaywrightSurface;
  readonly authority: ApprovalAuthority;
  readonly recorder: EventRecorder;
  readonly evidence: EvidenceStore;
  readonly redactor: Redactor;
  readonly runId: string;
}) {
  const runner = createRunner({
    ...options,
    inputs: { member_number: options.memberNumber },
  });
  return runner.run();
}

async function runTransferScenario(options: {
  readonly environment: HostedDemoEnvironment;
  readonly catalog: CapabilityCatalog;
  readonly profile: TargetInstanceProfileV2;
  readonly surface: PlaywrightSurface;
  readonly authority: ApprovalAuthority;
  readonly recorder: EventRecorder;
  readonly evidence: EvidenceStore;
  readonly redactor: Redactor;
  readonly outerRunId: string;
}): Promise<{
  readonly progress: ReplayProgressV2;
  readonly assertion: Readonly<Record<string, RunValueV2>>;
  readonly artifactDigests: readonly string[];
}> {
  const balance = bindCapability(
    publishedCapability(options.catalog, "member.get_record_and_balances"),
    options.profile,
  );
  const transfer = bindCapability(publishedCapability(options.catalog, "funds.transfer"), options.profile);
  const beforeProgress = await runBalanceStage({
    memberNumber: options.environment.memberNumber,
    bound: balance,
    surface: options.surface,
    authority: options.authority,
    recorder: options.recorder,
    evidence: options.evidence,
    redactor: options.redactor,
    runId: `${options.outerRunId}-before`,
  });
  const before = requireTerminalSuccess(beforeProgress, "transfer pre-read");
  const selected = selectOneDollarTransfer(typedShares(before.outputs.shares));
  options.redactor.registerMany([
    selected.source.shareId,
    selected.destination.shareId,
    TRANSFER_MEMO,
  ]);

  const runner = createRunner({
    bound: transfer,
    inputs: {
      member_number: options.environment.memberNumber,
      from_share: selected.source.shareId,
      to_share: selected.destination.shareId,
      amount: ONE_DOLLAR,
      memo: TRANSFER_MEMO,
    },
    surface: options.surface,
    authority: options.authority,
    recorder: options.recorder,
    evidence: options.evidence,
    redactor: options.redactor,
    runId: `${options.outerRunId}-transfer`,
  });
  const paused = await runner.run();
  if (paused.status !== "awaiting_approval") {
    throw new Error("Transfer did not stop at its exact approval boundary");
  }
  assertExactTransferReview(paused, {
    member: options.environment.memberNumber,
    source: selected.source.shareId,
    destination: selected.destination.shareId,
  });
  const completed = await runner.resume(runner.issueApproval({
    id: "hosted-demo-teller",
    roles: ["teller"],
  }));
  const write = requireTerminalSuccess(completed, "transfer-success");
  const sourceBefore = moneyMinorUnits(write.outputs.source_balance_before);
  const destinationBefore = moneyMinorUnits(write.outputs.destination_balance_before);
  const sourceReceipt = moneyMinorUnits(write.outputs.source_balance);
  const destinationReceipt = moneyMinorUnits(write.outputs.destination_balance);
  if (
    sourceBefore !== selected.source.balanceMinorUnits ||
    destinationBefore !== selected.destination.balanceMinorUnits ||
    moneyMinorUnits(write.outputs.amount) !== ONE_DOLLAR.minorUnits ||
    sourceReceipt !== sourceBefore - ONE_DOLLAR.minorUnits ||
    destinationReceipt !== destinationBefore + ONE_DOLLAR.minorUnits ||
    typeof write.outputs.confirmation !== "string" ||
    write.outputs.confirmation.length === 0 ||
    typeof write.outputs.posted_at !== "string" ||
    write.outputs.posted_at.length === 0
  ) {
    throw new Error("Transfer receipt did not prove the exact one-dollar balance deltas");
  }

  const afterProgress = await runBalanceStage({
    memberNumber: options.environment.memberNumber,
    bound: balance,
    surface: options.surface,
    authority: options.authority,
    recorder: options.recorder,
    evidence: options.evidence,
    redactor: options.redactor,
    runId: `${options.outerRunId}-after`,
  });
  const after = requireTerminalSuccess(afterProgress, "transfer read-after-write");
  const afterShares = typedShares(after.outputs.shares);
  const sourceAfter = afterShares.find((share) => share.shareId === selected.source.shareId);
  const destinationAfter = afterShares.find((share) => share.shareId === selected.destination.shareId);
  if (
    sourceAfter?.balanceMinorUnits !== sourceReceipt ||
    destinationAfter?.balanceMinorUnits !== destinationReceipt
  ) {
    throw new Error("Read-after-write did not confirm the posted one-dollar transfer");
  }
  return {
    progress: completed,
    assertion: {
      amountMinorUnits: ONE_DOLLAR.minorUnits,
      exactApproval: true,
      oneCommitAttempt: write.journal.filter((entry) => entry.stepId === "commit_transfer").length === 1,
      receiptDeltaVerified: true,
      readAfterWriteVerified: true,
      confirmationPresent: true,
    },
    artifactDigests: [balance.baseArtifactDigest, transfer.baseArtifactDigest],
  };
}

interface HostedTransactionOptions {
  readonly environment: HostedDemoEnvironment;
  readonly catalog: CapabilityCatalog;
  readonly profile: TargetInstanceProfileV2;
  readonly surface: PlaywrightSurface;
  readonly authority: ApprovalAuthority;
  readonly recorder: EventRecorder;
  readonly evidence: EvidenceStore;
  readonly redactor: Redactor;
  readonly outerRunId: string;
}

function exactApprovalSummary(
  progress: Extract<ReplayProgressV2, { status: "awaiting_approval" }>,
  requirement: "user_confirmation" | "supervisor_confirmation",
  targetIds: readonly string[],
): Readonly<Record<string, RunValueV2>> {
  if (progress.challenge.requirement !== requirement) {
    throw new Error(`Expected ${requirement} but received ${progress.challenge.requirement}`);
  }
  if (
    progress.challenge.summary.length !== targetIds.length ||
    progress.challenge.summary.some((item) => !targetIds.includes(item.targetId))
  ) {
    throw new Error("Approval summary did not contain the exact reviewed fields");
  }
  return Object.fromEntries(progress.challenge.summary.map((item) => [item.targetId, item.value]));
}

async function runOpenShareScenario(options: HostedTransactionOptions): Promise<{
  readonly progress: ReplayProgressV2;
  readonly newShareId: string;
  readonly assertion: Readonly<Record<string, RunValueV2>>;
  readonly artifactDigests: readonly string[];
}> {
  const balance = bindCapability(
    publishedCapability(options.catalog, "member.get_record_and_balances"),
    options.profile,
  );
  const openShare = bindCapability(publishedCapability(options.catalog, "share.open"), options.profile);
  const runner = createRunner({
    bound: openShare,
    inputs: {
      member_number: options.environment.memberNumber,
      share_type: "S0001",
      initial_deposit: FIVE_DOLLARS,
    },
    surface: options.surface,
    authority: options.authority,
    recorder: options.recorder,
    evidence: options.evidence,
    redactor: options.redactor,
    runId: `${options.outerRunId}-open-share`,
  });
  const paused = await runner.run();
  if (paused.status !== "awaiting_approval") {
    throw new Error("Open-share run did not stop at its exact approval boundary");
  }
  const summary = exactApprovalSummary(paused, "user_confirmation", [
    "review_member",
    "review_type",
    "review_deposit",
  ]);
  if (
    typeof summary.review_member !== "string" ||
    !summary.review_member.includes(options.environment.memberNumber) ||
    typeof summary.review_type !== "string" ||
    !summary.review_type.includes("S0001") ||
    typeof summary.review_deposit !== "string" ||
    !/^\$?5\.00$/u.test(summary.review_deposit)
  ) {
    throw new Error("Open-share approval summary did not match the exact requested values");
  }
  const completed = await runner.resume(runner.issueApproval({
    id: "hosted-demo-teller",
    roles: ["teller"],
  }));
  const write = requireTerminalSuccess(completed, "share-open-success");
  if (
    typeof write.outputs.new_share_id !== "string" ||
    !SHARE_ID.test(write.outputs.new_share_id) ||
    typeof write.outputs.confirmation !== "string" ||
    write.outputs.confirmation.length === 0 ||
    moneyMinorUnits(write.outputs.opening_balance) !== FIVE_DOLLARS.minorUnits
  ) {
    throw new Error("Open-share receipt did not prove the exact created share and opening balance");
  }
  const newShareId = write.outputs.new_share_id;
  options.redactor.register(newShareId);
  if (typedShares(write.outputs.shares_before).some((share) => share.shareId === newShareId)) {
    throw new Error("Open-share receipt reused a share that existed before the commit");
  }
  const afterProgress = await runBalanceStage({
    memberNumber: options.environment.memberNumber,
    bound: balance,
    surface: options.surface,
    authority: options.authority,
    recorder: options.recorder,
    evidence: options.evidence,
    redactor: options.redactor,
    runId: `${options.outerRunId}-open-share-after`,
  });
  const after = requireTerminalSuccess(afterProgress, "open-share read-after-write");
  const created = typedShares(after.outputs.shares).find((share) => share.shareId === newShareId);
  if (created?.balanceMinorUnits !== FIVE_DOLLARS.minorUnits) {
    throw new Error("Read-after-write did not confirm the newly opened share");
  }
  return {
    progress: completed,
    newShareId,
    assertion: {
      openingBalanceMinorUnits: FIVE_DOLLARS.minorUnits,
      exactApproval: true,
      oneCommitAttempt: write.journal.filter((entry) => entry.stepId === "commit_new_share").length === 1,
      receiptVerified: true,
      readAfterWriteVerified: true,
    },
    artifactDigests: [openShare.baseArtifactDigest, balance.baseArtifactDigest],
  };
}

async function runMemberUpdateScenario(options: HostedTransactionOptions): Promise<{
  readonly progress: ReplayProgressV2;
  readonly assertion: Readonly<Record<string, RunValueV2>>;
  readonly artifactDigests: readonly string[];
}> {
  const balance = bindCapability(
    publishedCapability(options.catalog, "member.get_record_and_balances"),
    options.profile,
  );
  const update = bindCapability(
    publishedCapability(options.catalog, "member.update_information"),
    options.profile,
  );
  const beforeProgress = await runBalanceStage({
    memberNumber: options.environment.memberNumber,
    bound: balance,
    surface: options.surface,
    authority: options.authority,
    recorder: options.recorder,
    evidence: options.evidence,
    redactor: options.redactor,
    runId: `${options.outerRunId}-update-before`,
  });
  const before = requireTerminalSuccess(beforeProgress, "member-update pre-read");
  const email = before.outputs.email;
  const phone = before.outputs.phone;
  const address = before.outputs.address;
  if (
    typeof email !== "string" ||
    typeof phone !== "string" ||
    typeof address !== "string" ||
    email.length === 0 ||
    phone.length === 0 ||
    address.length < 5
  ) {
    throw new Error("Member-update pre-read did not return valid current contact values");
  }
  options.redactor.registerMany([email, phone, address]);
  const runner = createRunner({
    bound: update,
    inputs: { member_number: options.environment.memberNumber, email, phone, address },
    surface: options.surface,
    authority: options.authority,
    recorder: options.recorder,
    evidence: options.evidence,
    redactor: options.redactor,
    runId: `${options.outerRunId}-update`,
  });
  const paused = await runner.run();
  if (paused.status !== "awaiting_approval") {
    throw new Error("Member-update run did not stop at its exact approval boundary");
  }
  const summary = exactApprovalSummary(paused, "user_confirmation", ["email", "phone", "address"]);
  if (summary.email !== email || summary.phone !== phone || summary.address !== address) {
    throw new Error("Member-update approval summary did not match the exact current values");
  }
  const completed = await runner.resume(runner.issueApproval({
    id: "hosted-demo-teller",
    roles: ["teller"],
  }));
  const write = requireTerminalSuccess(completed, "member-update-success");
  if (
    write.outputs.email_before !== email ||
    write.outputs.phone_before !== phone ||
    write.outputs.address_before !== address ||
    write.outputs.email !== email ||
    write.outputs.phone !== phone ||
    write.outputs.address !== address
  ) {
    throw new Error("Member-update outputs did not prove exact before/after values");
  }
  const afterProgress = await runBalanceStage({
    memberNumber: options.environment.memberNumber,
    bound: balance,
    surface: options.surface,
    authority: options.authority,
    recorder: options.recorder,
    evidence: options.evidence,
    redactor: options.redactor,
    runId: `${options.outerRunId}-update-after`,
  });
  const after = requireTerminalSuccess(afterProgress, "member-update read-after-write");
  if (after.outputs.email !== email || after.outputs.phone !== phone || after.outputs.address !== address) {
    throw new Error("Read-after-write did not confirm the saved member contact values");
  }
  return {
    progress: completed,
    assertion: {
      noNetContactChange: true,
      exactApproval: true,
      oneCommitAttempt: write.journal.filter((entry) => entry.stepId === "save_update").length === 1,
      beforeAfterVerified: true,
      readAfterWriteVerified: true,
    },
    artifactDigests: [balance.baseArtifactDigest, update.baseArtifactDigest],
  };
}

async function runHoldSupervisorHandoffScenario(options: HostedTransactionOptions): Promise<{
  readonly progress: ReplayProgressV2;
  readonly assertion: Readonly<Record<string, RunValueV2>>;
  readonly artifactDigests: readonly string[];
}> {
  const opened = await runOpenShareScenario(options);
  const hold = bindCapability(publishedCapability(options.catalog, "account.place_hold"), options.profile);
  const balance = bindCapability(
    publishedCapability(options.catalog, "member.get_record_and_balances"),
    options.profile,
  );
  let currentRole: string = "teller";
  const originalSessionId = options.surface.sessionId;
  const runner = createRunner({
    bound: hold,
    inputs: {
      member_number: options.environment.memberNumber,
      share: opened.newShareId,
      reason: "FRAUD",
      notes: HOLD_NOTES,
    },
    surface: options.surface,
    authority: options.authority,
    recorder: options.recorder,
    evidence: options.evidence,
    redactor: options.redactor,
    runId: `${options.outerRunId}-hold`,
    currentPrincipalRole: () => currentRole,
    authenticateSupervisor: async () => {
      await restoreSameMeridianSession(options.surface, {
        operator: options.environment.supervisorOperator,
        password: options.environment.supervisorPassword,
        branch: options.environment.branch,
      });
      currentRole = "supervisor";
    },
  });
  const intervention = await runner.run();
  if (
    intervention.status !== "awaiting_human" ||
    intervention.intervention.reasonCode !== "SUPERVISOR_REQUIRED" ||
    intervention.intervention.action !== "authenticate_supervisor" ||
    intervention.intervention.requiredRole !== "supervisor" ||
    intervention.intervention.sameLiveSession !== true
  ) {
    throw new Error("Hold did not stop for the required same-session supervisor handoff");
  }
  const actor = { id: "hosted-demo-supervisor", roles: ["supervisor"] } as const;
  await runner.takeHumanControl(intervention.intervention.interventionId, actor);
  await runner.performHumanAction(
    intervention.intervention.interventionId,
    actor,
    "authenticate_supervisor",
  );
  const paused = await runner.resumeHuman(intervention.intervention.interventionId, actor);
  if (paused.status !== "awaiting_approval") {
    throw new Error("Hold did not reach its supervisor approval boundary after handoff");
  }
  const summary = exactApprovalSummary(paused, "supervisor_confirmation", [
    "review_member",
    "review_share",
    "review_reason",
    "review_notes",
  ]);
  if (
    typeof summary.review_member !== "string" ||
    !summary.review_member.includes(options.environment.memberNumber) ||
    typeof summary.review_share !== "string" ||
    !summary.review_share.includes(opened.newShareId) ||
    typeof summary.review_reason !== "string" ||
    !summary.review_reason.includes("FRAUD") ||
    summary.review_notes !== HOLD_NOTES
  ) {
    throw new Error("Hold approval summary did not match the exact reviewed values");
  }
  const completed = await runner.resume(runner.issueApproval(actor));
  const write = requireTerminalSuccess(completed, "hold-supervisor-handoff");
  if (
    typeof write.outputs.confirmation !== "string" ||
    write.outputs.confirmation.length === 0 ||
    typeof write.outputs.share_status !== "string" ||
    !write.outputs.share_status.includes(opened.newShareId) ||
    !write.outputs.share_status.endsWith(" is now HOLD") ||
    typeof write.outputs.applied_at !== "string" ||
    write.outputs.applied_at.length === 0
  ) {
    throw new Error("Hold receipt did not prove the exact applied hold");
  }
  const afterProgress = await runBalanceStage({
    memberNumber: options.environment.memberNumber,
    bound: balance,
    surface: options.surface,
    authority: options.authority,
    recorder: options.recorder,
    evidence: options.evidence,
    redactor: options.redactor,
    runId: `${options.outerRunId}-hold-after`,
  });
  const after = requireTerminalSuccess(afterProgress, "hold read-after-write");
  const held = typedShares(after.outputs.shares).find((share) => share.shareId === opened.newShareId);
  if (!held?.status.toLocaleUpperCase("en-US").includes("HOLD")) {
    throw new Error("Read-after-write did not confirm the held share status");
  }
  return {
    progress: completed,
    assertion: {
      newSharePreparedForHold: true,
      sameLiveSession: options.surface.sessionId === originalSessionId,
      supervisorReauthenticated: currentRole === "supervisor",
      exactSupervisorApproval: true,
      oneHoldCommitAttempt: write.journal.filter((entry) => entry.stepId === "commit_hold").length === 1,
      receiptVerified: true,
      readAfterWriteVerified: true,
    },
    artifactDigests: [...new Set([
      ...opened.artifactDigests,
      hold.baseArtifactDigest,
      balance.baseArtifactDigest,
    ])],
  };
}

function faultForScenario(
  scenario: HostedReadScenario,
): MeridianInjectedFault | undefined {
  switch (scenario) {
    case "maintenance-recovery":
      return "maintenance";
    case "session-timeout":
      return "timeout";
    case "application-error":
      return "server";
    case "supervisor-required":
      return "permission";
    case "validation-rejected":
      return "validation";
    default:
      return undefined;
  }
}

async function recursiveFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...(await recursiveFiles(root, absolute)));
    else if (entry.isFile()) files.push(path.relative(root, absolute).split(path.sep).join("/"));
    else throw new Error("Evidence bundle contains a non-file filesystem entry");
  }
  return files.sort();
}

/** Verify every bundle byte is covered by the final manifest (except the manifest itself). */
export async function verifyHostedEvidenceBundle(directory: string): Promise<string> {
  const manifestPath = path.join(directory, "manifest.json");
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
    schemaVersion?: unknown;
    evidence?: Array<{ path?: unknown; sha256?: unknown; bytes?: unknown }>;
  };
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.evidence)) {
    throw new Error("Evidence manifest is invalid");
  }
  const listed: string[] = [];
  for (const reference of manifest.evidence) {
    if (
      typeof reference.path !== "string" ||
      reference.path.startsWith("/") ||
      reference.path.includes("\\") ||
      reference.path.split("/").some((part) => !part || part === "." || part === "..") ||
      typeof reference.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(reference.sha256) ||
      typeof reference.bytes !== "number"
    ) {
      throw new Error("Evidence manifest contains an invalid reference");
    }
    const bytes = await readFile(path.join(directory, ...reference.path.split("/")));
    if (
      bytes.byteLength !== reference.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== reference.sha256
    ) {
      throw new Error(`Evidence hash verification failed for ${reference.path}`);
    }
    listed.push(reference.path);
  }
  const files = await recursiveFiles(directory);
  const expected = [...listed, "manifest.json"].sort();
  if (files.length !== expected.length || files.some((file, index) => file !== expected[index])) {
    throw new Error("Evidence bundle contains bytes not covered by its final manifest");
  }
  const eventReference = listed.find((value) => value === "events.jsonl");
  if (!eventReference) throw new Error("Evidence bundle is missing its finalized event stream");
  const eventLines = (await readFile(path.join(directory, eventReference), "utf8"))
    .split(/\r?\n/u)
    .filter(Boolean);
  if (eventLines.length === 0) throw new Error("Evidence event stream is empty");
  for (const line of eventLines) JSON.parse(line);
  return createHash("sha256").update(manifestBytes).digest("hex");
}

async function assertSensitiveValuesAbsent(
  directory: string,
  values: readonly string[],
): Promise<void> {
  const files = await recursiveFiles(directory);
  const forbidden = values.filter((value) => value.length > 0).map((value) => Buffer.from(value, "utf8"));
  for (const file of files) {
    const bytes = await readFile(path.join(directory, ...file.split("/")));
    if (forbidden.some((value) => bytes.indexOf(value) >= 0)) {
      throw new Error("Evidence privacy verification found a configured sensitive value");
    }
  }
}

export async function runHostedDemoScenario(
  scenario: HostedDemoScenario,
  environment: HostedDemoEnvironment = loadHostedDemoEnvironment(),
  configuredCatalog?: CapabilityCatalog,
): Promise<HostedScenarioResult> {
  const catalog = configuredCatalog ?? await loadConfiguredCapabilityCatalog();
  const outerRunId = `${scenario}-${randomUUID()}`;
  const redactor = new Redactor({
    sensitiveValues: [
      environment.operator,
      environment.password,
      environment.supervisorOperator,
      environment.supervisorPassword,
      environment.branch,
      environment.memberNumber,
      environment.missingMemberNumber,
      TRANSFER_MEMO,
      HOLD_NOTES,
    ],
  });
  const evidence = await EvidenceStore.create({
    rootDirectory: environment.evidenceRoot,
    runId: outerRunId,
    redactor,
  });
  const recorder = await EventRecorder.create({
    filePath: path.join(evidence.runDirectory, "events.jsonl"),
    runId: outerRunId,
    runMetadata: {
      mode: "hosted-meridian-scenario",
      scenario,
      plannerCallsAllowed: false,
    },
    redactor,
  });
  const observationScratch = await mkdtemp(path.join(tmpdir(), "meridian-hosted-demo-"));
  const profile = createMeridianTargetProfile({ origin: environment.origin, id: "meridian.default" });
  const profileDigest = targetProfileDigest(profile);
  const signOn = bindCapability(publishedCapability(catalog, "session.sign_on"), profile);
  const balance = bindCapability(
    publishedCapability(catalog, "member.get_record_and_balances"),
    profile,
  );
  const authority = new ApprovalAuthority();
  const surface = new PlaywrightSurface(createMeridianSurfaceOptions(observationScratch, {
    origin: environment.origin,
    headless: environment.headless,
  }));
  let publicSummary: {
    scenario: HostedDemoScenario;
    status: "verified" | "failed";
    observation?: ScenarioObservation;
    assertion?: Readonly<Record<string, RunValueV2>>;
    plannerCallsAllowed: false;
  };
  let executionError: unknown;
  let observation: ScenarioObservation | undefined;
  let assertion: Readonly<Record<string, RunValueV2>> | undefined;
  let artifactDigests: readonly string[] = [balance.baseArtifactDigest];

  try {
    await surface.start(signOn.artifact.compatibility.entryPoint);
    const signOnProgress = await createRunner({
      bound: signOn,
      inputs: {
        operator: environment.operator,
        password: environment.password,
        branch: environment.branch,
      },
      surface,
      authority,
      recorder,
      evidence,
      redactor,
      runId: `${outerRunId}-sign-on`,
    }).run();
    requireTerminalSuccess(signOnProgress, "hosted sign-on");

    const transactionOptions: HostedTransactionOptions = {
      environment,
      catalog,
      profile,
      surface,
      authority,
      recorder,
      evidence,
      redactor,
      outerRunId,
    };
    if (scenario === "transfer-success") {
      const transferResult = await runTransferScenario({
        ...transactionOptions,
      });
      observation = observationFromProgress(transferResult.progress, "funds.transfer");
      assertion = transferResult.assertion;
      artifactDigests = transferResult.artifactDigests;
    } else if (scenario === "share-open-success") {
      const openResult = await runOpenShareScenario(transactionOptions);
      observation = observationFromProgress(openResult.progress, "share.open");
      assertion = openResult.assertion;
      artifactDigests = openResult.artifactDigests;
    } else if (scenario === "member-update-success") {
      const updateResult = await runMemberUpdateScenario(transactionOptions);
      observation = observationFromProgress(updateResult.progress, "member.update_information");
      assertion = updateResult.assertion;
      artifactDigests = updateResult.artifactDigests;
    } else if (scenario === "hold-supervisor-handoff") {
      const holdResult = await runHoldSupervisorHandoffScenario(transactionOptions);
      observation = observationFromProgress(holdResult.progress, "account.place_hold");
      assertion = holdResult.assertion;
      artifactDigests = holdResult.artifactDigests;
    } else {
      const fault = faultForScenario(scenario);
      const adapter = fault
        ? await installOneShotFaultAdapter(surface, environment.origin, fault, recorder)
        : undefined;
      try {
        const progress = await runBalanceStage({
          memberNumber: scenario === "member-not-found"
            ? environment.missingMemberNumber
            : environment.memberNumber,
          bound: balance,
          surface,
          authority,
          recorder,
          evidence,
          redactor,
          runId: `${outerRunId}-scenario`,
        });
        assertion = assertReadScenario(scenario, progress, adapter?.wasApplied() ?? false);
        observation = observationFromProgress(progress, balance.artifact.capability.id);
      } finally {
        await adapter?.remove();
      }
    }
    publicSummary = {
      scenario,
      status: "verified",
      observation,
      assertion,
      plannerCallsAllowed: false,
    };
    await recorder.record("demo.assertion_passed", {
      scenario,
      observedStatus: observation.status,
      observedCode: observation.code ?? null,
    }, { actor: "system" });
  } catch (error) {
    executionError = error;
    publicSummary = { scenario, status: "failed", plannerCallsAllowed: false };
    await recorder.recordError(error, { scenario, stage: "hosted_demo" }, { actor: "system" });
  } finally {
    await surface.close().catch(async (error) => {
      executionError ??= error;
      await recorder.recordError(error, { scenario, stage: "surface_close" }, { actor: "system" });
    });
    await rm(observationScratch, { recursive: true, force: true });
  }

  await evidence.saveJson("scenario-summary", publicSummary);
  await recorder.recordRunFinished({
    scenario,
    status: executionError === undefined ? "verified" : "failed",
    plannerCallsAllowed: false,
  }, { actor: "system" });
  await recorder.close();
  await evidence.registerFinalizedFile(
    "events.jsonl",
    "json",
    "application/x-ndjson; charset=utf-8",
    { redacted: true },
  );
  await evidence.writeManifest({
    evidenceVersion: "v2",
    mode: "hosted-meridian-scenario",
    scenario,
    status: executionError === undefined ? "verified" : "failed",
    artifactDigests,
    targetProfileDigest: profileDigest,
    plannerCallsAllowed: false,
    target: "hosted_meridian",
  });
  const manifestSha256 = await verifyHostedEvidenceBundle(evidence.runDirectory);
  await assertSensitiveValuesAbsent(evidence.runDirectory, [
    environment.operator,
    environment.password,
    environment.supervisorOperator,
    environment.supervisorPassword,
    environment.branch,
    environment.memberNumber,
    environment.missingMemberNumber,
    TRANSFER_MEMO,
    HOLD_NOTES,
  ]);

  if (executionError !== undefined || !observation || !assertion) {
    throw new Error(
      `Hosted MERIDIAN scenario failed; sanitized evidence is at ${evidence.runDirectory}`,
      { cause: executionError },
    );
  }
  return {
    scenario,
    status: "verified",
    observation,
    assertion,
    artifactDigests,
    targetProfileDigest: profileDigest,
    evidenceDirectory: evidence.runDirectory,
    manifestSha256,
    plannerCallsAllowed: false,
  };
}

function help(): string {
  return [
    "Usage: npm run demo:scenario -- <scenario>",
    "",
    `Scenarios: ${HOSTED_DEMO_SCENARIOS.join(", ")}`,
    "",
    "Required environment:",
    "  MERIDIAN_DEMO_SCENARIOS=1",
    "  MERIDIAN_TELLER_OPERATOR=<hosted demo operator>",
    "  MERIDIAN_TELLER_PASSWORD=<hosted demo password>",
    "  MERIDIAN_SUPERVISOR_OPERATOR=<hosted demo supervisor>",
    "  MERIDIAN_SUPERVISOR_PASSWORD=<hosted demo supervisor password>",
    "",
    "This command only targets https://web-sample.interface-hiring.com.",
  ].join("\n");
}

export async function runHostedDemoCli(
  argv: readonly string[] = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(`${help()}\n`);
    return;
  }
  if (argv.length !== 1) throw new Error(help());
  const scenario = parseHostedDemoScenario(argv[0]);
  const result = await runHostedDemoScenario(scenario, loadHostedDemoEnvironment(environment));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath && invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  await runHostedDemoCli().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Hosted MERIDIAN scenario failed"}\n`);
    process.exitCode = 1;
  });
}
