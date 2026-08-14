/**
 * A deliberately small, ordered risk vocabulary.  Keeping the ordering here
 * (rather than relying on string comparisons) makes policy decisions explicit.
 */
export const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;

export type RiskLevel = (typeof RISK_LEVELS)[number];

export interface RiskInput {
  /** The primitive the automation runtime is about to execute. */
  action: string;
  /** Accessible name, visible label, or other user-facing description. */
  label?: string;
  /** Optional target metadata that can make an otherwise generic click risky. */
  target?: string;
  /** Input type, when the action operates on a form control. */
  inputType?: string;
  /** Never needed for classification; only the fact that a value is sensitive. */
  containsSensitiveValue?: boolean;
  /** Additional, already-safe context such as a field name. */
  context?: string;
}

export interface RiskAssessment {
  level: RiskLevel;
  score: number;
  reasons: readonly string[];
  matchedTerms: readonly string[];
}

interface RiskRule {
  level: RiskLevel;
  reason: string;
  patterns: readonly RegExp[];
}

/*
 * Phrase rules are anchored at token boundaries.  This matters: a substring
 * check for "pay", for example, would classify "display settings" as a payment.
 */
const LABEL_RULES: readonly RiskRule[] = [
  {
    level: "critical",
    reason: "The target appears to move money or complete a purchase.",
    patterns: [
      /(?:^| )(?:wire|transfer|send) (?:funds?|money|payment)(?: |$)/u,
      /(?:^| )(?:pay|payment|purchase|buy|place order|checkout|complete purchase|transfer)(?: |$)/u,
      /(?:^| )(?:withdraw|cash out)(?: |$)/u,
    ],
  },
  {
    level: "critical",
    reason: "The target appears to destroy an account or security boundary.",
    patterns: [
      /(?:^| )(?:delete|close|terminate|deactivate) (?:my )?(?:account|workspace|organization|tenant)(?: |$)/u,
      /(?:^| )(?:disable|remove) (?:mfa|2fa|two factor|multi factor)(?: |$)/u,
      /(?:^| )(?:grant|make) (?:administrator|admin|owner)(?: |$)/u,
    ],
  },
  {
    level: "critical",
    reason: "The target appears to create a financial account, an irreversible business write.",
    patterns: [/(?:^| )create (?:a )?(?:sub )?account(?: |$)/u],
  },
  {
    level: "critical",
    reason: "The target appears to execute code or install software.",
    patterns: [
      /(?:^| )(?:run|execute) (?:script|code|command|macro|program)(?: |$)/u,
      /(?:^| )(?:install|deploy) (?:application|app|software|package|extension|plugin)(?: |$)/u,
    ],
  },
  {
    level: "high",
    reason: "The target appears to send, publish, or submit information externally.",
    patterns: [
      /(?:^| )(?:send|publish|post|broadcast|share|submit)(?: |$)/u,
      /(?:^| )(?:confirm|finalize|complete) (?:submission|application|request|booking|reservation)(?: |$)/u,
      /(?:^| )(?:approve|authorize|consent|sign)(?: |$)/u,
    ],
  },
  {
    level: "high",
    reason: "The target appears to delete or irreversibly alter data.",
    patterns: [
      /(?:^| )(?:delete|erase|destroy|purge|remove permanently|empty trash)(?: |$)/u,
      /(?:^| )(?:revoke|disable|deactivate|terminate|cancel)(?: |$)/u,
      /(?:^| )(?:overwrite|replace all|reset)(?: |$)/u,
    ],
  },
  {
    level: "high",
    reason: "The target appears to change identity, access, or security settings.",
    patterns: [
      /(?:^| )(?:change|reset) (?:password|passcode|pin)(?: |$)/u,
      /(?:^| )(?:permission|permissions|access control|security settings|api key|secret key)(?: |$)/u,
      /(?:^| )(?:invite user|add member|create user)(?: |$)/u,
    ],
  },
  {
    level: "medium",
    reason: "The target appears to persist a change.",
    patterns: [
      /(?:^| )(?:save|update|apply|create|add|edit|rename|upload|import)(?: |$)/u,
      /(?:^| )(?:accept|agree)(?: |$)/u,
    ],
  },
];

const ACTION_BASELINES: Readonly<Record<string, RiskLevel>> = {
  assert: "low",
  observe: "low",
  inspect: "low",
  screenshot: "low",
  wait: "low",
  scroll: "low",
  hover: "low",
  extract: "low",
  read: "low",
  navigate: "medium",
  goto: "medium",
  click: "medium",
  press: "medium",
  check: "medium",
  uncheck: "medium",
  select: "medium",
  selectoption: "medium",
  fill: "medium",
  type: "medium",
  upload: "high",
  download: "medium",
  submit: "high",
  delete: "high",
  execute: "critical",
};

const LEVEL_SCORES: Readonly<Record<RiskLevel, number>> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export function riskScore(level: RiskLevel): number {
  return LEVEL_SCORES[level];
}

export function compareRisk(left: RiskLevel, right: RiskLevel): number {
  return riskScore(left) - riskScore(right);
}

export function isRiskAtMost(actual: RiskLevel, maximum: RiskLevel): boolean {
  return compareRisk(actual, maximum) <= 0;
}

export function highestRisk(left: RiskLevel, right: RiskLevel): RiskLevel {
  return compareRisk(left, right) >= 0 ? left : right;
}

/** Normalize confusable punctuation and whitespace before applying phrase rules. */
export function normalizeRiskText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\p{P}\p{S}_]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeAction(value: string): string {
  return normalizeRiskText(value).replace(/ /gu, "");
}

/**
 * Conservatively classify an action before it is executed.  Unknown primitives
 * are high risk: adding a new browser primitive should require an explicit
 * policy decision rather than quietly inheriting a safe default.
 */
export function classifyRisk(input: RiskInput | string): RiskAssessment {
  const request: RiskInput = typeof input === "string" ? { action: input } : input;
  const action = normalizeAction(request.action);
  let level: RiskLevel = ACTION_BASELINES[action] ?? "high";
  const reasons: string[] = [];
  const matchedTerms = new Set<string>();

  if (ACTION_BASELINES[action] === undefined) {
    reasons.push(`Unknown action primitive "${request.action}" defaults to high risk.`);
  } else {
    reasons.push(`The ${request.action} primitive has a ${level} baseline risk.`);
  }

  const labelText = [request.label, request.target, request.context]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ");
  const normalizedLabel = normalizeRiskText(labelText);

  for (const rule of LABEL_RULES) {
    for (const pattern of rule.patterns) {
      const match = pattern.exec(normalizedLabel);
      if (match === null) continue;
      level = highestRisk(level, rule.level);
      reasons.push(rule.reason);
      const phrase = match[0]?.trim();
      if (phrase) matchedTerms.add(phrase);
      break;
    }
  }

  if (request.containsSensitiveValue === true) {
    level = highestRisk(level, "high");
    reasons.push("The action carries a value marked as sensitive.");
  }

  const inputType = normalizeAction(request.inputType ?? "");
  if (["password", "file", "hidden"].includes(inputType)) {
    const inputRisk: RiskLevel = inputType === "file" ? "high" : "medium";
    level = highestRisk(level, inputRisk);
    reasons.push(`The target is a ${request.inputType ?? inputType} input.`);
  }

  return {
    level,
    score: riskScore(level),
    reasons: [...new Set(reasons)],
    matchedTerms: [...matchedTerms],
  };
}
