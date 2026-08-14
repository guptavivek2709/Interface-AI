import { z } from "zod";

const RESERVED_PROPERTY_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const IdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)
  .refine((value) => !RESERVED_PROPERTY_NAMES.has(value), "Reserved property name is forbidden");
const NonEmptySchema = z.string().trim().min(1);
const IsoDateSchema = z.iso.datetime({ offset: true });
const JsonScalarSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);

export const DataClassificationSchema = z.enum([
  "public",
  "internal",
  "confidential",
  "restricted",
]);
export type DataClassification = z.infer<typeof DataClassificationSchema>;

export const LiteralValueExprSchema = z
  .object({ kind: z.literal("literal"), value: JsonScalarSchema })
  .strict();
export const InputValueExprSchema = z
  .object({ kind: z.literal("input"), name: IdSchema })
  .strict();
export const ValueExprSchema = z.discriminatedUnion("kind", [
  LiteralValueExprSchema,
  InputValueExprSchema,
]);
export type ValueExpr = z.infer<typeof ValueExprSchema>;

export const FramePathSegmentSchema = z.object({ title: NonEmptySchema }).strict();
export const FramePathSchema = z.array(FramePathSegmentSchema).max(12);
export type FramePath = z.infer<typeof FramePathSchema>;

export const LocatorStrategySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("role"),
      role: NonEmptySchema,
      name: NonEmptySchema,
      exact: z.boolean(),
    })
    .strict(),
  z.object({ kind: z.literal("label"), label: NonEmptySchema, exact: z.boolean() }).strict(),
  z.object({ kind: z.literal("name"), name: NonEmptySchema }).strict(),
  z.object({ kind: z.literal("text"), text: NonEmptySchema, exact: z.boolean() }).strict(),
]);
export type LocatorStrategy = z.infer<typeof LocatorStrategySchema>;

export const TargetRefSchema = z
  .object({
    id: IdSchema,
    description: NonEmptySchema,
    framePath: FramePathSchema,
    strategies: z.array(LocatorStrategySchema).min(1),
    cardinality: z.literal("exactly_one"),
    rationale: NonEmptySchema,
  })
  .strict();
export type TargetRef = z.infer<typeof TargetRefSchema>;

export const TargetVisibleConditionSchema = z
  .object({ kind: z.literal("target_visible"), targetId: IdSchema, visible: z.boolean() })
  .strict();
export const TargetValueConditionSchema = z
  .object({
    kind: z.literal("target_value"),
    targetId: IdSchema,
    operator: z.enum(["equals", "contains", "matches"]),
    value: ValueExprSchema,
  })
  .strict();
export const FramePathConditionSchema = z
  .object({ kind: z.literal("frame_path"), framePath: FramePathSchema.min(1) })
  .strict();
export const TextVisibleConditionSchema = z
  .object({ kind: z.literal("text_visible"), text: NonEmptySchema, exact: z.boolean() })
  .strict();
export const AtomicConditionSchema = z.discriminatedUnion("kind", [
  TargetVisibleConditionSchema,
  TargetValueConditionSchema,
  FramePathConditionSchema,
  TextVisibleConditionSchema,
]);
export const AllConditionSchema = z
  .object({ kind: z.literal("all"), conditions: z.array(AtomicConditionSchema).min(1) })
  .strict();
export const ConditionSchema = z.union([AtomicConditionSchema, AllConditionSchema]);
export type Condition = z.infer<typeof ConditionSchema>;

export const ClickActionSchema = z.object({ kind: z.literal("click"), targetId: IdSchema }).strict();
export const FillActionSchema = z
  .object({ kind: z.literal("fill"), targetId: IdSchema, value: ValueExprSchema })
  .strict();
export const SelectActionSchema = z
  .object({ kind: z.literal("select"), targetId: IdSchema, value: ValueExprSchema })
  .strict();
export const ExtractActionSchema = z
  .object({ kind: z.literal("extract"), targetId: IdSchema, outputName: IdSchema })
  .strict();
