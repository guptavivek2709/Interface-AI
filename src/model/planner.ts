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
    outputType: z.enum(["string", "money"]).nullable(),
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

export function plannerPrompt(request: PlannerRequest): string {
  const controls = request.observation.controls.map((control) => ({
    ref: control.ref,
    frame: control.framePath.map((frame) => frame.title),
    role: control.role,
    name: control.name,
    label: control.label,
    value: control.value,
    disabled: control.disabled,
  }));
  const frames = request.observation.frames.map((frame) => ({
    frame: frame.framePath.map((item) => item.title),
    url: frame.url,
    headings: frame.headings,
    visibleText: frame.visibleText.slice(0, 1_500),
  }));

  return [
    "You are the discovery planner for a safe computer-use recorder.",
    "Decide exactly ONE next UI action from the attached screenshot and the compact accessibility observation.",
    "Do not call tools, browse, or invent control refs. Use only a ref listed under controls.",
    "The UI is a synthetic training bank. All values are fake. Never click a final Create/Confirm/Submit transaction control.",
    "Use value.kind=input and value.name=<input key> for caller-supplied values; never copy an input as a literal.",
    "Use extract on review outputs requested by the goal, with a stable camelCase outputName and outputType string or money.",
    "Extract exactly the output keys requested by the goal. Do not invent summary/banner/status outputs.",
    "Choose finish only after the visible goal checkpoint is reached and requested outputs were extracted.",
    "Choose escalate when safe progress is impossible. Keep reason concise and never repeat sensitive values.",
    `Step ${request.currentStep} of at most ${request.maxSteps}.`,
    `GOAL: ${request.goal}`,
    `INPUTS: ${JSON.stringify(request.inputs)}`,
    `HISTORY: ${JSON.stringify(request.history)}`,
    `FRAMES: ${JSON.stringify(frames)}`,
    `CONTROLS: ${JSON.stringify(controls)}`,
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
