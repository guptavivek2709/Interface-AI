import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ApiError,
  evidenceFinalizationStatus,
  evidenceUrl,
  getEvidence,
  type EvidenceItem,
} from "../api";
import { humanize } from "../form";
import { incidentPresentation } from "../incident";
import { contractValues } from "../security";
import type { HumanHandoffController } from "../hooks/useHumanHandoff";
import { useReconciliation } from "../hooks/useReconciliation";
import type { Capability, ConnectionState, ConsolePrincipal, LiveEvent, RunRecord } from "../types";
import { ApprovalPanel, type ApprovalLatch } from "./ApprovalPanel";
import { HumanHandoffPanel } from "./HumanHandoffPanel";
import { ReconciliationPanel } from "./ReconciliationPanel";
import {
  Alert,
  ConnectionBadge,
  EmptyState,
  LoadingRows,
  ValueView,
  errorMessage,
  formatBytes,
  formatDate,
  shortId,
} from "./common";

const PHASES = ["queued", "running", "awaiting_approval", "completed"] as const;

function PhaseTracker({ run }: { run: RunRecord }): ReactNode {
  const index = run.phase === "recovering" || run.phase === "awaiting_human" ? 1 : PHASES.indexOf(run.phase as (typeof PHASES)[number]);
  return (
    <ol className="phase-tracker" aria-label={`Run phase: ${humanize(run.phase)}`}>
      {PHASES.map((item, itemIndex) => <li className={itemIndex < index ? "done" : itemIndex === index ? "active" : ""} key={item}><span aria-hidden="true">{itemIndex < index ? "✓" : itemIndex + 1}</span><small>{item === "awaiting_approval" ? "Review" : humanize(item)}</small></li>)}
    </ol>
  );
}

function Timeline({ run, liveEvents }: { run: RunRecord; liveEvents: LiveEvent[] }): ReactNode {
  if (run.journal.length === 0 && liveEvents.length === 0) return <EmptyState icon="·" title="Waiting for the first step" detail="The deterministic runner will report each meaningful state transition here." />;
  return (
    <ol className="timeline">
      {run.journal.map((entry) => (
        <li key={`journal-${entry.sequence}-${entry.attempt}`} className={`timeline-${entry.status}`}>
          <span className="timeline-marker" aria-hidden="true">{entry.status === "succeeded" ? "✓" : entry.status === "failed" ? "!" : "·"}</span>
          <div className="timeline-copy"><div><strong>{entry.title}<span className="visually-hidden"> — {humanize(entry.status)}</span></strong><time dateTime={entry.startedAt}>{formatDate(entry.completedAt ?? entry.startedAt)}</time></div><p>{entry.summary ?? `${humanize(entry.action)} · ${humanize(entry.effect)}`}</p>{entry.attempt > 1 ? <span className="attempt">Attempt {entry.attempt}</span> : null}</div>
        </li>
      ))}
      {liveEvents.map((event) => (
        <li key={`live-${event.id}`} className={`timeline-live timeline-${event.tone}`}>
          <span className="timeline-marker" aria-hidden="true">{event.tone === "positive" ? "✓" : event.tone === "critical" ? "!" : "·"}</span>
          <div className="timeline-copy"><div><strong>{event.title}<span className="visually-hidden"> — {humanize(event.tone)}</span></strong><time dateTime={event.timestamp}>{formatDate(event.timestamp)}</time></div>{event.summary ? <p>{event.summary}</p> : null}</div>
        </li>
      ))}
    </ol>
  );
}

export function Outcome({ run }: { run: RunRecord }): ReactNode {
  if (!run.terminalStatus) return null;
  if (run.terminalStatus === "success") return <Alert tone="positive" title="Run completed">The approved capability reached its verified checkpoint.</Alert>;
  if (run.effectUncertain) return <Alert title="Commit outcome is unknown">Do not retry this operation. Reconcile it with the target system before taking another action.</Alert>;
  const tone = run.terminalStatus === "business_outcome" ? "warning" : "critical";
  const title = run.terminalStatus === "business_outcome" ? "Action needs different information" : run.terminalStatus === "escalation" ? "Human attention required" : "Run stopped safely";
  return <Alert tone={tone} title={title}><p>{run.message ?? "The run ended without changing any further target state."}</p>{run.code ? <code className="error-code">{run.code}</code> : null}</Alert>;
}

