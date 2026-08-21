import type { ReactNode } from "react";
import { humanize } from "../form";
import type {
  Capability,
  CapabilityField,
  DiscoveryRunRecord,
  DiscoveryRunTimelineEvent,
  FieldType,
} from "../types";
import { Alert, EmptyState, LoadingRows, formatDate, shortId } from "./common";

function fieldTypeLabel(type: FieldType): string {
  if (type.kind === "array") return `${fieldTypeLabel(type.items ?? { kind: "string" })}[]`;
  if (type.kind === "object") return "object";
  return type.format && type.format !== "plain" ? `${type.kind} · ${humanize(type.format)}` : type.kind;
}

function ContractFields({ fields, withheld = false }: { fields: CapabilityField[]; withheld?: boolean }): ReactNode {
  if (fields.length === 0) return <p className="muted discovery-empty-contract">No fields are declared.</p>;
  return (
    <dl className="discovery-contract-list">
      {fields.map((field) => (
        <div key={field.name}>
          <dt><code>{field.name}</code><span>{field.required ? "Required" : "Optional"}</span></dt>
          <dd><strong>{fieldTypeLabel(field.type)}</strong><span>{humanize(field.classification)}</span>{withheld ? <em>Invocation value withheld</em> : null}</dd>
        </div>
      ))}
    </dl>
  );
}

function timelineSummary(event: DiscoveryRunTimelineEvent): string {
  if (event.type === "draft_created") return `Trace ${shortId(event.traceDigest ?? "")} compiled into artifact ${shortId(event.artifactDigest)}.`;
  if (event.type === "reviewed") return `${event.changedPathCount ?? 0} reviewed path changes bound to ${shortId(event.artifactDigest)}.`;
  if (event.type === "canary_passed") return `Read-only canary ${shortId(event.canaryRunId ?? "")} passed; evidence ${shortId(event.evidenceDigest ?? "")} retained by digest.`;
  return `Approved immutable artifact ${shortId(event.artifactDigest)} for publication.`;
}

export function DiscoveryRunHistory({
  runs,
  activeId,
  loading,
  error,
  onSelect,
  onRetry,
}: {
  runs: DiscoveryRunRecord[];
  activeId: string;
  loading: boolean;
  error: string;
  onSelect(run: DiscoveryRunRecord): void;
  onRetry(): void;
}): ReactNode {
  return (
    <section className="panel history-panel" aria-labelledby="discovery-history-title">
      <div className="panel-heading"><div><p className="eyebrow">Model discovery record</p><h2 id="discovery-history-title">Discovery history</h2></div><button className="button quiet small" type="button" onClick={onRetry}>Refresh</button></div>
      {loading ? <LoadingRows count={6} /> : null}
      {!loading && error ? <Alert title="Discovery history unavailable">{error}</Alert> : null}
      {!loading && !error && runs.length === 0 ? <EmptyState icon="◇" title="No published discovery runs" detail="Validated discovery lineage appears here after publication." /> : null}
      <div className="history-list">
        {runs.map((run) => (
          <button key={run.id} type="button" aria-pressed={activeId === run.id} className={`history-row${activeId === run.id ? " selected" : ""}`} onClick={() => onSelect(run)}>
            <span className="status-orb status-success" aria-hidden="true" />
            <span className="history-name"><strong>{run.capabilityName}</strong><small>{shortId(run.discoveryRunId)} · {formatDate(run.completedAt)}</small></span>
            <span className="history-state" aria-hidden="true">{humanize(run.status)}</span>
            <span className="visually-hidden">Status: {humanize(run.status)}.</span><span aria-hidden="true">›</span>
          </button>
        ))}
      </div>
    </section>
  );
}

