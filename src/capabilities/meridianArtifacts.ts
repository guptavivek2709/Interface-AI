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
  MERIDIAN_DEFAULT_ORIGIN,
  MERIDIAN_PRODUCT,
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

const mainMenu = target.role("main_menu", "link", "Main Menu", "Return to the authenticated main menu");
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
      category: "escalation",
      priority: 1_000,
      condition: { kind: "http_status", status: 440 },
    },
    {
      code: "SUPERVISOR_REQUIRED",
      description: "This operation requires a separately authenticated supervisor session.",
      category: "escalation",
      priority: 990,
      condition: { kind: "http_status", status: 403 },
      requiredRole: "supervisor",
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
  const origin = spec.origin ?? MERIDIAN_DEFAULT_ORIGIN;
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
      appVersion: "4.2.1",
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
  ]).filter((state) => state.code !== "AUTHENTICATION_REQUIRED"),
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
    target.name("transaction_token", "_token", "Current form anti-replay token", true),
    maintenanceContinue,
  ];
  if (kind === "transfer") {
    return [
      ...common,
      target.role("open_transaction", "link", "Funds Transfer", "Open funds transfer"),
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
    ];
  }
  return [
    ...common,
    target.role("open_transaction", "link", "Place Account Hold", "Open account hold form"),
    target.name("share", "share", "Share to hold", true),
    target.name("reason", "reason", "Hold reason code"),
    target.name("notes", "notes", "Hold notes", true),
    target.role("continue", "button", "Continue", "Review account hold"),
    target.role("commit", "button", "Apply Hold", "Final account-hold commit"),
    target.value("review_member", "Member:", "Reviewed member", true),
    target.value("review_share", "Share:", "Reviewed share", true),
    target.value("review_reason", "Reason:", "Reviewed hold reason"),
    target.value("review_notes", "Notes:", "Reviewed hold notes", true),
  ];
}

function tokenCondition() {
  return {
    kind: "target_value" as const,
    targetId: "transaction_token",
    operator: "matches" as const,
    value: { kind: "literal" as const, value: "^[a-f0-9]{8}-[a-f0-9]{3}$" },
    redactActual: true,
  };
}

