import type { ReactNode } from "react";
import { humanize } from "../form";
import type { ReconciliationController } from "../hooks/useReconciliation";
import type { RunRecord } from "../types";
import { Alert, shortId } from "./common";

export interface ReconciliationPanelProps {
  run: RunRecord;
  controller: ReconciliationController;
  online: boolean;
}

export function ReconciliationPanel({ run, controller, online }: ReconciliationPanelProps): ReactNode {
  if (!controller.sourceRunId) return null;
  const record = controller.record;
  const isSourceRun = run.id === controller.sourceRunId;
  const canStart = isSourceRun && run.phase === "completed" && run.terminalStatus === "failure" && run.effectUncertain;
  return (
    <section className="reconciliation-card" aria-labelledby={`reconciliation-${controller.sourceRunId}`}>
      <div className="reconciliation-heading">
        <div><p className="eyebrow">Read-only write reconciliation</p><h3 id={`reconciliation-${controller.sourceRunId}`}>Reconcile run {shortId(controller.sourceRunId)}</h3></div>
        {record ? <span className={`reconciliation-state reconciliation-${record.status}`}>{humanize(record.status)}</span> : null}
      </div>
      <p>The service retains the original write context and starts a bound read capability. This browser never reconstructs or resubmits the write inputs.</p>
      {controller.error ? <Alert title="Reconciliation unavailable">{controller.error}</Alert> : null}
      {(controller.checking && !record) ? <div className="reconciliation-loading" role="status"><span className="spinner" aria-hidden="true" />Checking reconciliation status…</div> : null}
      {canStart && (!record || record.status === "not_started") ? (
        <button className="button reconciliation-button" type="button" disabled={!online || controller.busy || controller.checking} onClick={() => void controller.start()}>
          {controller.busy ? <><span className="spinner" aria-hidden="true" />Starting reconciliation…</> : "Start reconciliation"}
        </button>
      ) : null}
      {record && ["running", "running_or_complete"].includes(record.status) ? <Alert tone="info" title="Read-only reconciliation in progress">The bound read run {record.runId ? shortId(record.runId) : ""} is being observed. No write retry is permitted.</Alert> : null}
      {record?.status === "complete" && record.decision ? (
        <div className={`reconciliation-decision decision-${record.decision.classification}`}>
          <strong>{record.decision.classification === "applied" ? "Write appears applied" : record.decision.classification === "not_applied" ? "Write appears not applied" : "Write outcome is still unknown"}</strong>
          <p>{record.decision.reason}</p>
          {record.decision.checkedFields.length ? <small>Checked fields: {record.decision.checkedFields.map(humanize).join(", ")}</small> : null}
          <span>Reconciliation is evidence, not authorization to retry. Start a new write only after the outcome and business intent are independently reviewed.</span>
        </div>
      ) : null}
      {record ? <button className="button quiet small" type="button" disabled={!online || controller.checking} onClick={() => void controller.refresh()}>Refresh reconciliation</button> : null}
    </section>
  );
}
