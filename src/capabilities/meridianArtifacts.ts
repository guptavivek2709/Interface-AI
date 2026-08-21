import {
  CapabilityArtifactV2Schema,
  type CapabilityArtifactV2,
  type FieldSpecV2,
  type InputRelationV2,
  type RuntimeStateRuleV2,
  type StepEffectV2,
  type StepV2,
  type TargetV2,
} from "../domain/index.js";
import {
  MERIDIAN_ADAPTER,
  MERIDIAN_APP_VERSION,
  MERIDIAN_PRODUCT,
  MERIDIAN_VENDOR_ORIGIN,
} from "../profiles/meridianCore.js";

const createdAt = "2026-08-20T18:00:00.000Z";

const target = {
  name(id: string, name: string, description: string, sensitive = false): TargetV2 {
    return {
      id,
      description,
      framePath: [],
      strategies: [{ kind: "name", name }],
      cardinality: "exactly_one",
      sensitive,
    };
  },
  role(id: string, role: string, name: string, description: string, sensitive = false): TargetV2 {
    return {
      id,
      description,
      framePath: [],
      strategies: [{ kind: "role", role, name, exact: true }],
      cardinality: "exactly_one",
      sensitive,
    };
  },
  value(id: string, label: string, description: string, sensitive = false): TargetV2 {
    return {
      id,
      description,
      framePath: [],
      strategies: [{ kind: "label_value", label, valueCellOffset: 1 }],
      cardinality: "exactly_one",
      sensitive,
    };
  },
  inputLabelValue(
    id: string,
    inputName: string,
    suffix: string,
    description: string,
    sensitive = false,
  ): TargetV2 {
    return {
      id,
      description,
      framePath: [],
      strategies: [{
        kind: "label_value_expr",
        label: { kind: "input", name: inputName },
        prefix: "",
        suffix,
        valueCellOffset: 1,
      }],
      cardinality: "exactly_one",
      sensitive,
    };
  },
  tableRowValue(
    id: string,
    keyInput: string,
    valueColumn: string,
    description: string,
    sensitive = false,
  ): TargetV2 {
    return {
      id,
      description,
      framePath: [],
      strategies: [{
        kind: "table_row_value",
        headers: ["Share ID", "Type", "Balance", "Status"],
        keyColumn: "Share ID",
        key: { kind: "input", name: keyInput },
        valueColumn,
      }],
      cardinality: "exactly_one",
      sensitive,
    };
  },
  table(id: string, headers: string[], description: string, sensitive = false): TargetV2 {
    return {
      id,
      description,
      framePath: [],
      strategies: [{ kind: "table", headers }],
      cardinality: "exactly_one",
      sensitive,
    };
  },
};

const mainMenu: TargetV2 = {
  id: "main_menu",
  description: "Return to the authenticated main menu from the persistent navigation region",
  framePath: [],
  strategies: [{
    kind: "navigation_link",
    name: "Main Menu",
    exact: true,
    companionText: "Member Inquiry",
  }],
  cardinality: "exactly_one",
  sensitive: false,
};
const memberInquiry = target.role(
  "member_inquiry",
  "link",
  "Member Inquiry / Selection",
  "Open member inquiry from the main menu",
);
const searchBy = target.name("search_by", "by", "Member inquiry search mode");
const searchValue = target.name("search_value", "q", "Member inquiry search value", true);
const searchButton = target.role("search", "button", "Search", "Submit member inquiry");
const searchResults = target.table(
  "search_results",
  ["Member No.", "Name", "Shares"],
  "Member inquiry result rows",
  true,
);
const selectedMember = (inputName = "member_number"): TargetV2 => ({
  id: "select_member",
  description: "Select the result row for the exact requested member number",
  framePath: [],
  strategies: [
    {
      kind: "table_row_control",
      headers: ["Member No.", "Name", "Shares"],
      keyColumn: "Member No.",
      key: { kind: "input", name: inputName },
      controlRole: "link",
      controlName: "Select",
    },
  ],
  cardinality: "exactly_one",
  sensitive: true,
});
const maintenanceContinue = target.role(
  "maintenance_continue",
  "link",
  "Continue",
  "Leave the declared maintenance interstitial",
);

const memberNumberValue = target.value("member_number_value", "Member No.:", "Selected member number", true);
const memberNameValue = target.value("member_name_value", "Name:", "Selected member name", true);
const emailValue = target.value("email_value", "E-mail:", "Member email address", true);
const phoneValue = target.value("phone_value", "Phone:", "Member phone number", true);
const addressValue = target.value("address_value", "Address:", "Member mailing address", true);
const sharesTable = target.table(
  "shares_table",
  ["Share ID", "Type", "Balance", "Status"],
  "Selected member shares and balances",
  true,
);

const shareSetOutput = (name: string, description: string): CapabilityArtifactV2["outputs"][number] => ({
  name,
  description,
  type: {
    kind: "array",
    maxItems: 100,
    items: {
      kind: "object",
      properties: {
        share_id: { kind: "string", format: "share_id" },
        type: { kind: "string" },
        balance: { kind: "money", currency: "USD" },
        status: { kind: "string" },
      },
      required: ["share_id", "type", "balance", "status"],
    },
  },
  classification: "restricted",
});

const shareSetExtraction = (id: string, title: string, outputName: string): StepV2 => step(
  id,
  title,
  {
    kind: "extract_table",
    targetId: "shares_table",
    outputName,
    columns: [
      { header: "Share ID", key: "share_id", type: { kind: "string", format: "share_id" }, classification: "restricted" },
      { header: "Type", key: "type", type: { kind: "string" }, classification: "internal" },
      { header: "Balance", key: "balance", type: { kind: "money", currency: "USD" }, classification: "restricted" },
      { header: "Status", key: "status", type: { kind: "string" }, classification: "internal" },
    ],
  },
  { kind: "target_present", targetId: "shares_table", present: true },
);

const stringInput = (
  name: string,
  description: string,
  options: Partial<FieldSpecV2> & { classification?: FieldSpecV2["classification"] } = {},
): FieldSpecV2 => ({
  name,
  description,
  type: { kind: "string" },
  required: true,
  classification: "confidential",
  ...options,
});

