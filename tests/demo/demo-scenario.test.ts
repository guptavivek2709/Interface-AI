import { describe, expect, it } from "vitest";
import {
  HOSTED_DEMO_SCENARIOS,
  injectedMemberNavigationUrl,
  loadHostedDemoEnvironment,
  parseHostedDemoScenario,
} from "../../scripts/demo-scenario.js";
import { MERIDIAN_DEFAULT_ORIGIN } from "../../src/profiles/index.js";

function enabledEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    MERIDIAN_DEMO_SCENARIOS: "1",
    MERIDIAN_TELLER_OPERATOR: "operator-from-environment",
    MERIDIAN_TELLER_PASSWORD: "password-from-environment",
    MERIDIAN_SUPERVISOR_OPERATOR: "supervisor-from-environment",
    MERIDIAN_SUPERVISOR_PASSWORD: "supervisor-password-from-environment",
    ...overrides,
  };
}

describe("hosted MERIDIAN scenario policy", () => {
  it("recognizes exactly the eleven reviewer scenarios", () => {
    expect(HOSTED_DEMO_SCENARIOS).toEqual([
      "balance-success",
      "member-not-found",
      "maintenance-recovery",
      "session-timeout",
      "application-error",
      "supervisor-required",
      "transfer-success",
      "share-open-success",
      "member-update-success",
      "hold-supervisor-handoff",
      "validation-rejected",
    ]);
    for (const name of HOSTED_DEMO_SCENARIOS) expect(parseHostedDemoScenario(name)).toBe(name);
    expect(() => parseHostedDemoScenario("fixture-success")).toThrow(/Scenario must be one of/u);
  });

  it("fails closed unless real execution and credentials are explicitly enabled", () => {
    expect(() => loadHostedDemoEnvironment({})).toThrow(/MERIDIAN_DEMO_SCENARIOS=1/u);
    expect(() => loadHostedDemoEnvironment({ MERIDIAN_DEMO_SCENARIOS: "1" })).toThrow(
      /MERIDIAN_TELLER_OPERATOR/u,
    );
    expect(() => loadHostedDemoEnvironment({
      MERIDIAN_DEMO_SCENARIOS: "1",
      MERIDIAN_TELLER_OPERATOR: "operator-from-environment",
    })).toThrow(/MERIDIAN_TELLER_PASSWORD/u);
  });

  it("cannot be redirected to a fixture or arbitrary host", () => {
    expect(() => loadHostedDemoEnvironment(enabledEnvironment({
      MERIDIAN_ORIGIN: "http://127.0.0.1:9999",
    }))).toThrow(/restricted to https:\/\/web-sample\.interface-hiring\.com/u);
    expect(loadHostedDemoEnvironment(enabledEnvironment())).toMatchObject({
      origin: MERIDIAN_DEFAULT_ORIGIN,
      branch: "MAIN-001",
      memberNumber: "100234",
      missingMemberNumber: "999999",
      headless: true,
    });
  });

  it("validates non-secret scenario selectors without exposing credentials", () => {
    expect(() => loadHostedDemoEnvironment(enabledEnvironment({
      MERIDIAN_DEMO_BRANCH: "UNKNOWN",
    }))).toThrow(/MERIDIAN_DEMO_BRANCH/u);
    expect(() => loadHostedDemoEnvironment(enabledEnvironment({
      MERIDIAN_DEMO_MEMBER_NUMBER: "123",
    }))).toThrow(/six-digit member/u);
    expect(() => loadHostedDemoEnvironment(enabledEnvironment({
      MERIDIAN_DEMO_MEMBER_NUMBER: "100234",
      MERIDIAN_DEMO_MISSING_MEMBER_NUMBER: "100234",
    }))).toThrow(/different six-digit member/u);
  });
});

describe("one-shot hosted fault URL adapter", () => {
  it("adds an allowed inject marker only to an exact member-detail GET", () => {
    expect(injectedMemberNavigationUrl({
      rawUrl: `${MERIDIAN_DEFAULT_ORIGIN}/members/100234`,
      method: "GET",
      origin: MERIDIAN_DEFAULT_ORIGIN,
      fault: "maintenance",
    })).toBe(`${MERIDIAN_DEFAULT_ORIGIN}/members/100234?inject=maintenance`);
  });

  it.each([
    [`${MERIDIAN_DEFAULT_ORIGIN}/members`, "GET"],
    [`${MERIDIAN_DEFAULT_ORIGIN}/members/100234/transfer`, "GET"],
    [`${MERIDIAN_DEFAULT_ORIGIN}/members/100234`, "POST"],
    [`${MERIDIAN_DEFAULT_ORIGIN}/members/100234?inject=server`, "GET"],
    ["http://127.0.0.1:9999/members/100234", "GET"],
  ])("does not rewrite an out-of-scope request (%s %s)", (rawUrl, method) => {
    expect(injectedMemberNavigationUrl({
      rawUrl,
      method,
      origin: MERIDIAN_DEFAULT_ORIGIN,
      fault: "server",
    })).toBeUndefined();
  });
});
