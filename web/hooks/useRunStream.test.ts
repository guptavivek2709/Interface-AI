import { describe, expect, it } from "vitest";
import { parseRunStreamEvent } from "./useRunStream";

describe("run stream event parsing", () => {
  it("accepts a monotonic event and its exact bound snapshot", () => {
    const parsed = parseRunStreamEvent(JSON.stringify({
      runId: "run-1",
      sequence: 4,
      event: { type: "step.succeeded", title: "Read member" },
      snapshot: { runId: "run-1", capabilityId: "member.lookup", phase: "running", revision: 3 },
    }), "step.succeeded", "4", "run-1", 2);
    expect(parsed).toEqual(expect.objectContaining({
      sequence: 4,
      snapshot: expect.objectContaining({ id: "run-1", revision: 3 }),
      live: expect.objectContaining({ type: "step.succeeded" }),
    }));
  });

  it("drops stale, malformed, and cross-run events", () => {
    expect(parseRunStreamEvent("not-json", "message", "", "run-1", 0)).toBeNull();
    expect(parseRunStreamEvent(JSON.stringify({ runId: "run-2", sequence: 5 }), "message", "5", "run-1", 0)).toBeNull();
    expect(parseRunStreamEvent(JSON.stringify({ runId: "run-1", sequence: 2 }), "message", "2", "run-1", 2)).toBeNull();
  });
});
