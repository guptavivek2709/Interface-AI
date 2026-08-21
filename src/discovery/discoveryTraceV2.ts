import { z } from "zod";
import {
  LocatorStrategyV2Schema,
  ValueExprV2Schema,
  type LocatorStrategyV2,
  type ValueExprV2,
} from "../domain/index.js";
import { sha256Digest } from "../security/digest.js";
import type { ObservedTarget } from "../surface/types.js";
import type { DiscoveryJournalEntry, DiscoverySuccess } from "./discoveryRunner.js";

const IdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)
  .refine((value) => !["__proto__", "constructor", "prototype"].includes(value), {
    message: "Reserved identifier is forbidden",
  });
const NonEmptySchema = z.string().trim().min(1);
const SafeTextSchema = NonEmptySchema.max(4_000);
const JsonScalarSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);

const DiscoveryTraceTargetV2Schema = z
  .object({
    id: IdSchema,
    description: NonEmptySchema,
    framePath: z.array(z.object({ title: NonEmptySchema }).strict()).max(12),
    strategies: z.array(LocatorStrategyV2Schema).min(1),
    cardinality: z.literal("exactly_one"),
  })
  .strict();
export type DiscoveryTraceTargetV2 = z.infer<typeof DiscoveryTraceTargetV2Schema>;

const DiscoveryTraceActionV2Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("click"), targetId: IdSchema }).strict(),
  z
    .object({ kind: z.literal("fill"), targetId: IdSchema, value: ValueExprV2Schema })
    .strict(),
  z
    .object({ kind: z.literal("select"), targetId: IdSchema, value: ValueExprV2Schema })
    .strict(),
  z
    .object({
      kind: z.literal("extract"),
      targetId: IdSchema,
      outputName: IdSchema,
    })
    .strict(),
  z.object({ kind: z.literal("press"), key: NonEmptySchema.max(80) }).strict(),
]);
export type DiscoveryTraceActionV2 = z.infer<typeof DiscoveryTraceActionV2Schema>;

const DiscoveryTraceStateV2Schema = z
  .object({
    stateHash: NonEmptySchema.max(256),
    headings: z.array(SafeTextSchema).max(100),
  })
  .strict();

const DiscoveryTraceStepV2Schema = z
  .object({
    id: IdSchema,
    sequence: z.number().int().positive(),
    action: DiscoveryTraceActionV2Schema,
    target: DiscoveryTraceTargetV2Schema.optional(),
    before: DiscoveryTraceStateV2Schema,
    after: DiscoveryTraceStateV2Schema,
  })
  .strict()
  .superRefine((step, context) => {
    const targetId = "targetId" in step.action ? step.action.targetId : undefined;
    if (targetId !== step.target?.id) {
      if (targetId !== undefined || step.target !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["target"],
          message: "Trace target must match the action target",
        });
      }
    }
  });
export type DiscoveryTraceStepV2 = z.infer<typeof DiscoveryTraceStepV2Schema>;

