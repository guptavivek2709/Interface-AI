import { describe, expect, it } from "vitest";
import {
  AbortableRequestLatch,
  isRetainedRunUnavailable,
  nextRunSelection,
  withoutRun,
} from "./lifecycle";

describe("frontend lifecycle helpers", () => {
  it("preserves an owned selection but does not auto-select terminal history", () => {
    const runs = [
      { id: "completed", phase: "completed" as const },
      { id: "running", phase: "running" as const },
    ];
    expect(nextRunSelection("completed", runs)).toBe("completed");
    expect(nextRunSelection("missing", runs)).toBe("running");
    expect(nextRunSelection("", [runs[0]!])).toBe("");
  });

  it("removes only the unavailable owner-scoped run", () => {
    expect(withoutRun([{ id: "one" }, { id: "two" }], "one")).toEqual([{ id: "two" }]);
    expect(isRetainedRunUnavailable({ status: 404, code: "RUN_NOT_FOUND" })).toBe(true);
    expect(isRetainedRunUnavailable({ status: 404, code: "EVIDENCE_NOT_FOUND" })).toBe(false);
    expect(isRetainedRunUnavailable({ status: 503, code: "RUN_NOT_FOUND" })).toBe(false);
  });

  it("latches synchronously and aborts retained work across lifecycle resets", () => {
    const latch = new AbortableRequestLatch();
    const first = latch.begin();
    expect(first).not.toBeNull();
    expect(latch.begin()).toBeNull();
    expect(latch.active).toBe(true);

    latch.reset("auth_transition");
    expect(first?.signal.aborted).toBe(true);
    expect(first?.signal.reason).toBe("auth_transition");
    expect(latch.active).toBe(false);

    const second = latch.begin();
    expect(second).not.toBeNull();
    latch.release(second!);
    expect(latch.active).toBe(false);
  });
});
