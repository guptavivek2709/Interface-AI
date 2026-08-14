import {
  classifyRisk,
  isRiskAtMost,
  normalizeRiskText,
  type RiskAssessment,
  type RiskInput,
  type RiskLevel,
} from "./risk.js";

export type NavigationKind = "direct" | "redirect" | "popup" | "frame";
export type RouteMatch = "exact" | "prefix" | "glob";

export interface AllowedRoute {
  /** An exact origin, e.g. https://example.test or http://localhost:3000. */
  origin: string;
  /** An absolute pathname. Query strings and fragments are intentionally ignored. */
  path: string;
  /** Exact is the safe default; prefix matches only on a complete path segment. */
  match?: RouteMatch | undefined;
}

export interface PolicyConfig {
  /** Exact origins permitted for navigation. Never matched as substrings. */
  allowedOrigins?: readonly string[] | undefined;
  /** Optional path restrictions. A matching route also permits its exact origin. */
  allowedRoutes?: readonly (AllowedRoute | string)[] | undefined;
  /** Browser/action primitives permitted before risk classification. */
  allowedActions?: readonly string[] | undefined;
  /** Explicit denials win over the allowlist. */
  deniedActions?: readonly string[] | undefined;
  /** Maximum risk allowed without refusing the action. Defaults to medium. */
  maxRisk?: RiskLevel | undefined;
}

export interface ActionRequest extends RiskInput {
  /** A stable identifier useful to callers when recording a policy decision. */
  stepId?: string;
}

export interface ActionDecision {
  allowed: boolean;
  action: string;
  assessment: RiskAssessment;
  reason: string;
  violation?: "action" | "risk";
}

export interface NavigationRequest {
  url: string | URL;
  kind?: NavigationKind;
  /** Required for redirect/popup checks when the source is known. */
  sourceUrl?: string | URL;
}

export interface NavigationDecision {
  allowed: boolean;
  kind: NavigationKind;
  url?: string;
  sourceUrl?: string;
  reason: string;
  matchedRule?: string;
}

export class PolicyViolationError extends Error {
  readonly code: "ACTION_DENIED" | "RISK_EXCEEDED" | "NAVIGATION_DENIED" | "INVALID_URL";
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: PolicyViolationError["code"],
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "PolicyViolationError";
    this.code = code;
    this.details = details;
  }
}

interface CompiledRoute {
  origin: string;
  pathname: string;
  match: RouteMatch;
  test(pathname: string): boolean;
  display: string;
}

const ENCODED_PATH_CONTROL = /%(?:(?:25)*)(?:00|2e|2f|5c)/iu;
const SCHEME = /^[a-z][a-z\d+.-]*:/iu;

function normalizeActionName(value: string): string {
  return normalizeRiskText(value).replace(/ /gu, "");
}