export const PressActionSchema = z.object({ kind: z.literal("press"), key: NonEmptySchema }).strict();
export const ActionSchema = z.discriminatedUnion("kind", [
  ClickActionSchema,
  FillActionSchema,
  SelectActionSchema,
  ExtractActionSchema,
  PressActionSchema,
]);
export type Action = z.infer<typeof ActionSchema>;
export const ActionKindSchema = z.enum(["click", "fill", "select", "extract", "press"]);
export type ActionKind = z.infer<typeof ActionKindSchema>;

export const StepSchema = z
  .object({
    id: IdSchema,
    title: NonEmptySchema,
    action: ActionSchema,
    preconditions: z.array(ConditionSchema),
    postcondition: ConditionSchema,
    timeoutMs: z.number().int().min(100).max(120_000),
    retry: z
      .object({
        maxAttempts: z.number().int().min(1).max(10),
        backoffMs: z.number().int().min(0).max(30_000),
      })
      .strict(),
    risk: z.enum(["safe", "reversible", "irreversible"]),
  })
  .strict();
export type Step = z.infer<typeof StepSchema>;

export const AllowedRouteSchema = z
  .object({
    origin: NonEmptySchema,
    path: z.string().startsWith("/"),
    match: z.enum(["exact", "prefix", "glob"]).optional(),
  })
  .strict();
export const PolicyConfigSchema = z
  .object({
    allowedOrigins: z.array(NonEmptySchema).optional(),
    allowedRoutes: z.array(z.union([NonEmptySchema, AllowedRouteSchema])).optional(),
    allowedActions: z.array(NonEmptySchema).optional(),
    deniedActions: z.array(NonEmptySchema).optional(),
    maxRisk: z.enum(["low", "medium", "high", "critical"]).optional(),
  })
  .strict();
export type PolicyConfig = z.infer<typeof PolicyConfigSchema>;

export const InputSpecSchema = z
  .object({
    name: IdSchema,
    description: NonEmptySchema,
    type: z.enum(["string", "number", "boolean"]),
    required: z.boolean(),
    classification: DataClassificationSchema,
    pattern: z
      .string()
      .min(1)
      .superRefine((pattern, context) => {
        try {
          // Replay uses JavaScript regexes. Compiling with Unicode semantics here
          // prevents an artifact from loading successfully and failing later when
          // invocation input validation first touches a malformed pattern.
          new RegExp(pattern, "u");
        } catch (error) {
          context.addIssue({
            code: "custom",
            message: `Invalid ECMAScript regular expression: ${
              error instanceof Error ? error.message : "unknown syntax error"
            }`,
          });
        }
      })
      .optional(),
    enum: z.array(JsonScalarSchema).min(1).optional(),
  })
  .strict();
export type InputSpec = z.infer<typeof InputSpecSchema>;

export const OutputSpecSchema = z
  .object({
    name: IdSchema,
    description: NonEmptySchema,
    type: z.enum(["string", "number", "boolean", "money"]),
    classification: DataClassificationSchema,
  })
  .strict();
export type OutputSpec = z.infer<typeof OutputSpecSchema>;

export const BusinessOutcomeSpecSchema = z
  .object({ code: IdSchema, description: NonEmptySchema, condition: ConditionSchema })
  .strict();
export type BusinessOutcomeSpec = z.infer<typeof BusinessOutcomeSpecSchema>;

export const RecoverySpecSchema = z
  .object({
    code: IdSchema,
    description: NonEmptySchema,
    condition: ConditionSchema,
    strategy: z.enum(["dismiss", "retry", "wait"]),
    action: ActionSchema.optional(),
    maxAttempts: z.number().int().min(1).max(10),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.strategy === "dismiss" && value.action === undefined) {
      context.addIssue({ code: "custom", path: ["action"], message: "dismiss requires an action" });
    }
  });
export type RecoverySpec = z.infer<typeof RecoverySpecSchema>;

export const ExceptionSpecSchema = z
  .object({
    code: IdSchema,
    description: NonEmptySchema,
    condition: ConditionSchema,
    disposition: z.enum(["failure", "intervention"]),
  })
  .strict();
export type ExceptionSpec = z.infer<typeof ExceptionSpecSchema>;

