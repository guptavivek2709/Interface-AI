import { describe, expect, it } from "vitest";
import { Redactor } from "../../src/safety/redactor.js";

const CANARY = "SENSITIVE_CANARY_4e1c70cb";

describe("Redactor", () => {
  it("recursively masks sensitive keys and registered values", () => {
    const redactor = new Redactor({ sensitiveValues: [CANARY] });
    const input = {
      password: "not-the-canary",
      profile: {
        accessToken: CANARY,
        notes: [`prefix ${CANARY} suffix`],
      },
      map: new Map([["api-key", CANARY]]),
    };

    const serialized = JSON.stringify(redactor.redact(input));
    expect(serialized).not.toContain(CANARY);
    expect(serialized).not.toContain("not-the-canary");
    expect(serialized.match(/\[REDACTED\]/gu)?.length).toBeGreaterThanOrEqual(4);
  });

  it("redacts encoded variants and common credential patterns", () => {
    const redactor = new Redactor({ sensitiveValues: [CANARY] });
    const input = [
      `Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.signature123`,
      `api_key=abcdef123456`,
      `https://alice:password@example.test/`,
      Buffer.from(CANARY, "utf8").toString("base64"),
      encodeURIComponent(CANARY),
      new URLSearchParams([["value", "Rainy Day"]]).toString(),
    ].join("\n");
    redactor.register("Rainy Day");
    const output = redactor.redactString(input);
    expect(output).not.toContain(CANARY);
    expect(output).not.toContain("abcdef123456");
    expect(output).not.toContain("password@example");
    expect(output).not.toContain("eyJhbGci");
    expect(output).not.toContain("Rainy+Day");
  });

  it("handles cycles without mutating the input", () => {
    const input: { message: string; self?: unknown } = { message: CANARY };
    input.self = input;
    const redactor = new Redactor({ sensitiveValues: [CANARY] });
    expect(redactor.redact(input)).toEqual({ message: "[REDACTED]", self: "[Circular]" });
    expect(input.message).toBe(CANARY);
  });

  it("masks short standalone values without corrupting hashes or prose", () => {
    const redactor = new Redactor({ sensitiveValues: ["0", "A"] });
    const output = redactor.redactString(
      "grade A; amount=0; hash=a0ff; port=43170; Automation remains observable",
    );
    expect(output).toContain("grade [REDACTED]");
    expect(output).toContain("amount=[REDACTED]");
    expect(output).toContain("hash=a0ff");
    expect(output).toContain("port=43170");
    expect(output).toContain("Automation remains observable");
  });
});
