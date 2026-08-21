import { z } from "zod";
import type { SurfaceObservation } from "../surface/types.js";

export const PlannerValueSchema = z
  .object({
    kind: z.enum(["input", "literal"]),
    name: z.string().nullable(),
    value: z.union([z.string(), z.number(), z.boolean()]).nullable(),
  })
  .strict();

export const PlannerActionSchema = z
  .object({
    kind: z.enum(["click", "fill", "select", "extract", "press"]),
    targetRef: z.string().nullable(),
    value: PlannerValueSchema.nullable(),
    outputName: z.string().nullable(),
    outputType: z.enum(["string", "money", "table"]).nullable(),
    key: z.string().nullable(),
  })
  .strict();

export const PlannerDecisionSchema = z
  .object({
    decision: z.enum(["act", "finish", "escalate"]),
    reason: z.string().min(1).max(500),
    action: PlannerActionSchema.nullable(),
    checkpointText: z.string().nullable(),
    escalationReason: z.string().nullable(),
  })
  .strict()
  .superRefine((decision, context) => {
    if (decision.decision === "act" && decision.action === null) {
      context.addIssue({ code: "custom", message: "act requires action", path: ["action"] });
    }
    if (decision.decision === "finish" && !decision.checkpointText) {
      context.addIssue({
        code: "custom",
        message: "finish requires checkpointText",
        path: ["checkpointText"],
      });
    }
    if (decision.decision === "escalate" && !decision.escalationReason) {
      context.addIssue({
        code: "custom",
        message: "escalate requires escalationReason",
        path: ["escalationReason"],
      });
    }
  });

export type PlannerValue = z.infer<typeof PlannerValueSchema>;
export type PlannerAction = z.infer<typeof PlannerActionSchema>;
export type PlannerDecision = z.infer<typeof PlannerDecisionSchema>;

export interface PlannerHistoryEntry {
  step: number;
  decision: "act" | "finish" | "escalate";
  actionKind: string | null;
  targetName: string | null;
  outputName: string | null;
  result: string;
}

export interface PlannerRequest {
  goal: string;
  inputs: Record<string, string | number | boolean>;
  observation: SurfaceObservation;
  history: PlannerHistoryEntry[];
  maxSteps: number;
  currentStep: number;
}

export interface PlannerResponse {
  decision: PlannerDecision;
  metadata: {
    provider: string;
    model: string;
    responseId: string | null;
    latencyMs: number;
  };
}

export interface Planner {
  readonly name: string;
  readonly model: string;
  decide(request: PlannerRequest): Promise<PlannerResponse>;
}