export const CapabilityArtifactSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    capability: z
      .object({
        id: IdSchema,
        name: NonEmptySchema,
        description: NonEmptySchema,
        version: z.string().regex(/^\d+\.\d+\.\d+$/u),
        approval: z.enum(["draft", "approved", "retired"]),
        tags: z.array(NonEmptySchema),
      })
      .strict(),
    provenance: z
      .object({
        source: z.enum(["discovery", "authored"]),
        createdAt: IsoDateSchema,
        discoveryRunId: IdSchema.optional(),
        goal: NonEmptySchema,
        planner: z
          .object({ provider: NonEmptySchema, model: NonEmptySchema })
          .strict()
          .optional(),
      })
      .strict(),
    compatibility: z
      .object({
        surfaceAdapter: NonEmptySchema,
        vendorProduct: NonEmptySchema,
        appVersion: NonEmptySchema.optional(),
        tenantVariant: NonEmptySchema.optional(),
        entryPoint: NonEmptySchema,
      })
      .strict(),
    inputs: z.array(InputSpecSchema),
    outputs: z.array(OutputSpecSchema),
    policy: PolicyConfigSchema,
    targets: z.array(TargetRefSchema).min(1),
    steps: z.array(StepSchema).min(1),
    businessOutcomes: z.array(BusinessOutcomeSpecSchema),
    recoveries: z.array(RecoverySpecSchema),
    exceptions: z.array(ExceptionSpecSchema),
    checkpoint: ConditionSchema,
  })
  .strict()
  .superRefine((artifact, context) => {
    const reportDuplicates = (values: string[], path: (string | number)[], label: string) => {
      const seen = new Set<string>();
      for (const value of values) {
        if (seen.has(value)) {
          context.addIssue({ code: "custom", path, message: `Duplicate ${label}: ${value}` });
        }
        seen.add(value);
      }
      return seen;
    };
    const targetIds = reportDuplicates(
      artifact.targets.map((target) => target.id),
      ["targets"],
      "target ID",
    );
    const inputNames = reportDuplicates(
      artifact.inputs.map((input) => input.name),
      ["inputs"],
      "input name",
    );
    const outputNames = reportDuplicates(
      artifact.outputs.map((output) => output.name),
      ["outputs"],
      "output name",
    );
    reportDuplicates(artifact.steps.map((step) => step.id), ["steps"], "step ID");
    reportDuplicates(
      [
        ...artifact.businessOutcomes.map((outcome) => outcome.code),
        ...artifact.recoveries.map((recovery) => recovery.code),
        ...artifact.exceptions.map((item) => item.code),
      ],
      ["businessOutcomes"],
      "outcome/recovery/exception code",
    );

    const verifyValue = (value: ValueExpr, path: (string | number)[]) => {
      if (value.kind === "input" && !inputNames.has(value.name)) {
        context.addIssue({ code: "custom", path, message: `Unknown input reference: ${value.name}` });
      }
    };
    const verifyCondition = (condition: Condition, path: (string | number)[]) => {
      if (condition.kind === "all") {
        condition.conditions.forEach((child, index) =>
          verifyCondition(child, [...path, "conditions", index]),
        );
      } else if (condition.kind === "target_visible") {
        if (!targetIds.has(condition.targetId)) {
          context.addIssue({
            code: "custom",
            path: [...path, "targetId"],
            message: `Unknown target reference: ${condition.targetId}`,
          });
        }
      } else if (condition.kind === "target_value") {
        if (!targetIds.has(condition.targetId)) {
          context.addIssue({
            code: "custom",
            path: [...path, "targetId"],
            message: `Unknown target reference: ${condition.targetId}`,
          });
        }
        verifyValue(condition.value, [...path, "value"]);
      }
    };
    const verifyAction = (action: Action, path: (string | number)[]) => {
      if (action.kind !== "press" && !targetIds.has(action.targetId)) {
        context.addIssue({
          code: "custom",
          path: [...path, "targetId"],
          message: `Unknown target reference: ${action.targetId}`,
        });
      }
      if (action.kind === "fill" || action.kind === "select") {
        verifyValue(action.value, [...path, "value"]);
      }
      if (action.kind === "extract" && !outputNames.has(action.outputName)) {
        context.addIssue({
          code: "custom",
          path: [...path, "outputName"],
          message: `Unknown output reference: ${action.outputName}`,
        });
      }
    };

    artifact.steps.forEach((step, index) => {
      verifyAction(step.action, ["steps", index, "action"]);
      step.preconditions.forEach((condition, conditionIndex) =>
        verifyCondition(condition, ["steps", index, "preconditions", conditionIndex]),
      );
      verifyCondition(step.postcondition, ["steps", index, "postcondition"]);
    });
    artifact.businessOutcomes.forEach((outcome, index) =>
      verifyCondition(outcome.condition, ["businessOutcomes", index, "condition"]),
    );
    artifact.recoveries.forEach((recovery, index) => {
      verifyCondition(recovery.condition, ["recoveries", index, "condition"]);
      if (recovery.action) verifyAction(recovery.action, ["recoveries", index, "action"]);
    });
    artifact.exceptions.forEach((exception, index) =>
      verifyCondition(exception.condition, ["exceptions", index, "condition"]),
    );
    verifyCondition(artifact.checkpoint, ["checkpoint"]);
  });
