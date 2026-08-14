import { describe, expect, it } from "vitest";
import { CodexPlanner } from "../../src/model/codexPlanner.js";

describe("CodexPlanner configuration", () => {
  it("validates its bounded per-call timeout without invoking the CLI", () => {
    expect(() => new CodexPlanner({ timeoutMs: 999 })).toThrow(/timeout/u);
    expect(() => new CodexPlanner({ timeoutMs: 900_001 })).toThrow(/timeout/u);
    expect(() => new CodexPlanner({ timeoutMs: 600_000 })).not.toThrow();
  });

});
