import {
  CapabilityArtifactSchema,
  type CapabilityArtifact,
  type Condition,
  type Step,
  type TargetRef,
  type ValueExpr,
} from "../domain/index.js";
import type { DiscoveryJournalEntry, DiscoverySuccess } from "./discoveryRunner.js";

export interface ArtifactCompilerOptions {
  compatibility: CapabilityArtifact["compatibility"];
  policy: CapabilityArtifact["policy"];
  capability?: Partial<CapabilityArtifact["capability"]>;
  profile?: Pick<CapabilityArtifact, "businessOutcomes" | "recoveries" | "exceptions"> & {
    targets?: TargetRef[];
  };
  /** Invocation values are used only as a denylist and are never serialized. */
  sensitiveInvocationValues?: Iterable<string | number | boolean>;
}

function slug(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .toLocaleLowerCase()
    .slice(0, 70);
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function targetId(entry: DiscoveryJournalEntry): string {
  if (!entry.target) throw new Error(`Journal action ${entry.action.kind} has no target`);
  const base = slug(entry.target.name || entry.target.label || entry.target.nameAttribute || "control");
  const discriminator =
    entry.action.outputName ??
    (entry.action.value?.kind === "input" ? entry.action.value.name : null) ??
    entry.target.role;
  return `target.${entry.action.kind}.${base}.${slug(discriminator ?? "control")}`;
}

function conditionForHeadings(headings: string[], fallbackTargetId?: string): Condition {
  const heading = headings.find((value) => value.trim().length > 0);
  if (heading) return { kind: "text_visible", text: heading, exact: true };
  if (fallbackTargetId) return { kind: "target_visible", targetId: fallbackTargetId, visible: true };
  throw new Error("Cannot compile a condition without a heading or target");
}

function compileValue(entry: DiscoveryJournalEntry, sensitiveValues: ReadonlySet<string>): ValueExpr {
  const value = entry.action.value;
  if (!value) throw new Error(`${entry.action.kind} journal action omitted value`);
  if (value.kind === "input") {
    if (!value.name) throw new Error("Planner input value omitted its input name");
    return { kind: "input", name: value.name };
  }
  if (value.value === null) throw new Error("Literal journal value cannot be null");
  if (sensitiveValues.has(String(value.value))) {
    throw new Error(
      "Refusing to compile a planner literal that equals a sensitive invocation value; use an input reference.",
    );
  }
  return { kind: "literal", value: value.value };
}

function compileTarget(entry: DiscoveryJournalEntry): TargetRef {
  const target = entry.target;
  if (!target) throw new Error(`Journal action ${entry.action.kind} has no observed target`);
  const strategies: TargetRef["strategies"] = [];
  if (target.role && target.name) {
    strategies.push({ kind: "role", role: target.role, name: target.name, exact: true });
  }
  if (target.label) strategies.push({ kind: "label", label: target.label, exact: true });
  if (target.nameAttribute) strategies.push({ kind: "name", name: target.nameAttribute });
  if (
    target.text &&
    !target.label &&
    entry.action.kind !== "extract" &&
    target.text.length <= 120
  ) {
    strategies.push({ kind: "text", text: target.text, exact: true });
  }
  if (strategies.length === 0) throw new Error(`Target ${target.name} has no durable locator strategy`);
  return {
    id: targetId(entry),
    description: `Control named ${target.name} used for ${entry.action.kind}.`,
    framePath: target.framePath.map((frame) => ({ title: frame.title })),
    strategies,
    cardinality: "exactly_one",
    rationale:
      "Prefer exact accessibility role/name, then associated label, then semantic name attribute; every strategy must resolve to exactly one control and ambiguity fails closed.",
  };
}

function compileStep(
  entry: DiscoveryJournalEntry,
  index: number,
  journal: DiscoveryJournalEntry[],
  sensitiveValues: ReadonlySet<string>,
): Step {
  const id = `step.${String(index + 1).padStart(2, "0")}.${entry.action.kind}`;
  const target = entry.target ? targetId(entry) : undefined;
  let action: Step["action"];
  switch (entry.action.kind) {
    case "click":
      action = { kind: "click", targetId: target! };
      break;
    case "fill":
      action = { kind: "fill", targetId: target!, value: compileValue(entry, sensitiveValues) };
      break;
    case "select":
      action = { kind: "select", targetId: target!, value: compileValue(entry, sensitiveValues) };
      break;
    case "extract":
      if (!entry.action.outputName) throw new Error("Extract journal action omitted outputName");
      action = { kind: "extract", targetId: target!, outputName: entry.action.outputName };
      break;
    case "press":
      action = { kind: "press", key: entry.action.key! };
      break;
  }
  const nextTarget = journal.slice(index + 1).find((candidate) => candidate.target !== null);
  const changedHeadings = entry.afterHeadings.filter(
    (heading) => !entry.beforeHeadings.includes(heading),
  );
  const postcondition =
    entry.action.kind === "fill" || entry.action.kind === "select"
      ? ({
          kind: "target_value",
          targetId: target!,
          operator: "equals",
          value: compileValue(entry, sensitiveValues),
        } as const)
      : entry.action.kind === "extract"
        ? ({ kind: "target_visible", targetId: target!, visible: true } as const)
        : entry.action.kind === "click" && nextTarget?.target
          ? ({ kind: "target_visible", targetId: targetId(nextTarget), visible: true } as const)
          : conditionForHeadings(changedHeadings, target);
  return {
    id,
    title: `${entry.action.kind} ${entry.target?.name ?? entry.action.key ?? "control"}`,
    action,
    preconditions:
      entry.action.kind === "press" ? [] : [{ kind: "target_visible", targetId: target!, visible: true }],
    postcondition,
    timeoutMs: 8_000,
    retry: {
      maxAttempts: entry.action.kind === "click" ? 1 : 2,
      backoffMs: 150,
    },
    risk: entry.risk,
  };
}

export function compileArtifact(
  discovery: DiscoverySuccess,
  options: ArtifactCompilerOptions,
): CapabilityArtifact {
  const actionable = discovery.journal;
  const sensitiveValues = new Set(
    [...(options.sensitiveInvocationValues ?? [])].map((value) => String(value)),
  );
  for (const value of sensitiveValues) {
    if (value && discovery.goal.includes(value)) {
      throw new Error(
        "Refusing to persist a provenance goal containing a sensitive invocation value; use {{inputName}} placeholders.",
      );
    }
  }
  const compiledTargets = actionable
    .filter((entry) => entry.target !== null)
    .map(compileTarget);
  const targetMap = new Map<string, TargetRef>();
  for (const target of [...(options.profile?.targets ?? []), ...compiledTargets]) {
    const existing = targetMap.get(target.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(target)) {
      throw new Error(
        `Target ID collision for ${target.id}; refusing to overwrite a different locator contract.`,
      );
    }
    targetMap.set(target.id, target);
  }
  const inputNames = unique(
    actionable
      .map((entry) => (entry.action.value?.kind === "input" ? entry.action.value.name : null))
      .filter((name): name is string => Boolean(name)),
  );
  const outputNames = unique(
    actionable
      .map((entry) => (entry.action.kind === "extract" ? entry.action.outputName : null))
      .filter((name): name is string => Boolean(name)),
  );
  const outputType = (name: string) =>
    actionable.find((entry) => entry.action.outputName === name)?.action.outputType ?? "string";
  const steps = actionable.map((entry, index) =>
    compileStep(entry, index, actionable, sensitiveValues),
  );

  return CapabilityArtifactSchema.parse({
    schemaVersion: "1.0",
    capability: {
      id: options.capability?.id ?? "prepare-sub-account-review",
      name: options.capability?.name ?? "Prepare sub-account review",
      description:
        options.capability?.description ??
        "Looks up a synthetic member, prepares a sub-account, stops before creation, and returns the review summary.",
      version: options.capability?.version ?? "1.0.0",
      approval: options.capability?.approval ?? "draft",
      tags: options.capability?.tags ?? ["banking", "member-servicing", "read-before-write"],
    },
    provenance: {
      source: "discovery",
      createdAt: discovery.finalObservation.capturedAt,
      discoveryRunId: discovery.runId,
      goal: discovery.goal,
      planner: {
        provider: discovery.planner.provider,
        model: discovery.planner.model,
      },
    },
    compatibility: options.compatibility,
    inputs: inputNames.map((name) => ({
      name,
      description: `Caller-provided ${name} parameter.`,
      type: "string",
      required: true,
      classification:
        name === "memberId" || name === "initialDeposit" ? "restricted" : "confidential",
      ...(name === "memberId" ? { pattern: "^[A-Z]+-[0-9]{4}$" } : {}),
    })),
    outputs: outputNames.map((name) => ({
      name,
      description: `Value extracted from the verified review checkpoint: ${name}.`,
      type: outputType(name),
      classification:
        name === "memberId" || name === "memberName" || name === "initialDeposit"
          ? "restricted"
          : "confidential",
    })),
    policy: options.policy,
    targets: [...targetMap.values()],
    steps,
    businessOutcomes: options.profile?.businessOutcomes ?? [],
    recoveries: options.profile?.recoveries ?? [],
    exceptions: options.profile?.exceptions ?? [],
    checkpoint:
      discovery.checkpointText === "Review ready"
        ? { kind: "text_visible", text: "Review ready", exact: true }
        : {
            kind: "all",
            conditions: [
              { kind: "text_visible", text: discovery.checkpointText, exact: true },
              { kind: "text_visible", text: "Review ready", exact: true },
            ],
          },
  });
}
