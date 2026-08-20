import type { PlaywrightSurfaceOptions } from "../surface/playwright/playwrightSurface.js";

export const MERIDIAN_DEFAULT_ORIGIN = "https://web-sample.interface-hiring.com";
export const MERIDIAN_PRODUCT = "Meridian Core";
export const MERIDIAN_ADAPTER = "playwright-web-meridian-v2";

const DOCUMENT_PATH =
  /^\/(?:signon|signoff|menu|members(?:\/[0-9]{6}(?:\/(?:transfer|open-share|update|hold)(?:\/(?:review|post))?)?)?)$/u;
const DOCUMENT_QUERY_KEYS = new Set(["by", "q", "next", "inject"]);

export function normalizeMeridianOrigin(value: string | URL): string {
  const url = value instanceof URL ? new URL(value.href) : new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("MERIDIAN requires HTTP(S)");
  if (url.username || url.password) throw new Error("Credential-bearing MERIDIAN origins are forbidden");
  if (url.pathname !== "/" || url.search || url.hash) throw new Error("MERIDIAN origin must not include a path");
  return url.origin;
}

export function createMeridianSurfaceOptions(
  observationDirectory: string,
  options: { origin?: string; headless?: boolean; timeoutMs?: number } = {},
): PlaywrightSurfaceOptions {
  const origin = normalizeMeridianOrigin(options.origin ?? MERIDIAN_DEFAULT_ORIGIN);
  const assertOrigin = (raw: string): URL => {
    const url = new URL(raw);
    if (url.origin !== origin) throw new Error(`MERIDIAN egress to ${url.origin} is forbidden`);
    return url;
  };
  return {
    observationDirectory,
    headless: options.headless ?? true,
    timeoutMs: options.timeoutMs ?? 8_000,
    assertResourceAllowed: (raw) => {
      assertOrigin(raw);
    },
    assertNavigationAllowed: (raw) => {
      const url = assertOrigin(raw);
      if (!DOCUMENT_PATH.test(url.pathname)) throw new Error(`MERIDIAN route ${url.pathname} is forbidden`);
      for (const key of url.searchParams.keys()) {
        if (!DOCUMENT_QUERY_KEYS.has(key)) throw new Error(`MERIDIAN query parameter ${key} is forbidden`);
      }
    },
    redactObservedUrl: (url) => {
      url.pathname = url.pathname.replace(/^\/members\/[0-9]{6}(?=\/|$)/u, "/members/[MEMBER]");
      if (url.searchParams.has("q")) url.searchParams.set("q", "[REDACTED]");
    },
    sensitiveSelectors: [
      'td[style*="padding:12px"] > table',
      'td[style*="padding:12px"] form',
      // MERIDIAN echoes the operator ID and target-session identifier in its
      // footer on every authenticated page.
      'td[bgcolor="#e4e4e4"][style*="border-top"]',
      // Search-miss help text enumerates real sample member numbers outside
      // the result form/table and must not bypass the member-data mask.
      'font[color="#555555"]',
      ".box",
    ],
  };
}

export function meridianEntryPoint(origin = MERIDIAN_DEFAULT_ORIGIN): string {
  return `${normalizeMeridianOrigin(origin)}/signon`;
}