export const DiscoveryTraceV2Schema = z
  .object({
    schemaVersion: z.literal("2.0"),
    runId: IdSchema,
    goalTemplate: SafeTextSchema,
    createdAt: z.iso.datetime({ offset: true }),
    planner: z
      .object({
        provider: NonEmptySchema,
        model: NonEmptySchema,
        mode: z.enum(["model", "test_double"]),
        callCount: z.number().int().nonnegative(),
      })
      .strict(),
    inputs: z
      .array(
        z
          .object({
            name: IdSchema,
            scalarType: z.enum(["string", "number", "boolean"]),
          })
          .strict(),
      )
      .max(100),
    checkpointText: SafeTextSchema,
    finalState: z
      .object({
        url: z.string().max(4_000),
        title: z.string().max(1_000),
        httpStatus: z.number().int().min(100).max(599).nullable(),
        stateHash: NonEmptySchema.max(256),
        headings: z.array(SafeTextSchema).max(100),
      })
      .strict(),
    steps: z.array(DiscoveryTraceStepV2Schema).min(1).max(1_000),
  })
  .strict()
  .superRefine((trace, context) => {
    const inputNames = new Set<string>();
    for (const [index, input] of trace.inputs.entries()) {
      if (inputNames.has(input.name)) {
        context.addIssue({ code: "custom", path: ["inputs", index, "name"], message: "Duplicate input name" });
      }
      inputNames.add(input.name);
    }
    const stepIds = new Set<string>();
    for (const [index, step] of trace.steps.entries()) {
      if (step.sequence !== index + 1) {
        context.addIssue({
          code: "custom",
          path: ["steps", index, "sequence"],
          message: "Trace steps must be contiguous and ordered",
        });
      }
      if (stepIds.has(step.id)) {
        context.addIssue({ code: "custom", path: ["steps", index, "id"], message: "Duplicate trace step ID" });
      }
      stepIds.add(step.id);
      if ("value" in step.action && step.action.value.kind === "input" && !inputNames.has(step.action.value.name)) {
        context.addIssue({
          code: "custom",
          path: ["steps", index, "action", "value", "name"],
          message: "Trace action references an undeclared input",
        });
      }
    }
  });
export type DiscoveryTraceV2 = z.infer<typeof DiscoveryTraceV2Schema>;

export interface DiscoveryTraceProjectionOptions {
  inputs: Readonly<Record<string, string | number | boolean>>;
  plannerMode: "model" | "test_double";
}

