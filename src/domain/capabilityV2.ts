import { z } from "zod";

const RESERVED_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const IdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)
  .refine((value) => !RESERVED_NAMES.has(value), "Reserved property name is forbidden");
const NonEmptySchema = z.string().trim().min(1);
const JsonScalarSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const AnchoredPatternSchema = NonEmptySchema.refine((pattern) => {
  if (!pattern.startsWith("^") || !pattern.endsWith("$")) return false;
  try {
    new RegExp(pattern, "u");
    return true;
  } catch {
    return false;
  }
}, "Pattern must be a valid anchored ECMAScript expression");

function addDuplicateIssues(
  values: readonly string[],
  context: z.RefinementCtx,
  path: (string | number)[],
  label: string,
): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      context.addIssue({ code: "custom", path: [...path, index], message: `Duplicate ${label}: ${value}` });
    }
    seen.add(value);
  }
}

export const ClassificationV2Schema = z.enum([
  "public",
  "internal",
  "confidential",
  "restricted",
  "secret",
]);
export type ClassificationV2 = z.infer<typeof ClassificationV2Schema>;

const StringTypeSpecSchema = z
  .object({
    kind: z.literal("string"),
    format: z.enum(["plain", "email", "phone", "member_number", "share_id"]).optional(),
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().positive().optional(),
    pattern: z
      .string()
      .min(1)
      .refine((pattern) => {
        try {
          new RegExp(pattern, "u");
          return true;
        } catch {
          return false;
        }
      }, "Pattern must be a valid ECMAScript regular expression")
      .optional(),
    enum: z.array(z.string()).min(1).optional(),
  })
  .strict()
  .superRefine((type, context) => {
    if (type.minLength !== undefined && type.maxLength !== undefined && type.minLength > type.maxLength) {
      context.addIssue({ code: "custom", path: ["maxLength"], message: "maxLength must be at least minLength" });
    }
    if (type.enum) {
      addDuplicateIssues(type.enum, context, ["enum"], "enum value");
      let expression: RegExp | undefined;
      if (type.pattern) expression = new RegExp(type.pattern, "u");
      for (const [index, value] of type.enum.entries()) {
        if (type.minLength !== undefined && value.length < type.minLength) {
          context.addIssue({ code: "custom", path: ["enum", index], message: "Enum value is shorter than minLength" });
        }
        if (type.maxLength !== undefined && value.length > type.maxLength) {
          context.addIssue({ code: "custom", path: ["enum", index], message: "Enum value is longer than maxLength" });
        }
        if (expression && !expression.test(value)) {
          context.addIssue({ code: "custom", path: ["enum", index], message: "Enum value does not match pattern" });
        }
      }
    }
  });
const NumberTypeSpecSchema = z
  .object({
    kind: z.literal("number"),
    integer: z.boolean().optional(),
    minimum: z.number().finite().optional(),
    maximum: z.number().finite().optional(),
  })
  .strict()
  .superRefine((type, context) => {
    if (type.minimum !== undefined && type.maximum !== undefined && type.minimum > type.maximum) {
      context.addIssue({ code: "custom", path: ["maximum"], message: "maximum must be at least minimum" });
    }
  });
const BooleanTypeSpecSchema = z.object({ kind: z.literal("boolean") }).strict();
const MoneyTypeSpecSchema = z
  .object({
    kind: z.literal("money"),
    currency: z.string().regex(/^[A-Z]{3}$/u),
    minimumMinorUnits: z.number().int().refine(Number.isSafeInteger, "Minor-unit bound must be a safe integer").optional(),
    maximumMinorUnits: z.number().int().refine(Number.isSafeInteger, "Minor-unit bound must be a safe integer").optional(),
  })
  .strict()
  .superRefine((type, context) => {
    if (
      type.minimumMinorUnits !== undefined &&
      type.maximumMinorUnits !== undefined &&
      type.minimumMinorUnits > type.maximumMinorUnits
    ) {
      context.addIssue({
        code: "custom",
        path: ["maximumMinorUnits"],
        message: "maximumMinorUnits must be at least minimumMinorUnits",
      });
    }
  });

