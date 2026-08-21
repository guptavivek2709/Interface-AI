import { describe, expect, it } from "vitest";
import { createMeridianDiscoveryPolicyV2 } from "../../src/discovery/cliV2.js";

describe("production V2 discovery policy", () => {
  it("allows sensitive sign-on fills and conservatively critical transaction-entry links", () => {
    const policy = createMeridianDiscoveryPolicyV2("https://meridian.example");

    expect(policy.maxRisk).toBe("critical");
    expect(
      policy.evaluateAction({
        action: "fill",
        label: "Password",
        inputType: "password",
        containsSensitiveValue: true,
      }),
    ).toMatchObject({ allowed: true, assessment: { level: "high" } });
    expect(policy.evaluateAction({ action: "click", label: "Transfer money" })).toMatchObject({
      allowed: true,
      assessment: { level: "critical" },
    });
  });
});