interface Substitution {
  readonly value: string;
  readonly placeholder: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function substitutionsFor(
  inputs: Readonly<Record<string, string | number | boolean>>,
): readonly Substitution[] {
  const substitutions = new Map<string, string>();
  for (const [name, value] of Object.entries(inputs)) {
    const text = String(value);
    const variants = new Set([text]);
    try {
      variants.add(encodeURIComponent(text));
      variants.add(new URLSearchParams([["value", text]]).toString().slice("value=".length));
    } catch {
      // The raw representation is still symbolized if encoding rejects malformed text.
    }
    for (const variant of variants) {
      if (variant && !substitutions.has(variant)) substitutions.set(variant, `{{${name}}}`);
    }
  }
  return [...substitutions]
    .map(([value, placeholder]) => ({ value, placeholder }))
    .sort((left, right) => right.value.length - left.value.length);
}

function symbolize(text: string, substitutions: readonly Substitution[]): string {
  return text
    .split(/(\{\{[A-Za-z0-9._:-]+\}\})/gu)
    .map((part) =>
      /^\{\{[A-Za-z0-9._:-]+\}\}$/u.test(part)
        ? part
        : symbolizeUnprotected(part, substitutions),
    )
    .join("");
}

function symbolizeUnprotected(text: string, substitutions: readonly Substitution[]): string {
  let result = text;
  for (const substitution of substitutions) {
    if (substitution.value.length < 3) {
      result = result.replace(
        new RegExp(
          `(?<![\\p{L}\\p{N}_])${escapeRegExp(substitution.value)}(?![\\p{L}\\p{N}_])`,
          "gu",
        ),
        () => substitution.placeholder,
      );
    } else {
      result = result.replaceAll(substitution.value, substitution.placeholder);
    }
  }
  return result;
}

function containsPlaceholder(value: string): boolean {
  return /\{\{[A-Za-z0-9._:-]+\}\}/u.test(value);
}

function slug(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .toLocaleLowerCase("en-US")
    .slice(0, 60);
  return normalized || "control";
}

function safeFramePath(
  control: ObservedTarget,
  substitutions: readonly Substitution[],
): Array<{ title: string }> {
  return control.framePath.map((frame) => {
    const title = symbolize(frame.title, substitutions);
    if (containsPlaceholder(title)) {
      throw new Error("Cannot persist a durable frame locator whose title contains a discovery input");
    }
    return { title };
  });
}

function traceTarget(
  control: ObservedTarget,
  substitutions: readonly Substitution[],
  inputs: Readonly<Record<string, string | number | boolean>>,
): DiscoveryTraceTargetV2 {
  if ("kind" in control) {
    const framePath = safeFramePath(control, substitutions);
    let strategies: LocatorStrategyV2[];
    let idLabel: string;
    if (control.kind === "label_value") {
      const label = symbolize(control.label, substitutions);
      if (containsPlaceholder(label)) {
        throw new Error("Cannot persist a label-value locator containing discovery input material");
      }
      strategies = [{ kind: "label_value", label, valueCellOffset: control.valueCellOffset }];
      idLabel = label;
    } else if (control.kind === "table") {
      const headers = control.headers.map((header) => symbolize(header, substitutions));
      const nearText = control.nearText ? symbolize(control.nearText, substitutions) : undefined;
      if (headers.some(containsPlaceholder) || (nearText && containsPlaceholder(nearText))) {
        throw new Error("Cannot persist a table locator containing discovery input material");
      }
      strategies = [{ kind: "table", headers, ...(nearText ? { nearText } : {}) }];
      idLabel = headers.join("-");
    } else if (control.kind === "table_row_value") {
      if (!Object.hasOwn(inputs, control.keyInputName)) {
        throw new Error(`Observed row value references unknown input ${control.keyInputName}`);
      }
      const headers = control.headers.map((header) => symbolize(header, substitutions));
      const keyColumn = symbolize(control.keyColumn, substitutions);
      const valueColumn = symbolize(control.valueColumn, substitutions);
      if (
        headers.some(containsPlaceholder) ||
        containsPlaceholder(keyColumn) ||
        containsPlaceholder(valueColumn)
      ) {
        throw new Error("Cannot persist a row-value locator containing discovery input material");
      }
      strategies = [{
        kind: "table_row_value",
        headers,
        keyColumn,
        key: { kind: "input", name: control.keyInputName },
        valueColumn,
      }];
      idLabel = `${valueColumn}-${keyColumn}-${control.keyInputName}`;
    } else {
      if (!Object.hasOwn(inputs, control.keyInputName)) {
        throw new Error(`Observed row control references unknown input ${control.keyInputName}`);
      }
      const headers = control.headers.map((header) => symbolize(header, substitutions));
      const keyColumn = symbolize(control.keyColumn, substitutions);
      const controlName = symbolize(control.controlName, substitutions);
      if (
        headers.some(containsPlaceholder) ||
        containsPlaceholder(keyColumn) ||
        containsPlaceholder(controlName)
      ) {
        throw new Error("Cannot persist a row-control locator containing discovery input material");
      }
      strategies = [{
        kind: "table_row_control",
        headers,
        keyColumn,
        key: { kind: "input", name: control.keyInputName },
        controlRole: control.controlRole,
        controlName,
      }];
      idLabel = `${control.controlName}-${control.keyColumn}-${control.keyInputName}`;
    }
    const structuralIdentity = { framePath, strategies };
    return DiscoveryTraceTargetV2Schema.parse({
      id: `target.${slug(idLabel)}.${sha256Digest(structuralIdentity).slice(0, 12)}`,
      description: `Observed ${control.kind.replaceAll("_", " ")} target used during discovery.`,
      framePath,
      strategies,
      cardinality: "exactly_one",
    });
  }
  const name = symbolize(control.name, substitutions);
  const label = control.label === null ? null : symbolize(control.label, substitutions);
  // HTML form names conventionally match contract input names (for example
  // name="password"). If a demo value happens to equal that public field name,
  // treating the attribute as raw input would discard the only durable locator.
  // Preserve it only when it exactly names a declared input; all other
  // attributes still pass through raw-value symbolization.
  const nameAttribute = control.nameAttribute === null
    ? null
    : Object.hasOwn(inputs, control.nameAttribute)
      ? control.nameAttribute
      : symbolize(control.nameAttribute, substitutions);
  const text = control.text === null ? null : symbolize(control.text, substitutions);
  const strategies: LocatorStrategyV2[] = [];
  if (control.role && name && !containsPlaceholder(name)) {
    strategies.push({ kind: "role", role: control.role, name, exact: true });
  }
  if (label && !containsPlaceholder(label)) {
    strategies.push({ kind: "label", label, exact: true });
  }
  if (nameAttribute && !containsPlaceholder(nameAttribute)) {
    strategies.push({ kind: "name", name: nameAttribute });
  }
  if (
    text &&
    text.length <= 120 &&
    !label &&
    !containsPlaceholder(text) &&
    control.role !== "textbox" &&
    control.role !== "combobox"
  ) {
    strategies.push({ kind: "text", text, exact: true });
  }
  if (strategies.length === 0) {
    throw new Error(`Observed target ${JSON.stringify(control.name)} has no privacy-safe durable locator`);
  }
  const structuralIdentity = {
    framePath: safeFramePath(control, substitutions),
    role: control.role,
    name,
    label,
    nameAttribute,
  };
  const idBase = slug(nameAttribute ?? label ?? name ?? control.role);
  return DiscoveryTraceTargetV2Schema.parse({
    id: `target.${idBase}.${sha256Digest(structuralIdentity).slice(0, 12)}`,
    description: `Observed ${control.role} target used during discovery.`,
    framePath: structuralIdentity.framePath,
    strategies,
    cardinality: "exactly_one",
  });
}

function inputForLiteral(
  value: string | number | boolean | null,
  inputs: Readonly<Record<string, string | number | boolean>>,
): string | undefined {
  if (value === null) return undefined;
  const matches = Object.entries(inputs)
    .filter(([, inputValue]) => typeof inputValue === typeof value && inputValue === value)
    .map(([name]) => name);
  if (matches.length > 1) {
    throw new Error("A planner literal matched multiple discovery inputs; an explicit input reference is required");
  }
  return matches[0];
}

function traceValue(
  entry: DiscoveryJournalEntry,
  inputs: Readonly<Record<string, string | number | boolean>>,
  substitutions: readonly Substitution[],
): ValueExprV2 {
  const value = entry.action.value;
  if (!value) throw new Error(`${entry.action.kind} action omitted its value`);
  if (value.kind === "input") {
    if (!value.name || !Object.hasOwn(inputs, value.name)) {
      throw new Error(`Planner referenced unknown input ${value.name ?? "<missing>"}`);
    }
    return { kind: "input", name: value.name };
  }
  const matchedInput = inputForLiteral(value.value, inputs);
  if (matchedInput) return { kind: "input", name: matchedInput };
  if (value.value === null) throw new Error("Planner literal cannot be null for fill/select");
  if (typeof value.value === "string") {
    const safe = symbolize(value.value, substitutions);
    if (containsPlaceholder(safe)) {
      throw new Error("A planner literal contains discovery input material but is not an exact input reference");
    }
    return { kind: "literal", value: safe };
  }
  return { kind: "literal", value: value.value };
}

function traceAction(
  entry: DiscoveryJournalEntry,
  target: DiscoveryTraceTargetV2 | undefined,
  options: DiscoveryTraceProjectionOptions,
  substitutions: readonly Substitution[],
): DiscoveryTraceActionV2 {
  switch (entry.action.kind) {
    case "click":
      if (!target) throw new Error("Click action omitted an observed target");
      return { kind: "click", targetId: target.id };
    case "fill":
    case "select":
      if (!target) throw new Error(`${entry.action.kind} action omitted an observed target`);
      return {
        kind: entry.action.kind,
        targetId: target.id,
        value: traceValue(entry, options.inputs, substitutions),
      };
    case "extract":
      if (!target || !entry.action.outputName) throw new Error("Extract action omitted its target or output name");
      return { kind: "extract", targetId: target.id, outputName: entry.action.outputName };
    case "press":
      if (!entry.action.key) throw new Error("Press action omitted its key");
      return { kind: "press", key: symbolize(entry.action.key, substitutions) };
  }
}

/**
 * Projects the in-memory discovery result to a persistable trace. Invocation
 * values, model prose, output values, session identifiers, visible page text,
 * and screenshot paths are intentionally excluded.
 */
export function projectDiscoveryTraceV2(
  discovery: DiscoverySuccess,
  options: DiscoveryTraceProjectionOptions,
): DiscoveryTraceV2 {
  const substitutions = substitutionsFor(options.inputs);
  const steps = discovery.journal.map((entry, index) => {
    const target = entry.target
      ? traceTarget(entry.target, substitutions, options.inputs)
      : undefined;
    return {
      id: `trace.${String(index + 1).padStart(3, "0")}.${entry.action.kind}`,
      sequence: index + 1,
      action: traceAction(entry, target, options, substitutions),
      ...(target ? { target } : {}),
      before: {
        stateHash: entry.beforeStateHash,
        headings: entry.beforeHeadings.map((heading) => symbolize(heading, substitutions)),
      },
      after: {
        stateHash: entry.afterStateHash,
        headings: entry.afterHeadings.map((heading) => symbolize(heading, substitutions)),
      },
    };
  });

  return DiscoveryTraceV2Schema.parse({
    schemaVersion: "2.0",
    runId: discovery.runId,
    goalTemplate: symbolize(discovery.goal, substitutions),
    createdAt: discovery.finalObservation.capturedAt,
    planner: {
      provider: discovery.planner.provider,
      model: discovery.planner.model,
      mode: options.plannerMode,
      callCount: discovery.planner.callCount,
    },
    inputs: Object.entries(options.inputs)
      .map(([name, value]) => ({ name, scalarType: typeof value }))
      .sort((left, right) => left.name.localeCompare(right.name, "en-US")),
    checkpointText: symbolize(discovery.checkpointText, substitutions),
    finalState: {
      url: symbolize(discovery.finalObservation.url, substitutions),
      title: symbolize(discovery.finalObservation.title, substitutions),
      httpStatus: discovery.finalObservation.httpStatus,
      stateHash: discovery.finalObservation.stateHash,
      headings: discovery.finalObservation.frames
        .flatMap((frame) => frame.headings)
        .map((heading) => symbolize(heading, substitutions)),
    },
    steps,
  });
}

export function discoveryTraceDigestV2(trace: DiscoveryTraceV2): string {
  return sha256Digest(DiscoveryTraceV2Schema.parse(trace));
}

/** Fail-closed privacy guard shared by compilation and promotion. */
export function assertNoRawDiscoveryInputLeak(
  value: unknown,
  forbiddenInputValues: Iterable<string | number | boolean>,
): void {
  const strings: string[] = [];
  const scalars: Array<string | number | boolean | null> = [];
  const visit = (candidate: unknown): void => {
    if (candidate === null || typeof candidate === "string" || typeof candidate === "number" || typeof candidate === "boolean") {
      scalars.push(candidate);
      if (typeof candidate === "string") strings.push(candidate);
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (candidate && typeof candidate === "object") Object.values(candidate).forEach(visit);
  };
  visit(value);

  for (const forbidden of forbiddenInputValues) {
    if (typeof forbidden !== "string") {
      if (scalars.some((candidate) => candidate === forbidden)) {
        throw new Error("Raw discovery input leaked into a persisted discovery artifact");
      }
      continue;
    }
    if (!forbidden) continue;
    const variants = new Set([forbidden]);
    try {
      variants.add(encodeURIComponent(forbidden));
      variants.add(new URLSearchParams([["value", forbidden]]).toString().slice("value=".length));
    } catch {
      // The raw representation is still checked.
    }
    if ([...variants].some((variant) => variant.length >= 3 && strings.some((text) => text.includes(variant)))) {
      throw new Error("Raw discovery input leaked into a persisted discovery artifact");
    }
  }
}

export const DiscoveryTraceJsonScalarSchema = JsonScalarSchema;
