import { describe, expect, it } from "vitest";
import { PolicyEngine, PolicyViolationError } from "../../src/safety/policy.js";
import { classifyRisk } from "../../src/safety/risk.js";

function policy(): PolicyEngine {
  return new PolicyEngine({
    allowedOrigins: ["https://bank.example"],
    allowedRoutes: [
      { origin: "https://bank.example", path: "/app", match: "prefix" },
      { origin: "https://bank.example", path: "/health", match: "exact" },
    ],
    allowedActions: ["click", "fill", "observe"],
    maxRisk: "medium",
  });
}

describe("PolicyEngine navigation policy", () => {
  it("matches origins exactly rather than accepting hostile substrings", () => {
    const engine = policy();
    expect(engine.evaluateNavigation("https://bank.example/app").allowed).toBe(true);
    expect(engine.evaluateNavigation("https://bank.example.evil.test/app").allowed).toBe(false);
    expect(engine.evaluateNavigation("https://evil.test/bank.example/app").allowed).toBe(false);
    expect(engine.evaluateNavigation("https://bank.example@evil.test/app").allowed).toBe(false);
  });

  it("anchors prefix routes at complete path segments", () => {
    const engine = policy();
    expect(engine.evaluateNavigation("https://bank.example/app").allowed).toBe(true);
    expect(engine.evaluateNavigation("https://bank.example/app/member/42").allowed).toBe(true);
    expect(engine.evaluateNavigation("https://bank.example/application").allowed).toBe(false);
    expect(engine.evaluateNavigation("https://bank.example/health/ready").allowed).toBe(false);
  });

  it("rejects credentials and encoded route-confusion characters", () => {
    const engine = policy();
    expect(engine.evaluateNavigation("https://user:password@bank.example/app")).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/credential/i),
    });
    expect(engine.evaluateNavigation("https://bank.example/app/%2f/admin").allowed).toBe(false);
    expect(engine.evaluateNavigation("https://bank.example/app/%252e%252e/admin").allowed).toBe(false);
  });

  it("rechecks both sides of redirects and popups", () => {
    const engine = policy();
    expect(() =>
      engine.assertRedirectAllowed("https://bank.example/app", "https://evil.test/collect"),
    ).toThrow(PolicyViolationError);
    expect(() =>
      engine.assertPopupAllowed("https://evil.test/opener", "https://bank.example/app"),
    ).toThrow(PolicyViolationError);
  });

  it("applies exact-origin policy to non-navigation resources and WebSockets", () => {
    const engine = policy();
    expect(() => engine.assertResourceAllowed("https://bank.example/assets/app.js")).not.toThrow();
    expect(() => engine.assertResourceAllowed("wss://bank.example/events")).not.toThrow();
    expect(() => engine.assertResourceAllowed("https://bank.example.evil.test/pixel")).toThrow(
      PolicyViolationError,
    );
    expect(() => engine.assertResourceAllowed("wss://evil.test/exfiltrate")).toThrow(
      PolicyViolationError,
    );
  });
});

describe("PolicyEngine action policy", () => {
  it("blocks dangerous labels before a generic click", () => {
    const engine = policy();
    const deletion = engine.evaluateAction({ action: "click", label: "Delete account" });
    const payment = engine.evaluateAction({ action: "click", label: "Transfer money" });
    expect(deletion).toMatchObject({ allowed: false, violation: "risk" });
    expect(deletion.assessment.level).toBe("critical");
    expect(payment.assessment.level).toBe("critical");
    expect(engine.evaluateAction({ action: "click", label: "Create sub-account" })).toMatchObject({
      allowed: false,
      violation: "risk",
      assessment: { level: "critical" },
    });
  });

  it("does not classify innocent substrings as payment actions", () => {
    expect(classifyRisk({ action: "click", label: "Display settings" }).level).toBe("medium");
  });

  it("fails closed for an unknown primitive", () => {
    const engine = policy();
    const decision = engine.evaluateAction({ action: "teleport", label: "Next" });
    expect(decision.allowed).toBe(false);
    expect(decision.assessment.level).toBe("high");
  });
});