export interface ExecutionBindingView {
  version: string | null;
  artifactDigest: string | null;
  targetProfileDigest: string | null;
  discoveryRunId: string | null;
}

export function resolveExecutionBinding(
  run: RunRecord,
  capability: Capability | undefined,
): ExecutionBindingView {
  const bindingMatches = Boolean(
    capability?.contractValid &&
    run.capabilityVersion &&
    run.artifactDigest &&
    run.targetProfileDigest &&
    capability.id === run.capabilityId &&
    capability.version === run.capabilityVersion &&
    capability.digest === run.artifactDigest &&
    capability.targetProfileDigest === run.targetProfileDigest,
  );
  if (!bindingMatches) {
    return {
      version: null,
      artifactDigest: null,
      targetProfileDigest: null,
      discoveryRunId: null,
    };
  }
  return {
    version: run.capabilityVersion,
    artifactDigest: run.artifactDigest ?? null,
    targetProfileDigest: run.targetProfileDigest ?? null,
    discoveryRunId: capability?.lineage?.discoveryRunId || null,
  };
}

export function ExecutionBindingStrip({
  run,
  capability,
}: {
  run: RunRecord;
  capability: Capability | undefined;
}): ReactNode {
  const binding = resolveExecutionBinding(run, capability);
  const fields = [
    { label: "Version", value: binding.version, compact: false },
    { label: "Artifact digest", value: binding.artifactDigest, compact: true },
    { label: "Target-profile digest", value: binding.targetProfileDigest, compact: true },
    { label: "Discovery run", value: binding.discoveryRunId, compact: true },
  ] as const;
  return (
    <section className="execution-binding" aria-label="Execution binding">
      <p>Execution binding</p>
      <dl>
        {fields.map((field) => (
          <div key={field.label}>
            <dt>{field.label}</dt>
            <dd>{field.value
              ? <code title={field.value}>{field.compact ? shortId(field.value) : field.value}</code>
              : <span>Unavailable</span>}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export interface RunPanelProps {
  run: RunRecord | undefined;
  capability: Capability | undefined;
  connection: ConnectionState;
  liveEvents: LiveEvent[];
  loading: boolean;
  approving: boolean;
  approvalLatch: ApprovalLatch | null;
  cancelling: boolean;
  online: boolean;
  principal: ConsolePrincipal;
  handoff: HumanHandoffController;
  onRunUpdate(run: RunRecord, focus: boolean): void;
  onUnauthorized(): void;
  onUnavailable(runId: string): void;
  onRefresh(): void;
  onApprove(): void;
  onCancel(): void;
}

export function RunPanel({
  run,
  capability,
  connection,
  liveEvents,
  loading,
  approving,
  approvalLatch,
  cancelling,
  online,
  principal,
  handoff,
  onRunUpdate,
  onUnauthorized,
  onUnavailable,
  onRefresh,
  onApprove,
  onCancel,
}: RunPanelProps): ReactNode {
  const [evidence, setEvidence] = useState<EvidenceItem[]>([]);
  const [evidenceFinalized, setEvidenceFinalized] = useState(false);
  const [evidenceRunId, setEvidenceRunId] = useState("");
  const [evidenceRefresh, setEvidenceRefresh] = useState(0);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [evidenceError, setEvidenceError] = useState("");
  const reconciliation = useReconciliation({ run, online, onRun: onRunUpdate, onUnauthorized });
  useEffect(() => {
    setEvidence([]);
    setEvidenceFinalized(false);
    setEvidenceRunId(run?.id ?? "");
    setEvidenceError("");
    if (!run || run.phase !== "completed") {
      setEvidenceLoading(false);
      return;
    }
    const controller = new AbortController();
    setEvidenceLoading(true);
    void getEvidence(run.id, controller.signal)
      .then((listing) => {
        if (!controller.signal.aborted) {
          setEvidence(listing.items);
          setEvidenceFinalized(listing.finalized);
        }
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) {
          onUnauthorized();
          return;
        }
        if (error instanceof ApiError && error.status === 404 && error.code === "RUN_NOT_FOUND") {
          onUnavailable(run.id);
          return;
        }
        setEvidenceError(errorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setEvidenceLoading(false);
      });
    return () => controller.abort();
  }, [run?.id, run?.phase, evidenceRefresh, onUnauthorized, onUnavailable]);
  const evidenceMatchesRun = evidenceRunId === run?.id;
  const visibleEvidence = evidenceMatchesRun ? evidence : [];
  const visibleEvidenceFinalized = evidenceMatchesRun && evidenceFinalized;
  const visibleEvidenceLoading = !evidenceMatchesRun || evidenceLoading;
  const visibleEvidenceError = evidenceMatchesRun ? evidenceError : "";
  const snapshotEvidenceStatus = run ? evidenceFinalizationStatus(run) : undefined;
  const evidenceReady = visibleEvidenceFinalized &&
    (snapshotEvidenceStatus === undefined || snapshotEvidenceStatus === "complete");
  const displayOutputs = useMemo(
    () => run?.outputsDisplaySafe === true ? contractValues(run.outputs, capability?.outputs) : undefined,
    [run?.outputsDisplaySafe, run?.outputs, capability?.outputs],
  );
  const displayInputs = useMemo(
    () => contractValues(run?.inputs, capability?.inputs),
    [run?.inputs, capability?.inputs],
  );
  return (
    <section className="panel activity-panel" aria-labelledby="activity-title">
      <div className="panel-heading activity-heading">
        <div><p className="eyebrow">Runtime monitor</p><h2 id="activity-title">Live activity</h2></div>
        <ConnectionBadge state={connection} />
      </div>
      {loading ? <LoadingRows count={5} /> : null}
      {!loading && !run ? <EmptyState icon="◎" title="No run selected" detail="Start an operation or choose one from run history to inspect its progress." /> : null}
      {!loading && run ? (
        <div className="run-detail">
          <div className="run-identity"><div><span className={`status-orb status-${run.terminalStatus ?? run.phase}`} aria-hidden="true" /><div><strong>{capability?.name ?? humanize(run.capabilityId)}</strong><span>Run {shortId(run.id)}</span></div></div><button className="icon-button" type="button" aria-label="Refresh run" title="Refresh run" onClick={onRefresh}>↻</button></div>
          <ExecutionBindingStrip run={run} capability={capability} />
          <PhaseTracker run={run} />
          {run.phase === "queued" ? <div className="safe-stop-row queued-stop"><p>This request has not entered a browser step and can be removed safely.</p><button className="button quiet cancel-button" type="button" disabled={!online || cancelling} onClick={onCancel}>{cancelling ? <><span className="spinner" aria-hidden="true" />Cancelling…</> : "Cancel queued run"}</button></div> : null}
          {run.phase === "recovering" ? <Alert tone="warning" title="Safe recovery in progress">The runner detected a recoverable target state and is restarting only from an approved checkpoint.</Alert> : null}
          {run.phase === "awaiting_human" ? <HumanHandoffPanel run={run} principal={principal} controller={handoff} online={online} /> : null}
          <Outcome run={run} />
          <ReconciliationPanel run={run} controller={reconciliation} online={online} />
          {run.phase === "awaiting_approval" && run.challenge ? <ApprovalPanel challenge={run.challenge} approving={approving} latchStatus={approvalLatch?.runId === run.id && approvalLatch.challengeId === run.challenge.challengeId ? approvalLatch.status : null} blockedByOtherApproval={Boolean(approvalLatch && (approvalLatch.runId !== run.id || approvalLatch.challengeId !== run.challenge.challengeId))} cancelling={cancelling} online={online} onApprove={onApprove} onCancel={onCancel} /> : null}
          {run.incidents.length ? <section className="incidents" aria-labelledby="incidents-title"><h3 id="incidents-title">Incidents & recovery</h3>{run.incidents.map((incident, index) => { const presentation = incidentPresentation(incident.category); return <div className={`incident incident-${incident.category}`} key={`${incident.code}-${index}`}><span aria-label={presentation.label}>{presentation.icon}</span><div><strong>{humanize(incident.code)}</strong><p>{incident.message}</p>{incident.recoveryAttempt ? <small>Recovery attempt {incident.recoveryAttempt}</small> : null}</div></div>; })}</section> : null}
          <section className="timeline-section" aria-labelledby="timeline-title"><div className="section-heading"><h3 id="timeline-title">Execution timeline</h3><span>{run.journal.length + liveEvents.length} events</span></div><Timeline run={run} liveEvents={liveEvents} /></section>
          {run.phase === "completed" ? (
            <section className="evidence-section" aria-labelledby="evidence-title">
              <div className="section-heading">
                <h3 id="evidence-title">Run evidence</h3>
                <div className="section-actions">
                  <span>{evidenceReady ? `${visibleEvidence.length} files` : snapshotEvidenceStatus === "failed" ? "Finalization failed" : snapshotEvidenceStatus === "not_applicable" ? "Not applicable" : "Not finalized"}</span>
                  <button className="button quiet small" type="button" disabled={visibleEvidenceLoading} onClick={() => setEvidenceRefresh((current) => current + 1)}>Refresh evidence</button>
                </div>
              </div>
              {visibleEvidenceLoading ? <LoadingRows count={2} /> : null}
              {!visibleEvidenceLoading && visibleEvidenceError ? <Alert tone="info" title="Evidence unavailable">{visibleEvidenceError}</Alert> : null}
              {!visibleEvidenceLoading && !visibleEvidenceError && snapshotEvidenceStatus === "failed" ? <Alert title="Evidence finalization failed">Required evidence could not be finalized. Staged files are withheld because no complete manifest can be verified.</Alert> : null}
              {!visibleEvidenceLoading && !visibleEvidenceError && snapshotEvidenceStatus === "not_applicable" ? <p className="evidence-empty">This manager-only run did not create an evidence bundle.</p> : null}
              {!visibleEvidenceLoading && !visibleEvidenceError && snapshotEvidenceStatus !== "failed" && snapshotEvidenceStatus !== "not_applicable" && !evidenceReady ? <Alert tone="info" title={snapshotEvidenceStatus === "complete" ? "Final evidence manifest unavailable" : "Evidence is not finalized"}>{snapshotEvidenceStatus === "complete" ? "The run reports completed evidence capture, but the retained manifest could not be verified. Downloads are withheld; refresh to reconcile the listing." : <>The service has not published the final manifest. {visibleEvidence.length ? `${visibleEvidence.length} staged ${visibleEvidence.length === 1 ? "file is" : "files are"} withheld until finalization is confirmed.` : "Capture may still be finishing or may have failed; refresh to reconcile its status."}</>}</Alert> : null}
              {!visibleEvidenceLoading && !visibleEvidenceError && evidenceReady && visibleEvidence.length === 0 ? <p className="evidence-empty">No retained evidence files were reported for this run.</p> : null}
              {evidenceReady && visibleEvidence.length ? <ul className="evidence-list">{visibleEvidence.map((item) => { const fileName = item.path.split("/").at(-1) ?? "evidence"; return <li key={item.path}><div><strong>{humanize(fileName)}</strong><span>{item.path} · {formatBytes(item.bytes)}</span></div><a className="button quiet small" href={evidenceUrl(run.id, item.path)} download={fileName} rel="noopener">Download</a></li>; })}</ul> : null}
              <p className="evidence-note">Only manifest-finalized evidence can be downloaded, and it is never embedded in the console.</p>
            </section>
          ) : null}
          {displayOutputs ? <section className="outputs" aria-labelledby="outputs-title"><div className="section-heading"><h3 id="outputs-title">Verified output</h3><span>Contract-filtered result</span></div><ValueView value={displayOutputs} label="Run output" /></section> : null}
          {run.outputs && !displayOutputs ? <Alert tone="info" title="Output withheld">The service did not mark this result as safe for display under the approved output contract, so the console will not render its values.</Alert> : null}
          {displayInputs ? <details className="input-envelope"><summary>Submitted input envelope</summary><p>Only contract-declared, display-safe fields are shown.</p><ValueView value={displayInputs} label="Submitted inputs" /></details> : null}
        </div>
      ) : null}
    </section>
  );
}