interface InputSubstitution {
  variant: string;
  placeholder: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function inputSubstitutions(inputs: PlannerRequest["inputs"]): InputSubstitution[] {
  const substitutions = new Map<string, string>();
  for (const [name, value] of Object.entries(inputs)) {
    const text = String(value);
    const variants = new Set([text]);
    try {
      variants.add(encodeURIComponent(text));
      variants.add(new URLSearchParams([["value", text]]).toString().slice("value=".length));
    } catch {
      // The raw form is still symbolized if an input contains an unpaired surrogate.
    }
    for (const variant of variants) {
      if (variant && !substitutions.has(variant)) substitutions.set(variant, `{{${name}}}`);
    }
  }
  return [...substitutions]
    .map(([variant, placeholder]) => ({ variant, placeholder }))
    .sort((left, right) => right.variant.length - left.variant.length);
}

function symbolize(value: string, substitutions: readonly InputSubstitution[]): string;
function symbolize(value: string | null, substitutions: readonly InputSubstitution[]): string | null;
function symbolize(
  value: string | null,
  substitutions: readonly InputSubstitution[],
): string | null {
  if (value === null) return null;
  return value
    .split(/(\{\{[A-Za-z0-9._:-]+\}\})/gu)
    .map((part) =>
      /^\{\{[A-Za-z0-9._:-]+\}\}$/u.test(part)
        ? part
        : symbolizeUnprotected(part, substitutions),
    )
    .join("");
}

function symbolizeUnprotected(
  value: string,
  substitutions: readonly InputSubstitution[],
): string {
  let result = value;
  for (const { variant, placeholder } of substitutions) {
    if (variant.length < 3) {
      result = result.replace(
        new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(variant)}(?![\\p{L}\\p{N}_])`, "gu"),
        () => placeholder,
      );
    } else {
      result = result.replaceAll(variant, () => placeholder);
    }
  }
  return result;
}

export function plannerPrompt(request: PlannerRequest): string {
  const substitutions = inputSubstitutions(request.inputs);
  const inputs = Object.entries(request.inputs).map(([name, value]) => ({
    name,
    type: typeof value,
  }));
  const controls = request.observation.controls.map((control) => ({
    ref: control.ref,
    frame: control.framePath.map((frame) => symbolize(frame.title, substitutions)),
    role: control.role,
    name: symbolize(control.name, substitutions),
    label: symbolize(control.label, substitutions),
    value: symbolize(control.value, substitutions),
    disabled: control.disabled,
  }));
  const semanticTargets = (request.observation.semanticTargets ?? []).map((target) => ({
    ref: target.ref,
    frame: target.framePath.map((frame) => symbolize(frame.title, substitutions)),
    kind: target.kind,
    name: symbolize(target.name, substitutions),
    ...(target.kind === "label_value"
      ? { label: symbolize(target.label, substitutions), valueCellOffset: target.valueCellOffset }
      : {}),
    ...(target.kind === "table" || target.kind === "table_row_value" || target.kind === "table_row_control"
      ? { headers: target.headers.map((header) => symbolize(header, substitutions)) }
      : {}),
    ...(target.kind === "table_row_value"
      ? {
          keyColumn: symbolize(target.keyColumn, substitutions),
          keyInputName: target.keyInputName,
          valueColumn: symbolize(target.valueColumn, substitutions),
        }
      : {}),
    ...(target.kind === "table_row_control"
      ? {
          keyColumn: symbolize(target.keyColumn, substitutions),
          keyInputName: target.keyInputName,
          controlRole: target.controlRole,
          controlName: symbolize(target.controlName, substitutions),
        }
      : {}),
  }));
  const frames = request.observation.frames.map((frame) => ({
    frame: frame.framePath.map((item) => symbolize(item.title, substitutions)),
    url: symbolize(frame.url, substitutions),
    headings: frame.headings.map((heading) => symbolize(heading, substitutions)),
    visibleText: symbolize(frame.visibleText.slice(0, 1_500), substitutions),
  }));
  const history = request.history.map((entry) => ({
    ...entry,
    targetName: symbolize(entry.targetName, substitutions),
    outputName: symbolize(entry.outputName, substitutions),
    result: symbolize(entry.result, substitutions),
  }));

  return [
    "You are the discovery planner for a safe computer-use recorder.",
    "Decide exactly ONE next UI action from the attached screenshot and the compact accessibility observation.",
    "Do not call tools, browse, or invent target refs. Use only a ref listed under controls or semantic targets.",
    "The UI is the authorized hosted MERIDIAN training target. Never click a final Create/Confirm/Submit transaction control during discovery.",
    "Use value.kind=input and value.name=<input key> for caller-supplied values; never copy an input as a literal.",
    "Use extract on requested outputs. Choose a label_value semantic target for a labeled field, or a table semantic target with outputType table for structured rows.",
    "Use a table_row_control semantic target when repeated row controls share a name; its row key is already bound to the named caller input.",
    "Use a table_row_value semantic target to extract one scalar cell from the row keyed by a named caller input; preserve the exact requested outputName.",
    "For scalar extracts choose outputType string or money and copy outputName exactly from the GOAL, including underscores.",
    "Extract exactly the output keys requested by the goal. Do not rename them or invent summary/banner/status outputs.",
    "Choose finish only after the visible goal checkpoint is reached and requested outputs were extracted.",
    "Choose escalate when safe progress is impossible. Keep reason concise and never repeat sensitive values.",
    `Step ${request.currentStep} of at most ${request.maxSteps}.`,
    `GOAL: ${symbolize(request.goal, substitutions)}`,
    `INPUTS (values withheld; use names symbolically): ${JSON.stringify(inputs)}`,
    `HISTORY: ${JSON.stringify(history)}`,
    `FRAMES: ${JSON.stringify(frames)}`,
    `CONTROLS: ${JSON.stringify(controls)}`,
    `SEMANTIC TARGETS: ${JSON.stringify(semanticTargets)}`,
  ].join("\n\n");
}

export function normalizeDecision(input: unknown): PlannerDecision {
  const parsed = PlannerDecisionSchema.parse(input);
  if (parsed.decision === "act") {
    const action = parsed.action;
    if (!action) throw new Error("Planner act decision omitted action");
    if (action.kind !== "press" && !action.targetRef) {
      throw new Error(`${action.kind} requires targetRef`);
    }
    if ((action.kind === "fill" || action.kind === "select") && !action.value) {
      throw new Error(`${action.kind} requires value`);
    }
    if (action.kind === "extract" && (!action.outputName || !action.outputType)) {
      throw new Error("extract requires outputName and outputType");
    }
    if (
      action.kind === "extract" &&
      action.outputName &&
      ["__proto__", "constructor", "prototype"].includes(action.outputName)
    ) {
      throw new Error(`Reserved output name ${JSON.stringify(action.outputName)} is forbidden`);
    }
    if (action.kind === "press" && !action.key) {
      throw new Error("press requires key");
    }
  }
  return parsed;
}