export type TypeSpecV2 =
  | z.infer<typeof StringTypeSpecSchema>
  | z.infer<typeof NumberTypeSpecSchema>
  | z.infer<typeof BooleanTypeSpecSchema>
  | z.infer<typeof MoneyTypeSpecSchema>
  | { kind: "object"; properties: Record<string, TypeSpecV2>; required: string[] }
  | { kind: "array"; items: TypeSpecV2; maxItems?: number | undefined };

export const TypeSpecV2Schema: z.ZodType<TypeSpecV2> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    StringTypeSpecSchema,
    NumberTypeSpecSchema,
    BooleanTypeSpecSchema,
    MoneyTypeSpecSchema,
    z
      .object({
        kind: z.literal("object"),
        properties: z.record(IdSchema, TypeSpecV2Schema),
        required: z.array(IdSchema),
      })
      .strict()
      .superRefine((type, context) => {
        addDuplicateIssues(type.required, context, ["required"], "required property");
        for (const [index, name] of type.required.entries()) {
          if (!Object.hasOwn(type.properties, name)) {
            context.addIssue({
              code: "custom",
              path: ["required", index],
              message: `Required property is not declared: ${name}`,
            });
          }
        }
      }),
    z
      .object({
        kind: z.literal("array"),
        items: TypeSpecV2Schema,
        maxItems: z.number().int().positive().max(10_000).optional(),
      })
      .strict(),
  ]),
);

export const FieldSpecV2Schema = z
  .object({
    name: IdSchema,
    description: NonEmptySchema,
    type: TypeSpecV2Schema,
    required: z.boolean(),
    classification: ClassificationV2Schema,
  })
  .strict();
export type FieldSpecV2 = z.infer<typeof FieldSpecV2Schema>;

export const ValueExprV2Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("literal"), value: JsonScalarSchema }).strict(),
  z.object({ kind: z.literal("input"), name: IdSchema }).strict(),
  z.object({ kind: z.literal("binding"), name: IdSchema }).strict(),
]);
export type ValueExprV2 = z.infer<typeof ValueExprV2Schema>;

export const LocatorStrategyV2Schema = z.discriminatedUnion("kind", [
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
  z
    .object({
      kind: z.literal("navigation_link"),
      name: NonEmptySchema,
      exact: z.boolean(),
      companionText: NonEmptySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("label_value"),
      label: NonEmptySchema,
      valueCellOffset: z.number().int().min(1).max(8).default(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("label_value_expr"),
      label: ValueExprV2Schema,
      prefix: z.string().max(160).default(""),
      suffix: z.string().max(160).default(""),
      valueCellOffset: z.number().int().min(1).max(8).default(1),
    })
    .strict()
    .refine((strategy) => strategy.prefix.length > 0 || strategy.suffix.length > 0, {
      message: "Expression-backed labels require an authored prefix or suffix",
    }),
  z
    .object({
      kind: z.literal("table"),
      headers: z.array(NonEmptySchema).min(1),
      nearText: NonEmptySchema.optional(),
    })
    .strict()
    .superRefine((strategy, context) => addDuplicateIssues(strategy.headers, context, ["headers"], "table header")),
  z
    .object({
      kind: z.literal("table_row_control"),
      headers: z.array(NonEmptySchema).min(1),
      keyColumn: NonEmptySchema,
      key: ValueExprV2Schema,
      controlRole: NonEmptySchema,
      controlName: NonEmptySchema,
    })
    .strict()
    .superRefine((strategy, context) => {
      addDuplicateIssues(strategy.headers, context, ["headers"], "table header");
      if (!strategy.headers.includes(strategy.keyColumn)) {
        context.addIssue({ code: "custom", path: ["keyColumn"], message: "keyColumn must be one of the declared headers" });
      }
    }),
  z
    .object({
      kind: z.literal("table_row_value"),
      headers: z.array(NonEmptySchema).min(1),
      keyColumn: NonEmptySchema,
      key: ValueExprV2Schema,
      valueColumn: NonEmptySchema,
    })
    .strict()
    .superRefine((strategy, context) => {
      addDuplicateIssues(strategy.headers, context, ["headers"], "table header");
      if (!strategy.headers.includes(strategy.keyColumn)) {
        context.addIssue({ code: "custom", path: ["keyColumn"], message: "keyColumn must be one of the declared headers" });
      }
      if (!strategy.headers.includes(strategy.valueColumn)) {
        context.addIssue({ code: "custom", path: ["valueColumn"], message: "valueColumn must be one of the declared headers" });
      }
    }),
]);
export type LocatorStrategyV2 = z.infer<typeof LocatorStrategyV2Schema>;

export const TargetV2Schema = z
  .object({
    id: IdSchema,
    description: NonEmptySchema,
    framePath: z.array(z.object({ title: NonEmptySchema }).strict()).max(12),
    strategies: z.array(LocatorStrategyV2Schema).min(1),
    cardinality: z.literal("exactly_one"),
    sensitive: z.boolean().default(false),
  })
  .strict();
export type TargetV2 = z.infer<typeof TargetV2Schema>;

const TableColumnV2Schema = z
  .object({
    header: NonEmptySchema,
    key: IdSchema,
    type: TypeSpecV2Schema,
    classification: ClassificationV2Schema,
  })
  .strict();

export const ActionV2Schema = z.discriminatedUnion("kind", [
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
      outputName: IdSchema.optional(),
      bindingName: IdSchema.optional(),
      source: z.enum(["text", "value"]).default("text"),
      transform: z
        .object({ kind: z.literal("strip_exact_suffix"), suffix: NonEmptySchema })
        .strict()
        .optional(),
    })
    .strict()
    .refine((value) => Boolean(value.outputName) !== Boolean(value.bindingName), {
      message: "extract requires exactly one of outputName or bindingName",
    }),
  z
    .object({
      kind: z.literal("extract_table"),
      targetId: IdSchema,
      outputName: IdSchema,
      columns: z.array(TableColumnV2Schema).min(1),
    })
    .strict()
    .superRefine((action, context) => {
      addDuplicateIssues(action.columns.map((column) => column.header), context, ["columns"], "table column header");
      addDuplicateIssues(action.columns.map((column) => column.key), context, ["columns"], "table column key");
    }),
  z.object({ kind: z.literal("press"), key: NonEmptySchema }).strict(),
]);
export type ActionV2 = z.infer<typeof ActionV2Schema>;

