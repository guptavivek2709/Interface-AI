import { Buffer } from "node:buffer";

export const DEFAULT_REDACTION = "[REDACTED]";

export interface RedactorOptions {
  replacement?: string;
  sensitiveValues?: Iterable<string>;
  sensitiveKeys?: Iterable<string>;
}

const DEFAULT_SENSITIVE_KEYS = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "password",
  "passwd",
  "passphrase",
  "secret",
  "client_secret",
  "clientsecret",
  "api_key",
  "apikey",
  "access_key",
  "accesskey",
  "private_key",
  "privatekey",
  "token",
  "access_token",
  "accesstoken",
  "refresh_token",
  "refreshtoken",
  "id_token",
  "idtoken",
  "session_id",
  "sessionid",
  "csrf_token",
  "credit_card",
  "card_number",
] as const;

interface StringPattern {
  pattern: RegExp;
  replace: string | ((substring: string, ...args: string[]) => string);
}

const CREDENTIAL_PATTERNS: readonly StringPattern[] = [
  // PEM private keys are replaced as a unit, including multiline bodies.
  {
    pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/gu,
    replace: DEFAULT_REDACTION,
  },
  // Authorization and proxy-authorization values in headers or free text.
  {
    pattern: /\b((?:proxy-)?authorization\s*[:=]\s*)(?:bearer|basic|digest)\s+[^\s,;]+/giu,
    replace: (_match, prefix) => `${prefix}${DEFAULT_REDACTION}`,
  },
  {
    pattern: /\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/giu,
    replace: (_match, prefix) => `${prefix}${DEFAULT_REDACTION}`,
  },
  {
    pattern: /\b((?:set-)?cookie\s*:\s*)[^\r\n]+/giu,
    replace: (_match, prefix) => `${prefix}${DEFAULT_REDACTION}`,
  },
  // JWTs, including signed tokens embedded in prose.
  {
    pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/gu,
    replace: DEFAULT_REDACTION,
  },
  // Common provider token formats.
  {
    pattern: /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{12,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/gu,
    replace: DEFAULT_REDACTION,
  },
  // Credential-like key/value text, JSON, environment assignments, and query params.
  {
    pattern: /((?:password|passwd|passphrase|client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|session[_-]?id)\s*["']?\s*[:=]\s*["']?)([^\s"'&,;}\]]{3,})/giu,
    replace: (_match, prefix) => `${prefix}${DEFAULT_REDACTION}`,
  },
  {
    pattern: /([?&](?:password|passwd|passphrase|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|token|session[_-]?id)=)([^&#]*)/giu,
    replace: (_match, prefix) => `${prefix}${encodeURIComponent(DEFAULT_REDACTION)}`,
  },
  // User-info credentials in an absolute HTTP URL.
  {
    pattern: /(https?:\/\/)([^\s/@:]+):([^\s/@]+)@/giu,
    replace: (_match, scheme) => `${scheme}${DEFAULT_REDACTION}:${DEFAULT_REDACTION}@`,
  },
];

function normalizeKey(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/([\p{Ll}\d])([\p{Lu}])/gu, "$1_$2")
    .toLocaleLowerCase("en-US")
    .replace(/[\s-]+/gu, "_");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function registeredVariants(value: string): string[] {
  const variants = new Set([value]);
  try {
    variants.add(encodeURIComponent(value));
    variants.add(new URLSearchParams([["value", value]]).toString().slice("value=".length));
  } catch {
    // The raw value remains registered even when it contains an unpaired surrogate.
  }
  // Base64 is a common accidental leak in HTTP basic auth and serialized fixtures.
  variants.add(Buffer.from(value, "utf8").toString("base64"));
  return [...variants].filter((variant) => variant.length > 0);
}

/** Redacts both known values and common credential shapes before persistence. */
export class Redactor {
  readonly replacement: string;
  private readonly sensitiveValues = new Set<string>();
  private readonly sensitiveKeys = new Set<string>();

  constructor(options: RedactorOptions = {}) {
    this.replacement = options.replacement ?? DEFAULT_REDACTION;
    for (const key of DEFAULT_SENSITIVE_KEYS) this.sensitiveKeys.add(normalizeKey(key));
    for (const key of options.sensitiveKeys ?? []) this.sensitiveKeys.add(normalizeKey(key));
    for (const value of options.sensitiveValues ?? []) this.register(value);
  }

  register(value: string | null | undefined): this {
    if (typeof value !== "string" || value.length === 0) return this;
    for (const variant of registeredVariants(value)) this.sensitiveValues.add(variant);
    return this;
  }

  registerMany(values: Iterable<string | null | undefined>): this {
    for (const value of values) this.register(value);
    return this;
  }

  registerKey(key: string): this {
    if (key.length > 0) this.sensitiveKeys.add(normalizeKey(key));
    return this;
  }

  clearRegisteredValues(): void {
    this.sensitiveValues.clear();
  }

  isSensitiveKey(key: string): boolean {
    const normalized = normalizeKey(key);
    if (this.sensitiveKeys.has(normalized)) return true;
    return /(?:^|_)(?:password|passwd|passphrase|secret|token|api_key|private_key|session_id)(?:$|_)/u.test(
      normalized,
    );
  }

  redactString(input: string): string {
    let output = input;
    // Longest first prevents a shorter registered value from leaving a suffix.
    const knownValues = [...this.sensitiveValues].sort((a, b) => b.length - a.length);
    for (const value of knownValues) {
      // Very short caller values (for example "A" or "0") must still be
      // protected, but replacing them as arbitrary substrings destroys hashes,
      // paths, and ordinary prose. Match those only as standalone tokens.
      const expression =
        value.length < 3
          ? `(?<![\\p{L}\\p{N}_])${escapeRegExp(value)}(?![\\p{L}\\p{N}_])`
          : escapeRegExp(value);
      // Target systems commonly canonicalize operator IDs and other values to
      // upper case before echoing them. Registered secrets therefore match
      // Unicode case-insensitively as well as exactly.
      output = output.replace(new RegExp(expression, "giu"), () => this.replacement);
    }
    for (const { pattern, replace } of CREDENTIAL_PATTERNS) {
      const replacer =
        typeof replace === "string"
          ? this.replacement
          : (substring: string, ...args: string[]) =>
              replace(substring, ...args).replaceAll(DEFAULT_REDACTION, this.replacement);
      output = output.replace(pattern, replacer as never);
    }
    return output;
  }

  /**
   * Recursively returns a detached, persistence-safe value. Object keys which
   * name secrets are masked wholesale; strings elsewhere receive pattern and
   * registered-value redaction. Cycles are represented, never followed.
   */
  redact(value: unknown): unknown {
    return this.redactInner(value, new WeakSet<object>());
  }

  private redactInner(value: unknown, ancestors: WeakSet<object>): unknown {
    if (typeof value === "string") return this.redactString(value);
    if (
      value === null ||
      typeof value === "boolean" ||
      typeof value === "number" ||
      typeof value === "undefined"
    ) {
      return value;
    }
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "symbol") return value.description ?? "Symbol";
    if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
    if (value instanceof Date) return value.toISOString();
    if (value instanceof URL) return this.redactString(value.href);
    if (value instanceof Error) {
      return {
        name: value.name,
        message: this.redactString(value.message),
        ...(value.stack === undefined ? {} : { stack: this.redactString(value.stack) }),
      };
    }
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
      return `[binary ${value.byteLength} bytes]`;
    }
    if (typeof value !== "object") return String(value);
    if (ancestors.has(value)) return "[Circular]";

    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        return value.map((item) => this.redactInner(item, ancestors));
      }
      if (value instanceof Map) {
        return Object.fromEntries(
          [...value.entries()].map(([key, entryValue]) => {
            const safeKey = this.redactString(String(key));
            return [
              safeKey,
              this.isSensitiveKey(safeKey)
                ? this.replacement
                : this.redactInner(entryValue, ancestors),
            ];
          }),
        );
      }
      if (value instanceof Set) {
        return [...value].map((item) => this.redactInner(item, ancestors));
      }

      const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [key, entryValue] of Object.entries(value)) {
        const safeKey = this.redactString(key);
        output[safeKey] = this.isSensitiveKey(key)
          ? this.replacement
          : this.redactInner(entryValue, ancestors);
      }
      return output;
    } finally {
      ancestors.delete(value);
    }
  }
}

export function redact(value: unknown, options: RedactorOptions = {}): unknown {
  return new Redactor(options).redact(value);
}

export function redactString(value: string, options: RedactorOptions = {}): string {
  return new Redactor(options).redactString(value);
}
