import type { ApprovalChallenge, Capability, ConsolePrincipal, OperatorSession } from "./types.js";

type LaunchCapability = Pick<Capability, "risk" | "supportsSupervisorHandoff">;
type PrincipalRole = ConsolePrincipal["role"] | undefined;
type SessionProfile = OperatorSession["profile"];
type ApprovalRole = "teller" | "supervisor";

/**
 * Select the target profile for a new capability session. A teller can start a
 * supervisor-only capability only when its reviewed catalog entry advertises
 * the retained-session supervisor handoff contract.
 */
export function requiredProfileForCapability(
  capability: LaunchCapability,
  principalRole: PrincipalRole,
  preferredProfile: SessionProfile = "teller",
): SessionProfile | null {
  if (!principalRole) return null;
  if (capability.risk === "supervisor_only") {
    if (principalRole === "supervisor") return "supervisor";
    return principalRole === "teller" && capability.supportsSupervisorHandoff
      ? "teller"
      : null;
  }
  return preferredProfile === "supervisor" && principalRole === "supervisor"
    ? "supervisor"
    : "teller";
}

/**
 * Authorize launch against the active target session. Direct supervisor launch
 * requires both supervisor console authority and a supervisor target profile;
 * the delegated path is limited to a teller identity, teller target session,
 * and an explicit reviewed handoff declaration.
 */
export function canLaunchCapabilityInSession(
  capability: LaunchCapability,
  principalRole: PrincipalRole,
  sessionProfile: SessionProfile | undefined,
): boolean {
  if (!principalRole || !sessionProfile) return false;
  if (capability.risk !== "supervisor_only") return true;
  if (principalRole === "supervisor" && sessionProfile === "supervisor") return true;
  return principalRole === "teller" &&
    sessionProfile === "teller" &&
    capability.supportsSupervisorHandoff;
}

/**
 * Approval authority is projected by the server for the authenticated console
 * principal and retained target session. Local profile state is intentionally
 * not an input to this decision.
 */
export function approvalAuthorizedFromServerRoles(
  requirement: ApprovalChallenge["requirement"],
  authorizedRoles: readonly ApprovalRole[],
): boolean {
  return requirement === "supervisor_confirmation"
    ? authorizedRoles.includes("supervisor")
    : authorizedRoles.length > 0;
}