function globalRoutes(origin: string) {
  const injectedFault = {
    inject: {
      required: false,
      values: ["validation", "notfound", "permission", "timeout", "maintenance", "server"],
    },
  };
  return [
    { origin, pathPattern: "^/signon$", methods: ["GET", "POST"] as const },
    { origin, pathPattern: "^/menu$", methods: ["GET"] as const },
    {
      origin,
      pathPattern: "^/members$",
      methods: ["GET"] as const,
      query: {
        by: { required: false, values: ["number", "name"] },
        q: { required: false, pattern: "^[A-Za-z0-9 .,'-]{0,64}$" },
        next: { required: false, values: ["transfer", "open-share", "update", "hold"] },
      },
    },
    {
      origin,
      pathPattern: "^/members/[0-9]{6}$",
      methods: ["GET"] as const,
      query: injectedFault,
    },
    {
      origin,
      pathPattern: "^/members/[0-9]{6}/(?:transfer|open-share|hold)(?:/(?:review|post))?$",
      methods: ["GET", "POST"] as const,
      query: injectedFault,
    },
    {
      origin,
      pathPattern: "^/members/[0-9]{6}/update$",
      methods: ["GET", "POST"] as const,
      query: injectedFault,
    },
  ];
}

function commonStates(extra: RuntimeStateRuleV2[] = []): RuntimeStateRuleV2[] {
  const memberHttpStatus = (status: number) => ({
    kind: "all" as const,
    conditions: [
      { kind: "http_status" as const, status },
      {
        kind: "route" as const,
        pattern: "^/members(?:/[0-9]{6}(?:/(?:update|(?:transfer|open-share|hold)(?:/(?:review|post))?))?)?$",
      },
    ],
  });
  return [
    {
      code: "SESSION_EXPIRED",
      description: "The MERIDIAN session expired; sign on again before retrying from the beginning.",
      category: "intervention",
      priority: 1_000,
      condition: { kind: "http_status", status: 440 },
      effectCertainty: "not_applied",
      handoff: {
        kind: "same_session",
        action: "restore_session",
        resume: { kind: "restart_run" },
        revalidate: [{ kind: "route", pattern: "^/menu$" }],
        expiresInMs: 120_000,
      },
    },
    {
      code: "SUPERVISOR_REQUIRED",
      description: "This operation requires a separately authenticated supervisor session.",
      category: "intervention",
      priority: 990,
      condition: { kind: "http_status", status: 403 },
      effectCertainty: "not_applied",
      requiredRole: "supervisor",
      handoff: {
        kind: "same_session",
        action: "authenticate_supervisor",
        resume: { kind: "restart_run" },
        revalidate: [{ kind: "route", pattern: "^/menu$" }],
        expiresInMs: 120_000,
        trigger: { kind: "capability_role", role: "supervisor" },
      },
    },
    {
      code: "RECORD_NOT_FOUND",
      description: "The requested member record does not exist.",
      category: "business_outcome",
      priority: 980,
      condition: memberHttpStatus(404),
      effectCertainty: "not_applied",
    },
    {
      code: "APPLICATION_ERROR",
      description: "MERIDIAN returned an unexpected application error.",
      category: "failure",
      priority: 970,
      condition: { kind: "http_status", status: 500 },
    },
    {
      code: "MAINTENANCE",
      description: "MERIDIAN entered its declared maintenance interstitial; return to the menu and restart safely.",
      category: "recoverable",
      priority: 960,
      condition: { kind: "http_status", status: 503 },
      recovery: {
        kind: "restart_run",
        action: { kind: "click", targetId: "maintenance_continue" },
        maxAttempts: 1,
        waitMs: 0,
      },
    },
    {
      code: "AUTHENTICATION_REQUIRED",
      description: "The browser is no longer authenticated; establish a new secure session.",
      category: "escalation",
      priority: 950,
      condition: { kind: "text_visible", text: "OPERATOR SIGN ON", exact: true },
    },
    ...extra,
    {
      code: "MEMBER_NOT_FOUND",
      description: "No member records matched the requested search.",
      category: "business_outcome",
      priority: 900,
      condition: {
        kind: "text_visible",
        text: "No member records matched your search.",
        exact: true,
      },
    },
    {
      code: "VALIDATION_REJECTED",
      description: "MERIDIAN rejected one or more submitted field values.",
      category: "business_outcome",
      priority: 800,
      condition: memberHttpStatus(400),
      effectCertainty: "not_applied",
    },
  ];
}

function step(
  id: string,
  title: string,
  action: StepV2["action"],
  postcondition: StepV2["postcondition"],
  effect: StepEffectV2 = "read",
  preconditions: StepV2["preconditions"] = [],
): StepV2 {
  return {
    id,
    title,
    action,
    preconditions,
    postcondition,
    timeoutMs: 8_000,
    retry: { maxAttempts: action.kind === "click" ? 1 : 2, backoffMs: 100 },
    effect,
  };
}

function memberSearchSteps(mode: "number" | "name", inputName: string, select: boolean): StepV2[] {
  const steps = [
    step(
      "go_to_menu",
      "Return to main menu",
      { kind: "click", targetId: "main_menu" },
      { kind: "route", pattern: "^/menu$" },
      "read",
      [{ kind: "target_present", targetId: "main_menu", present: true }],
    ),
    step(
      "open_member_inquiry",
      "Open member inquiry",
      { kind: "click", targetId: "member_inquiry" },
      { kind: "route", pattern: "^/members$" },
      "read",
      [{ kind: "target_present", targetId: "member_inquiry", present: true }],
    ),
    step(
      "choose_search_mode",
      `Search by ${mode}`,
      { kind: "select", targetId: "search_by", value: { kind: "literal", value: mode } },
      {
        kind: "target_value",
        targetId: "search_by",
        operator: "equals",
        value: { kind: "literal", value: mode },
        redactActual: false,
      },
    ),
    step(
      "enter_search_value",
      "Enter member search value",
      { kind: "fill", targetId: "search_value", value: { kind: "input", name: inputName } },
      {
        kind: "target_value",
        targetId: "search_value",
        operator: "equals",
        value: { kind: "input", name: inputName },
        redactActual: true,
      },
      "read",
    ),
    step(
      "submit_member_search",
      "Submit member search",
      { kind: "click", targetId: "search" },
      { kind: "route", pattern: "^/members$" },
      "read",
      [{ kind: "target_present", targetId: "search", present: true }],
    ),
  ];
  if (select) {
    steps.push(
      {
        ...step(
          "select_member",
          "Select exact member result",
          { kind: "click", targetId: "select_member" },
          {
            kind: "all",
            conditions: [
              { kind: "route", pattern: "^/members/[0-9]{6}$" },
              {
                kind: "target_value",
                targetId: "member_number_value",
                operator: "equals",
                value: { kind: "input", name: inputName },
                redactActual: true,
              },
            ],
          },
          "read",
          [{ kind: "target_present", targetId: "select_member", present: true }],
        ),
        postconditionFailureCode: "MEMBER_BINDING_MISMATCH",
      },
    );
  }
  return steps;
}