export function DiscoveryRunDetail({ run, capability, loading }: { run: DiscoveryRunRecord | undefined; capability: Capability | undefined; loading: boolean }): ReactNode {
  if (loading) return <section className="panel activity-panel"><LoadingRows count={7} /></section>;
  if (!run) return <section className="panel activity-panel"><EmptyState icon="◇" title="Select a discovery run" detail="Choose a published discovery record to inspect its private-input boundary, structured output, promotion timeline, and evidence." /></section>;
  const outputContract = run.outputContract.length > 0 ? run.outputContract : capability?.outputs ?? [];
  return (
    <section className="panel activity-panel" aria-labelledby="discovery-detail-title">
      <div className="panel-heading activity-heading"><div><p className="eyebrow">Published discovery</p><h2 id="discovery-detail-title">{capability?.name ?? run.capabilityName}</h2></div><span className="history-state">{humanize(run.status)}</span></div>
      <div className="run-detail discovery-detail">
        <div className="run-identity"><div><span className="status-orb status-success" aria-hidden="true" /><div><strong>{run.capabilityId}</strong><span>{run.discoveryRunId}</span></div></div></div>
        <Alert tone="positive" title="Discovery promoted and published">This is the validated record of the real Anthropic discovery that produced the approved replay artifact.</Alert>
        <dl className="contract-strip discovery-contract-strip">
          <div><dt>Provider</dt><dd>{run.provider}</dd></div>
          <div><dt>Model</dt><dd>{run.model}</dd></div>
          <div><dt>Version</dt><dd>{run.capabilityVersion}</dd></div>
        </dl>

        <section className="discovery-request" aria-labelledby="discovery-request-title">
          <div className="section-heading"><h3 id="discovery-request-title">Discovery request</h3><span>{formatDate(run.createdAt)}</span></div>
          <p>{run.goal}</p>
          <Alert tone="info" title="Invocation values intentionally withheld">Only the reviewed input contract is retained. Raw discovery values, credentials, page prose, screenshots, cookies, and session references are not persisted.</Alert>
          <ContractFields fields={run.inputs} withheld />
        </section>

        <section className="outputs" aria-labelledby="discovery-output-title">
          <div className="section-heading"><h3 id="discovery-output-title">Structured discovery output</h3><span>{outputContract.length} output fields</span></div>
          <ContractFields fields={outputContract} />
          <dl className="value-grid discovery-digests">
            <div><dt>Trace digest</dt><dd><code>{run.output.traceDigest}</code></dd></div>
            <div><dt>Draft digest</dt><dd><code>{run.output.draftDigest}</code></dd></div>
            <div><dt>Reviewed digest</dt><dd><code>{run.output.reviewedDigest}</code></dd></div>
            <div><dt>Canary run</dt><dd><code>{run.output.canaryRunId}</code></dd></div>
            <div><dt>Approved digest</dt><dd><code>{run.output.approvedDigest}</code></dd></div>
          </dl>
        </section>

        <section className="timeline-section" aria-labelledby="discovery-timeline-title">
          <div className="section-heading"><h3 id="discovery-timeline-title">Promotion timeline</h3><span>{run.timeline.length} persisted events</span></div>
          <ol className="timeline">
            {run.timeline.map((event, index) => (
              <li className="timeline-positive" key={`${event.type}-${event.at}`}>
                <span className="timeline-marker" aria-hidden="true">{index + 1}</span>
                <div className="timeline-copy"><div><strong>{humanize(event.type)}</strong><time dateTime={event.at}>{formatDate(event.at)}</time></div><p>{timelineSummary(event)} Actor: {event.actor}.</p></div>
              </li>
            ))}
          </ol>
        </section>

        <section className="evidence-section" aria-labelledby="discovery-evidence-title">
          <div className="section-heading"><h3 id="discovery-evidence-title">Persisted evidence references</h3><span>{run.evidence.length} references</span></div>
          <p className="muted discovery-evidence-note">Discovery evidence is intentionally limited to the privacy-safe published artifact, external lineage, and canary digest. A missing raw trace or screenshot is a data-minimization boundary, not fabricated evidence.</p>
          <div className="discovery-evidence-list">
            {run.evidence.map((reference) => (
              <div key={`${reference.kind}-${reference.sha256}`}><span>{humanize(reference.kind)}</span><strong>{reference.label}</strong><code>{reference.sha256}</code>{reference.href ? <a className="button quiet small" href={reference.href} target="_blank" rel="noreferrer">Open verified projection</a> : null}</div>
            ))}
          </div>
        </section>
      </div>
    </section>
  );
}
