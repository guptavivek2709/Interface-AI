import { useState, type ReactNode } from "react";
import { humanize } from "../form";
import type { HumanHandoffController } from "../hooks/useHumanHandoff";
import type { ConsolePrincipal, OperatorSession } from "../types";
import { Alert } from "./common";

export interface SecureSessionPanelProps {
  principal: ConsolePrincipal;
  session: OperatorSession | null;
  profile: "teller" | "supervisor";
  branch: OperatorSession["branch"];
  connecting: boolean;
  online: boolean;
  handoff: HumanHandoffController;
  onProfile(value: "teller" | "supervisor"): void;
  onBranch(value: OperatorSession["branch"]): void;
  onConnect(): void;
}

export function SecureSessionPanel({
  principal,
  session,
  profile,
  branch,
  connecting,
  online,
  handoff,
  onProfile,
  onBranch,
  onConnect,
}: SecureSessionPanelProps): ReactNode {
  const [invitationToken, setInvitationToken] = useState("");
  const active = session?.status === "active";
  const provisioning = session?.status === "provisioning";
  return (
    <section className={`session-panel session-${session?.status ?? "idle"}`} aria-labelledby="session-title">
      <div className="session-copy">
        <span className="session-icon" aria-hidden="true">◆</span>
        <div><p className="eyebrow">Server-managed target access</p><h2 id="session-title">Secure MERIDIAN session</h2><span className="console-identity">Console identity: {principal.displayName} · {humanize(principal.role)}</span><p>{active ? `${humanize(session.profile)} session active at ${session.branch}. Sign out to establish a different target session.` : provisioning ? "Signing on with the server-managed credential profile. Runs remain disabled until verification succeeds." : session?.status === "failed" ? session.message ?? "The target session could not be established." : "Choose an authorized role and branch. The server supplies target credentials outside the browser."}</p></div>
      </div>
      <div className="session-controls">
        <label>Role<select value={profile} disabled={active || connecting || provisioning} onChange={(event) => onProfile(event.target.value as "teller" | "supervisor")}><option value="teller">Teller</option>{principal.role === "supervisor" ? <option value="supervisor">Supervisor</option> : null}</select></label>
        <label>Branch<select value={branch} disabled={active || connecting || provisioning} onChange={(event) => onBranch(event.target.value as OperatorSession["branch"])}><option value="MAIN-001">Main 001</option><option value="WEST-014">West 014</option><option value="EAST-022">East 022</option></select></label>
        <button className="button session-button" type="button" disabled={active || !online || connecting || provisioning || (profile === "supervisor" && principal.role !== "supervisor")} onClick={onConnect}>{connecting || provisioning ? <><span className="spinner" aria-hidden="true" />Connecting…</> : active ? "Session active" : "Connect session"}</button>
      </div>
      {principal.role === "supervisor" ? (
        <form className="handoff-redeem" onSubmit={(event) => { event.preventDefault(); void handoff.redeem(invitationToken); }}>
          <label htmlFor="handoff-invitation-token">Supervisor handoff invitation</label>
          <div>
            <input
              id="handoff-invitation-token"
              type="password"
              autoComplete="off"
              spellCheck={false}
              maxLength={43}
              value={invitationToken}
              placeholder="Paste the one-time invitation"
              onChange={(event) => setInvitationToken(event.target.value)}
            />
            <button className="button quiet" type="submit" disabled={!online || handoff.busy !== null || !/^[A-Za-z0-9_-]{43}$/u.test(invitationToken)}>
              {handoff.busy === "redeeming" ? <><span className="spinner" aria-hidden="true" />Redeeming…</> : "Redeem handoff"}
            </button>
          </div>
          <small>Redeeming consumes the invitation once and opens only its exact run intervention.</small>
          {handoff.error && handoff.busy === null ? <Alert title="Invitation not redeemed">{handoff.error}</Alert> : null}
        </form>
      ) : null}
    </section>
  );
}
