import type { ReactNode } from "react";
import { humanize } from "../form";
import type { HumanHandoffController } from "../hooks/useHumanHandoff";
import type { ConsolePrincipal, RunRecord } from "../types";
import { Alert, formatDate } from "./common";

export interface HumanHandoffPanelProps {
  run: RunRecord;
  principal: ConsolePrincipal;
  controller: HumanHandoffController;
  online: boolean;
}

export function HumanHandoffPanel({
  run,
  principal,
  controller,
  online,
}: HumanHandoffPanelProps): ReactNode {
  const intervention = run.intervention;
  if (run.phase !== "awaiting_human" || !intervention) {
    return run.phase === "awaiting_human"
      ? <Alert title="Handoff details unavailable">The service did not provide a complete intervention binding. Refresh the run; no handoff action is enabled.</Alert>
      : null;
  }
  const expired = Date.parse(intervention.expiresAt) <= Date.now();
  const delegatedRoleRequired = intervention.action === "authenticate_supervisor" &&
    Boolean(intervention.requiredRole) &&
    principal.role !== intervention.requiredRole;
  const disabled = !online || Boolean(controller.busy) || expired;
  const stateCopy = intervention.state === "awaiting_human"
    ? "Automation is paused before the intervention. The exact same retained target session must remain open."
    : intervention.state === "human_active"
      ? "Human control is active on the retained session. Complete only the named intervention, then confirm it below."
      : intervention.state === "action_completed"
        ? "The named human action completed on the retained session. Resume once to let the service revalidate the approved checkpoint."
        : "The service is revalidating the retained session. Automation will continue only after that authoritative check succeeds.";

  return (
    <section className="handoff-card" aria-labelledby={`handoff-${intervention.interventionId}`}>
      <div className="handoff-heading">
        <div>
          <p className="eyebrow">Same-session human handoff</p>
          <h3 id={`handoff-${intervention.interventionId}`}>{humanize(intervention.action)}</h3>
        </div>
        <span className={`handoff-state handoff-state-${intervention.state}`}>{humanize(intervention.state)}</span>
      </div>
      <p>{stateCopy}</p>
      <dl className="handoff-facts">
        <div><dt>Reason</dt><dd>{humanize(intervention.reasonCode)}</dd></div>
        <div><dt>Checkpoint</dt><dd>{humanize(intervention.stepId)}</dd></div>
        <div><dt>Expires</dt><dd>{formatDate(intervention.expiresAt)}</dd></div>
        {intervention.requiredRole ? <div><dt>Required role</dt><dd>{humanize(intervention.requiredRole)}</dd></div> : null}
      </dl>
      {expired ? <Alert title="Handoff expired">This intervention is no longer actionable. Refresh the run to reconcile its terminal state.</Alert> : null}
      {controller.error ? <Alert title="Handoff request stopped">{controller.error}</Alert> : null}
      {delegatedRoleRequired ? (
        <div className="handoff-delegation">
          <p>An authenticated {humanize(intervention.requiredRole ?? "required")} must redeem a one-time invitation before taking control.</p>
          {!controller.invitation ? (
            <button className="button" type="button" disabled={disabled} onClick={() => void controller.createInvitation()}>
              {controller.busy === "inviting" ? <><span className="spinner" aria-hidden="true" />Creating invitation…</> : "Create supervisor invitation"}
            </button>
          ) : (
            <div className="handoff-invitation" role="status">
              <strong>One-time invitation</strong>
              <code>{controller.invitation.token}</code>
              <small>Expires {formatDate(controller.invitation.expiresAt)}. Share through an approved secure channel; it is consumed on the first redemption attempt.</small>
              <button className="button quiet small" type="button" onClick={controller.clearInvitation}>Hide invitation</button>
            </div>
          )}
        </div>
      ) : (
        <div className="handoff-actions">
          {intervention.state === "awaiting_human" ? (
            <button className="button" type="button" disabled={disabled} onClick={() => void controller.take()}>
              {controller.busy === "taking" ? <><span className="spinner" aria-hidden="true" />Taking control…</> : "Take same-session control"}
            </button>
          ) : null}
          {intervention.state === "human_active" ? (
            <button className="button" type="button" disabled={disabled} onClick={() => void controller.perform()}>
              {controller.busy === "acting" ? <><span className="spinner" aria-hidden="true" />Confirming intervention…</> : intervention.action === "authenticate_supervisor" ? "Confirm supervisor authentication" : "Confirm session restoration"}
            </button>
          ) : null}
          {intervention.state === "action_completed" ? (
            <button className="button" type="button" disabled={disabled} onClick={() => void controller.resume()}>
              {controller.busy === "resuming" ? <><span className="spinner" aria-hidden="true" />Resuming…</> : "Resume approved automation"}
            </button>
          ) : null}
        </div>
      )}
      <p className="handoff-note">The browser submits only this run and intervention ID. It never accepts target locators, credentials, or model-provided approval material.</p>
    </section>
  );
}
