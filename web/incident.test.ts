import { describe, expect, it } from "vitest";
import { incidentPresentation } from "./incident";

describe("run incident presentation", () => {
  it("presents intervention as a human handoff instead of a failure", () => {
    expect(incidentPresentation("intervention")).toEqual({
      icon: "⇄",
      label: "Human handoff",
    });
    expect(incidentPresentation("intervention")).not.toEqual(incidentPresentation("failure"));
  });
});