const AtomicConditionV2Schema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("target_present"), targetId: IdSchema, present: z.boolean() })
    .strict(),
  z
    .object({ kind: z.literal("target_visible"), targetId: IdSchema, visible: z.boolean() })
    .strict(),
  z
    .object({
      kind: z.literal("target_value"),
      targetId: IdSchema,
      operator: z.enum(["equals", "contains", "matches"]),
      value: ValueExprV2Schema,
      redactActual: z.boolean().default(true),
    })
    .strict(),
  z.object({ kind: z.literal("text_visible"), text: NonEmptySchema, exact: z.boolean() }).strict(),
  z.object({ kind: z.literal("page_title"), title: NonEmptySchema, exact: z.boolean() }).strict(),
  z.object({ kind: z.literal("route"), pattern: AnchoredPatternSchema }).strict(),
  z.object({ kind: z.literal("http_status"), status: z.number().int().min(100).max(599) }).strict(),
]);

export type ConditionV2 =
  | z.infer<typeof AtomicConditionV2Schema>
  | { kind: "all" | "any"; conditions: ConditionV2[] }
  | { kind: "not"; condition: ConditionV2 };

export const ConditionV2Schema: z.ZodType<ConditionV2> = z.lazy(() =>
  z.union([
    AtomicConditionV2Schema,
    z
      .object({
        kind: z.enum(["all", "any"]),
        conditions: z.array(ConditionV2Schema).min(1),
      })
      .strict(),
    z.object({ kind: z.literal("not"), condition: ConditionV2Schema }).strict(),
  ]),
);

export const StepEffectV2Schema = z.enum([
  "read",
  "draft",
  "review",
  "reversible_write",
  "irreversible_commit",
]);
export type StepEffectV2 = z.infer<typeof StepEffectV2Schema>;

export const ApprovalRequirementV2Schema = z
  .object({
    kind: z.enum(["user_confirmation", "supervisor_confirmation"]),
    summaryTargets: z.array(IdSchema).min(1),
    summarySources: z.record(IdSchema, z.enum(["text", "value"])).default({}),
    stateNonceTarget: IdSchema,
    expiresInMs: z.number().int().min(5_000).max(900_000),
  })
  .strict()
  .superRefine((approval, context) => {
    addDuplicateIssues(approval.summaryTargets, context, ["summaryTargets"], "approval summary target");
    if (approval.summaryTargets.includes(approval.stateNonceTarget)) {
      context.addIssue({
        code: "custom",
        path: ["stateNonceTarget"],
        message: "The state nonce target cannot be displayed in the approval summary",
      });
    }
  });
