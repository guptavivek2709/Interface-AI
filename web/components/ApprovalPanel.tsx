import { useEffect, useState, type ReactNode } from "react";
import { humanize } from "../form";
import type { ApprovalChallenge } from "../types";
import { Alert, ValueView } from "./common";

export interface ApprovalLatch {
  runId: string;
  challengeId: string;
  status: "accepted" | "unconfirmed";
}

export interface ApprovalPanelProps {
  challenge: ApprovalChallenge;
  approving: boolean;
  latchStatus: ApprovalLatch["status"] | null;
  blockedByOtherApproval: boolean;
  cancelling: boolean;
  online: boolean;
  onApprove(): void;
  onCancel(): void;
}

export function ApprovalPanel({
  challenge,
  approving,
  latchStatus,
  blockedByOtherApproval,
  cancelling,
  online,
  onApprove,
  onCancel,
}: ApprovalPanelProps): ReactNode {
  const [confirmedChallengeId, setConfirmedChallengeId] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [challenge.challengeId]);
  const expiry = new Date(challenge.expiresAt).getTime();
  const remaining = Math.max(0, Math.ceil((expiry - now) / 1_000));
  const expired = !Number.isFinite(expiry) || remaining === 0;
  const supervisor = challenge.requirement === "supervisor_confirmation";
  const authorized = challenge.authorized;
  const reviewable = challenge.summary.length > 0 && challenge.summary.every((item) => item.reviewable);
  const confirmed = confirmedChallengeId === challenge.challengeId;
  return (
    <section className="approval-card" aria-labelledby="approval-title">
      <div className="approval-heading"><span className="approval-icon" aria-hidden="true">!</span><div><p className="eyebrow">Execution paused safely</p><h3 id="approval-title">{challenge.stepTitle}</h3></div><span className={`expiry${expired ? " expired" : ""}`}>{expired ? "Expired" : `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`}</span></div>
      <p>{!authorized ? supervisor ? "This checkpoint remains bound to the retained live session. Complete its one-time supervisor handoff from an authenticated supervisor console; do not restart or duplicate the write." : "This authenticated console is not authorized for the retained session checkpoint." : reviewable ? "Review the exact prepared values. Approval is bound to this run and expires automatically." : "Approval remains blocked because the service did not provide a complete, authorized review projection."}</p>
      {challenge.summary.length ? (
        <dl className="approval-summary">{challenge.summary.map((item) => <div key={item.targetId}><dt>{humanize(item.targetId)}</dt><dd>{item.reviewable ? <ValueView value={item.value} /> : <span className="protected-value">Protected value</span>}</dd></div>)}</dl>
      ) : <p className="muted">The target review checkpoint is ready. No display-safe summary values were returned.</p>}
      {!authorized ? <Alert tone="warning" title={supervisor ? "Supervisor handoff required" : "Approval authority required"}>{supervisor ? "Create and redeem the run's one-time supervisor invitation, take control of the same target session, authenticate there, and resume. The server enables approval only for the delegated supervisor bound to that session." : "Refresh under the authenticated console identity that owns this retained target session. No approval was sent."}</Alert> : (
        <>
          {!reviewable ? <Alert tone="info" title="Review details required">Refresh the run or ask an administrator to restore its authorized display projection. Credentials must never be entered to unblock it.</Alert> : null}
          {latchStatus ? <Alert tone={latchStatus === "accepted" ? "positive" : "warning"} title={latchStatus === "accepted" ? "Approval accepted" : "Approval status is being reconciled"}>{latchStatus === "accepted" ? "The bound request was accepted. Approval remains locked until the run advances beyond this exact challenge." : "Do not approve again. The console is checking whether the prior request reached the service."}</Alert> : null}
          {blockedByOtherApproval ? <Alert tone="warning" title="Another approval is being reconciled">Wait until the prior approval reaches a definitive run state before authorizing another operation.</Alert> : null}
          <label className="confirmation-check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmedChallengeId(event.target.checked ? challenge.challengeId : null)} disabled={!reviewable || expired || approving || Boolean(latchStatus) || blockedByOtherApproval} /><span>I reviewed these details and authorize this one operation.</span></label>
          <button className="button approval-button" type="button" disabled={!reviewable || !confirmed || expired || approving || Boolean(latchStatus) || blockedByOtherApproval} onClick={onApprove}>{approving ? <><span className="spinner" aria-hidden="true" />Approving…</> : latchStatus ? "Waiting for run to advance…" : blockedByOtherApproval ? "Another approval is pending…" : "Approve and continue"}</button>
        </>
      )}
      <div className="safe-stop-row">
        <p>{expired ? "This checkpoint expired without posting the operation." : "Cancelling here will not cross the paused commit boundary."}</p>
        <button className="button quiet cancel-button" type="button" disabled={!online || cancelling || approving || Boolean(latchStatus) || blockedByOtherApproval} onClick={onCancel}>{cancelling ? <><span className="spinner" aria-hidden="true" />Cancelling…</> : "Cancel safely"}</button>
      </div>
    </section>
  );
}