export type CapabilityArtifact = z.infer<typeof CapabilityArtifactSchema>;

export const JournalStatusSchema = z.enum(["started", "succeeded", "failed", "skipped"]);
export const ActionJournalEntrySchema = z
  .object({
    sequence: z.number().int().positive(),
    stepId: IdSchema,
    action: ActionSchema,
    status: JournalStatusSchema,
    startedAt: IsoDateSchema,
    completedAt: IsoDateSchema.optional(),
    summary: NonEmptySchema.optional(),
    evidencePaths: z.array(NonEmptySchema),
  })
  .strict();
export type ActionJournalEntry = z.infer<typeof ActionJournalEntrySchema>;

export const ControlOwnerSchema = z.enum(["automation", "human"]);
export const ControlLeaseSchema = z
  .object({
    sessionId: IdSchema,
    owner: ControlOwnerSchema,
    ownerId: IdSchema,
    epoch: z.number().int().nonnegative(),
  })
  .strict();
export type ControlLease = z.infer<typeof ControlLeaseSchema>;

export const InterventionRequestSchema = z
  .object({
    interventionId: IdSchema,
    sessionId: IdSchema,
    runId: IdSchema,
    capabilityId: IdSchema,
    goal: NonEmptySchema,
    stepId: IdSchema,
    reasonCode: IdSchema,
    reason: NonEmptySchema,
    screenshotPath: NonEmptySchema,
    observedState: NonEmptySchema,
    createdAt: IsoDateSchema,
    phase: z.enum(["awaiting_human", "human_active"]),
    operatorId: IdSchema.nullable(),
    leaseEpoch: z.number().int().nonnegative(),
  })
  .strict();
export type InterventionRequest = z.infer<typeof InterventionRequestSchema>;

const RunBase = {
  runId: IdSchema,
  capabilityId: IdSchema,
  startedAt: IsoDateSchema,
  completedAt: IsoDateSchema,
  journal: z.array(ActionJournalEntrySchema),
};
const OutputValueSchema = z.union([JsonScalarSchema, z.record(z.string(), JsonScalarSchema)]);
export const SuccessRunResultSchema = z
  .object({ ...RunBase, status: z.literal("success"), outputs: z.record(IdSchema, OutputValueSchema) })
  .strict();
export const BusinessOutcomeRunResultSchema = z
  .object({
    ...RunBase,
    status: z.literal("business_outcome"),
    code: IdSchema,
    message: NonEmptySchema,
  })
  .strict();
export const FailureRunResultSchema = z
  .object({
    ...RunBase,
    status: z.literal("failure"),
    code: IdSchema,
    message: NonEmptySchema,
    stepId: IdSchema.optional(),
    expected: NonEmptySchema.optional(),
    observed: NonEmptySchema.optional(),
    retryable: z.boolean(),
    evidencePaths: z.array(NonEmptySchema),
  })
  .strict();
export const InterventionRunResultSchema = z
  .object({ ...RunBase, status: z.literal("intervention"), request: InterventionRequestSchema })
  .strict();
export const RunResultSchema = z.discriminatedUnion("status", [
  SuccessRunResultSchema,
  BusinessOutcomeRunResultSchema,
  FailureRunResultSchema,
  InterventionRunResultSchema,
]);
export type RunResult = z.infer<typeof RunResultSchema>;