export type ApprovalRequirementV2 = z.infer<typeof ApprovalRequirementV2Schema>;

export const InputRelationV2Schema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("not_equal"), left: IdSchema, right: IdSchema })
    .strict()
    .refine((relation) => relation.left !== relation.right, { message: "not_equal inputs must be different" }),
  z
    .object({
      kind: z.literal("starts_with_input"),
      value: IdSchema,
      prefix: IdSchema,
      separator: z.string().max(8).default(""),
    })
    .strict()
    .refine((relation) => relation.value !== relation.prefix, { message: "Value and prefix inputs must be different" }),
]);
export type InputRelationV2 = z.infer<typeof InputRelationV2Schema>;

export const StepV2Schema = z
  .object({
    id: IdSchema,
    title: NonEmptySchema,
    action: ActionV2Schema,
    preconditions: z.array(ConditionV2Schema),
    postcondition: ConditionV2Schema,
    postconditionFailureCode: IdSchema.optional(),
    timeoutMs: z.number().int().min(100).max(120_000),
    retry: z
      .object({ maxAttempts: z.number().int().min(1).max(10), backoffMs: z.number().int().min(0).max(30_000) })
      .strict(),
    effect: StepEffectV2Schema,
    approval: ApprovalRequirementV2Schema.optional(),
    safeRestartStepId: IdSchema.optional(),
  })
  .strict();
export type StepV2 = z.infer<typeof StepV2Schema>;