function parseHttpUrl(value: string | URL, base?: URL): URL {
  const raw = value instanceof URL ? value.href : value.trim();
  if (raw.length === 0) throw new TypeError("URL cannot be empty.");
  if (/\p{C}/u.test(raw)) throw new TypeError("URL cannot contain control characters.");
  let parsed: URL;
  try {
    if (SCHEME.test(raw)) {
      parsed = new URL(raw);
    } else if (base !== undefined) {
      parsed = new URL(raw, base);
    } else {
      throw new TypeError("URL must be absolute.");
    }
  } catch (error) {
    if (error instanceof TypeError && error.message === "URL must be absolute.") throw error;
    throw new TypeError(`Invalid URL: ${raw}`);
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new TypeError(`Unsupported URL protocol: ${parsed.protocol}`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new TypeError("Credential-bearing URLs are forbidden.");
  }
  if (parsed.hostname === "") throw new TypeError("URL must have a hostname.");
  if (ENCODED_PATH_CONTROL.test(parsed.pathname)) {
    throw new TypeError("URL cannot contain encoded path separators, dot segments, or NUL bytes.");
  }
  return parsed;
}

function canonicalOrigin(value: string): string {
  const parsed = parseHttpUrl(value);
  const originSyntax = /^[a-z][a-z\d+.-]*:\/\/[^/?#]+(.*)$/iu.exec(value.trim());
  const tail = originSyntax?.[1] ?? "";
  if ((tail !== "" && tail !== "/") || parsed.search !== "" || parsed.hash !== "") {
    throw new TypeError(`Allowed origin must not contain a path, query, or fragment: ${value}`);
  }
  return parsed.origin;
}

function normalizePath(path: string): string {
  if (!path.startsWith("/")) throw new TypeError(`Allowed route must begin with '/': ${path}`);
  if (path.includes("?") || path.includes("#")) {
    throw new TypeError(`Allowed route cannot contain a query or fragment: ${path}`);
  }
  if (/\p{C}/u.test(path) || ENCODED_PATH_CONTROL.test(path)) {
    throw new TypeError(`Allowed route contains an unsafe character: ${path}`);
  }
  // Run through URL to apply dot-segment normalization consistently with requests.
  return new URL(path, "https://policy.invalid").pathname;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function compileGlob(path: string): RegExp {
  // '*' is one path segment; '**' is zero or more complete segments.
  const segments = path.split("/");
  let expression = "^";
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] ?? "";
    if (index === 0) continue;
    if (segment === "**") {
      if (index !== segments.length - 1) {
        throw new TypeError("A '**' route glob is only allowed as the final segment.");
      }
      expression += "(?:/.*)?";
    } else if (segment === "*") {
      expression += "/[^/]+";
    } else if (segment.includes("*")) {
      throw new TypeError("Wildcards must occupy an entire path segment.");
    } else {
      expression += `/${escapeRegExp(segment)}`;
    }
  }
  if (path.endsWith("/") && path !== "/") expression += "/";
  expression += "$";
  return new RegExp(expression, "u");
}

function compileRoute(input: AllowedRoute | string): CompiledRoute {
  let origin: string;
  let path: string;
  let match: RouteMatch;

  if (typeof input === "string") {
    const url = parseHttpUrl(input);
    if (url.search !== "" || url.hash !== "") {
      throw new TypeError(`Allowed route cannot contain a query or fragment: ${input}`);
    }
    origin = url.origin;
    path = url.pathname;
    match = path.includes("*") ? "glob" : "exact";
  } else {
    origin = canonicalOrigin(input.origin);
    path = normalizePath(input.path);
    match = input.match ?? (path.includes("*") ? "glob" : "exact");
  }

  if (match !== "glob" && path.includes("*")) {
    throw new TypeError("Wildcards require route match mode 'glob'.");
  }
  const display = `${origin}${path} (${match})`;
  if (match === "exact") {
    return { origin, pathname: path, match, display, test: (candidate) => candidate === path };
  }
  if (match === "prefix") {
    const prefix = path === "/" ? "/" : path.replace(/\/+$/u, "");
    return {
      origin,
      pathname: path,
      match,
      display,
      test: (candidate) =>
        prefix === "/" || candidate === prefix || candidate.startsWith(`${prefix}/`),
    };
  }
  const glob = compileGlob(path);
  return { origin, pathname: path, match, display, test: (candidate) => glob.test(candidate) };
}

/**
 * The single pre-flight boundary for both browser actions and all forms of
 * navigation. Callers should use the assert* methods immediately before acting.
 */
export class PolicyEngine {
  readonly maxRisk: RiskLevel;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly allowedActions: ReadonlySet<string>;
  readonly deniedActions: ReadonlySet<string>;
  private readonly routes: readonly CompiledRoute[];
  private readonly hasActionAllowlist: boolean;

  constructor(config: PolicyConfig) {
    this.maxRisk = config.maxRisk ?? "medium";
    this.routes = (config.allowedRoutes ?? []).map(compileRoute);
    const explicitOrigins = (config.allowedOrigins ?? []).map(canonicalOrigin);
    this.allowedOrigins = new Set([...explicitOrigins, ...this.routes.map((route) => route.origin)]);
    this.hasActionAllowlist = config.allowedActions !== undefined;
    this.allowedActions = new Set((config.allowedActions ?? []).map(normalizeActionName));
    this.deniedActions = new Set((config.deniedActions ?? []).map(normalizeActionName));
  }

  evaluateAction(request: ActionRequest | string): ActionDecision {
    const input: ActionRequest = typeof request === "string" ? { action: request } : request;
    const normalizedAction = normalizeActionName(input.action);
    const assessment = classifyRisk(input);

    if (normalizedAction === "") {
      return {
        allowed: false,
        action: input.action,
        assessment,
        reason: "Action cannot be empty.",
        violation: "action",
      };
    }
    if (this.deniedActions.has(normalizedAction)) {
      return {
        allowed: false,
        action: input.action,
        assessment,
        reason: `Action "${input.action}" is explicitly denied.`,
        violation: "action",
      };
    }
    if (this.hasActionAllowlist && !this.allowedActions.has(normalizedAction)) {
      return {
        allowed: false,
        action: input.action,
        assessment,
        reason: `Action "${input.action}" is not in the allowed-action list.`,
        violation: "action",
      };
    }
    if (!isRiskAtMost(assessment.level, this.maxRisk)) {
      return {
        allowed: false,
        action: input.action,
        assessment,
        reason: `Action risk ${assessment.level} exceeds policy maximum ${this.maxRisk}.`,
        violation: "risk",
      };
    }
    return {
      allowed: true,
      action: input.action,
      assessment,
      reason: `Action is allowed at ${assessment.level} risk.`,
    };
  }

  assertActionAllowed(request: ActionRequest | string): ActionDecision {
    const decision = this.evaluateAction(request);
    if (!decision.allowed) {
      const code = decision.violation === "risk" ? "RISK_EXCEEDED" : "ACTION_DENIED";
      throw new PolicyViolationError(code, decision.reason, { decision });
    }
    return decision;
  }

  evaluateNavigation(request: NavigationRequest | string | URL): NavigationDecision {
    const input: NavigationRequest =
      typeof request === "string" || request instanceof URL ? { url: request } : request;
    const kind = input.kind ?? "direct";

    let source: URL | undefined;
    try {
      if (input.sourceUrl !== undefined) source = parseHttpUrl(input.sourceUrl);
      const candidate = parseHttpUrl(input.url, source);
      const base: Omit<NavigationDecision, "matchedRule"> = {
        allowed: false,
        kind,
        url: candidate.href,
        reason: "",
        ...(source === undefined ? {} : { sourceUrl: source.href }),
      };

      if (source !== undefined && kind !== "direct") {
        const sourceDecision = this.evaluateNavigation({ url: source, kind: "direct" });
        if (!sourceDecision.allowed) {
          return {
            ...base,
            reason: `Navigation source is not allowed: ${sourceDecision.reason}`,
          };
        }
      }

      if (!this.allowedOrigins.has(candidate.origin)) {
        return {
          ...base,
          reason: `Origin ${candidate.origin} is not allowed.`,
        };
      }

      const originRoutes = this.routes.filter((route) => route.origin === candidate.origin);
      // An explicitly allowed origin with no route entries permits all of its paths.
      if (originRoutes.length === 0) {
        return {
          ...base,
          allowed: true,
          reason: `Exact origin ${candidate.origin} is allowed.`,
          matchedRule: candidate.origin,
        };
      }

      const matched = originRoutes.find((route) => route.test(candidate.pathname));
      if (matched === undefined) {
        return {
          ...base,
          reason: `Path ${candidate.pathname} does not match an allowed anchored route.`,
        };
      }
      return {
        ...base,
        allowed: true,
        reason: `Navigation matches ${matched.display}.`,
        matchedRule: matched.display,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Invalid URL.";
      return { allowed: false, kind, reason };
    }
  }

  assertNavigationAllowed(request: NavigationRequest | string | URL): NavigationDecision {
    const decision = this.evaluateNavigation(request);
    if (!decision.allowed) {
      const invalid = decision.url === undefined;
      throw new PolicyViolationError(invalid ? "INVALID_URL" : "NAVIGATION_DENIED", decision.reason, {
        decision,
      });
    }
    return decision;
  }

  /**
   * Enforces exact-origin egress for fetch/XHR/assets and WebSockets. Route
   * restrictions remain a document-navigation boundary; resources may use
   * sibling paths only on the same explicitly reviewed origin.
   */
  assertResourceAllowed(value: string | URL): void {
    let parsed: URL;
    try {
      parsed = value instanceof URL ? new URL(value.href) : new URL(value);
      if (parsed.protocol === "ws:") parsed.protocol = "http:";
      if (parsed.protocol === "wss:") parsed.protocol = "https:";
    } catch {
      throw new PolicyViolationError("INVALID_URL", "Invalid resource URL.");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new PolicyViolationError("INVALID_URL", `Unsupported resource protocol: ${parsed.protocol}`);
    }
    if (parsed.username !== "" || parsed.password !== "") {
      throw new PolicyViolationError("INVALID_URL", "Credential-bearing resource URLs are forbidden.");
    }
    if (!this.allowedOrigins.has(parsed.origin)) {
      throw new PolicyViolationError(
        "NAVIGATION_DENIED",
        `Resource origin ${parsed.origin} is not allowed.`,
        { origin: parsed.origin },
      );
    }
  }

  assertRedirectAllowed(sourceUrl: string | URL, targetUrl: string | URL): NavigationDecision {
    // Checking the destination on every redirect is the important invariant;
    // checking the source as well prevents a chain from being laundered through
    // an untrusted document that happened to redirect back into scope.
    this.assertNavigationAllowed({ url: sourceUrl, kind: "direct" });
    return this.assertNavigationAllowed({ url: targetUrl, sourceUrl, kind: "redirect" });
  }

  assertPopupAllowed(openerUrl: string | URL, popupUrl: string | URL): NavigationDecision {
    this.assertNavigationAllowed({ url: openerUrl, kind: "direct" });
    return this.assertNavigationAllowed({ url: popupUrl, sourceUrl: openerUrl, kind: "popup" });
  }

  assertNavigationChainAllowed(
    urls: readonly (string | URL)[],
    kind: Extract<NavigationKind, "direct" | "redirect"> = "redirect",
  ): readonly NavigationDecision[] {
    if (urls.length === 0) return [];
    const decisions: NavigationDecision[] = [
      this.assertNavigationAllowed({ url: urls[0] as string | URL, kind: "direct" }),
    ];
    for (let index = 1; index < urls.length; index += 1) {
      decisions.push(
        this.assertNavigationAllowed({
          url: urls[index] as string | URL,
          sourceUrl: urls[index - 1] as string | URL,
          kind,
        }),
      );
    }
    return decisions;
  }
}

export { parseHttpUrl as parseSafeHttpUrl };
