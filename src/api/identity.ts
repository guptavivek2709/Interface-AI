import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export type ConsoleRole = "teller" | "supervisor";

export interface ConsolePrincipal {
  readonly subject: string;
  readonly displayName: string;
  readonly roles: readonly ConsoleRole[];
}

export interface IdentityRequest {
  readonly cookieHeader?: string;
  readonly authorizationHeader?: string;
  /** Only an explicit operator action should extend the idle deadline. */
  readonly touch?: boolean;
}

export interface ConsoleLoginResult {
  readonly sessionToken: string;
  readonly principal: ConsolePrincipal;
  readonly expiresAt: string;
}

/**
 * Authentication is an API seam, not a property of the browser automation
 * session. An OIDC, SAML, mTLS, or gateway-backed implementation can replace
 * this local provider without changing run or capability contracts.
 */
export interface ConsoleIdentityProvider {
  authenticate(request: IdentityRequest): Promise<ConsolePrincipal | undefined>;
  login(accessCode: string, clientKey: string): Promise<ConsoleLoginResult>;
  logout(request: IdentityRequest): Promise<void>;
  close?(): Promise<void>;
}

export class ConsoleIdentityError extends Error {
  readonly code: "AUTH_UNAVAILABLE" | "AUTH_INVALID" | "AUTH_RATE_LIMITED";

  constructor(code: ConsoleIdentityError["code"], message: string) {
    super(message);
    this.name = "ConsoleIdentityError";
    this.code = code;
  }
}

export const CONSOLE_COOKIE_NAME = "meridian_console";

interface ConfiguredIdentity {
  readonly accessCodeDigest: Buffer;
  readonly principal: ConsolePrincipal;
}

interface IdentitySession {
  readonly principal: ConsolePrincipal;
  readonly createdAt: number;
  lastSeenAt: number;
}

interface LoginAttempts {
  windowStartedAt: number;
  failures: number;
  blockedUntil: number;
}

export interface StaticConsoleIdentityProviderOptions {
  readonly teller?: { accessCode: string; subject?: string; displayName?: string };
  readonly supervisor?: { accessCode: string; subject?: string; displayName?: string };
  readonly sessionAbsoluteTtlMs?: number;
  readonly sessionIdleTtlMs?: number;
  readonly loginWindowMs?: number;
  readonly maxLoginFailures?: number;
  readonly loginBlockMs?: number;
  readonly now?: () => number;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function safeEqual(left: Buffer, right: Buffer): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function positiveInteger(value: number, label: string, minimum = 1): number {
  if (!Number.isInteger(value) || value < minimum) throw new TypeError(`${label} must be at least ${minimum}`);
  return value;
}

function checkedAccessCode(value: string, label: string): string {
  if (value.length < 16 || value.length > 512) {
    throw new TypeError(`${label} must contain between 16 and 512 characters`);
  }
  return value;
}

function frozenPrincipal(
  subject: string,
  displayName: string,
  roles: readonly ConsoleRole[],
): ConsolePrincipal {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/u.test(subject)) {
    throw new TypeError("Console identity subject is invalid");
  }
  if (!displayName.trim() || displayName.length > 200) throw new TypeError("Console display name is invalid");
  return Object.freeze({ subject, displayName, roles: Object.freeze([...roles]) });
}

function cookieValue(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== CONSOLE_COOKIE_NAME) continue;
    const value = part.slice(separator + 1).trim();
    return /^[A-Za-z0-9_-]{32,128}$/u.test(value) ? value : undefined;
  }
  return undefined;
}

/** Local, fail-closed identity provider for the same-origin console and API clients. */
export class StaticConsoleIdentityProvider implements ConsoleIdentityProvider {
  readonly #identities: readonly ConfiguredIdentity[];
  readonly #sessions = new Map<string, IdentitySession>();
  readonly #attempts = new Map<string, LoginAttempts>();
  readonly #absoluteTtlMs: number;
  readonly #idleTtlMs: number;
  readonly #loginWindowMs: number;
  readonly #maxLoginFailures: number;
  readonly #loginBlockMs: number;
  readonly #now: () => number;