interface BuildArtifact {
  id: string;
  name: string;
  description: string;
  risk: CapabilityArtifactV2["capability"]["risk"];
  goal: string;
  inputs: FieldSpecV2[];
  outputs: CapabilityArtifactV2["outputs"];
  targets: TargetV2[];
  steps: StepV2[];
  states?: RuntimeStateRuleV2[];
  checkpoint: CapabilityArtifactV2["checkpoint"];
  allowedActions: CapabilityArtifactV2["policy"]["allowedActions"];
  maxEffect: StepEffectV2;
  inputRelations?: InputRelationV2[];
  origin?: string;
}

function build(spec: BuildArtifact): CapabilityArtifactV2 {
  // Approved artifacts describe the vendor product, not a deployment instance.
  // A signed TargetProfileV2 binds this immutable base artifact to the actual
  // hosted origin at execution time.
  const origin = spec.origin ?? MERIDIAN_VENDOR_ORIGIN;
  return CapabilityArtifactV2Schema.parse({
    schemaVersion: "2.0",
    capability: {
      id: spec.id,
      name: spec.name,
      description: spec.description,
      version: "2.0.0",
      approval: "approved",
      risk: spec.risk,
      tags: ["meridian", "deterministic-replay"],
    },
    provenance: {
      source: "authored",
      createdAt,
      goal: spec.goal,
    },
    compatibility: {
      surfaceAdapter: MERIDIAN_ADAPTER,
      vendorProduct: MERIDIAN_PRODUCT,
      appVersion: MERIDIAN_APP_VERSION,
      entryPoint: `${origin}/signon`,
    },
    inputs: spec.inputs,
    outputs: spec.outputs,
    policy: {
      routes: globalRoutes(origin),
      allowedActions: spec.allowedActions,
      maxEffect: spec.maxEffect,
      inputRelations: spec.inputRelations ?? [],
    },
    targets: spec.targets,
    steps: spec.steps,
    runtimeStates: spec.states ?? commonStates(),
    checkpoint: spec.checkpoint,
  });
}

const memberNumberInput = stringInput("member_number", "Six-digit MERIDIAN member number", {
  type: { kind: "string", format: "member_number", pattern: "^[0-9]{6}$", minLength: 6, maxLength: 6 },
  classification: "restricted",
});

export const meridianSignOnArtifact = build({
  id: "session.sign_on",
  name: "Sign on to MERIDIAN",
  description: "Create one isolated, memory-only MERIDIAN operator session.",
  risk: "read",
  goal: "Sign on with an operator ID, password, and exact branch value.",
  inputs: [
    stringInput("operator", "MERIDIAN operator ID", {
      type: { kind: "string", minLength: 1, maxLength: 20 },
      classification: "secret",
    }),
    stringInput("password", "MERIDIAN operator password", {
      type: { kind: "string", minLength: 1, maxLength: 128 },
      classification: "secret",
    }),
    stringInput("branch", "Stable MERIDIAN branch option value", {
      type: { kind: "string", enum: ["MAIN-001", "WEST-014", "EAST-022"] },
      classification: "internal",
    }),
  ],
  outputs: [],
  targets: [
    target.name("operator", "operator", "Operator ID field", true),
    target.name("password", "password", "Operator password field", true),
    target.name("branch", "branch", "Branch selection"),
    target.role("sign_on", "button", "Sign On", "Submit operator sign-on"),
    maintenanceContinue,
  ],
  steps: [
    step(
      "enter_operator",
      "Enter operator ID",
      { kind: "fill", targetId: "operator", value: { kind: "input", name: "operator" } },
      {
        kind: "target_value",
        targetId: "operator",
        operator: "equals",
        value: { kind: "input", name: "operator" },
        redactActual: true,
      },
      "draft",
    ),
    step(
      "enter_password",
      "Enter operator password",
      { kind: "fill", targetId: "password", value: { kind: "input", name: "password" } },
      {
        kind: "target_value",
        targetId: "password",
        operator: "equals",
        value: { kind: "input", name: "password" },
        redactActual: true,
      },
      "draft",
    ),
    step(
      "choose_branch",
      "Choose branch",
      { kind: "select", targetId: "branch", value: { kind: "input", name: "branch" } },
      {
        kind: "target_value",
        targetId: "branch",
        operator: "equals",
        value: { kind: "input", name: "branch" },
        redactActual: false,
      },
      "draft",
    ),
    step(
      "submit_sign_on",
      "Submit sign-on",
      { kind: "click", targetId: "sign_on" },
      { kind: "route", pattern: "^/menu$" },
      "read",
      [{ kind: "target_present", targetId: "sign_on", present: true }],
    ),
  ],
  states: commonStates([
    {
      code: "INVALID_CREDENTIALS",
      description: "MERIDIAN rejected the operator ID or password.",
      category: "business_outcome",
      priority: 995,
      condition: { kind: "text_visible", text: "Invalid operator ID or password.", exact: true },
    },
  ]).filter(
    (state) =>
      state.code !== "AUTHENTICATION_REQUIRED" &&
      state.code !== "SESSION_EXPIRED" &&
      state.code !== "SUPERVISOR_REQUIRED",
  ),
  checkpoint: { kind: "route", pattern: "^/menu$" },
  allowedActions: ["fill", "select", "click"],
  maxEffect: "draft",
});

export const meridianSearchByNumberArtifact = build({
  id: "member.search_by_number",
  name: "Select member by number",
  description: "Search by an exact member number and select only its row.",
  risk: "read",
  goal: "Select the exact member row without relying on duplicate Select link text or ordinal position.",
  inputs: [memberNumberInput],
  outputs: [
    { name: "member_number", description: "Selected member number", type: { kind: "string", format: "member_number" }, classification: "restricted" },
    { name: "member_name", description: "Selected member name", type: { kind: "string" }, classification: "confidential" },
  ],
  targets: [
    mainMenu,
    memberInquiry,
    searchBy,
    searchValue,
    searchButton,
    selectedMember(),
    memberNumberValue,
    memberNameValue,
    maintenanceContinue,
  ],
  steps: [
    ...memberSearchSteps("number", "member_number", true),
    step(
      "extract_member_number",
      "Extract selected member number",
      { kind: "extract", targetId: "member_number_value", outputName: "member_number", source: "text" },
      { kind: "target_present", targetId: "member_number_value", present: true },
    ),
    step(
      "extract_member_name",
      "Extract selected member name",
      { kind: "extract", targetId: "member_name_value", outputName: "member_name", source: "text" },
      { kind: "target_present", targetId: "member_name_value", present: true },
    ),
  ],
  checkpoint: { kind: "route", pattern: "^/members/[0-9]{6}$" },
  allowedActions: ["click", "fill", "select", "extract"],
  maxEffect: "read",
});