function transactionPrelude(pathName: "transfer" | "open-share" | "hold"): StepV2[] {
  return [
    ...memberSearchSteps("number", "member_number", true),
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
  confirmedTitle?: string,
) => ({
  kind: "all" as const,
  conditions: [
    { kind: "route" as const, pattern: `^/members/[0-9]{6}/${pathName}/post$` },
    { kind: "http_status" as const, status: 200 },
    ...(confirmedTitle
      ? [{ kind: "page_title" as const, title: confirmedTitle, exact: true }]
      : []),
  ],
});

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
  outputs: [],
  targets: transactionTargets("transfer"),
  inputRelations: [
    { kind: "starts_with_input", value: "from_share", prefix: "member_number", separator: "-" },
    { kind: "starts_with_input", value: "to_share", prefix: "member_number", separator: "-" },
    { kind: "not_equal", left: "from_share", right: "to_share" },
  ],
  steps: [
    ...transactionPrelude("transfer"),
    step("choose_source", "Choose source share", { kind: "select", targetId: "from_share", value: { kind: "input", name: "from_share" } }, { kind: "target_value", targetId: "from_share", operator: "equals", value: { kind: "input", name: "from_share" }, redactActual: true }, "draft"),
    step("choose_destination", "Choose destination share", { kind: "select", targetId: "to_share", value: { kind: "input", name: "to_share" } }, { kind: "target_value", targetId: "to_share", operator: "equals", value: { kind: "input", name: "to_share" }, redactActual: true }, "draft"),
    step("enter_amount", "Enter amount", { kind: "fill", targetId: "amount", value: { kind: "input", name: "amount" } }, { kind: "target_value", targetId: "amount", operator: "equals", value: { kind: "input", name: "amount" }, redactActual: true }, "draft"),
    step("enter_memo", "Enter memo", { kind: "fill", targetId: "memo", value: { kind: "input", name: "memo" } }, { kind: "target_value", targetId: "memo", operator: "equals", value: { kind: "input", name: "memo" }, redactActual: true }, "draft"),
    step("review_transfer", "Continue to transfer review", { kind: "click", targetId: "continue" }, { kind: "route", pattern: "^/members/[0-9]{6}/transfer/review$" }, "review", [tokenCondition()]),
    {
      ...step("commit_transfer", "Post reviewed transfer", { kind: "click", targetId: "commit" }, postCheckpoint("transfer", "Transfer Posted - Meridian Core"), "irreversible_commit", [tokenCondition()]),
      approval: {
        kind: "user_confirmation",
        summaryTargets: ["review_member", "review_from", "review_to", "review_amount", "review_memo"],
        summarySources: {},
        stateNonceTarget: "transaction_token",
        expiresInMs: 120_000,
      },
    },
  ],
  states: commonStates([
    { code: "INSUFFICIENT_FUNDS", description: "The source share has insufficient available balance.", category: "business_outcome", priority: 940, effectCertainty: "not_applied", condition: { kind: "text_visible", text: "Insufficient available balance in the source share.", exact: true } },
    { code: "SOURCE_SHARE_HELD", description: "The source share is on hold and cannot be debited.", category: "business_outcome", priority: 935, effectCertainty: "not_applied", condition: { kind: "text_visible", text: "Source share is HOLD and cannot be debited.", exact: true } },
  ]),
  checkpoint: postCheckpoint("transfer", "Transfer Posted - Meridian Core"),
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
  outputs: [],
  targets: transactionTargets("open"),
  steps: [
    ...transactionPrelude("open-share"),
    step("choose_share_type", "Choose share type", { kind: "select", targetId: "share_type", value: { kind: "input", name: "share_type" } }, { kind: "target_value", targetId: "share_type", operator: "equals", value: { kind: "input", name: "share_type" }, redactActual: false }, "draft"),
    step("enter_deposit", "Enter initial deposit", { kind: "fill", targetId: "deposit", value: { kind: "input", name: "initial_deposit" } }, { kind: "target_value", targetId: "deposit", operator: "equals", value: { kind: "input", name: "initial_deposit" }, redactActual: true }, "draft"),
    step("review_new_share", "Continue to new-share review", { kind: "click", targetId: "continue" }, { kind: "route", pattern: "^/members/[0-9]{6}/open-share/review$" }, "review", [tokenCondition()]),
    {
      ...step("commit_new_share", "Open reviewed share", { kind: "click", targetId: "commit" }, postCheckpoint("open-share"), "irreversible_commit", [tokenCondition()]),
      approval: {
        kind: "user_confirmation",
        summaryTargets: ["review_member", "review_type", "review_deposit"],
        summarySources: {},
        stateNonceTarget: "transaction_token",
        expiresInMs: 120_000,
      },
    },
  ],
  checkpoint: postCheckpoint("open-share"),
  allowedActions: ["click", "fill", "select", "extract"],
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
    emailValue,
    phoneValue,
    addressValue,
    maintenanceContinue,
  ],
  steps: [
    ...memberSearchSteps("number", "member_number", true),
    step("open_update", "Open member update", { kind: "click", targetId: "open_update" }, { kind: "route", pattern: "^/members/[0-9]{6}/update$" }, "read", [{ kind: "target_present", targetId: "open_update", present: true }]),
    step("enter_email", "Enter email", { kind: "fill", targetId: "email", value: { kind: "input", name: "email" } }, { kind: "target_value", targetId: "email", operator: "equals", value: { kind: "input", name: "email" }, redactActual: true }, "draft"),
    step("enter_phone", "Enter phone", { kind: "fill", targetId: "phone", value: { kind: "input", name: "phone" } }, { kind: "target_value", targetId: "phone", operator: "equals", value: { kind: "input", name: "phone" }, redactActual: true }, "draft"),
    step("enter_address", "Enter address", { kind: "fill", targetId: "address", value: { kind: "input", name: "address" } }, { kind: "target_value", targetId: "address", operator: "equals", value: { kind: "input", name: "address" }, redactActual: true }, "draft"),
    {
      ...step("save_update", "Save reviewed member update", { kind: "click", targetId: "save" }, { kind: "route", pattern: "^/members/[0-9]{6}$" }, "reversible_write", [tokenCondition()]),
      approval: {
        kind: "user_confirmation",
        summaryTargets: ["email", "phone", "address"],
        summarySources: { email: "value", phone: "value", address: "value" },
        stateNonceTarget: "transaction_token",
        expiresInMs: 120_000,
      },
    },
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
  outputs: [],
  targets: transactionTargets("hold"),
  inputRelations: [
    { kind: "starts_with_input", value: "share", prefix: "member_number", separator: "-" },
  ],
  steps: [
    ...transactionPrelude("hold"),
    step("choose_share", "Choose share", { kind: "select", targetId: "share", value: { kind: "input", name: "share" } }, { kind: "target_value", targetId: "share", operator: "equals", value: { kind: "input", name: "share" }, redactActual: true }, "draft"),
    step("choose_reason", "Choose hold reason", { kind: "select", targetId: "reason", value: { kind: "input", name: "reason" } }, { kind: "target_value", targetId: "reason", operator: "equals", value: { kind: "input", name: "reason" }, redactActual: false }, "draft"),
    step("enter_notes", "Enter hold notes", { kind: "fill", targetId: "notes", value: { kind: "input", name: "notes" } }, { kind: "target_value", targetId: "notes", operator: "equals", value: { kind: "input", name: "notes" }, redactActual: true }, "draft"),
    step("review_hold", "Continue to hold review", { kind: "click", targetId: "continue" }, { kind: "route", pattern: "^/members/[0-9]{6}/hold/review$" }, "review", [tokenCondition()]),
    {
      ...step("commit_hold", "Apply reviewed account hold", { kind: "click", targetId: "commit" }, postCheckpoint("hold"), "irreversible_commit", [tokenCondition()]),
      approval: {
        kind: "supervisor_confirmation",
        summaryTargets: ["review_member", "review_share", "review_reason", "review_notes"],
        summarySources: {},
        stateNonceTarget: "transaction_token",
        expiresInMs: 120_000,
      },
    },
  ],
  states: commonStates([
    { code: "HOLD_ALREADY_EXISTS", description: "The requested share already has a hold.", category: "business_outcome", priority: 940, effectCertainty: "not_applied", condition: { kind: "text_visible", text: "A hold already exists on this share.", exact: true } },
  ]),
  checkpoint: postCheckpoint("hold"),
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