  constructor(options: StaticConsoleIdentityProviderOptions = {}) {
    const identities: ConfiguredIdentity[] = [];
    if (options.teller) {
      identities.push({
        accessCodeDigest: digest(checkedAccessCode(options.teller.accessCode, "Teller console access code")),
        principal: frozenPrincipal(
          options.teller.subject ?? "console:teller",
          options.teller.displayName ?? "Teller operator",
          ["teller"],
        ),
      });
    }
    if (options.supervisor) {
      const supervisorDigest = digest(
        checkedAccessCode(options.supervisor.accessCode, "Supervisor console access code"),
      );
      if (identities.some((identity) => safeEqual(identity.accessCodeDigest, supervisorDigest))) {
        throw new TypeError("Teller and supervisor console access codes must be different");
      }
      const supervisorSubject = options.supervisor.subject ?? "console:supervisor";
      if (identities.some((identity) => identity.principal.subject === supervisorSubject)) {
        throw new TypeError("Teller and supervisor console subjects must be different");
      }
      identities.push({
        accessCodeDigest: supervisorDigest,
        principal: frozenPrincipal(
          supervisorSubject,
          options.supervisor.displayName ?? "Supervisor operator",
          ["teller", "supervisor"],
        ),
      });
    }
    this.#identities = Object.freeze(identities);
    this.#absoluteTtlMs = positiveInteger(options.sessionAbsoluteTtlMs ?? 8 * 60 * 60_000, "Session absolute TTL", 60_000);
    this.#idleTtlMs = positiveInteger(options.sessionIdleTtlMs ?? 30 * 60_000, "Session idle TTL", 60_000);
    if (this.#idleTtlMs > this.#absoluteTtlMs) throw new TypeError("Session idle TTL cannot exceed its absolute TTL");
    this.#loginWindowMs = positiveInteger(options.loginWindowMs ?? 60_000, "Login window", 1_000);
    this.#maxLoginFailures = positiveInteger(options.maxLoginFailures ?? 5, "Maximum login failures");
    this.#loginBlockMs = positiveInteger(options.loginBlockMs ?? 60_000, "Login block duration", 1_000);
    this.#now = options.now ?? Date.now;
  }

  static fromEnvironment(environment: NodeJS.ProcessEnv = process.env): StaticConsoleIdentityProvider {
    const configured = (
      role: "TELLER" | "SUPERVISOR",
    ): { accessCode: string; subject?: string; displayName?: string } | undefined => {
      const accessCode = environment[`MERIDIAN_CONSOLE_${role}_ACCESS_CODE`];
      if (!accessCode) return undefined;
      const subject = environment[`MERIDIAN_CONSOLE_${role}_SUBJECT`]?.trim();
      const displayName = environment[`MERIDIAN_CONSOLE_${role}_DISPLAY_NAME`]?.trim();
      return {
        accessCode,
        ...(subject ? { subject } : {}),
        ...(displayName ? { displayName } : {}),
      };
    };
    const teller = configured("TELLER");
    const supervisor = configured("SUPERVISOR");
    return new StaticConsoleIdentityProvider({
      ...(teller ? { teller } : {}),
      ...(supervisor ? { supervisor } : {}),
    });
  }

  async authenticate(request: IdentityRequest): Promise<ConsolePrincipal | undefined> {
    this.#sweepExpiredSessions();
    // Console access codes are bootstrap credentials, never reusable API bearer
    // tokens. A gateway/OIDC implementation may deliberately support the
    // Authorization header through a different ConsoleIdentityProvider.
    if (request.authorizationHeader !== undefined) return undefined;
    const token = cookieValue(request.cookieHeader);
    if (!token) return undefined;
    const key = digest(token).toString("hex");
    const session = this.#sessions.get(key);
    if (!session) return undefined;
    const now = this.#now();
    if (
      now - session.createdAt >= this.#absoluteTtlMs ||
      now - session.lastSeenAt >= this.#idleTtlMs
    ) {
      this.#sessions.delete(key);
      return undefined;
    }
    if (request.touch === true) session.lastSeenAt = now;
    return session.principal;
  }

  async login(accessCode: string, clientKey: string): Promise<ConsoleLoginResult> {
    if (this.#identities.length === 0) {
      throw new ConsoleIdentityError("AUTH_UNAVAILABLE", "Console authentication is not configured.");
    }
    const now = this.#now();
    this.#sweepExpiredSessions(now);
    const attempts = this.#attempts.get(clientKey);
    if (attempts && attempts.blockedUntil > now) {
      throw new ConsoleIdentityError("AUTH_RATE_LIMITED", "Too many sign-in attempts. Try again later.");
    }
    const principal = this.#matchAccessCode(accessCode);
    if (!principal) {
      this.#recordFailure(clientKey, now);
      throw new ConsoleIdentityError("AUTH_INVALID", "The console access code was not accepted.");
    }
    this.#attempts.delete(clientKey);
    const sessionToken = randomBytes(32).toString("base64url");
    this.#sessions.set(digest(sessionToken).toString("hex"), {
      principal,
      createdAt: now,
      lastSeenAt: now,
    });
    return Object.freeze({
      sessionToken,
      principal,
      expiresAt: new Date(now + this.#absoluteTtlMs).toISOString(),
    });
  }

  async logout(request: IdentityRequest): Promise<void> {
    const token = cookieValue(request.cookieHeader);
    if (token) this.#sessions.delete(digest(token).toString("hex"));
  }

  async close(): Promise<void> {
    this.#sessions.clear();
    this.#attempts.clear();
  }

  #matchAccessCode(value: string): ConsolePrincipal | undefined {
    const candidate = digest(value);
    let matched: ConsolePrincipal | undefined;
    for (const identity of this.#identities) {
      if (safeEqual(candidate, identity.accessCodeDigest)) matched = identity.principal;
    }
    return matched;
  }

  #recordFailure(clientKey: string, now: number): void {
    const previous = this.#attempts.get(clientKey);
    const current = !previous || now - previous.windowStartedAt >= this.#loginWindowMs
      ? { windowStartedAt: now, failures: 0, blockedUntil: 0 }
      : previous;
    current.failures += 1;
    if (current.failures >= this.#maxLoginFailures) current.blockedUntil = now + this.#loginBlockMs;
    this.#attempts.set(clientKey, current);
  }

  #sweepExpiredSessions(now = this.#now()): void {
    for (const [key, session] of this.#sessions) {
      if (
        now - session.createdAt >= this.#absoluteTtlMs ||
        now - session.lastSeenAt >= this.#idleTtlMs
      ) {
        this.#sessions.delete(key);
      }
    }
  }
}