const searchRowType = {
  kind: "object" as const,
  properties: {
    member_number: { kind: "string" as const, format: "member_number" as const },
    name: { kind: "string" as const },
    share_count: { kind: "number" as const, integer: true },
  },
  required: ["member_number", "name", "share_count"],
};

export const meridianSearchByLastNameArtifact = build({
  id: "member.search_by_last_name",
  name: "Search members by last name",
  description: "Return all matching member rows for a last-name query without silently selecting one.",
  risk: "read",
  goal: "Return structured candidates when a last-name search has zero, one, or many matches.",
  inputs: [
    stringInput("last_name", "Full or partial member last name", {
      type: { kind: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z .,'-]+$" },
      classification: "confidential",
    }),
  ],
  outputs: [
    {
      name: "candidates",
      description: "All exact rows returned by MERIDIAN",
      type: { kind: "array", items: searchRowType, maxItems: 100 },
      classification: "restricted",
    },
  ],
  targets: [mainMenu, memberInquiry, searchBy, searchValue, searchButton, searchResults, maintenanceContinue],
  steps: [
    ...memberSearchSteps("name", "last_name", false),
    step(
      "extract_candidates",
      "Extract all matching member rows",
      {
        kind: "extract_table",
        targetId: "search_results",
        outputName: "candidates",
        columns: [
          { header: "Member No.", key: "member_number", type: { kind: "string", format: "member_number" }, classification: "restricted" },
          { header: "Name", key: "name", type: { kind: "string" }, classification: "confidential" },
          { header: "Shares", key: "share_count", type: { kind: "number", integer: true }, classification: "internal" },
        ],
      },
      { kind: "target_present", targetId: "search_results", present: true },
    ),
  ],
  checkpoint: { kind: "target_present", targetId: "search_results", present: true },
  allowedActions: ["click", "fill", "select", "extract_table"],
  maxEffect: "read",
});

export const meridianRecordAndBalancesArtifact = build({
  id: "member.get_record_and_balances",
  name: "Get member record and balances",
  description: "Return the selected member profile plus an arbitrary-length structured share and balance list.",
  risk: "read",
  goal: "Read one member record and all current shares, balances, and statuses.",
  inputs: [memberNumberInput],
  outputs: [
    { name: "member_number", description: "Member number", type: { kind: "string", format: "member_number" }, classification: "restricted" },
    { name: "member_name", description: "Member name", type: { kind: "string" }, classification: "confidential" },
    { name: "email", description: "Email address", type: { kind: "string", format: "email" }, classification: "confidential" },
    { name: "phone", description: "Phone number", type: { kind: "string", format: "phone" }, classification: "confidential" },
    { name: "address", description: "Mailing address", type: { kind: "string" }, classification: "restricted" },
    {
      name: "shares",
      description: "All current shares",
      type: {
        kind: "array",
        maxItems: 100,
        items: {
          kind: "object",
          properties: {
            share_id: { kind: "string", format: "share_id" },
            type: { kind: "string" },
            balance: { kind: "money", currency: "USD" },
            status: { kind: "string" },
          },
          required: ["share_id", "type", "balance", "status"],
        },
      },
      classification: "restricted",
    },
  ],
  targets: [
    mainMenu,
    memberInquiry,
    searchBy,
    searchValue,
    searchButton,
    selectedMember(),
    memberNumberValue,
    memberNameValue,
    emailValue,
    phoneValue,
    addressValue,
    sharesTable,
    maintenanceContinue,
  ],
  steps: [
    ...memberSearchSteps("number", "member_number", true),
    step("extract_member_number", "Extract member number", { kind: "extract", targetId: "member_number_value", outputName: "member_number", source: "text" }, { kind: "target_present", targetId: "member_number_value", present: true }),
    step("extract_member_name", "Extract member name", { kind: "extract", targetId: "member_name_value", outputName: "member_name", source: "text" }, { kind: "target_present", targetId: "member_name_value", present: true }),
    step("extract_email", "Extract email", { kind: "extract", targetId: "email_value", outputName: "email", source: "text" }, { kind: "target_present", targetId: "email_value", present: true }),
    step("extract_phone", "Extract phone", { kind: "extract", targetId: "phone_value", outputName: "phone", source: "text" }, { kind: "target_present", targetId: "phone_value", present: true }),
    step("extract_address", "Extract address", { kind: "extract", targetId: "address_value", outputName: "address", source: "text" }, { kind: "target_present", targetId: "address_value", present: true }),
    step(
      "extract_shares",
      "Extract every share row",
      {
        kind: "extract_table",
        targetId: "shares_table",
        outputName: "shares",
        columns: [
          { header: "Share ID", key: "share_id", type: { kind: "string", format: "share_id" }, classification: "restricted" },
          { header: "Type", key: "type", type: { kind: "string" }, classification: "internal" },
          { header: "Balance", key: "balance", type: { kind: "money", currency: "USD" }, classification: "restricted" },
          { header: "Status", key: "status", type: { kind: "string" }, classification: "internal" },
        ],
      },
      { kind: "target_present", targetId: "shares_table", present: true },
    ),
  ],
  checkpoint: { kind: "target_present", targetId: "shares_table", present: true },
  allowedActions: ["click", "fill", "select", "extract", "extract_table"],
  maxEffect: "read",
});

function transactionTargets(kind: "transfer" | "open" | "hold"): TargetV2[] {
  const common = [
    mainMenu,
    memberInquiry,
    searchBy,
    searchValue,
    searchButton,
    selectedMember(),
    memberNumberValue,
    sharesTable,
    target.name("transaction_token", "_token", "Current form anti-replay token", true),
    maintenanceContinue,
  ];
  if (kind === "transfer") {
    return [
      ...common,
      target.role("open_transaction", "link", "Funds Transfer", "Open funds transfer"),
      target.tableRowValue("source_balance_before", "from_share", "Balance", "Source share balance before posting", true),
      target.tableRowValue("destination_balance_before", "to_share", "Balance", "Destination share balance before posting", true),
      target.name("from_share", "from", "Source share"),
      target.name("to_share", "to", "Destination share"),
      target.name("amount", "amount", "Transfer amount", true),
      target.name("memo", "memo", "Transfer memo", true),
      target.role("continue", "button", "Continue", "Review transfer"),
      target.role("commit", "button", "Post Transfer", "Final transfer commit"),
      target.value("review_member", "Member:", "Reviewed member", true),
      target.value("review_from", "From:", "Reviewed source share", true),
      target.value("review_to", "To:", "Reviewed destination share", true),
      target.value("review_amount", "Amount:", "Reviewed transfer amount", true),
      target.value("review_memo", "Memo:", "Reviewed memo", true),
      target.value("receipt_confirmation", "Confirmation:", "Posted transfer confirmation reference"),
      target.value("receipt_posted", "Posted:", "Posted transfer timestamp"),
      target.value("receipt_amount", "Amount:", "Posted transfer amount", true),
      target.inputLabelValue(
        "receipt_source_balance",
        "from_share",
        ":",
        "Source share balance reported after posting",
        true,
      ),
      target.inputLabelValue(
        "receipt_destination_balance",
        "to_share",
        ":",
        "Destination share balance reported after posting",
        true,
      ),
    ];
  }
  if (kind === "open") {
    return [
      ...common,
      target.role("open_transaction", "link", "Open New Share", "Open new share form"),
      target.name("share_type", "type", "New share type"),
      target.name("deposit", "deposit", "Initial deposit", true),
      target.role("continue", "button", "Continue", "Review new share"),
      target.role("commit", "button", "Open Share", "Final new-share commit"),
      target.value("review_member", "Member:", "Reviewed member", true),
      target.value("review_type", "Share Type:", "Reviewed share type"),
      target.value("review_deposit", "Initial Deposit:", "Reviewed initial deposit", true),
      target.value("receipt_confirmation", "Confirmation:", "Opened-share confirmation reference"),
      target.value("receipt_new_share_id", "New Share ID:", "Newly opened share ID", true),
      target.value("receipt_share_type", "Type:", "Opened share type"),
      target.value("receipt_opening_balance", "Opening Balance:", "Opened share balance", true),
    ];
  }
  return [
    ...common,
    target.role("open_transaction", "link", "Place Account Hold", "Open account hold form"),
    target.tableRowValue("share_status_before", "share", "Status", "Selected share status before the hold", true),
    target.name("share", "share", "Share to hold", true),
    target.name("reason", "reason", "Hold reason code"),
    target.name("notes", "notes", "Hold notes", true),
    target.role("continue", "button", "Continue", "Review account hold"),
    target.role("commit", "button", "Apply Hold", "Final account-hold commit"),
    target.value("review_member", "Member:", "Reviewed member", true),
    target.value("review_share", "Share:", "Reviewed share", true),
    target.value("review_reason", "Reason:", "Reviewed hold reason"),
    target.value("review_notes", "Notes:", "Reviewed hold notes", true),
    target.value("receipt_confirmation", "Confirmation:", "Applied-hold confirmation reference"),
    target.value("receipt_share_status", "Share:", "Share status reported after the hold", true),
    target.value("receipt_applied", "Applied:", "Applied-hold timestamp"),
  ];
}

function tokenCondition() {
  return {
    kind: "all" as const,
    conditions: [
      { kind: "target_present" as const, targetId: "transaction_token", present: true },
      {
        kind: "target_value" as const,
        targetId: "transaction_token",
        operator: "matches" as const,
        value: { kind: "literal" as const, value: "^[^\\r\\n]{1,256}(?![\\s\\S])" },
        redactActual: true,
      },
    ],
  };
}

function transactionPrelude(
  pathName: "transfer" | "open-share" | "hold",
  beforeOpen: StepV2[] = [],
): StepV2[] {
  return [
    ...memberSearchSteps("number", "member_number", true),
    ...beforeOpen,
    step(
      "open_transaction",
      "Open transaction form",
      { kind: "click", targetId: "open_transaction" },
      { kind: "route", pattern: `^/members/[0-9]{6}/${pathName}$` },
      "read",
      [{ kind: "target_present", targetId: "open_transaction", present: true }],
    ),
  ];
}

const postCheckpoint = (
  pathName: "transfer" | "open-share" | "hold",
  confirmedTitle: string,
  receiptTargetIds: readonly string[],
) => ({
  kind: "all" as const,
  conditions: [
    { kind: "route" as const, pattern: `^/members/[0-9]{6}/${pathName}/post$` },
    { kind: "http_status" as const, status: 200 },
    { kind: "page_title" as const, title: confirmedTitle, exact: true },
    ...receiptTargetIds.map((targetId) => ({
      kind: "target_present" as const,
      targetId,
      present: true,
    })),
  ],
});

const receiptExtraction = (
  id: string,
  title: string,
  targetId: string,
  outputName: string,
  postcondition?: StepV2["postcondition"],
  stripExactSuffix?: string,
): StepV2 => step(
  id,
  title,
  {
    kind: "extract",
    targetId,
    outputName,
    source: "text",
    ...(stripExactSuffix
      ? { transform: { kind: "strip_exact_suffix" as const, suffix: stripExactSuffix } }
      : {}),
  },
  postcondition ?? { kind: "target_present", targetId, present: true },
);

export const meridianTransferArtifact = build({
  id: "funds.transfer",
  name: "Transfer funds",
  description: "Transfer funds between member shares through review and an approval-bound final post.",
  risk: "irreversible",
  goal: "Select the exact member and shares, review the transfer, then commit only after human confirmation.",
  inputs: [
    memberNumberInput,
    stringInput("from_share", "Stable source share ID", { type: { kind: "string", format: "share_id", pattern: "^[0-9]{6}-[A-Z0-9-]{5,20}$" }, classification: "restricted" }),
    stringInput("to_share", "Stable destination share ID", { type: { kind: "string", format: "share_id", pattern: "^[0-9]{6}-[A-Z0-9-]{5,20}$" }, classification: "restricted" }),
    { name: "amount", description: "Positive USD amount", type: { kind: "money", currency: "USD", minimumMinorUnits: 1 }, required: true, classification: "restricted" },
    stringInput("memo", "Transfer memo", { type: { kind: "string", maxLength: 60 }, classification: "confidential" }),
  ],
  outputs: [
    { name: "source_balance_before", description: "Source share balance captured before transfer review", type: { kind: "money", currency: "USD" }, classification: "restricted" },
    { name: "destination_balance_before", description: "Destination share balance captured before transfer review", type: { kind: "money", currency: "USD" }, classification: "restricted" },
    { name: "confirmation", description: "MERIDIAN transfer confirmation reference", type: { kind: "string", minLength: 1, maxLength: 128 }, classification: "internal" },
    { name: "posted_at", description: "Timestamp reported by MERIDIAN for the posted transfer", type: { kind: "string", minLength: 1, maxLength: 128 }, classification: "internal" },
    { name: "amount", description: "Amount confirmed on the posted transfer receipt", type: { kind: "money", currency: "USD", minimumMinorUnits: 1 }, classification: "restricted" },
    { name: "source_balance", description: "Source share balance reported after the transfer", type: { kind: "money", currency: "USD" }, classification: "restricted" },
    { name: "destination_balance", description: "Destination share balance reported after the transfer", type: { kind: "money", currency: "USD" }, classification: "restricted" },
  ],
  targets: transactionTargets("transfer"),
  inputRelations: [
    { kind: "starts_with_input", value: "from_share", prefix: "member_number", separator: "-" },
    { kind: "starts_with_input", value: "to_share", prefix: "member_number", separator: "-" },
    { kind: "not_equal", left: "from_share", right: "to_share" },
  ],
  steps: [
    ...transactionPrelude("transfer", [
      receiptExtraction("extract_source_balance_before", "Read source balance before transfer", "source_balance_before", "source_balance_before"),
      receiptExtraction("extract_destination_balance_before", "Read destination balance before transfer", "destination_balance_before", "destination_balance_before"),
    ]),
    step("choose_source", "Choose source share", { kind: "select", targetId: "from_share", value: { kind: "input", name: "from_share" } }, { kind: "target_value", targetId: "from_share", operator: "equals", value: { kind: "input", name: "from_share" }, redactActual: true }, "draft"),
    step("choose_destination", "Choose destination share", { kind: "select", targetId: "to_share", value: { kind: "input", name: "to_share" } }, { kind: "target_value", targetId: "to_share", operator: "equals", value: { kind: "input", name: "to_share" }, redactActual: true }, "draft"),
    step("enter_amount", "Enter amount", { kind: "fill", targetId: "amount", value: { kind: "input", name: "amount" } }, { kind: "target_value", targetId: "amount", operator: "equals", value: { kind: "input", name: "amount" }, redactActual: true }, "draft"),
    step("enter_memo", "Enter memo", { kind: "fill", targetId: "memo", value: { kind: "input", name: "memo" } }, { kind: "target_value", targetId: "memo", operator: "equals", value: { kind: "input", name: "memo" }, redactActual: true }, "draft"),
    step("review_transfer", "Continue to transfer review", { kind: "click", targetId: "continue" }, { kind: "route", pattern: "^/members/[0-9]{6}/transfer/review$" }, "review", [tokenCondition()]),
    {
      ...step(
        "commit_transfer",
        "Post reviewed transfer",
        { kind: "click", targetId: "commit" },
        postCheckpoint("transfer", "Transfer Posted - Meridian Core", [
          "receipt_confirmation",
          "receipt_posted",
          "receipt_amount",
          "receipt_source_balance",
          "receipt_destination_balance",
        ]),
        "irreversible_commit",
        [tokenCondition()],
      ),
      approval: {
        kind: "user_confirmation",
        summaryTargets: ["review_member", "review_from", "review_to", "review_amount", "review_memo"],
        summarySources: {},
        stateNonceTarget: "transaction_token",
        expiresInMs: 120_000,
      },
    },
    receiptExtraction("extract_transfer_confirmation", "Read transfer confirmation", "receipt_confirmation", "confirmation"),
    receiptExtraction("extract_transfer_posted_at", "Read transfer posting time", "receipt_posted", "posted_at"),
    receiptExtraction(
      "extract_transfer_amount",
      "Read posted transfer amount",
      "receipt_amount",
      "amount",
      { kind: "target_value", targetId: "receipt_amount", operator: "contains", value: { kind: "input", name: "amount" }, redactActual: true },
    ),
    receiptExtraction("extract_transfer_source_balance", "Read resulting source balance", "receipt_source_balance", "source_balance", undefined, " (new balance)"),
    receiptExtraction("extract_transfer_destination_balance", "Read resulting destination balance", "receipt_destination_balance", "destination_balance", undefined, " (new balance)"),
  ],
  states: commonStates([
    { code: "INSUFFICIENT_FUNDS", description: "The source share has insufficient available balance.", category: "business_outcome", priority: 940, effectCertainty: "not_applied", condition: { kind: "text_visible", text: "Insufficient available balance in the source share.", exact: true } },
    { code: "SOURCE_SHARE_HELD", description: "The source share is on hold and cannot be debited.", category: "business_outcome", priority: 935, effectCertainty: "not_applied", condition: { kind: "text_visible", text: "Source share is HOLD and cannot be debited.", exact: true } },
  ]),
  checkpoint: postCheckpoint("transfer", "Transfer Posted - Meridian Core", [
    "receipt_confirmation",
    "receipt_posted",
    "receipt_amount",
    "receipt_source_balance",
    "receipt_destination_balance",
  ]),
  allowedActions: ["click", "fill", "select", "extract"],
  maxEffect: "irreversible_commit",
});

export const meridianOpenShareArtifact = build({
  id: "share.open",
  name: "Open new share",
  description: "Open a new member share through review and an approval-bound final post.",
  risk: "irreversible",
  goal: "Review a new share type and deposit, then commit only after human confirmation.",
  inputs: [
    memberNumberInput,
    stringInput("share_type", "Stable MERIDIAN share type code", { type: { kind: "string", enum: ["S0001", "S0070", "MMKT", "CERT"] }, classification: "internal" }),
    { name: "initial_deposit", description: "USD initial deposit", type: { kind: "money", currency: "USD", minimumMinorUnits: 1 }, required: true, classification: "restricted" },
  ],
  outputs: [
    shareSetOutput("shares_before", "Complete share set captured before opening a new share"),
    { name: "confirmation", description: "MERIDIAN new-share confirmation reference", type: { kind: "string", minLength: 1, maxLength: 128 }, classification: "internal" },
    { name: "new_share_id", description: "Stable ID assigned to the newly opened share", type: { kind: "string", format: "share_id", pattern: "^[0-9]{6}-[A-Z0-9-]{5,20}$" }, classification: "restricted" },
    { name: "share_type", description: "Display type confirmed by MERIDIAN for the opened share", type: { kind: "string", minLength: 1, maxLength: 128 }, classification: "internal" },
    { name: "opening_balance", description: "Opening balance confirmed by MERIDIAN", type: { kind: "money", currency: "USD", minimumMinorUnits: 1 }, classification: "restricted" },
  ],
  targets: transactionTargets("open"),
  steps: [
    ...transactionPrelude("open-share", [
      shareSetExtraction("extract_shares_before_open", "Read share set before opening", "shares_before"),
    ]),
    step("choose_share_type", "Choose share type", { kind: "select", targetId: "share_type", value: { kind: "input", name: "share_type" } }, { kind: "target_value", targetId: "share_type", operator: "equals", value: { kind: "input", name: "share_type" }, redactActual: false }, "draft"),
    step("enter_deposit", "Enter initial deposit", { kind: "fill", targetId: "deposit", value: { kind: "input", name: "initial_deposit" } }, { kind: "target_value", targetId: "deposit", operator: "equals", value: { kind: "input", name: "initial_deposit" }, redactActual: true }, "draft"),
    step("review_new_share", "Continue to new-share review", { kind: "click", targetId: "continue" }, { kind: "route", pattern: "^/members/[0-9]{6}/open-share/review$" }, "review", [tokenCondition()]),
    {
      ...step(
        "commit_new_share",
        "Open reviewed share",
        { kind: "click", targetId: "commit" },
        postCheckpoint("open-share", "Share Opened - Meridian Core", [
          "receipt_confirmation",
          "receipt_new_share_id",
          "receipt_share_type",
          "receipt_opening_balance",
        ]),
        "irreversible_commit",
        [tokenCondition()],
      ),
      approval: {
        kind: "user_confirmation",
        summaryTargets: ["review_member", "review_type", "review_deposit"],
        summarySources: {},
        stateNonceTarget: "transaction_token",
        expiresInMs: 120_000,
      },
    },
    receiptExtraction("extract_open_share_confirmation", "Read new-share confirmation", "receipt_confirmation", "confirmation"),
    receiptExtraction("extract_new_share_id", "Read the assigned share ID", "receipt_new_share_id", "new_share_id"),
    receiptExtraction(
      "extract_opened_share_type",
      "Read the opened share type",
      "receipt_share_type",
      "share_type",
    ),
    receiptExtraction(
      "extract_opening_balance",
      "Read the opening balance",
      "receipt_opening_balance",
      "opening_balance",
      { kind: "target_value", targetId: "receipt_opening_balance", operator: "contains", value: { kind: "input", name: "initial_deposit" }, redactActual: true },
    ),
  ],
  checkpoint: postCheckpoint("open-share", "Share Opened - Meridian Core", [
    "receipt_confirmation",
    "receipt_new_share_id",
    "receipt_share_type",
    "receipt_opening_balance",
  ]),
  allowedActions: ["click", "fill", "select", "extract", "extract_table"],
  maxEffect: "irreversible_commit",
});

export const meridianUpdateMemberArtifact = build({
  id: "member.update_information",
  name: "Update member information",
  description: "Update member contact fields with input validation and an approval-bound direct save.",
  risk: "write",
  goal: "Review the entered email, phone, and address in the local approval panel before saving.",
  inputs: [
    memberNumberInput,
    stringInput("email", "Updated member email", { type: { kind: "string", format: "email", maxLength: 254 }, classification: "confidential" }),
    stringInput("phone", "Updated member phone", { type: { kind: "string", format: "phone", pattern: "^[0-9()+ .-]{7,24}$" }, classification: "confidential" }),
    stringInput("address", "Updated mailing address", { type: { kind: "string", minLength: 5, maxLength: 160 }, classification: "restricted" }),
  ],
  outputs: [
    { name: "email_before", description: "Email captured before the update", type: { kind: "string", format: "email" }, classification: "confidential" },
    { name: "phone_before", description: "Phone captured before the update", type: { kind: "string", format: "phone" }, classification: "confidential" },
    { name: "address_before", description: "Address captured before the update", type: { kind: "string" }, classification: "restricted" },
    { name: "email", description: "Saved email", type: { kind: "string", format: "email" }, classification: "confidential" },
    { name: "phone", description: "Saved phone", type: { kind: "string", format: "phone" }, classification: "confidential" },
    { name: "address", description: "Saved address", type: { kind: "string" }, classification: "restricted" },
  ],
  targets: [
    mainMenu,
    memberInquiry,
    searchBy,
    searchValue,
    searchButton,
    selectedMember(),
    memberNumberValue,
    target.role("open_update", "link", "Update Member Information", "Open member update form"),
    target.name("transaction_token", "_token", "Current update-form token", true),
    target.name("email", "email", "Email field", true),
    target.name("phone", "phone", "Phone field", true),
    target.name("address", "address", "Mailing address field", true),
    target.role("save", "button", "Save Changes", "Save member information"),
    target.role(
      "return_member_record",
      "link",
      "Return to Member Record",
      "Leave the successful update receipt and return to the member record",
    ),
    emailValue,
    phoneValue,
    addressValue,
    maintenanceContinue,
  ],
  steps: [
    ...memberSearchSteps("number", "member_number", true),
    receiptExtraction("extract_email_before", "Read email before update", "email_value", "email_before"),
    receiptExtraction("extract_phone_before", "Read phone before update", "phone_value", "phone_before"),
    receiptExtraction("extract_address_before", "Read address before update", "address_value", "address_before"),
    step("open_update", "Open member update", { kind: "click", targetId: "open_update" }, { kind: "route", pattern: "^/members/[0-9]{6}/update$" }, "read", [{ kind: "target_present", targetId: "open_update", present: true }]),
    step("enter_email", "Enter email", { kind: "fill", targetId: "email", value: { kind: "input", name: "email" } }, { kind: "target_value", targetId: "email", operator: "equals", value: { kind: "input", name: "email" }, redactActual: true }, "draft"),
    step("enter_phone", "Enter phone", { kind: "fill", targetId: "phone", value: { kind: "input", name: "phone" } }, { kind: "target_value", targetId: "phone", operator: "equals", value: { kind: "input", name: "phone" }, redactActual: true }, "draft"),
    step("enter_address", "Enter address", { kind: "fill", targetId: "address", value: { kind: "input", name: "address" } }, { kind: "target_value", targetId: "address", operator: "equals", value: { kind: "input", name: "address" }, redactActual: true }, "draft"),
    {
      ...step(
        "save_update",
        "Save reviewed member update",
        { kind: "click", targetId: "save" },
        {
          kind: "all",
          conditions: [
            { kind: "route", pattern: "^/members/[0-9]{6}/update$" },
            { kind: "target_present", targetId: "return_member_record", present: true },
          ],
        },
        "reversible_write",
        [tokenCondition()],
      ),
      approval: {
        kind: "user_confirmation",
        summaryTargets: ["email", "phone", "address"],
        summarySources: { email: "value", phone: "value", address: "value" },
        stateNonceTarget: "transaction_token",
        expiresInMs: 120_000,
      },
    },
    step(
      "return_to_member_record",
      "Return to the updated member record",
      { kind: "click", targetId: "return_member_record" },
      { kind: "route", pattern: "^/members/[0-9]{6}$" },
      "read",
      [{ kind: "target_present", targetId: "return_member_record", present: true }],
    ),
    { ...step("extract_saved_email", "Read saved email", { kind: "extract", targetId: "email_value", outputName: "email", source: "text" }, { kind: "target_value", targetId: "email_value", operator: "equals", value: { kind: "input", name: "email" }, redactActual: true }), postconditionFailureCode: "SAVED_VALUE_MISMATCH" },
    { ...step("extract_saved_phone", "Read saved phone", { kind: "extract", targetId: "phone_value", outputName: "phone", source: "text" }, { kind: "target_value", targetId: "phone_value", operator: "equals", value: { kind: "input", name: "phone" }, redactActual: true }), postconditionFailureCode: "SAVED_VALUE_MISMATCH" },
    { ...step("extract_saved_address", "Read saved address", { kind: "extract", targetId: "address_value", outputName: "address", source: "text" }, { kind: "target_value", targetId: "address_value", operator: "equals", value: { kind: "input", name: "address" }, redactActual: true }), postconditionFailureCode: "SAVED_VALUE_MISMATCH" },
  ],
  states: commonStates([
    { code: "INVALID_EMAIL", description: "The email address is not in a valid format.", category: "business_outcome", priority: 940, effectCertainty: "not_applied", condition: { kind: "text_visible", text: "E-mail address is not in a valid format.", exact: true } },
    { code: "INVALID_PHONE", description: "The phone number is not valid.", category: "business_outcome", priority: 939, effectCertainty: "not_applied", condition: { kind: "text_visible", text: "Phone number is not valid.", exact: true } },
    { code: "INVALID_ADDRESS", description: "The mailing address is too short.", category: "business_outcome", priority: 938, effectCertainty: "not_applied", condition: { kind: "text_visible", text: "Mailing address is too short.", exact: true } },
  ]),
  checkpoint: { kind: "route", pattern: "^/members/[0-9]{6}$" },
  allowedActions: ["click", "fill", "select", "extract"],
  maxEffect: "reversible_write",
});

export const meridianPlaceHoldArtifact = build({
  id: "account.place_hold",
  name: "Place account hold",
  description: "Place a supervisor-only share hold through review and an approval-bound final post.",
  risk: "supervisor_only",
  goal: "Require a separately authenticated supervisor and explicit supervisor approval before applying a hold.",
  inputs: [
    memberNumberInput,
    stringInput("share", "Stable share ID to hold", { type: { kind: "string", format: "share_id", pattern: "^[0-9]{6}-[A-Z0-9-]{5,20}$" }, classification: "restricted" }),
    stringInput("reason", "MERIDIAN hold reason code", { type: { kind: "string", enum: ["FRAUD", "LEGAL", "DECEASED"] }, classification: "internal" }),
    stringInput("notes", "Hold notes", { type: { kind: "string", maxLength: 80 }, classification: "restricted" }),
  ],
  outputs: [
    { name: "share_status_before", description: "Exact selected-share status captured before the hold", type: { kind: "string", minLength: 1, maxLength: 64 }, classification: "restricted" },
    { name: "confirmation", description: "MERIDIAN account-hold confirmation reference", type: { kind: "string", minLength: 1, maxLength: 128 }, classification: "internal" },
    { name: "share_status", description: "Share and hold status reported by MERIDIAN", type: { kind: "string", minLength: 1, maxLength: 256, pattern: "^.+ is now HOLD$" }, classification: "restricted" },
    { name: "applied_at", description: "Timestamp reported by MERIDIAN for the applied hold", type: { kind: "string", minLength: 1, maxLength: 128 }, classification: "internal" },
  ],
  targets: transactionTargets("hold"),
  inputRelations: [
    { kind: "starts_with_input", value: "share", prefix: "member_number", separator: "-" },
  ],
  steps: [
    ...transactionPrelude("hold", [
      receiptExtraction("extract_share_status_before", "Read selected share status before hold", "share_status_before", "share_status_before"),
    ]),
    step("choose_share", "Choose share", { kind: "select", targetId: "share", value: { kind: "input", name: "share" } }, { kind: "target_value", targetId: "share", operator: "equals", value: { kind: "input", name: "share" }, redactActual: true }, "draft"),
    step("choose_reason", "Choose hold reason", { kind: "select", targetId: "reason", value: { kind: "input", name: "reason" } }, { kind: "target_value", targetId: "reason", operator: "equals", value: { kind: "input", name: "reason" }, redactActual: false }, "draft"),
    step("enter_notes", "Enter hold notes", { kind: "fill", targetId: "notes", value: { kind: "input", name: "notes" } }, { kind: "target_value", targetId: "notes", operator: "equals", value: { kind: "input", name: "notes" }, redactActual: true }, "draft"),
    step("review_hold", "Continue to hold review", { kind: "click", targetId: "continue" }, { kind: "route", pattern: "^/members/[0-9]{6}/hold/review$" }, "review", [tokenCondition()]),
    {
      ...step(
        "commit_hold",
        "Apply reviewed account hold",
        { kind: "click", targetId: "commit" },
        postCheckpoint("hold", "Hold Applied - Meridian Core", [
          "receipt_confirmation",
          "receipt_share_status",
          "receipt_applied",
        ]),
        "irreversible_commit",
        [tokenCondition()],
      ),
      approval: {
        kind: "supervisor_confirmation",
        summaryTargets: ["review_member", "review_share", "review_reason", "review_notes"],
        summarySources: {},
        stateNonceTarget: "transaction_token",
        expiresInMs: 120_000,
      },
    },
    receiptExtraction("extract_hold_confirmation", "Read hold confirmation", "receipt_confirmation", "confirmation"),
    receiptExtraction(
      "extract_held_share_status",
      "Read resulting share hold status",
      "receipt_share_status",
      "share_status",
      { kind: "target_value", targetId: "receipt_share_status", operator: "contains", value: { kind: "input", name: "share" }, redactActual: true },
    ),
    receiptExtraction("extract_hold_applied_at", "Read hold application time", "receipt_applied", "applied_at"),
  ],
  states: commonStates([
    { code: "HOLD_ALREADY_EXISTS", description: "The requested share already has a hold.", category: "business_outcome", priority: 940, effectCertainty: "not_applied", condition: { kind: "text_visible", text: "A hold already exists on this share.", exact: true } },
  ]),
  checkpoint: postCheckpoint("hold", "Hold Applied - Meridian Core", [
    "receipt_confirmation",
    "receipt_share_status",
    "receipt_applied",
  ]),
  allowedActions: ["click", "fill", "select", "extract"],
  maxEffect: "irreversible_commit",
});

export const meridianArtifacts: readonly CapabilityArtifactV2[] = Object.freeze([
  meridianSignOnArtifact,
  meridianSearchByNumberArtifact,
  meridianSearchByLastNameArtifact,
  meridianRecordAndBalancesArtifact,
  meridianTransferArtifact,
  meridianOpenShareArtifact,
  meridianUpdateMemberArtifact,
  meridianPlaceHoldArtifact,
]);