export const RuntimeStateRuleV2Schema = z
  .object({
    code: IdSchema,
    description: NonEmptySchema,
    category: z.enum(["business_outcome", "recoverable", "failure", "escalation", "intervention"]),
    priority: z.number().int().min(0).max(1_000),
    condition: ConditionV2Schema,
    effectCertainty: z.enum(["unknown", "not_applied"]).optional(),
    requiredRole: IdSchema.optional(),
    recovery: z
      .object({
        kind: z.enum(["restart_run", "restart_from_step", "wait_then_restart"]),
        stepId: IdSchema.optional(),
        action: ActionV2Schema.optional(),
        maxAttempts: z.number().int().min(1).max(5),
        waitMs: z.number().int().min(0).max(60_000).default(0),
      })
      .strict()
      .optional(),
    handoff: z
      .object({
        kind: z.literal("same_session"),
        action: z.enum(["restore_session", "authenticate_supervisor"]),
        resume: z.object({ kind: z.literal("restart_run") }).strict(),
        revalidate: z.array(ConditionV2Schema).min(1),
        expiresInMs: z.number().int().min(5_000).max(900_000),
        trigger: z
          .object({ kind: z.literal("capability_role"), role: IdSchema })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((rule, context) => {
    if (rule.requiredRole && rule.category !== "escalation" && rule.category !== "intervention") {
      context.addIssue({
        code: "custom",
        path: ["requiredRole"],
        message: "requiredRole is valid only for escalation or intervention states",
      });
    }
    if (rule.category === "intervention" && !rule.handoff) {
      context.addIssue({ code: "custom", path: ["handoff"], message: "Intervention states require a handoff directive" });
    }
    if (rule.category !== "intervention" && rule.handoff) {
      context.addIssue({ code: "custom", path: ["handoff"], message: "Only intervention states may declare handoff" });
    }
    if (rule.category === "intervention" && rule.effectCertainty !== "not_applied") {
      context.addIssue({
        code: "custom",
        path: ["effectCertainty"],
        message: "Intervention states must prove that no effect was applied",
      });
    }
    if (rule.handoff?.action === "authenticate_supervisor" && rule.requiredRole !== "supervisor") {
      context.addIssue({
        code: "custom",
        path: ["requiredRole"],
        message: "Supervisor authentication handoff requires the supervisor role",
      });
    }
    if (rule.handoff?.trigger && rule.requiredRole !== rule.handoff.trigger.role) {
      context.addIssue({
        code: "custom",
        path: ["handoff", "trigger", "role"],
        message: "Handoff trigger role must match requiredRole",
      });
    }
  });
export type RuntimeStateRuleV2 = z.infer<typeof RuntimeStateRuleV2Schema>;

export const AllowedRouteV2Schema = z
  .object({
    origin: z.string().url(),
    pathPattern: NonEmptySchema.refine((pattern) => {
      if (!pattern.startsWith("^") || !pattern.endsWith("$")) return false;
      try {
        new RegExp(pattern, "u");
        return true;
      } catch {
        return false;
      }
    }, "Route pattern must be a valid anchored ECMAScript expression"),
    methods: z.array(z.enum(["GET", "POST"])).min(1),
    query: z
      .record(
        z.string(),
        z
          .object({
            required: z.boolean().default(false),
            values: z.array(z.string()).min(1).optional(),
            pattern: z
              .string()
              .refine((pattern) => {
                if (!pattern.startsWith("^") || !pattern.endsWith("$")) return false;
                try {
                  new RegExp(pattern, "u");
                  return true;
                } catch {
                  return false;
                }
              }, "Query pattern must be a valid anchored ECMAScript expression")
              .optional(),
          })
          .strict()
          .refine((rule) => rule.values !== undefined || rule.pattern !== undefined, {
            message: "Query rule requires values or a pattern",
          }),
      )
      .optional(),
  })
  .strict();

export const CapabilityArtifactV2Schema = z
  .object({
    schemaVersion: z.literal("2.0"),
    capability: z
      .object({
        id: IdSchema,
        name: NonEmptySchema,
        description: NonEmptySchema,
        version: z.string().regex(/^\d+\.\d+\.\d+$/u),
        approval: z.enum(["draft", "approved", "retired"]),
        risk: z.enum(["read", "write", "irreversible", "supervisor_only"]),
        tags: z.array(NonEmptySchema),
      })
      .strict(),
    provenance: z
      .object({
        source: z.enum(["discovery", "authored"]),
        createdAt: z.iso.datetime({ offset: true }),
        goal: NonEmptySchema,
        discoveryRunId: IdSchema.optional(),
        planner: z.object({ provider: NonEmptySchema, model: NonEmptySchema }).strict().optional(),
      })
      .strict(),
    compatibility: z
      .object({
        surfaceAdapter: NonEmptySchema,
        vendorProduct: NonEmptySchema,
        appVersion: NonEmptySchema.optional(),
        entryPoint: z.string().url(),
      })
      .strict(),
    inputs: z.array(FieldSpecV2Schema),
    outputs: z.array(FieldSpecV2Schema.omit({ required: true })),
    policy: z
      .object({
        routes: z.array(AllowedRouteV2Schema).min(1),
        allowedActions: z.array(z.enum(["click", "fill", "select", "extract", "extract_table", "press"])).min(1),
        maxEffect: StepEffectV2Schema,
        inputRelations: z.array(InputRelationV2Schema).default([]),
      })
      .strict(),
    targets: z.array(TargetV2Schema),
    steps: z.array(StepV2Schema).min(1),
    runtimeStates: z.array(RuntimeStateRuleV2Schema),
    checkpoint: ConditionV2Schema,
  })
  .strict()
  .superRefine((artifact, context) => {
    const effectRank: Record<StepEffectV2, number> = {
      read: 0,
      draft: 1,
      review: 2,
      reversible_write: 3,
      irreversible_commit: 4,
    };
    const unique = (values: string[], path: (string | number)[], label: string) => {
      const seen = new Set<string>();
      for (const value of values) {
        if (seen.has(value)) context.addIssue({ code: "custom", path, message: `Duplicate ${label}: ${value}` });
        seen.add(value);
      }
      return seen;
    };
    const targets = unique(artifact.targets.map((item) => item.id), ["targets"], "target ID");
    const inputs = unique(artifact.inputs.map((item) => item.name), ["inputs"], "input name");
    const outputs = unique(artifact.outputs.map((item) => item.name), ["outputs"], "output name");
    const steps = unique(artifact.steps.map((item) => item.id), ["steps"], "step ID");
    unique(artifact.runtimeStates.map((item) => item.code), ["runtimeStates"], "runtime state code");
    unique(artifact.capability.tags, ["capability", "tags"], "capability tag");
    unique(artifact.policy.allowedActions, ["policy", "allowedActions"], "allowed action");

    const inputTypes = new Map(artifact.inputs.map((input) => [input.name, input.type]));
    for (const [index, relation] of artifact.policy.inputRelations.entries()) {
      const names = relation.kind === "not_equal"
        ? [relation.left, relation.right]
        : [relation.value, relation.prefix];
      for (const name of names) {
        if (!inputs.has(name)) {
          context.addIssue({
            code: "custom",
            path: ["policy", "inputRelations", index],
            message: `Unknown relation input: ${name}`,
          });
        }
      }
      if (relation.kind === "starts_with_input") {
        if (inputTypes.get(relation.value)?.kind !== "string" || inputTypes.get(relation.prefix)?.kind !== "string") {
          context.addIssue({
            code: "custom",
            path: ["policy", "inputRelations", index],
            message: "starts_with_input requires string inputs",
          });
        }
      }
    }

    const verifyValue = (value: ValueExprV2, path: (string | number)[]) => {
      if (value.kind === "input" && !inputs.has(value.name)) {
        context.addIssue({ code: "custom", path, message: `Unknown input: ${value.name}` });
      }
    };
    const verifyTarget = (targetId: string, path: (string | number)[]) => {
      if (!targets.has(targetId)) context.addIssue({ code: "custom", path, message: `Unknown target: ${targetId}` });
    };
    const verifyCondition = (condition: ConditionV2, path: (string | number)[]) => {
      if (condition.kind === "all" || condition.kind === "any") {
        condition.conditions.forEach((child, index) => verifyCondition(child, [...path, "conditions", index]));
      } else if (condition.kind === "not") {
        verifyCondition(condition.condition, [...path, "condition"]);
      } else if (condition.kind === "target_present" || condition.kind === "target_visible") {
        verifyTarget(condition.targetId, [...path, "targetId"]);
      } else if (condition.kind === "target_value") {
        verifyTarget(condition.targetId, [...path, "targetId"]);
        verifyValue(condition.value, [...path, "value"]);
        if (condition.operator === "matches") {
          if (condition.value.kind !== "literal" || typeof condition.value.value !== "string") {
            context.addIssue({
              code: "custom",
              path: [...path, "value"],
              message: "Regex matches require an authored literal string",
            });
          } else {
            try {
              new RegExp(condition.value.value, "u");
            } catch {
              context.addIssue({
                code: "custom",
                path: [...path, "value"],
                message: "Regex match value is invalid",
              });
            }
          }
        }
      }
    };
    for (const [targetIndex, target] of artifact.targets.entries()) {
      for (const [strategyIndex, strategy] of target.strategies.entries()) {
        if (strategy.kind === "table_row_control" || strategy.kind === "table_row_value") {
          verifyValue(strategy.key, ["targets", targetIndex, "strategies", strategyIndex, "key"]);
        }
        if (strategy.kind === "label_value_expr") verifyValue(strategy.label, ["targets", targetIndex, "strategies", strategyIndex, "label"]);
      }
    }
    for (const [index, step] of artifact.steps.entries()) {
      const action = step.action;
      if (action.kind !== "press") verifyTarget(action.targetId, ["steps", index, "action", "targetId"]);
      if (action.kind === "fill" || action.kind === "select") verifyValue(action.value, ["steps", index, "action", "value"]);
      if ((action.kind === "extract" || action.kind === "extract_table") && action.outputName && !outputs.has(action.outputName)) {
        context.addIssue({ code: "custom", path: ["steps", index, "action", "outputName"], message: `Unknown output: ${action.outputName}` });
      }
      if (step.safeRestartStepId && !steps.has(step.safeRestartStepId)) {
        context.addIssue({ code: "custom", path: ["steps", index, "safeRestartStepId"], message: `Unknown restart step: ${step.safeRestartStepId}` });
      }
      if (step.safeRestartStepId) {
        const restartIndex = artifact.steps.findIndex((candidate) => candidate.id === step.safeRestartStepId);
        if (step.effect !== "reversible_write") {
          context.addIssue({
            code: "custom",
            path: ["steps", index, "safeRestartStepId"],
            message: "Only reversible writes may declare a safe restart boundary",
          });
        } else if (restartIndex <= index) {
          context.addIssue({
            code: "custom",
            path: ["steps", index, "safeRestartStepId"],
            message: "A safe restart boundary must be a later step",
          });
        } else if (artifact.steps[restartIndex]?.effect !== "read") {
          context.addIssue({
            code: "custom",
            path: ["steps", index, "safeRestartStepId"],
            message: "A safe restart boundary must point to a read-only verification step",
          });
        }
      }
      if ((step.effect === "reversible_write" || step.effect === "irreversible_commit") && !step.approval) {
        context.addIssue({
          code: "custom",
          path: ["steps", index, "approval"],
          message: "Externally visible writes require an explicit approval gate",
        });
      }
      if (step.effect === "reversible_write" && artifact.capability.risk === "read") {
        context.addIssue({
          code: "custom",
          path: ["steps", index, "effect"],
          message: "A read-risk capability cannot contain a reversible write",
        });
      }
      if (
        step.effect === "irreversible_commit" &&
        artifact.capability.risk !== "irreversible" &&
        artifact.capability.risk !== "supervisor_only"
      ) {
        context.addIssue({
          code: "custom",
          path: ["steps", index, "effect"],
          message: "An irreversible commit requires irreversible or supervisor_only capability risk",
        });
      }
      if (
        artifact.capability.risk === "supervisor_only" &&
        (step.effect === "reversible_write" || step.effect === "irreversible_commit") &&
        step.approval?.kind !== "supervisor_confirmation"
      ) {
        context.addIssue({
          code: "custom",
          path: ["steps", index, "approval", "kind"],
          message: "Supervisor-only writes require supervisor confirmation",
        });
      }
      if (effectRank[step.effect] > effectRank[artifact.policy.maxEffect]) {
        context.addIssue({
          code: "custom",
          path: ["steps", index, "effect"],
          message: `Step effect ${step.effect} exceeds policy maxEffect ${artifact.policy.maxEffect}`,
        });
      }
      if (!artifact.policy.allowedActions.includes(step.action.kind)) {
        context.addIssue({
          code: "custom",
          path: ["steps", index, "action", "kind"],
          message: `Action ${step.action.kind} is not allowed by policy`,
        });
      }
      if (step.approval?.kind === "supervisor_confirmation" && artifact.capability.risk !== "supervisor_only") {
        context.addIssue({
          code: "custom",
          path: ["steps", index, "approval", "kind"],
          message: "Supervisor approval requires supervisor_only capability risk",
        });
      }
      if (step.approval && !artifact.policy.allowedActions.includes("extract")) {
        context.addIssue({
          code: "custom",
          path: ["policy", "allowedActions"],
          message: "Approval summaries require the extract action",
        });
      }
      if (step.approval) {
        const summaryTargets = new Set(step.approval.summaryTargets);
        for (const targetId of step.approval.summaryTargets) {
          verifyTarget(targetId, ["steps", index, "approval", "summaryTargets"]);
        }
        for (const targetId of Object.keys(step.approval.summarySources)) {
          if (!summaryTargets.has(targetId)) {
            context.addIssue({
              code: "custom",
              path: ["steps", index, "approval", "summarySources", targetId],
              message: "Approval summary source refers to a target that is not summarized",
            });
          }
        }
        verifyTarget(step.approval.stateNonceTarget, ["steps", index, "approval", "stateNonceTarget"]);
        const nonceTarget = artifact.targets.find((target) => target.id === step.approval?.stateNonceTarget);
        if (nonceTarget && !nonceTarget.sensitive) {
          context.addIssue({
            code: "custom",
            path: ["steps", index, "approval", "stateNonceTarget"],
            message: "Approval state nonce targets must be classified as sensitive",
          });
        }
      }
      step.preconditions.forEach((condition, conditionIndex) => verifyCondition(condition, ["steps", index, "preconditions", conditionIndex]));
      verifyCondition(step.postcondition, ["steps", index, "postcondition"]);
    }
    artifact.runtimeStates.forEach((state, index) => {
      verifyCondition(state.condition, ["runtimeStates", index, "condition"]);
      state.handoff?.revalidate.forEach((condition, conditionIndex) => {
        verifyCondition(condition, ["runtimeStates", index, "handoff", "revalidate", conditionIndex]);
      });
      if (state.recovery?.stepId && !steps.has(state.recovery.stepId)) {
        context.addIssue({ code: "custom", path: ["runtimeStates", index, "recovery", "stepId"], message: `Unknown restart step: ${state.recovery.stepId}` });
      }
      if (state.recovery?.action) {
        const action = state.recovery.action;
        if (action.kind !== "press") verifyTarget(action.targetId, ["runtimeStates", index, "recovery", "action", "targetId"]);
        if (action.kind === "fill" || action.kind === "select") {
          verifyValue(action.value, ["runtimeStates", index, "recovery", "action", "value"]);
        }
        if (!artifact.policy.allowedActions.includes(action.kind)) {
          context.addIssue({
            code: "custom",
            path: ["runtimeStates", index, "recovery", "action", "kind"],
            message: `Recovery action ${action.kind} is not allowed by policy`,
          });
        }
      }
      if (state.recovery?.kind === "restart_from_step" && !state.recovery.stepId) {
        context.addIssue({
          code: "custom",
          path: ["runtimeStates", index, "recovery", "stepId"],
          message: "restart_from_step requires a stepId",
        });
      }
      if (state.category === "recoverable" && !state.recovery) {
        context.addIssue({
          code: "custom",
          path: ["runtimeStates", index, "recovery"],
          message: "Recoverable runtime states require a recovery directive",
        });
      }
      if (state.category !== "recoverable" && state.recovery) {
        context.addIssue({
          code: "custom",
          path: ["runtimeStates", index, "recovery"],
          message: "Only recoverable runtime states may declare recovery",
        });
      }
    });

    const classificationRank: Record<ClassificationV2, number> = {
      public: 0,
      internal: 1,
      confidential: 2,
      restricted: 3,
      secret: 4,
    };
    const outputActions = new Map<string, number[]>();
    for (const [stepIndex, step] of artifact.steps.entries()) {
      const action = step.action;
      if (action.kind !== "extract" && action.kind !== "extract_table") continue;
      if (!action.outputName) continue;
      const indices = outputActions.get(action.outputName) ?? [];
      indices.push(stepIndex);
      outputActions.set(action.outputName, indices);
      if (action.kind !== "extract_table") continue;
      const output = artifact.outputs.find((candidate) => candidate.name === action.outputName);
      if (!output || output.type.kind !== "array" || output.type.items.kind !== "object") {
        context.addIssue({
          code: "custom",
          path: ["steps", stepIndex, "action", "outputName"],
          message: "Table extraction requires an array-of-object output",
        });
        continue;
      }
      const columnKeys = new Set(action.columns.map((column) => column.key));
      const propertyKeys = new Set(Object.keys(output.type.items.properties));
      if (
        columnKeys.size !== propertyKeys.size ||
        [...columnKeys].some((key) => !propertyKeys.has(key)) ||
        output.type.items.required.length !== propertyKeys.size ||
        output.type.items.required.some((key) => !propertyKeys.has(key))
      ) {
        context.addIssue({
          code: "custom",
          path: ["steps", stepIndex, "action", "columns"],
          message: "Table columns must exactly match the required object properties of the declared output",
        });
      }
      for (const [columnIndex, column] of action.columns.entries()) {
        const property = output.type.items.properties[column.key];
        if (property && JSON.stringify(property) !== JSON.stringify(column.type)) {
          context.addIssue({
            code: "custom",
            path: ["steps", stepIndex, "action", "columns", columnIndex, "type"],
            message: `Table column type does not match output property ${column.key}`,
          });
        }
        if (classificationRank[column.classification] > classificationRank[output.classification]) {
          context.addIssue({
            code: "custom",
            path: ["steps", stepIndex, "action", "columns", columnIndex, "classification"],
            message: "Table column classification exceeds the enclosing output classification",
          });
        }
      }
    }
    for (const [index, output] of artifact.outputs.entries()) {
      const producers = outputActions.get(output.name) ?? [];
      if (producers.length !== 1) {
        context.addIssue({
          code: "custom",
          path: ["outputs", index, "name"],
          message: `Output ${output.name} must be produced by exactly one extraction step`,
        });
      }
    }
    verifyCondition(artifact.checkpoint, ["checkpoint"]);
  });

export type CapabilityArtifactV2 = z.infer<typeof CapabilityArtifactV2Schema>;

export function isCapabilityArtifactV2(value: unknown): value is CapabilityArtifactV2 {
  return CapabilityArtifactV2Schema.safeParse(value).success;
}
