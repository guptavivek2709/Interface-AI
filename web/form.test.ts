import { describe, expect, it } from "vitest";
import { fieldPath, flattenProposal, isRunnable, serializeInputs } from "./form";
import type { Capability } from "./types";

const capability: Capability = {
  id: "funds.transfer",
  name: "Transfer funds",
  description: "Transfer between shares",
  version: "2.0.0",
  schemaVersion: "2.0",
  approval: "approved",
  risk: "irreversible",
  tags: [],
  digest: "a".repeat(64),
  contractValid: true,
  inputs: [
    { name: "amount", description: "Transfer amount", type: { kind: "money", currency: "USD" }, required: true, classification: "confidential" },
    { name: "operatorPassword", description: "Managed", type: { kind: "string" }, required: true, classification: "secret" },
  ],
  outputs: [],
};

describe("guided capability forms", () => {
  it("serializes decimal money while omitting protected fields", () => {
    expect(serializeInputs(capability, { amount: "12.30", operatorPassword: "canary" }, {})).toEqual({
      inputs: { amount: "12.30" },
      errors: {},
    });
    expect(serializeInputs(capability, { amount: "12.3" }, {}).inputs).toEqual({ amount: "12.30" });
    expect(serializeInputs(capability, { amount: "12" }, {}).inputs).toEqual({ amount: "12.00" });
  });

  it("rejects imprecise money and excludes protected proposals", () => {
    expect(serializeInputs(capability, { amount: "12.345" }, {}).errors.amount).toMatch(/two decimals/u);
    expect(flattenProposal(capability, { amount: "5.00", operatorPassword: "canary" }).values).toEqual({
      amount: "5.00",
    });
  });

  it("enforces exact minor-unit bounds from the reviewed money contract", () => {
    const bounded: Capability = {
      ...capability,
      inputs: [{ ...capability.inputs[0]!, type: { kind: "money", currency: "USD", minimumMinorUnits: 1, maximumMinorUnits: 500 } }],
    };
    expect(serializeInputs(bounded, { amount: "0.00" }, {}).errors.amount).toMatch(/at least 0\.01/u);
    expect(serializeInputs(bounded, { amount: "5.01" }, {}).errors.amount).toMatch(/no more than 5\.00/u);
    expect(serializeInputs(bounded, { amount: "5.00" }, {}).inputs).toEqual({ amount: "5.00" });
  });

  it("only enables approved V2 non-authentication capabilities", () => {
    expect(isRunnable(capability)).toBe(true);
    expect(isRunnable({ ...capability, id: "session.sign_on" })).toBe(false);
    expect(isRunnable({ ...capability, id: "auth.sign_in" })).toBe(false);
    expect(isRunnable({ ...capability, schemaVersion: "1.0" })).toBe(false);
  });

  it("preserves optional object and boolean absence until explicitly included", () => {
    const optional: Capability = {
      ...capability,
      inputs: [
        {
          name: "profile",
          description: "Optional profile",
          required: false,
          classification: "internal",
          type: { kind: "object", required: ["name"], properties: { name: { kind: "string" } } },
        },
        { name: "includeClosed", description: "Optional switch", required: false, classification: "internal", type: { kind: "boolean" } },
      ],
    };
    expect(serializeInputs(optional, {}, {})).toEqual({ inputs: {}, errors: {} });
    expect(serializeInputs(optional, { profile: true }, {}).errors["profile/name"]).toMatch(/required/u);
    expect(serializeInputs(optional, { includeClosed: "false" }, {}).inputs).toEqual({ includeClosed: false });
  });

  it("uses collision-safe paths for dotted names and nested fields", () => {
    const dotted: Capability = {
      ...capability,
      inputs: [
        { name: "a.b", description: "Dotted", required: true, classification: "internal", type: { kind: "string" } },
        { name: "a", description: "Nested", required: true, classification: "internal", type: { kind: "object", required: ["b"], properties: { b: { kind: "string" } } } },
      ],
    };
    expect(fieldPath(["a.b"])).not.toBe(fieldPath(["a", "b"]));
    expect(serializeInputs(dotted, { [fieldPath(["a.b"])]: "top", [fieldPath(["a", "b"])]: "nested" }, {}).inputs).toEqual({
      "a.b": "top",
      a: { b: "nested" },
    });
  });

  it("enforces reviewed email formats before launch", () => {
    const email: Capability = {
      ...capability,
      inputs: [{ name: "email", description: "Email", required: true, classification: "internal", type: { kind: "string", format: "email" } }],
    };
    expect(serializeInputs(email, { email: "not-an-email" }, {}).errors.email).toMatch(/valid email/u);
  });
});
