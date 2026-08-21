import { describe, expect, it } from "vitest";
import {
  approvalAuthorizedFromServerRoles,
  canLaunchCapabilityInSession,
  requiredProfileForCapability,
} from "./authorization";

const handoffCapability = {
  risk: "supervisor_only" as const,
  supportsSupervisorHandoff: true,
};

const directOnlyCapability = {
  risk: "supervisor_only" as const,
  supportsSupervisorHandoff: false,
};

describe("frontend capability authorization", () => {
  it("lets a teller use only an advertised same-session supervisor handoff", () => {
    expect(requiredProfileForCapability(handoffCapability, "teller")).toBe("teller");
    expect(canLaunchCapabilityInSession(handoffCapability, "teller", "teller")).toBe(true);

    expect(requiredProfileForCapability(directOnlyCapability, "teller")).toBeNull();
    expect(canLaunchCapabilityInSession(directOnlyCapability, "teller", "teller")).toBe(false);
  });

  it("preserves the direct supervisor target-session path", () => {
    expect(requiredProfileForCapability(directOnlyCapability, "supervisor")).toBe("supervisor");
    expect(canLaunchCapabilityInSession(directOnlyCapability, "supervisor", "supervisor")).toBe(true);
    expect(canLaunchCapabilityInSession(directOnlyCapability, "supervisor", "teller")).toBe(false);
  });

  it("derives delegated approval only from server-projected roles", () => {
    expect(approvalAuthorizedFromServerRoles("supervisor_confirmation", ["supervisor"])).toBe(true);
    expect(approvalAuthorizedFromServerRoles("supervisor_confirmation", ["teller"])).toBe(false);
    expect(approvalAuthorizedFromServerRoles("supervisor_confirmation", [])).toBe(false);
    expect(approvalAuthorizedFromServerRoles("user_confirmation", ["teller"])).toBe(true);
  });
});
