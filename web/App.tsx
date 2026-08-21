import {
  Component,
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ApiError,
  approveRun,
  cancelRun as requestRunCancellation,
  createSession,
  createRun,
  getCapabilities,
  getAuthState,
  getDiscoveryRun,
  getDiscoveryRuns,
  getRun,
  getRuns,
  login,
  logout,
  postChat,
} from "./api";
import {
  type ArrayCounts,
  type FlatFormValues,
  fieldDomId,
  fieldPath,
  humanize,
  isRunnable,
  prepareProposalInputs,
  prepareSequenceStepInputs,
  serializeInputs,
} from "./form";
import {
  AbortableRequestLatch,
  isRetainedRunUnavailable,
  nextRunSelection,
  withoutRun,
} from "./lifecycle";
import {
  canLaunchCapabilityInSession,
  requiredProfileForCapability,
} from "./authorization";
import {
  containsCredentialMaterial,
  containsProtectedMaterial,
  isProtectedField,
  isProtectedKey,
} from "./security";
import { ChatPanel } from "./components/ChatPanel";
import { DiscoveryRunDetail, DiscoveryRunHistory } from "./components/DiscoveryHistory";
import { type ApprovalLatch } from "./components/ApprovalPanel";
import { RunPanel } from "./components/RunDetail";
import { SecureSessionPanel } from "./components/SecureSessionPanel";
import { useRunStream } from "./hooks/useRunStream";
import { useTargetSessionObserver } from "./hooks/useTargetSessionObserver";
import { useHumanHandoff } from "./hooks/useHumanHandoff";
import {
  Alert,
  Brand,
  EmptyState,
  LoadingRows,
  RISK_LABELS,
  RiskBadge,
  errorMessage,
  formatDate,
  shortId,
} from "./components/common";
import {
  initialSequenceExecution,
  resolveSequenceCapability,
  sequenceRunMatchesStep,
  updateSequenceStep,
} from "./sequence";
import type {
  ApprovalChallenge,
  Capability,
  CapabilityField,
  ChatMessage,
  ChatSequenceExecution,
  ChatSequencePlan,
  ConsolePrincipal,
  DiscoveryRunRecord,
  FieldType,
  JsonValue,
  OperatorSession,
  RiskLevel,
  RunRecord,
} from "./types";
const LOCAL_LOCK_KEY = "meridian.console.locally-locked";
const TAB_LOCK_KEY = "meridian.console.tab-locked";
const AUTH_EVENT_KEY = "meridian.console.auth-change";

function localConsoleLocked(): boolean {
  try {
    return window.localStorage.getItem(LOCAL_LOCK_KEY) !== null || window.sessionStorage.getItem(TAB_LOCK_KEY) !== null;
  } catch { return false; }
}

function setLocalConsoleLock(locked: boolean): void {
  try {
    if (locked) window.localStorage.setItem(LOCAL_LOCK_KEY, new Date().toISOString());
    else {
      window.localStorage.removeItem(LOCAL_LOCK_KEY);
      window.sessionStorage.removeItem(TAB_LOCK_KEY);
    }
  } catch {
    // Storage may be disabled; the in-memory gate and server logout still apply.
  }
}

function broadcastAuthChange(kind: "login" | "logout" | "expired"): void {
  try { window.localStorage.setItem(AUTH_EVENT_KEY, `${kind}:${Date.now()}:${crypto.randomUUID()}`); } catch { /* best effort */ }
}

function capabilityKey(capability: Pick<Capability, "id" | "version">): string {
  return `${capability.id}@${capability.version}`;
}

type ChatProposal = NonNullable<ChatMessage["proposal"]>;
type ChatExecution = NonNullable<ChatMessage["execution"]>;

interface ChatApprovalCandidate {
  message: ChatMessage;
  binding: {
    capabilityId: string;
    capabilityVersion: string;
    artifactDigest: string;
    targetProfileDigest: string;
    arguments: Record<string, JsonValue>;
    boundInputs: string[];
  };
  authorizedRunId: string;
  run: RunRecord;
  challenge: ApprovalChallenge;
  sequenceStepIndex?: number;
}

function resolveProposalCapability(
  capabilities: readonly Capability[],
  proposal: ChatProposal,
): Capability | undefined {
  return capabilities.find(
    (item) =>
      item.id === proposal.capabilityId &&
      item.version === proposal.capabilityVersion &&
      item.digest === proposal.artifactDigest &&
      item.targetProfileDigest === proposal.targetProfileDigest &&
      isRunnable(item),
  );
}

function errorCode(error: unknown): string {
  return error instanceof ApiError ? error.code : "UNEXPECTED_ERROR";
}

function isTerminal(run: RunRecord | undefined): boolean {
  return run?.phase === "completed";
}

function runTimestamp(run: RunRecord): string {
  return run.updatedAt ?? run.completedAt ?? run.startedAt ?? run.createdAt ?? "";
}

function mergeRuns(current: RunRecord[], incoming: RunRecord): RunRecord[] {
  const existing = current.find((run) => run.id === incoming.id);
  const selected = existing?.revision !== undefined
    ? incoming.revision === undefined || incoming.revision <= existing.revision ? existing : incoming
    : incoming;
  const next = current.filter((run) => run.id !== incoming.id);
  return [selected, ...next].sort((left, right) => runTimestamp(right).localeCompare(runTimestamp(left)));
}

function reconcileRuns(current: RunRecord[], incoming: RunRecord[]): RunRecord[] {
  return incoming.reduce<RunRecord[]>((next, run) => mergeRuns(next, run), current.filter((run) => incoming.some((item) => item.id === run.id)));
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function requestFingerprint(capability: Capability, inputs: Record<string, JsonValue>): Promise<string> {
  if (!crypto.subtle) throw new Error("Secure request binding is unavailable in this browser.");
  const binding = canonicalJson({
    capabilityId: capability.id,
    capabilityVersion: capability.version,
    artifactDigest: capability.digest,
    targetProfileDigest: capability.targetProfileDigest,
    inputs,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(binding));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function preferredScrollBehavior(): ScrollBehavior {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const connected = () => setOnline(true);
    const disconnected = () => setOnline(false);
    window.addEventListener("online", connected);
    window.addEventListener("offline", disconnected);
    return () => {
      window.removeEventListener("online", connected);
      window.removeEventListener("offline", disconnected);
    };
  }, []);
  return online;
}

interface ErrorBoundaryState {
  failed: boolean;
}

interface PendingChatProposalLaunch {
  kind: "proposal";
  messageId: string;
  proposal: ChatProposal;
  inputs: Record<string, JsonValue>;
  profile: "teller" | "supervisor";
  branch: OperatorSession["branch"];
}

interface PendingChatSequenceLaunch {
  kind: "sequence";
  messageId: string;
  sequence: ChatSequencePlan;
  profile: "teller" | "supervisor";
  branch: OperatorSession["branch"];
}

type PendingChatLaunch = PendingChatProposalLaunch | PendingChatSequenceLaunch;

export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <main className="fatal-shell">
          <section className="fatal-card" role="alert">
            <div className="brand-mark" aria-hidden="true"><span>B</span></div>
            <p className="eyebrow">Safe stop</p>
            <h1>The console could not render this view.</h1>
            <p>The interface cannot confirm server state. An existing operation may still continue; reload, then inspect run history before retrying anything.</p>
            <button className="button primary" type="button" onClick={() => window.location.reload()}>
              Reload console
            </button>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}

interface FieldControlProps {
  field: CapabilityField;
  parts: string[];
  values: FlatFormValues;
  counts: ArrayCounts;
  errors: Record<string, string>;
  onValue(path: string, value: string | boolean): void;
  onCount(path: string, count: number): void;
  onRemovePrefix(prefix: string): void;
}

function childField(parent: CapabilityField, name: string, type: FieldType, required: boolean): CapabilityField {
  return {
    name,
    type,
    required,
    description: humanize(name),
    classification: parent.classification,
  };
}

function FieldControl(props: FieldControlProps): ReactNode {
  const { field, parts, values, counts, errors, onValue, onCount, onRemovePrefix } = props;
  const path = fieldPath(parts);
  const id = fieldDomId(path);
  const error = errors[path];
  if (isProtectedField(field) || isProtectedKey(path)) {
    return (
      <div className="managed-field">
        <span aria-hidden="true">◆</span>
        <div><strong>{humanize(field.name)}</strong><p>Resolved securely by the service. This console never requests it.</p></div>
      </div>
    );
  }
  if (field.type.kind === "object") {
    const included = field.required || values[path] === true;
    const includeId = `${id}-include`;
    return (
      <fieldset className="nested-fieldset" id={id} tabIndex={-1} aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`}>
        <legend>{humanize(field.name)}{field.required ? <><span className="visually-hidden"> (required)</span><span className="required-mark" aria-hidden="true"> *</span></> : null}</legend>
        <p className="field-description">{field.description}</p>
        {!field.required ? <label className="optional-group-toggle" htmlFor={includeId}><input id={includeId} type="checkbox" checked={included} onChange={(event) => { if (event.target.checked) onValue(path, true); else onRemovePrefix(path); }} /><span>Include {humanize(field.name)}</span></label> : null}
        {included ? <div className="nested-grid">
          {Object.entries(field.type.properties ?? {}).map(([name, type]) => (
            <FieldControl
              {...props}
              key={name}
              field={childField(field, name, type, field.type.required?.includes(name) ?? false)}
              parts={[...parts, name]}
            />
          ))}
        </div> : null}
        <span className="visually-hidden" id={`${id}-hint`}>{field.description}</span>
        {error ? <p className="field-error" id={`${id}-error`}>{error}</p> : null}
      </fieldset>
    );
  }
  if (field.type.kind === "array") {
    const count = counts[path] ?? (field.required ? 1 : 0);
    const maximum = Math.min(field.type.maxItems ?? 20, 20);
    return (
      <fieldset className="nested-fieldset array-fieldset" id={id} tabIndex={-1} aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`}>
        <legend>{humanize(field.name)}{field.required ? <><span className="visually-hidden"> (required)</span><span className="required-mark" aria-hidden="true"> *</span></> : null}</legend>
        <p className="field-description">{field.description}</p>
        {Array.from({ length: count }, (_, index) => (
          <div className="array-item" key={index}>
            <span className="array-number" aria-hidden="true">{index + 1}</span>
            <FieldControl
              {...props}
              field={childField(field, `Item ${index + 1}`, field.type.items ?? { kind: "string" }, true)}
              parts={[...parts, String(index)]}
            />
          </div>
        ))}
        <div className="array-actions">
          <button className="button quiet small" type="button" disabled={count >= maximum} onClick={() => onCount(path, count + 1)}>Add item</button>
          <button
            className="button quiet small"
            type="button"
            disabled={count === 0 || (field.required && count === 1)}
            onClick={() => {
              onRemovePrefix(fieldPath([...parts, String(count - 1)]));
              onCount(path, count - 1);
            }}
          >Remove last</button>
        </div>
        <span className="visually-hidden" id={`${id}-hint`}>{field.description}</span>
        {error ? <p className="field-error" id={`${id}-error`}>{error}</p> : null}
      </fieldset>
    );
  }

  const describedBy = `${id}-hint${error ? ` ${id}-error` : ""}`;
  if (field.type.kind === "boolean") {
    if (!field.required) {
      return (
        <div className="field">
          <label htmlFor={id}>{humanize(field.name)}</label>
          <select id={id} name={path} value={typeof values[path] === "string" ? values[path] : ""} aria-describedby={`${id}-hint`} onChange={(event) => onValue(path, event.target.value)}>
            <option value="">Use capability default</option>
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
          <small id={`${id}-hint`}>{field.description}</small>
        </div>
      );
    }
    return (
      <div className="field checkbox-field">
        <label htmlFor={id}>
          <input id={id} type="checkbox" checked={values[path] === true} onChange={(event) => onValue(path, event.target.checked)} />
          <span><strong>{humanize(field.name)}</strong><small id={`${id}-hint`}>{field.description}</small></span>
        </label>
        {error ? <p className="field-error" id={`${id}-error`}>{error}</p> : null}
      </div>
    );
  }

  const common = {
    id,
    name: path,
    required: field.required,
    value: typeof values[path] === "string" ? values[path] : "",
    "aria-invalid": Boolean(error),
    "aria-describedby": describedBy,
    autoComplete: "off",
  } as const;
  const label = <label htmlFor={id}>{humanize(field.name)}{field.type.kind === "money" ? <span className="field-unit"> ({field.type.currency ?? "USD"})</span> : null}{field.required ? <span className="required-mark" aria-hidden="true"> *</span> : null}</label>;
  let control: ReactNode;
  if (field.type.enum?.length) {
    control = (
      <select {...common} onChange={(event) => onValue(path, event.target.value)}>
        <option value="">Choose an option</option>
        {field.type.enum.map((option) => <option key={String(option)} value={String(option)}>{String(option)}</option>)}
      </select>
    );
  } else if (field.type.kind === "money") {
    control = (
      <div className="money-input">
        <span aria-hidden="true">{field.type.currency === "USD" || !field.type.currency ? "$" : field.type.currency}</span>
        <input {...common} type="text" inputMode="decimal" placeholder="0.00" onChange={(event) => onValue(path, event.target.value)} />
      </div>
    );
  } else {
    const inputType = field.type.kind === "number" ? "number" : field.type.format === "email" ? "email" : field.type.format === "phone" ? "tel" : "text";
    control = (
      <input
        {...common}
        type={inputType}
        inputMode={field.type.kind === "number" ? "decimal" : undefined}
        min={field.type.minimum}
        max={field.type.maximum}
        step={field.type.integer ? 1 : undefined}
        minLength={field.type.minLength}
        maxLength={field.type.maxLength}
        onChange={(event) => onValue(path, event.target.value)}
      />
    );
  }
  return (
    <div className="field">
      {label}{control}
      <small id={`${id}-hint`}>{field.description}</small>
      {error ? <p className="field-error" id={`${id}-error`}>{error}</p> : null}
    </div>
  );
}

function CapabilityCatalog({
  capabilities,
  selectedKey,
  loading,
  error,
  onSelect,
  onRetry,
}: {
  capabilities: Capability[];
  selectedKey: string;
  loading: boolean;
  error: string;
  onSelect(capability: Capability): void;
  onRetry(): void;
}): ReactNode {
  const [query, setQuery] = useState("");
  const [risk, setRisk] = useState<"all" | RiskLevel>("all");
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return capabilities.filter((capability) => {
      const matchesRisk = risk === "all" || capability.risk === risk;
      const matchesText = !needle || `${capability.name} ${capability.id} ${capability.description}`.toLocaleLowerCase().includes(needle);
      return matchesRisk && matchesText;
    });
  }, [capabilities, query, risk]);

  return (
    <section className="panel catalog-panel" aria-labelledby="catalog-title">
      <div className="panel-heading">
        <div><p className="eyebrow">Approved catalog</p><h2 id="catalog-title">Capabilities</h2></div>
        <span className="count-badge">{capabilities.length}</span>
      </div>
      <div className="catalog-tools">
        <label className="search-box">
          <span className="visually-hidden">Search capabilities</span>
          <span aria-hidden="true">⌕</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} type="search" placeholder="Search capabilities" />
        </label>
        <label className="visually-hidden" htmlFor="risk-filter">Filter by risk</label>
        <select id="risk-filter" value={risk} onChange={(event) => setRisk(event.target.value as "all" | RiskLevel)}>
          <option value="all">All risk levels</option>
          <option value="read">Read only</option>
          <option value="write">Writes data</option>
          <option value="irreversible">Confirmation required</option>
          <option value="supervisor_only">Supervisor only</option>
        </select>
      </div>
      <div className="capability-list">
        {loading ? <LoadingRows count={5} /> : null}
        {!loading && error ? (
          <Alert title="Catalog unavailable" action={<button className="button quiet small" type="button" onClick={onRetry}>Try again</button>}>{error}</Alert>
        ) : null}
        {!loading && !error && filtered.length === 0 ? (
          <EmptyState icon="◇" title={capabilities.length ? "No matching capabilities" : "No approved capabilities"} detail={capabilities.length ? "Adjust your search or risk filter." : "Approved catalog entries will appear here."} />
        ) : null}
        {filtered.map((capability) => {
          const selected = capabilityKey(capability) === selectedKey;
          return (
            <button
              className={`capability-card${selected ? " selected" : ""}`}
              type="button"
              key={capabilityKey(capability)}
              onClick={() => onSelect(capability)}
              aria-pressed={selected}
            >
              <span className={`risk-dot risk-dot-${capability.risk}`} aria-hidden="true" />
              <span className="capability-main"><strong>{capability.name}</strong><small>{capability.description}</small></span>
              <span className="capability-meta"><span>v{capability.version}</span><span>{capability.inputs.length} inputs</span><span className={`capability-risk risk-text-${capability.risk}`}>{RISK_LABELS[capability.risk]}</span></span>
              <span className="card-arrow" aria-hidden="true">›</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function GuidedRunForm({
  capability,
  values,
  counts,
  online,
  sessionReady,
  riskAuthorized,
  submitting,
  onValues,
  onCounts,
  onSubmit,
}: {
  capability: Capability | undefined;
  values: FlatFormValues;
  counts: ArrayCounts;
  online: boolean;
  sessionReady: boolean;
  riskAuthorized: boolean;
  submitting: boolean;
  onValues(next: FlatFormValues): void;
  onCounts(next: ArrayCounts): void;
  onSubmit(inputs: Record<string, JsonValue>): void;
}): ReactNode {
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => setErrors({}), [capability]);
  if (!capability) {
    return (
      <section id="guided-operation-panel" className="panel run-form-panel" tabIndex={-1} aria-label="Guided operation"><EmptyState icon="↗" title="Choose a capability" detail="Select an approved operation to see its guided inputs and safety boundary." /></section>
    );
  }
  const runnable = isRunnable(capability);
  const protectedCount = capability.inputs.filter(isProtectedField).length;
  const update = (path: string, value: string | boolean) => {
    onValues({ ...values, [path]: value });
    setErrors((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== path && !path.startsWith(`${key}/`))));
  };
  const removePrefix = (prefix: string) => {
    onValues(Object.fromEntries(Object.entries(values).filter(([key]) => key !== prefix && !key.startsWith(`${prefix}/`))));
    setErrors((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== prefix && !key.startsWith(`${prefix}/`))));
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!runnable || !sessionReady || !riskAuthorized || submitting) return;
    const result = serializeInputs(capability, values, counts);
    setErrors(result.errors);
    const first = Object.keys(result.errors)[0];
    if (first) {
      document.getElementById(fieldDomId(first))?.focus();
      return;
    }
    onSubmit(result.inputs);
  };
  const managedAuthentication = !runnable && /sign[._-]?on|login|auth/iu.test(capability.id);
  return (
    <section id="guided-operation-panel" className="panel run-form-panel" tabIndex={-1} aria-labelledby="run-form-title">
      <div className="operation-heading">
        <div className="operation-title">
          <p className="eyebrow">Guided operation</p>
          <h2 id="run-form-title">{capability.name}</h2>
          <p>{capability.description}</p>
        </div>
        <RiskBadge risk={capability.risk} />
      </div>
      <dl className="contract-strip">
        <div><dt>Version</dt><dd>{capability.version}</dd></div>
        <div><dt>Contract</dt><dd>Schema {capability.schemaVersion}</dd></div>
        <div><dt>Digest</dt><dd title={capability.digest}>{capability.digest ? shortId(capability.digest) : "Verified at server"}</dd></div>
      </dl>
      {capability.lineage ? (
        <section className="lineage-panel" aria-label="Approved discovery lineage">
          <div><p className="eyebrow">Approved discovery lineage</p><strong title={capability.lineage.lineageId}>{capability.lineage.lineageId}</strong></div>
          <ol>
            <li><span>Discovery</span><code title={capability.lineage.discoveryRunId}>{shortId(capability.lineage.discoveryRunId)}</code><small title={`${capability.lineage.provider} · ${capability.lineage.model} · trace ${capability.lineage.traceDigest}`}>{capability.lineage.model} · trace {shortId(capability.lineage.traceDigest)}</small></li>
            <li><span>Draft</span><code title={capability.lineage.draftDigest}>{shortId(capability.lineage.draftDigest)}</code></li>
            <li><span>Reviewed</span><code title={capability.lineage.reviewedDigest}>{shortId(capability.lineage.reviewedDigest)}</code></li>
            <li><span>Canary passed</span><code title={capability.lineage.canaryRunId}>{shortId(capability.lineage.canaryRunId)}</code></li>
            <li><span>Approved</span><code title={capability.lineage.approvedDigest}>{shortId(capability.lineage.approvedDigest)}</code></li>
          </ol>
        </section>
      ) : capability.approval === "approved" ? (
        <Alert tone="warning" title="Discovery lineage unavailable">This approved entry has no complete discovery, review, canary, and publication projection. It remains visible for diagnosis but cannot establish reviewer-facing lineage.</Alert>
      ) : null}
      {managedAuthentication ? (
        <Alert tone="info" title="Authentication is service-managed">This capability is cataloged for auditability, but sign-in credentials are resolved outside this user interface.</Alert>
      ) : null}
      {capability.approval !== "approved" ? (
        <Alert tone="warning" title="Capability is not approved">Draft and retired contracts cannot be launched from the console.</Alert>
      ) : null}
      {runnable && !sessionReady ? (
        <Alert tone="info" title="Secure target session required">Connect the server-managed operator session above before starting this capability. No target-system credential is entered in this console.</Alert>
      ) : null}
      {runnable && sessionReady && !riskAuthorized ? (
        <Alert tone="warning" title="Supervisor session required">Sign out, authenticate as a supervisor, establish a supervisor MERIDIAN session, then start this operation from the beginning. The console cannot switch identity during a run.</Alert>
      ) : null}
      <form className="guided-form" onSubmit={submit} noValidate>
        {capability.inputs.length === 0 ? <p className="no-inputs"><span aria-hidden="true">✓</span> No user input is required for this operation.</p> : null}
        {capability.inputs.map((field) => (
          <FieldControl
            key={field.name}
            field={field}
            parts={[field.name]}
            values={values}
            counts={counts}
            errors={errors}
            onValue={update}
            onCount={(path, count) => onCounts({ ...counts, [path]: count })}
            onRemovePrefix={removePrefix}
          />
        ))}
        {protectedCount > 0 ? <p className="privacy-note"><span aria-hidden="true">◆</span>{protectedCount} protected {protectedCount === 1 ? "value is" : "values are"} supplied securely by the service and never collected here.</p> : null}
        <div className="form-footer">
          <div><strong>Ready for guarded replay</strong><span>{capability.risk === "read" ? "This run will not change target data." : "Any irreversible step pauses for explicit review."}</span></div>
          <button className="button primary launch-button" type="submit" disabled={!runnable || !sessionReady || !riskAuthorized || !online || submitting}>
            {submitting ? <><span className="spinner" aria-hidden="true" />Starting…</> : <>Start run <span aria-hidden="true">→</span></>}
          </button>
        </div>
      </form>
    </section>
  );
}

function RunHistory({ runs, capabilities, activeId, loading, error, onSelect, onRetry }: { runs: RunRecord[]; capabilities: Capability[]; activeId: string; loading: boolean; error: string; onSelect(run: RunRecord): void; onRetry(): void }): ReactNode {
  const name = (run: RunRecord) => capabilities.find((item) => item.id === run.capabilityId && (!run.capabilityVersion || item.version === run.capabilityVersion))?.name ?? humanize(run.capabilityId);
  return (
    <section className="panel history-panel" aria-labelledby="history-title">
      <div className="panel-heading"><div><p className="eyebrow">Operational record</p><h2 id="history-title">Run history</h2></div><button className="button quiet small" type="button" onClick={onRetry}>Refresh</button></div>
      {loading ? <LoadingRows count={6} /> : null}
      {!loading && error ? <Alert title="Run history unavailable">{error}</Alert> : null}
      {!loading && !error && runs.length === 0 ? <EmptyState icon="◷" title="No runs yet" detail="Runs appear here as soon as an approved capability is started." /> : null}
      <div className="history-list">
        {runs.map((run) => <button key={run.id} type="button" aria-pressed={activeId === run.id} className={`history-row${activeId === run.id ? " selected" : ""}`} onClick={() => onSelect(run)}><span className={`status-orb status-${run.terminalStatus ?? run.phase}`} aria-hidden="true" /><span className="history-name"><strong>{name(run)}</strong><small>{shortId(run.id)} · {formatDate(runTimestamp(run))}</small></span><span className="history-state" aria-hidden="true">{humanize(run.terminalStatus ?? run.phase)}</span><span className="visually-hidden">Status: {humanize(run.terminalStatus ?? run.phase)}.</span><span aria-hidden="true">›</span></button>)}
      </div>
    </section>
  );
}

function AuthGate({ loading, error, online, onLogin }: { loading: boolean; error: string; online: boolean; onLogin(accessCode: string): void }): ReactNode {
  const accessCodeRef = useRef<HTMLInputElement>(null);
  return (
    <main className="auth-shell">
      <section className="auth-card" aria-labelledby="auth-title">
        <Brand />
        <p className="eyebrow">Operator console</p>
        <h1 id="auth-title">Sign in to Bridge Console</h1>
        <p>Use your console access code. It is sent only to this same-origin service, is cleared immediately, and is never stored in browser storage.</p>
        {!online ? <Alert tone="warning" title="Browser offline">Reconnect before entering your access code.</Alert> : null}
        {error ? <Alert title="Sign-in failed">{error}</Alert> : null}
        <form onSubmit={(event) => {
          event.preventDefault();
          if (!online) return;
          const input = accessCodeRef.current;
          const code = input?.value ?? "";
          if (input) input.value = "";
          if (code) onLogin(code);
        }}>
          <label htmlFor="console-access-code">Console access code</label>
          <input ref={accessCodeRef} id="console-access-code" name="access-code" type="password" required autoComplete="current-password" spellCheck={false} disabled={loading || !online} />
          <button className="button primary" type="submit" disabled={loading || !online}>{loading ? <><span className="spinner" aria-hidden="true" />Signing in…</> : "Sign in securely"}</button>
        </form>
        <small>Target-system usernames, passwords, tokens, and PINs must never be entered here.</small>
      </section>
    </main>
  );
}

export default function App(): ReactNode {
  const online = useOnline();
  const [principal, setPrincipal] = useState<ConsolePrincipal | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [authBusy, setAuthBusy] = useState(true);
  const [authError, setAuthError] = useState("");
  const [operatorSession, setOperatorSession] = useState<OperatorSession | null>(null);
  const [sessionProfile, setSessionProfile] = useState<"teller" | "supervisor">("teller");
  const [sessionBranch, setSessionBranch] = useState<OperatorSession["branch"]>("MAIN-001");
  const [sessionConnecting, setSessionConnecting] = useState(false);
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [discoveryRuns, setDiscoveryRuns] = useState<DiscoveryRunRecord[]>([]);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [selectedKey, setSelectedKey] = useState("");
  const [activeRunId, setActiveRunId] = useState("");
  const [activeDiscoveryRunId, setActiveDiscoveryRunId] = useState("");
  const [view, setView] = useState<"workspace" | "runs">("workspace");
  const [historyKind, setHistoryKind] = useState<"replay" | "discovery">("replay");
  const [side, setSide] = useState<"activity" | "assistant">("activity");
  const [values, setValues] = useState<FlatFormValues>({});
  const [counts, setCounts] = useState<ArrayCounts>({});
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [runsLoading, setRunsLoading] = useState(true);
  const [discoveryRunsLoading, setDiscoveryRunsLoading] = useState(true);
  const [discoveryRunLoading, setDiscoveryRunLoading] = useState(false);
  const [runLoading, setRunLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [approving, setApproving] = useState(false);
  const [cancellingRunId, setCancellingRunId] = useState("");
  const [approvalLatch, setApprovalLatch] = useState<ApprovalLatch | null>(null);
  const [catalogError, setCatalogError] = useState("");
  const [runsError, setRunsError] = useState("");
  const [discoveryRunsError, setDiscoveryRunsError] = useState("");
  const [actionError, setActionError] = useState<{ title: string; message: string; code: string } | null>(null);
  const [lastUpdated, setLastUpdated] = useState("");
  const [toast, setToast] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatDraft, setChatDraft] = useState("");
  const [chatSending, setChatSending] = useState(false);
  const [chatAutomationBusy, setChatAutomationBusy] = useState(false);
  const [chatError, setChatError] = useState("");
  const [pendingChatLaunch, setPendingChatLaunch] = useState<PendingChatLaunch | null>(null);
  const pendingRunRequests = useRef<Map<string, string>>(new Map());
  const sessionBootstrapInFlight = useRef(false);
  const launchInFlight = useRef(false);
  const chatAutomationInFlight = useRef(false);
  const chatApprovalAttempts = useRef<Set<string>>(new Set());
  const sequenceAdvanceInFlight = useRef<Set<string>>(new Set());
  const chatRequestLatch = useRef(new AbortableRequestLatch());
  const cancellingRunRef = useRef("");
  const authGeneration = useRef(0);
  const runMutationEpoch = useRef(0);
  const runListRequest = useRef(0);
  const runDetailRequest = useRef(0);
  const discoveryListRequest = useRef(0);
  const discoveryDetailRequest = useRef(0);
  const reconciledTerminalRuns = useRef<Set<string>>(new Set());
  const sidePanelRef = useRef<HTMLDivElement>(null);
  const historyDetailRef = useRef<HTMLDivElement>(null);
  const topbarRef = useRef<HTMLElement>(null);

  const selectedCapability = capabilities.find((item) => capabilityKey(item) === selectedKey);
  const activeRun = runs.find((run) => run.id === activeRunId);
  const activeDiscoveryRun = discoveryRuns.find((run) => run.id === activeDiscoveryRunId);
  const activeDiscoveryCapability = activeDiscoveryRun
    ? capabilities.find((capability) => capability.id === activeDiscoveryRun.capabilityId && capability.version === activeDiscoveryRun.capabilityVersion)
    : undefined;
  const activeCapability = activeRun
    ? capabilities.find((item) =>
        item.contractValid &&
        item.id === activeRun.capabilityId &&
        item.version === activeRun.capabilityVersion &&
        item.digest === activeRun.artifactDigest &&
        item.targetProfileDigest === activeRun.targetProfileDigest,
      )
    : undefined;
  const sessionReady = operatorSession?.status === "active" && !sessionConnecting;
  const signOutBlocked = runs.some((run) => run.phase === "running" || run.phase === "recovering");
  const revealRegion = (element: HTMLElement): void => {
    const bounds = element.getBoundingClientRect();
    const headerBottom = topbarRef.current?.getBoundingClientRect().bottom ?? 0;
    if (bounds.top < headerBottom + 12 || bounds.bottom > window.innerHeight) {
      window.scrollTo({
        top: Math.max(0, window.scrollY + bounds.top - headerBottom - 12),
        behavior: preferredScrollBehavior(),
      });
    }
    element.focus({ preventScroll: true });
  };

  const clearOperatorData = useCallback(() => {
    authGeneration.current += 1;
    chatRequestLatch.current.reset("auth_transition");
    cancellingRunRef.current = "";
    setOperatorSession(null);
    setRuns([]);
    setDiscoveryRuns([]);
    setCapabilities([]);
    setActiveRunId("");
    setActiveDiscoveryRunId("");
    setSelectedKey("");
    setValues({});
    setCounts({});
    setMessages([]);
    setChatDraft("");
    setChatError("");
    setChatSending(false);
    setChatAutomationBusy(false);
    setPendingChatLaunch(null);
    setApprovalLatch(null);
    setActionError(null);
    setDiscoveryRunsError("");
    setToast("");
    setLastUpdated("");
    setCatalogLoading(false);
    setRunsLoading(false);
    setDiscoveryRunsLoading(false);
    setDiscoveryRunLoading(false);
    setRunLoading(false);
    setSubmitting(false);
    setApproving(false);
    setCancellingRunId("");
    setSessionConnecting(false);
    setAuthBusy(false);
    setAuthError("");
    setView("workspace");
    setHistoryKind("replay");
    setSide("activity");
    pendingRunRequests.current.clear();
    sessionBootstrapInFlight.current = false;
    launchInFlight.current = false;
    chatAutomationInFlight.current = false;
    chatApprovalAttempts.current.clear();
    sequenceAdvanceInFlight.current.clear();
    runMutationEpoch.current += 1;
    runListRequest.current += 1;
    runDetailRequest.current += 1;
    discoveryListRequest.current += 1;
    discoveryDetailRequest.current += 1;
    reconciledTerminalRuns.current.clear();
  }, []);

  const expireConsole = useCallback(() => {
    clearOperatorData();
    setPrincipal(null);
    setAuthError("Your console session expired. Sign in again to continue.");
    broadcastAuthChange("expired");
  }, [clearOperatorData]);

  const reconcileTargetSession = useCallback(async () => {
    if (!principal) return false;
    const generation = authGeneration.current;
    try {
      const current = await getAuthState();
      if (generation !== authGeneration.current) return false;
      if (!current) {
        expireConsole();
        return true;
      }
      if (current.principal.id !== principal.id || current.principal.role !== principal.role) {
        clearOperatorData();
        setPrincipal(current.principal);
        if (current.meridianSession) {
          setOperatorSession({
            profile: current.meridianSession.profile ?? "teller",
            branch: current.meridianSession.branch ?? "MAIN-001",
            status: current.meridianSession.status,
          });
        }
        return true;
      }
      if (current.principal.displayName !== principal.displayName) setPrincipal(current.principal);
      if (!current.meridianSession) {
        setOperatorSession(null);
        return true;
      }
      setOperatorSession((session) => session?.runId && session.status === "provisioning"
        ? {
            ...session,
            profile: current.meridianSession!.profile ?? session.profile,
            branch: current.meridianSession!.branch ?? session.branch,
            status: current.meridianSession!.status,
          }
        : {
            profile: current.meridianSession!.profile ?? session?.profile ?? "teller",
            branch: current.meridianSession!.branch ?? session?.branch ?? "MAIN-001",
            status: current.meridianSession!.status,
          });
      return true;
    } catch (error) {
      if (generation === authGeneration.current && error instanceof ApiError && error.status === 401) {
        expireConsole();
        return true;
      }
      // A transient reconciliation failure never fabricates session state. The
      // next protected action remains server-authoritative and fail-closed.
      return false;
    }
  }, [principal, clearOperatorData, expireConsole]);

  const loadCatalog = useCallback(async (signal?: AbortSignal) => {
    const generation = authGeneration.current;
    setCatalogLoading(true);
    setCatalogError("");
    try {
      const result = await getCapabilities(signal);
      if (generation !== authGeneration.current) return;
      setCapabilities(result);
      setSelectedKey((current) => current && result.some((item) => capabilityKey(item) === current) ? current : result.find(isRunnable) ? capabilityKey(result.find(isRunnable)!) : result[0] ? capabilityKey(result[0]) : "");
      setLastUpdated(new Date().toISOString());
    } catch (error) {
      if (signal?.aborted) return;
      if (generation !== authGeneration.current) return;
      if (error instanceof ApiError && error.status === 401) {
        broadcastAuthChange("expired");
        clearOperatorData();
        setPrincipal(null);
        return;
      }
      setCatalogError(errorMessage(error));
    } finally {
      if (!signal?.aborted) setCatalogLoading(false);
    }
  }, [clearOperatorData]);

  const loadDiscoveryRuns = useCallback(async (signal?: AbortSignal) => {
    const generation = authGeneration.current;
    const requestSequence = ++discoveryListRequest.current;
    setDiscoveryRunsLoading(true);
    setDiscoveryRunsError("");
    try {
      const result = await getDiscoveryRuns(signal);
      if (generation !== authGeneration.current || requestSequence !== discoveryListRequest.current) return;
      setDiscoveryRuns(result);
      setActiveDiscoveryRunId((current) => current && result.some((run) => run.id === current) ? current : result[0]?.id ?? "");
      setLastUpdated(new Date().toISOString());
    } catch (error) {
      if (signal?.aborted || generation !== authGeneration.current) return;
      if (error instanceof ApiError && error.status === 401) {
        broadcastAuthChange("expired");
        clearOperatorData();
        setPrincipal(null);
        return;
      }
      setDiscoveryRunsError(errorMessage(error));
    } finally {
      if (!signal?.aborted && requestSequence === discoveryListRequest.current) setDiscoveryRunsLoading(false);
    }
  }, [clearOperatorData]);

  const loadDiscoveryRun = useCallback(async (id: string) => {
    if (!id) return;
    const generation = authGeneration.current;
    const requestSequence = ++discoveryDetailRequest.current;
    setDiscoveryRunLoading(true);
    try {
      const run = await getDiscoveryRun(id);
      if (generation !== authGeneration.current || requestSequence !== discoveryDetailRequest.current) return;
      setDiscoveryRuns((current) => current.some((item) => item.id === run.id)
        ? current.map((item) => item.id === run.id ? run : item)
        : [...current, run]);
      setLastUpdated(new Date().toISOString());
    } catch (error) {
      if (generation !== authGeneration.current || requestSequence !== discoveryDetailRequest.current) return;
      if (error instanceof ApiError && error.status === 401) {
        broadcastAuthChange("expired");
        clearOperatorData();
        setPrincipal(null);
        return;
      }
      setActionError({ title: "Discovery details unavailable", message: errorMessage(error), code: errorCode(error) });
    } finally {
      if (requestSequence === discoveryDetailRequest.current) setDiscoveryRunLoading(false);
    }
  }, [clearOperatorData]);

  const loadRuns = useCallback(async (signal?: AbortSignal, silent = false) => {
    const generation = authGeneration.current;
    const mutationEpoch = runMutationEpoch.current;
    const requestSequence = ++runListRequest.current;
    if (!silent) {
      setRunsLoading(true);
      setRunsError("");
    }
    try {
      const result = await getRuns(signal);
      if (generation !== authGeneration.current || requestSequence !== runListRequest.current) return;
      const mayRemoveMissing = mutationEpoch === runMutationEpoch.current;
      setRuns((current) => mayRemoveMissing
        ? reconcileRuns(current, result)
        : result.reduce<RunRecord[]>((next, run) => mergeRuns(next, run), current));
      if (mayRemoveMissing) {
        setActiveRunId((current) => nextRunSelection(current, result));
      }
      setRunsError("");
      setLastUpdated(new Date().toISOString());
    } catch (error) {
      if (signal?.aborted) return;
      if (generation !== authGeneration.current) return;
      if (error instanceof ApiError && error.status === 401) {
        broadcastAuthChange("expired");
        clearOperatorData();
        setPrincipal(null);
        return;
      }
      if (!silent) setRunsError(errorMessage(error));
    } finally {
      if (!signal?.aborted && requestSequence === runListRequest.current) setRunsLoading(false);
    }
  }, [clearOperatorData]);

  const forgetUnavailableRun = useCallback((id: string) => {
    runDetailRequest.current += 1;
    setRunLoading(false);
    setRuns((current) => withoutRun(current, id));
    setActiveRunId((current) => current === id ? "" : current);
    setApprovalLatch((current) => current?.runId === id ? null : current);
    setOperatorSession((current) => current?.runId === id
      ? { ...current, status: "failed", message: "The retained sign-on run is no longer available. Reconnect the target session." }
      : current);
  }, []);

  const invalidateUnavailableRun = useCallback((id: string) => {
    forgetUnavailableRun(id);
    setToast("That run is no longer retained for this console identity. Run history was refreshed.");
    void loadRuns(undefined, true);
  }, [forgetUnavailableRun, loadRuns]);

  const loadRun = useCallback(async (id: string, showLoading = false) => {
    if (!id) return;
    const generation = authGeneration.current;
    const requestSequence = ++runDetailRequest.current;
    if (showLoading) setRunLoading(true);
    try {
      const run = await getRun(id);
      if (generation !== authGeneration.current || requestSequence !== runDetailRequest.current) return;
      setRuns((current) => mergeRuns(current, run));
      setLastUpdated(new Date().toISOString());
    } catch (error) {
      if (generation !== authGeneration.current || requestSequence !== runDetailRequest.current) return;
      if (error instanceof ApiError && error.status === 401) {
        broadcastAuthChange("expired");
        clearOperatorData();
        setPrincipal(null);
        return;
      }
      if (error instanceof ApiError && error.status === 404 && error.code === "RUN_NOT_FOUND") {
        invalidateUnavailableRun(id);
        return;
      }
      setActionError({ title: "Run details unavailable", message: errorMessage(error), code: errorCode(error) });
    } finally {
      if (showLoading && requestSequence === runDetailRequest.current) setRunLoading(false);
    }
  }, [clearOperatorData, invalidateUnavailableRun]);

  const acceptStreamSnapshot = useCallback((run: RunRecord): void => {
    setRuns((current) => mergeRuns(current, run));
    setLastUpdated(new Date().toISOString());
  }, []);
  const refreshStreamRun = useCallback((runId: string): void => {
    void loadRun(runId);
  }, [loadRun]);
  const { connection, liveEvents } = useRunStream({
    activeRunId,
    activeRun,
    online,
    authGeneration: authGeneration.current,
    onSnapshot: acceptStreamSnapshot,
    onRefresh: refreshStreamRun,
    onUnauthorized: expireConsole,
  });
  const acceptSessionRun = useCallback((run: RunRecord): void => {
    setRuns((current) => mergeRuns(current, run));
  }, []);
  const showSessionToast = useCallback((message: string): void => setToast(message), []);
  useTargetSessionObserver({
    session: operatorSession,
    setSession: setOperatorSession,
    online,
    authGeneration: authGeneration.current,
    onRun: acceptSessionRun,
    onUnauthorized: expireConsole,
    onToast: showSessionToast,
  });

  const acceptHandoffRun = useCallback((run: RunRecord): void => {
    runMutationEpoch.current += 1;
    setRuns((current) => mergeRuns(current, run));
    setActiveRunId(run.id);
    setSide("activity");
  }, []);
  const humanHandoff = useHumanHandoff({
    run: activeRun,
    authEpoch: authGeneration.current,
    onRun: acceptHandoffRun,
    onUnauthorized: expireConsole,
  });
  const acceptReconciliationRun = useCallback((run: RunRecord, focus: boolean): void => {
    runMutationEpoch.current += 1;
    setRuns((current) => mergeRuns(current, run));
    if (focus) {
      setActiveRunId(run.id);
      setSide("activity");
    }
  }, []);

  useEffect(() => {
    if (localConsoleLocked()) {
      setAuthError("This console was locked after inactivity. Enter your access code to unlock it.");
      setAuthChecked(true);
      setAuthBusy(false);
      return;
    }
    const controller = new AbortController();
    const generation = authGeneration.current;
    setAuthBusy(true);
    void getAuthState(controller.signal)
      .then((current) => {
        if (generation !== authGeneration.current) return;
        setPrincipal(current?.principal ?? null);
        if (!current) {
          clearOperatorData();
          return;
        }
        if (current?.meridianSession) {
          setOperatorSession({
            profile: current.meridianSession.profile ?? "teller",
            branch: current.meridianSession.branch ?? "MAIN-001",
            status: current.meridianSession.status,
          });
          if (current.meridianSession.profile) setSessionProfile(current.meridianSession.profile);
          if (current.meridianSession.branch) setSessionBranch(current.meridianSession.branch);
        }
      })
      .catch((error) => {
        if (generation === authGeneration.current) setAuthError(errorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setAuthChecked(true);
          setAuthBusy(false);
        }
      });
    return () => controller.abort();
  }, [clearOperatorData]);

  useEffect(() => {
    const lockFromAnotherTab = (event: StorageEvent) => {
      if (event.newValue === null || (event.key !== LOCAL_LOCK_KEY && event.key !== AUTH_EVENT_KEY)) return;
      try { window.sessionStorage.setItem(TAB_LOCK_KEY, new Date().toISOString()); } catch { /* best effort */ }
      clearOperatorData();
      setPrincipal(null);
      setAuthError(event.key === LOCAL_LOCK_KEY
        ? "This console was locked after inactivity in another tab. Enter your access code to unlock it."
        : "Console authentication changed in another tab. Enter your access code before continuing here.");
    };
    window.addEventListener("storage", lockFromAnotherTab);
    return () => window.removeEventListener("storage", lockFromAnotherTab);
  }, [clearOperatorData]);

  useEffect(() => {
    if (!principal) {
      setCatalogLoading(false);
      setRunsLoading(false);
      setDiscoveryRunsLoading(false);
      return;
    }
    const controller = new AbortController();
    void loadCatalog(controller.signal);
    void loadRuns(controller.signal);
    void loadDiscoveryRuns(controller.signal);
    return () => controller.abort();
  }, [principal, loadCatalog, loadRuns, loadDiscoveryRuns]);

  useEffect(() => {
    if (!principal || !online) return;
    let stopped = false;
    let refreshing = false;
    let refreshController: AbortController | null = null;
    const refresh = async () => {
      if (stopped || refreshing || document.visibilityState === "hidden") return;
      refreshing = true;
      const controller = new AbortController();
      refreshController = controller;
      try {
        await loadRuns(controller.signal, true);
      } finally {
        if (refreshController === controller) refreshController = null;
        refreshing = false;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const timer = window.setInterval(() => void refresh(), 15_000);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      refreshController?.abort("lifecycle_reset");
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [principal, online, loadRuns]);

  useEffect(() => {
    if (!principal) return;
    let requiresReconciliation = false;
    const pendingRunIds: string[] = [];
    for (const run of runs) {
      if (
        run.phase !== "completed" ||
        run.capabilityId === "session.sign_on" ||
        run.terminalStatus === "success" ||
        run.terminalStatus === "business_outcome" ||
        reconciledTerminalRuns.current.has(run.id)
      ) continue;
      reconciledTerminalRuns.current.add(run.id);
      pendingRunIds.push(run.id);
      requiresReconciliation = true;
    }
    if (requiresReconciliation) {
      void reconcileTargetSession().then((reconciled) => {
        if (!reconciled) pendingRunIds.forEach((id) => reconciledTerminalRuns.current.delete(id));
      });
    }
  }, [principal, runs, reconcileTargetSession]);

  useEffect(() => {
    if (!principal) return;
    let checking = false;
    const revalidate = async () => {
      if (checking || document.visibilityState === "hidden") return;
      checking = true;
      const generation = authGeneration.current;
      try {
        const current = await getAuthState();
        if (generation !== authGeneration.current) return;
        if (!current) {
          broadcastAuthChange("expired");
          clearOperatorData();
          setPrincipal(null);
          return;
        }
        if (current.principal.id !== principal.id || current.principal.role !== principal.role) {
          clearOperatorData();
          setPrincipal(current.principal);
          if (current.meridianSession) {
            setOperatorSession({
              profile: current.meridianSession.profile ?? "teller",
              branch: current.meridianSession.branch ?? "MAIN-001",
              status: current.meridianSession.status,
            });
          }
          return;
        }
        if (current.principal.displayName !== principal.displayName) setPrincipal(current.principal);
        if (current.meridianSession) {
          setOperatorSession((session) => session?.runId && session.status === "provisioning"
            ? session
            : {
                profile: current.meridianSession!.profile ?? session?.profile ?? "teller",
                branch: current.meridianSession!.branch ?? session?.branch ?? "MAIN-001",
                status: current.meridianSession!.status,
              });
        } else {
          setOperatorSession(null);
        }
      } catch {
        // A transient revalidation failure does not erase locally visible state;
        // the next protected request still fails closed on 401.
      } finally {
        checking = false;
      }
    };
    window.addEventListener("focus", revalidate);
    document.addEventListener("visibilitychange", revalidate);
    return () => {
      window.removeEventListener("focus", revalidate);
      document.removeEventListener("visibilitychange", revalidate);
    };
  }, [principal, clearOperatorData]);

  useEffect(() => {
    if (!principal) return;
    let timer = 0;
    let validating = false;
    let lastValidatedAt = Date.now();
    const expireLocalView = () => {
      setLocalConsoleLock(true);
      clearOperatorData();
      setPrincipal(null);
      setAuthError("The console locked after 30 minutes without operator activity. Sign in again to continue.");
      void logout().catch(() => undefined);
    };
    const validateServerSession = async () => {
      if (validating) return;
      validating = true;
      const generation = authGeneration.current;
      try {
        const current = await getAuthState(undefined, true);
        if (generation !== authGeneration.current) return;
        if (!current) {
          expireConsole();
          return;
        }
        if (current.principal.id !== principal.id || current.principal.role !== principal.role) {
          clearOperatorData();
          setPrincipal(current.principal);
          if (current.meridianSession?.profile && current.meridianSession.branch) {
            setOperatorSession({
              profile: current.meridianSession.profile,
              branch: current.meridianSession.branch,
              status: current.meridianSession.status,
            });
          }
        }
      } catch (error) {
        if (generation === authGeneration.current && error instanceof ApiError && error.status === 401) expireConsole();
      } finally {
        lastValidatedAt = Date.now();
        validating = false;
      }
    };
    const reset = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(expireLocalView, 30 * 60_000);
      if (Date.now() - lastValidatedAt >= 5 * 60_000) void validateServerSession();
    };
    reset();
    window.addEventListener("pointerdown", reset, { passive: true });
    window.addEventListener("keydown", reset);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointerdown", reset);
      window.removeEventListener("keydown", reset);
    };
  }, [principal, clearOperatorData, expireConsole]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 4_500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!approvalLatch || !online) return;
    let stopped = false;
    let polling = false;
    const generation = authGeneration.current;
    const check = async () => {
      if (polling) return;
      polling = true;
      try {
        const run = await getRun(approvalLatch.runId);
        if (stopped || generation !== authGeneration.current) return;
        setRuns((current) => mergeRuns(current, run));
        if (!run.challenge || run.challenge.challengeId !== approvalLatch.challengeId) {
          setApprovalLatch(null);
          setToast("Approval state reconciled from the bound run snapshot.");
        }
      } catch (error) {
        if (stopped || generation !== authGeneration.current || !(error instanceof ApiError)) return;
        if (error.status === 401) {
          expireConsole();
        } else if (isRetainedRunUnavailable(error)) {
          invalidateUnavailableRun(approvalLatch.runId);
        }
      } finally {
        polling = false;
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), 2_500);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [approvalLatch, online, expireConsole, invalidateUnavailableRun]);

  const chooseCapability = (capability: Capability) => {
    if (capabilityKey(capability) === selectedKey) return;
    setSelectedKey(capabilityKey(capability));
    setValues({});
    setCounts({});
    setView("workspace");
  };

  const authenticate = async (accessCode: string) => {
    if (authBusy || !online) return;
    clearOperatorData();
    const generation = authGeneration.current;
    setAuthBusy(true);
    setAuthError("");
    try {
      const authenticated = await login(accessCode);
      if (generation !== authGeneration.current) return;
      const current = await getAuthState();
      if (generation !== authGeneration.current) return;
      if (!current) throw new ApiError(401, "AUTH_REQUIRED", "The new console session could not be verified.");
      setLocalConsoleLock(false);
      broadcastAuthChange("login");
      setPrincipal(current.principal ?? authenticated);
      setSessionProfile(current.principal.role === "supervisor" ? "supervisor" : "teller");
      if (current.meridianSession) {
        setOperatorSession({
          profile: current.meridianSession.profile ?? "teller",
          branch: current.meridianSession.branch ?? "MAIN-001",
          status: current.meridianSession.status,
        });
        if (current.meridianSession.profile) setSessionProfile(current.meridianSession.profile);
        if (current.meridianSession.branch) setSessionBranch(current.meridianSession.branch);
      }
    } catch (error) {
      if (generation !== authGeneration.current) return;
      setAuthError(errorMessage(error));
    } finally {
      if (generation === authGeneration.current) {
        setAuthBusy(false);
        setAuthChecked(true);
      }
    }
  };

  const signOut = async () => {
    const generation = authGeneration.current;
    chatRequestLatch.current.cancel("signout");
    setAuthBusy(true);
    setActionError(null);
    try {
      await logout();
      if (generation !== authGeneration.current) return;
      setLocalConsoleLock(true);
      broadcastAuthChange("logout");
      setPrincipal(null);
      clearOperatorData();
    } catch (error) {
      if (generation !== authGeneration.current) return;
      if (error instanceof ApiError && error.status === 401) {
        setLocalConsoleLock(true);
        broadcastAuthChange("logout");
        setPrincipal(null);
        clearOperatorData();
        return;
      }
      const uncertain = error instanceof ApiError &&
        (error.status === 0 || error.status === 408 || error.status >= 500 || error.code === "UNKNOWN_OUTCOME");
      if (uncertain) {
        setLocalConsoleLock(true);
        broadcastAuthChange("expired");
        setPrincipal(null);
        clearOperatorData();
        setAuthError(`${errorMessage(error)} The local console was locked because server-side sign-out could not be confirmed. Sign in again to reconcile any active work.`);
        return;
      }
      setActionError({ title: "Sign-out not confirmed", message: errorMessage(error), code: errorCode(error) });
    } finally {
      if (generation === authGeneration.current) setAuthBusy(false);
    }
  };

  const setChatExecution = (messageId: string, execution: ChatExecution): void => {
    setMessages((current) => current.map((message) => message.id === messageId ? { ...message, execution } : message));
  };

  const setChatApproval = (messageId: string, approval: NonNullable<ChatExecution["approval"]>): void => {
    setMessages((current) => current.map((message) =>
      message.id === messageId && message.execution
        ? { ...message, execution: { ...message.execution, approval } }
        : message,
    ));
  };

  const updateSequenceExecution = (
    messageId: string,
    update: (execution: ChatSequenceExecution) => ChatSequenceExecution,
  ): void => {
    setMessages((current) => current.map((message) =>
      message.id === messageId && message.sequenceExecution
        ? { ...message, sequenceExecution: update(message.sequenceExecution) }
        : message,
    ));
  };

  const setSequenceApproval = (
    messageId: string,
    stepIndex: number,
    approval: NonNullable<ChatExecution["approval"]>,
  ): void => {
    updateSequenceExecution(messageId, (execution) => {
      const step = execution.steps[stepIndex];
      return step ? updateSequenceStep(execution, stepIndex, { ...step, approval }) : execution;
    });
  };

  const rejectChatAutomation = (messageId: string, code: string, message: string): void => {
    setMessages((current) => current.map((item) => {
      if (item.id !== messageId) return item;
      if (item.sequenceExecution) {
        return { ...item, sequenceExecution: { ...item.sequenceExecution, state: "rejected", code, message } };
      }
      return { ...item, execution: { state: "rejected", code, message } };
    }));
  };

  const connectTargetSession = async (request?: {
    profile: "teller" | "supervisor";
    branch: OperatorSession["branch"];
    keepAssistant: boolean;
    chatMessageId: string;
  }): Promise<boolean> => {
    const profile = request?.profile ?? sessionProfile;
    const branch = request?.branch ?? sessionBranch;
    if (!principal || !online) return false;
    if (sessionBootstrapInFlight.current || sessionConnecting) {
      if (request) {
        rejectChatAutomation(request.chatMessageId, "SESSION_BOOTSTRAP_BUSY", "Another target-session bootstrap is already in flight, so this request was not attached or started.");
      }
      return false;
    }
    if (profile === "supervisor" && principal.role !== "supervisor") {
      const message = "This console identity cannot establish a supervisor target session.";
      if (request) rejectChatAutomation(request.chatMessageId, "ROLE_REQUIRED", message);
      else setActionError({ title: "Supervisor access required", message, code: "ROLE_REQUIRED" });
      return false;
    }
    sessionBootstrapInFlight.current = true;
    setSessionConnecting(true);
    setActionError(null);
    const generation = authGeneration.current;
    try {
      const created = await createSession(profile, branch);
      if (generation !== authGeneration.current) return false;
      const status: OperatorSession["status"] = created.run.phase === "completed" && created.run.terminalStatus !== "success"
        ? "failed"
        : "provisioning";
      setOperatorSession({
        runId: created.run.id,
        profile,
        branch,
        status,
        ...(status === "failed" ? { message: created.run.message ?? "Secure sign-on did not complete." } : {}),
      });
      runMutationEpoch.current += 1;
      setRuns((current) => mergeRuns(current, created.run));
      setActiveRunId(created.run.id);
      setSide(request?.keepAssistant ? "assistant" : "activity");
      setToast(request ? "Secure sign-on queued for the validated assistant operation." : "Secure sign-on queued. Runs remain disabled until the owned target session is independently verified.");
      if (status === "failed" && request) {
        rejectChatAutomation(request.chatMessageId, created.run.code ?? "SESSION_SIGN_ON_FAILED", created.run.message ?? "The secure target session could not be established.");
      }
      return status !== "failed";
    } catch (error) {
      if (generation !== authGeneration.current) return false;
      if (error instanceof ApiError && error.status === 401) {
        broadcastAuthChange("expired");
        setPrincipal(null);
        clearOperatorData();
        return false;
      }
      const uncertain = error instanceof ApiError &&
        (error.status === 0 || error.status === 408 || error.status >= 500 || error.code === "SESSION_ALREADY_ACTIVE");
      if (uncertain) {
        setOperatorSession({ profile, branch, status: "provisioning" });
      }
      const message = uncertain
        ? `${errorMessage(error)} The console is reconciling the server-owned session state before any capability launch.`
        : errorMessage(error);
      if (request && !uncertain) {
        rejectChatAutomation(request.chatMessageId, errorCode(error), message);
      } else if (!request) {
        setActionError({
          title: uncertain ? "Secure session status not confirmed" : "Secure session unavailable",
          message,
          code: errorCode(error),
        });
      }
      return uncertain;
    } finally {
      sessionBootstrapInFlight.current = false;
      if (generation === authGeneration.current) setSessionConnecting(false);
    }
  };

  const launchCapability = async (
    capability: Capability,
    inputs: Record<string, JsonValue>,
    origin: { chatMessageId?: string; keepAssistant?: boolean } = {},
  ) => {
    const rejectLaunch = (title: string, message: string, code: string): void => {
      if (origin.chatMessageId) {
        setChatExecution(origin.chatMessageId, { state: "rejected", code, message });
      } else {
        setActionError({ title, message, code });
      }
    };
    if (!isRunnable(capability)) {
      rejectLaunch("Capability is not approved", "This exact capability version is no longer approved for launch.", "CAPABILITY_NOT_APPROVED");
      return "rejected" as const;
    }
    if (operatorSession?.status !== "active" || sessionConnecting) {
      rejectLaunch("Secure session required", "Connect an active MERIDIAN session before starting this operation.", "SESSION_NOT_ACTIVE");
      return "rejected" as const;
    }
    if (!online) {
      rejectLaunch("Console is offline", "Reconnect the console before starting this operation.", "NETWORK_UNAVAILABLE");
      return "rejected" as const;
    }
    if (capability.risk === "supervisor_only" && !canLaunchCapabilityInSession(capability, principal?.role, operatorSession.profile)) {
      rejectLaunch("Supervisor session required", "This capability requires either an active supervisor target session or its reviewed same-session supervisor handoff path.", "SUPERVISOR_REQUIRED");
      return "rejected" as const;
    }
    if (containsProtectedMaterial(inputs)) {
      rejectLaunch(
        "Protected material blocked",
        "One or more business inputs appear to contain a credential or protected authentication field. Remove it before starting the run.",
        "PROTECTED_INPUT_BLOCKED",
      );
      return "rejected" as const;
    }
    if (launchInFlight.current) {
      rejectLaunch("Run start already in progress", "Another run request is crossing the idempotent submission boundary. This request was not started.", "RUN_START_IN_PROGRESS");
      return "rejected" as const;
    }
    launchInFlight.current = true;
    if (origin.chatMessageId) setChatExecution(origin.chatMessageId, { state: "starting" });
    setSubmitting(true);
    setActionError(null);
    setChatError("");
    const generation = authGeneration.current;
    let fingerprint = "";
    try {
      fingerprint = await requestFingerprint(capability, inputs);
      const retainedKey = pendingRunRequests.current.get(fingerprint);
      if (!retainedKey && pendingRunRequests.current.size >= 20) {
        throw new ApiError(409, "UNRESOLVED_REQUEST_LIMIT", "Twenty run requests still have unconfirmed outcomes. Reconcile run history or sign out before starting another operation.");
      }
      const idempotencyKey = retainedKey ?? crypto.randomUUID();
      pendingRunRequests.current.set(fingerprint, idempotencyKey);
      const created = await createRun({ capability, inputs, idempotencyKey });
      if (generation !== authGeneration.current) return;
      runMutationEpoch.current += 1;
      setRuns((current) => mergeRuns(current, created));
      setActiveRunId(created.id);
      if (origin.chatMessageId) {
        setChatExecution(origin.chatMessageId, { state: "submitted", runId: created.id });
      }
      setSide(origin.keepAssistant ? "assistant" : "activity");
      setToast(origin.chatMessageId ? "Assistant request started as an approved, idempotent run." : "Run started with an idempotent request.");
      pendingRunRequests.current.delete(fingerprint);
      return "submitted" as const;
    } catch (error) {
      if (generation !== authGeneration.current) return;
      if (error instanceof ApiError && error.status === 401) {
        broadcastAuthChange("expired");
        setPrincipal(null);
        clearOperatorData();
        return;
      }
      const outcomeUnconfirmed =
        error instanceof ApiError && (error.status === 0 || error.status === 408 || error.status >= 500 || error.code === "UNKNOWN_OUTCOME");
      const idempotencyConflict = error instanceof ApiError && error.code === "IDEMPOTENCY_CONFLICT";
      if (fingerprint && error instanceof ApiError && !outcomeUnconfirmed) {
        pendingRunRequests.current.delete(fingerprint);
      }
      if (error instanceof ApiError && error.code === "SESSION_NOT_ACTIVE") {
        setOperatorSession((current) => current ? { ...current, status: "failed", message: "The server reported that this target session is no longer active." } : current);
      }
      const title = outcomeUnconfirmed ? "Run status not confirmed" : idempotencyConflict ? "Request binding changed" : "Run did not start";
      const message = outcomeUnconfirmed
        ? `${errorMessage(error)} Reconcile with the same inputs; the original idempotency key will be reused.`
        : idempotencyConflict
          ? "The service rejected this key because it was already bound to different reviewed details. Inspect run history, then submit again to create a new request identity."
          : errorMessage(error);
      if (origin.chatMessageId) {
        setChatExecution(origin.chatMessageId, {
          state: outcomeUnconfirmed ? "unconfirmed" : "rejected",
          code: errorCode(error),
          message,
        });
      } else {
        setActionError({ title, message, code: errorCode(error) });
      }
      return outcomeUnconfirmed ? "unconfirmed" as const : "rejected" as const;
    } finally {
      launchInFlight.current = false;
      if (generation === authGeneration.current) setSubmitting(false);
    }
  };

  const start = async (inputs: Record<string, JsonValue>) => {
    if (!selectedCapability) return;
    await launchCapability(selectedCapability, inputs);
  };

  const approve = async () => {
    if (!activeRun?.challenge || approving || approvalLatch) return;
    const runId = activeRun.id;
    const challengeId = activeRun.challenge.challengeId;
    if (!activeRun.challenge.authorized) {
      setActionError({
        title: activeRun.challenge.requirement === "supervisor_confirmation" ? "Supervisor handoff required" : "Approval authority required",
        message: "The server has not authorized this console identity for the retained target-session checkpoint. No approval was posted.",
        code: activeRun.challenge.requirement === "supervisor_confirmation" ? "SUPERVISOR_REQUIRED" : "APPROVAL_NOT_AUTHORIZED",
      });
      return;
    }
    if (new Date(activeRun.challenge.expiresAt).getTime() <= Date.now()) {
      setActionError({ title: "Approval expired", message: "Refresh the run to request a new review checkpoint. No action was posted.", code: "APPROVAL_EXPIRED" });
      return;
    }
    setApproving(true);
    setActionError(null);
    const generation = authGeneration.current;
    try {
      const resumed = await approveRun(activeRun.id, activeRun.challenge.challengeId);
      if (generation !== authGeneration.current) return;
      setRuns((current) => mergeRuns(current, resumed));
      setApprovalLatch({ runId, challengeId, status: "accepted" });
      setToast("Approval accepted. The run is resuming from its bound checkpoint.");
    } catch (error) {
      if (generation !== authGeneration.current) return;
      if (error instanceof ApiError && error.status === 401) {
        broadcastAuthChange("expired");
        setPrincipal(null);
        clearOperatorData();
        return;
      }
      const uncertain = error instanceof ApiError && (error.status === 0 || error.status === 408 || error.status >= 500 || error.code === "UNKNOWN_OUTCOME");
      if (uncertain) setApprovalLatch({ runId, challengeId, status: "unconfirmed" });
      setActionError({
        title: uncertain ? "Approval status not confirmed" : "Approval was rejected",
        message: uncertain
          ? `${errorMessage(error)} Do not approve again. The console will reconcile this challenge from run snapshots.`
          : errorMessage(error),
        code: errorCode(error),
      });
      if (!uncertain) void loadRun(runId);
    } finally {
      if (generation === authGeneration.current) setApproving(false);
    }
  };

  const cancelActiveRun = async () => {
    if (!activeRun || !online || cancellingRunRef.current) return;
    if (activeRun.phase !== "queued" && activeRun.phase !== "awaiting_approval") return;
    if (approvalLatch) {
      setActionError({
        title: "Approval is still being reconciled",
        message: "Wait until the prior approval request has a definitive run state before cancelling this operation.",
        code: "APPROVAL_RECONCILIATION_REQUIRED",
      });
      return;
    }
    const runId = activeRun.id;
    cancellingRunRef.current = runId;
    setCancellingRunId(runId);
    setActionError(null);
    const generation = authGeneration.current;
    try {
      const cancelled = await requestRunCancellation(runId);
      if (generation !== authGeneration.current) return;
      runMutationEpoch.current += 1;
      setRuns((current) => mergeRuns(current, cancelled));
      setApprovalLatch((current) => current?.runId === runId ? null : current);
      const sessionReconciled = await reconcileTargetSession();
      if (generation !== authGeneration.current) return;
      setToast(sessionReconciled
        ? "The run stopped at a safe boundary. Target-session state was reconciled."
        : "The run stopped at a safe boundary. The target session will be rechecked before protected work continues.");
    } catch (error) {
      if (generation !== authGeneration.current) return;
      if (error instanceof ApiError && error.status === 401) {
        expireConsole();
        return;
      }
      const uncertain = error instanceof ApiError &&
        (error.status === 0 || error.status === 408 || error.status >= 500 || error.code === "UNKNOWN_OUTCOME");
      setActionError({
        title: uncertain ? "Cancellation status not confirmed" : "Run could not be cancelled",
        message: uncertain
          ? `${errorMessage(error)} The console is refreshing the authoritative run state; do not start a replacement operation yet.`
          : errorMessage(error),
        code: errorCode(error),
      });
      void loadRun(runId, true);
    } finally {
      if (cancellingRunRef.current === runId) cancellingRunRef.current = "";
      if (generation === authGeneration.current) setCancellingRunId((current) => current === runId ? "" : current);
    }
  };

  const selectRun = (run: RunRecord) => {
    setHistoryKind("replay");
    setActiveRunId(run.id);
    setSide("activity");
    void loadRun(run.id, true);
    if (window.matchMedia("(max-width: 980px)").matches) {
      window.requestAnimationFrame(() => {
        if (historyDetailRef.current) revealRegion(historyDetailRef.current);
      });
    }
  };

  const selectDiscoveryRun = (run: DiscoveryRunRecord) => {
    setHistoryKind("discovery");
    setActiveDiscoveryRunId(run.id);
    void loadDiscoveryRun(run.id);
    if (window.matchMedia("(max-width: 980px)").matches) {
      window.requestAnimationFrame(() => {
        if (historyDetailRef.current) revealRegion(historyDetailRef.current);
      });
    }
  };

  const sendChat = async () => {
    const text = chatDraft.trim();
    if (!text || chatSending || chatRequestLatch.current.active || chatAutomationInFlight.current || !online) return;
    if (containsCredentialMaterial(text)) {
      setChatDraft("");
      setChatError("That message appears to contain a credential, so it was cleared and was not sent.");
      return;
    }
    const controller = chatRequestLatch.current.begin();
    if (!controller) return;
    const user: ChatMessage = { id: crypto.randomUUID(), role: "user", text, createdAt: new Date().toISOString() };
    const prior = messages;
    setMessages([...prior, user]);
    setChatDraft("");
    setChatError("");
    setChatSending(true);
    const generation = authGeneration.current;
    try {
      const response = await postChat(text, prior, controller.signal);
      if (generation !== authGeneration.current) return;
      const assistant: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        text: response.text,
        createdAt: new Date().toISOString(),
        ...(response.proposal ? { proposal: response.proposal } : {}),
        ...(response.sequence ? {
          sequence: response.sequence,
          sequenceExecution: initialSequenceExecution(response.sequence),
        } : {}),
        ...(response.routing ? { routing: response.routing } : {}),
      };
      setMessages((current) => [...current, assistant]);
      if (assistant.proposal || assistant.sequence) {
        chatAutomationInFlight.current = true;
        setChatAutomationBusy(true);
        if (assistant.sequence) await launchSequence(assistant);
        else await launchProposal(assistant);
      }
    } catch (error) {
      if (generation !== authGeneration.current) return;
      if (error instanceof ApiError && error.status === 401) {
        broadcastAuthChange("expired");
        setPrincipal(null);
        clearOperatorData();
        return;
      }
      if (error instanceof ApiError && error.code === "REQUEST_CANCELLED") {
        setChatError("Assistant request cancelled. No capability was started and no approval was granted.");
      } else if (error instanceof ApiError && error.code === "REQUEST_TIMEOUT") {
        setChatError("The assistant did not respond within 20 seconds. No capability was started; you can try again.");
      } else {
        setChatError(errorMessage(error));
      }
    } finally {
      chatRequestLatch.current.release(controller);
      if (generation === authGeneration.current) setChatSending(false);
    }
  };

  const cancelChat = () => {
    chatRequestLatch.current.cancel("operator_cancelled");
  };

  const finishChatAutomation = (): void => {
    chatAutomationInFlight.current = false;
    setChatAutomationBusy(false);
    setPendingChatLaunch(null);
  };

  const stopSequence = (
    messageId: string,
    stepIndex: number,
    code: string,
    message: string,
    state: "stopped" | "unconfirmed" | "rejected" = "stopped",
  ): void => {
    updateSequenceExecution(messageId, (execution) => {
      const current = execution.steps[stepIndex];
      if (!current) return { ...execution, state: "rejected", code: "SEQUENCE_EXECUTION_MISMATCH", message: "The sequence step was no longer current." };
      return updateSequenceStep(
        execution,
        stepIndex,
        { ...current, state, code, message },
        state,
      );
    });
    if (state !== "unconfirmed") finishChatAutomation();
  };

  const launchSequenceStep = async (
    messageId: string,
    sequence: ChatSequencePlan,
    stepIndex: number,
    selectionIndex?: number,
  ): Promise<void> => {
    const step = sequence.steps[stepIndex];
    if (!step || Date.parse(sequence.expiresAt) <= Date.now()) {
      stopSequence(messageId, Math.min(stepIndex, sequence.steps.length - 1), "SEQUENCE_NOT_FOUND", "The reviewed sequence expired before this step could start.", "rejected");
      return;
    }
    const capability = resolveSequenceCapability(capabilities, step);
    if (!capability) {
      stopSequence(messageId, stepIndex, "SEQUENCE_STEP_MISMATCH", "This exact capability, artifact digest, or target profile is no longer approved.", "rejected");
      return;
    }
    const prepared = prepareSequenceStepInputs(capability, step.literalArguments, step.bindings.map((binding) => binding.targetInput));
    const firstError = Object.values(prepared.errors)[0];
    if (firstError) {
      stopSequence(messageId, stepIndex, "INVALID_SEQUENCE_INPUT", `The reviewed sequence step no longer passes its exact input contract: ${firstError}`, "rejected");
      return;
    }
    if (operatorSession?.status !== "active" || sessionConnecting || !online) {
      stopSequence(messageId, stepIndex, "SESSION_NOT_ACTIVE", "The independently verified target session is not active for this sequence step.", "rejected");
      return;
    }
    if (launchInFlight.current) {
      // A second click/effect cannot cross the single browser submission latch.
      // The in-flight exact request remains authoritative and will update state.
      return;
    }
    launchInFlight.current = true;
    setSubmitting(true);
    setActionError(null);
    setChatError("");
    updateSequenceExecution(messageId, (execution) => {
      const current = execution.steps[stepIndex];
      if (!current) return execution;
      const { code: _code, message: _message, ...starting } = current;
      return updateSequenceStep(execution, stepIndex, { ...starting, state: "starting" }, "running");
    });
    const generation = authGeneration.current;
    try {
      const created = await createRun({
        capability,
        inputs: prepared.inputs,
        sequence: {
          sequenceId: sequence.sequenceId,
          stepId: step.stepId,
          ...(selectionIndex === undefined ? {} : { selectionIndex }),
        },
      });
      if (generation !== authGeneration.current) return;
      if (!sequenceRunMatchesStep(created, sequence, step, stepIndex)) {
        throw new ApiError(502, "SEQUENCE_BINDING_MISMATCH", "The returned run did not preserve the exact sequence binding.");
      }
      runMutationEpoch.current += 1;
      setRuns((current) => mergeRuns(current, created));
      setActiveRunId(created.id);
      setSelectedKey(capabilityKey(capability));
      setSide("assistant");
      updateSequenceExecution(messageId, (execution) => {
        const current = execution.steps[stepIndex];
        return current
          ? updateSequenceStep(execution, stepIndex, { stepId: step.stepId, state: "submitted", runId: created.id }, "running")
          : execution;
      });
      setToast(`Sequence step ${stepIndex + 1} of ${sequence.steps.length} started with server-managed idempotency.`);
    } catch (error) {
      if (generation !== authGeneration.current) return;
      if (error instanceof ApiError && error.status === 401) {
        expireConsole();
        return;
      }
      if (error instanceof ApiError && error.code === "SESSION_NOT_ACTIVE") {
        setOperatorSession((current) => current ? { ...current, status: "failed", message: "The server reported that this target session is no longer active." } : current);
      }
      if (error instanceof ApiError && error.code === "SEQUENCE_SELECTION_REQUIRED" && selectionIndex === undefined) {
        const count = typeof error.details?.count === "number" ? error.details.count : 0;
        const sourceStepId = typeof error.details?.sourceStepId === "string" ? error.details.sourceStepId : "";
        const sourceCollectionPath = Array.isArray(error.details?.sourceCollectionPath)
          ? error.details.sourceCollectionPath.filter((segment): segment is string => typeof segment === "string")
          : [];
        const bindingMatches = step.bindings.some((binding) =>
          binding.sourceStepId === sourceStepId &&
          binding.sourceCollectionPath.join("\u0000") === sourceCollectionPath.join("\u0000"),
        );
        if (count > 1 && bindingMatches) {
          updateSequenceExecution(messageId, (execution) => {
            const current = execution.steps[stepIndex];
            if (!current) return execution;
            return {
              ...updateSequenceStep(execution, stepIndex, { stepId: step.stepId, state: "selection_required" }, "selection_required"),
              selection: { stepId: step.stepId, sourceStepId, sourceCollectionPath, count },
            };
          });
          setToast("The sequence paused for an authenticated result selection.");
          return;
        }
      }
      const uncertain = !(error instanceof ApiError) ||
        error.status === 0 || error.status === 408 || error.status >= 500 || error.code === "UNKNOWN_OUTCOME";
      if (uncertain) {
        stopSequence(messageId, stepIndex, errorCode(error), `${errorMessage(error)} The console is reconciling this server-idempotent step before any continuation.`, "unconfirmed");
        void loadRuns(undefined, true);
        return;
      }
      stopSequence(
        messageId,
        stepIndex,
        errorCode(error),
        error instanceof ApiError && error.code === "SEQUENCE_NO_MATCH"
          ? "The prior step returned no matching row, so the sequence stopped without starting this step."
          : errorMessage(error),
        error instanceof ApiError && ["SEQUENCE_NO_MATCH", "SEQUENCE_STOPPED"].includes(error.code) ? "stopped" : "rejected",
      );
    } finally {
      launchInFlight.current = false;
      if (generation === authGeneration.current) setSubmitting(false);
    }
  };

  const launchSequence = async (message: ChatMessage): Promise<void> => {
    const sequence = message.sequence;
    if (!sequence || !message.sequenceExecution) {
      finishChatAutomation();
      return;
    }
    const capabilitiesForSteps = sequence.steps.map((step) => resolveSequenceCapability(capabilities, step));
    if (capabilitiesForSteps.some((capability) => !capability)) {
      rejectChatAutomation(message.id, "SEQUENCE_STEP_MISMATCH", "One or more exact sequence capabilities are no longer approved for this target profile.");
      finishChatAutomation();
      return;
    }
    for (let index = 0; index < sequence.steps.length; index += 1) {
      const step = sequence.steps[index]!;
      const prepared = prepareSequenceStepInputs(capabilitiesForSteps[index]!, step.literalArguments, step.bindings.map((binding) => binding.targetInput));
      if (Object.keys(prepared.errors).length > 0) {
        stopSequence(message.id, index, "INVALID_SEQUENCE_INPUT", "A reviewed sequence step no longer passes its exact local contract.", "rejected");
        return;
      }
    }
    const sequenceCapabilities = capabilitiesForSteps as Capability[];
    const requiredProfiles = sequenceCapabilities.map((capability) => requiredProfileForCapability(capability, principal?.role));
    if (requiredProfiles.some((profile) => profile === null)) {
      rejectChatAutomation(message.id, "SUPERVISOR_REQUIRED", "This sequence contains a supervisor-only capability without a reviewed teller-to-supervisor handoff path.");
      finishChatAutomation();
      return;
    }
    const requiredProfile: "teller" | "supervisor" = requiredProfiles.includes("supervisor") ? "supervisor" : "teller";
    if (operatorSession?.status === "active") {
      if (!sequenceCapabilities.every((capability) => canLaunchCapabilityInSession(capability, principal?.role, operatorSession.profile))) {
        rejectChatAutomation(message.id, "SUPERVISOR_SESSION_REQUIRED", "This sequence requires either a supervisor target session or reviewed same-session handoff support for every supervisor-only step.");
        finishChatAutomation();
        return;
      }
      await launchSequenceStep(message.id, sequence, 0);
      return;
    }
    const pending: PendingChatSequenceLaunch = {
      kind: "sequence",
      messageId: message.id,
      sequence,
      profile: requiredProfile,
      branch: sessionBranch,
    };
    updateSequenceExecution(message.id, (execution) => ({ ...execution, state: "connecting" }));
    setSessionProfile(requiredProfile);
    setPendingChatLaunch(pending);
    if (operatorSession?.status === "provisioning" || sessionConnecting) return;
    const accepted = await connectTargetSession({
      profile: requiredProfile,
      branch: sessionBranch,
      keepAssistant: true,
      chatMessageId: message.id,
    });
    if (!accepted) finishChatAutomation();
  };

  const launchProposal = async (message: ChatMessage) => {
    if (!message.proposal) {
      finishChatAutomation();
      return;
    }
    const capability = resolveProposalCapability(capabilities, message.proposal);
    if (!capability) {
      setChatExecution(message.id, {
        state: "rejected",
        code: "CAPABILITY_NOT_APPROVED",
        message: "That exact capability version is not currently approved for launch.",
      });
      finishChatAutomation();
      return;
    }
    const prepared = prepareProposalInputs(capability, message.proposal.arguments);
    const firstError = Object.values(prepared.errors)[0];
    if (firstError) {
      setChatExecution(message.id, {
        state: "rejected",
        code: "INVALID_PROPOSAL_INPUT",
        message: `The proposal no longer passes the current local contract: ${firstError}`,
      });
      finishChatAutomation();
      return;
    }
    setSelectedKey(capabilityKey(capability));
    const requiredProfile = requiredProfileForCapability(capability, principal?.role, sessionProfile);
    if (!requiredProfile) {
      setChatExecution(message.id, {
        state: "rejected",
        code: "SUPERVISOR_REQUIRED",
        message: "This console identity cannot authorize the supervisor session required by that capability.",
      });
      finishChatAutomation();
      return;
    }
    if (operatorSession?.status === "active") {
      if (!canLaunchCapabilityInSession(capability, principal?.role, operatorSession.profile)) {
        setChatExecution(message.id, {
          state: "rejected",
          code: "SUPERVISOR_SESSION_REQUIRED",
          message: "This supervisor-only capability has no reviewed same-session handoff path for the active teller session.",
        });
        finishChatAutomation();
        return;
      }
      await launchCapability(capability, prepared.inputs, { chatMessageId: message.id, keepAssistant: true });
      finishChatAutomation();
      return;
    }
    if (operatorSession?.status === "provisioning" || sessionConnecting) {
      if (operatorSession && (operatorSession.profile !== requiredProfile || operatorSession.branch !== sessionBranch)) {
        setChatExecution(message.id, {
          state: "rejected",
          code: "SESSION_BOOTSTRAP_CONFLICT",
          message: "A different target session is already being established. No capability run was started.",
        });
        finishChatAutomation();
        return;
      }
      setChatExecution(message.id, { state: "connecting" });
      setPendingChatLaunch({ kind: "proposal", messageId: message.id, proposal: message.proposal, inputs: prepared.inputs, profile: requiredProfile, branch: sessionBranch });
      return;
    }
    const pending: PendingChatLaunch = {
      kind: "proposal",
      messageId: message.id,
      proposal: message.proposal,
      inputs: prepared.inputs,
      profile: requiredProfile,
      branch: sessionBranch,
    };
    setSessionProfile(requiredProfile);
    setChatExecution(message.id, { state: "connecting" });
    setPendingChatLaunch(pending);
    const accepted = await connectTargetSession({
      profile: requiredProfile,
      branch: sessionBranch,
      keepAssistant: true,
      chatMessageId: message.id,
    });
    if (!accepted) finishChatAutomation();
  };

  useEffect(() => {
    if (!pendingChatLaunch || !online) return;
    if (operatorSession?.status === "failed") {
      rejectChatAutomation(pendingChatLaunch.messageId, "SESSION_SIGN_ON_FAILED", operatorSession.message ?? "The authorized target session could not be established, so no capability run was started.");
      finishChatAutomation();
      return;
    }
    if (operatorSession?.status !== "active") return;
    if (operatorSession.profile !== pendingChatLaunch.profile || operatorSession.branch !== pendingChatLaunch.branch) {
      rejectChatAutomation(pendingChatLaunch.messageId, "SESSION_BINDING_MISMATCH", "The verified target session did not match the role and branch bound to this request.");
      finishChatAutomation();
      return;
    }
    const pending = pendingChatLaunch;
    setPendingChatLaunch(null);
    if (pending.kind === "sequence") {
      const first = pending.sequence.steps[0];
      if (!first || !resolveSequenceCapability(capabilities, first)) {
        rejectChatAutomation(pending.messageId, "SEQUENCE_STEP_MISMATCH", "The first sequence capability changed while the target session was being established.");
        finishChatAutomation();
        return;
      }
      void launchSequenceStep(pending.messageId, pending.sequence, 0);
      return;
    }
    const capability = resolveProposalCapability(capabilities, pending.proposal);
    if (!capability) {
      rejectChatAutomation(pending.messageId, "CAPABILITY_NOT_APPROVED", "The capability changed while the target session was being established, so no run was started.");
      finishChatAutomation();
      return;
    }
    void launchCapability(capability, pending.inputs, { chatMessageId: pending.messageId, keepAssistant: true }).finally(finishChatAutomation);
  }, [pendingChatLaunch, operatorSession?.status, operatorSession?.profile, operatorSession?.branch, online, capabilities]);

  const continueSequenceSelection = (messageId: string, selectionIndex: number): void => {
    const message = messages.find((item) => item.id === messageId);
    const execution = message?.sequenceExecution;
    const selection = execution?.selection;
    if (
      !message?.sequence ||
      !execution ||
      execution.state !== "selection_required" ||
      !selection ||
      !Number.isSafeInteger(selectionIndex) ||
      selectionIndex < 0 ||
      selectionIndex >= selection.count ||
      message.sequence.steps[execution.currentStepIndex]?.stepId !== selection.stepId
    ) return;
    void launchSequenceStep(message.id, message.sequence, execution.currentStepIndex, selectionIndex);
  };

  useEffect(() => {
    const candidate = messages.find((message) => {
      const execution = message.sequenceExecution;
      if (!message.sequence || !execution || !["running", "unconfirmed"].includes(execution.state)) return false;
      const stepExecution = execution.steps[execution.currentStepIndex];
      return stepExecution?.state === "submitted" || stepExecution?.state === "unconfirmed";
    });
    if (!candidate?.sequence || !candidate.sequenceExecution) return;
    const execution = candidate.sequenceExecution;
    const stepIndex = execution.currentStepIndex;
    const step = candidate.sequence.steps[stepIndex];
    const stepExecution = execution.steps[stepIndex];
    if (!step || !stepExecution) return;
    const run = stepExecution.runId
      ? runs.find((item) => item.id === stepExecution.runId)
      : runs.find((item) => sequenceRunMatchesStep(item, candidate.sequence!, step, stepIndex));
    if (!run) return;
    if (!sequenceRunMatchesStep(run, candidate.sequence, step, stepIndex)) {
      stopSequence(candidate.id, stepIndex, "SEQUENCE_BINDING_MISMATCH", "The observed run no longer matches this exact sequence step.", "rejected");
      return;
    }
    if (!stepExecution.runId) {
      updateSequenceExecution(candidate.id, (current) => {
        const currentStep = current.steps[stepIndex];
        return currentStep
          ? updateSequenceStep(current, stepIndex, { ...currentStep, state: "submitted", runId: run.id }, "running")
          : current;
      });
      return;
    }
    if (run.phase !== "completed") return;
    const advanceKey = `${candidate.sequence.sequenceId}:${step.stepId}:${run.id}`;
    if (sequenceAdvanceInFlight.current.has(advanceKey)) return;
    sequenceAdvanceInFlight.current.add(advanceKey);
    if (run.terminalStatus !== "success") {
      stopSequence(
        candidate.id,
        stepIndex,
        run.code ?? "SEQUENCE_STOPPED",
        run.effectUncertain
          ? "The sequence stopped because this step's write effect is uncertain. Reconcile the run before any new action."
          : run.message ?? "The sequence stopped because this step did not complete successfully.",
      );
      sequenceAdvanceInFlight.current.delete(advanceKey);
      return;
    }
    updateSequenceExecution(candidate.id, (current) => {
      const currentStep = current.steps[stepIndex];
      if (!currentStep) return current;
      if (stepIndex === candidate.sequence!.steps.length - 1) {
        return updateSequenceStep(current, stepIndex, { ...currentStep, state: "success" }, "completed");
      }
      return updateSequenceStep(current, stepIndex, { ...currentStep, state: "success" }, "running");
    });
    if (stepIndex === candidate.sequence.steps.length - 1) {
      setToast("The approved capability sequence completed successfully.");
      finishChatAutomation();
      sequenceAdvanceInFlight.current.delete(advanceKey);
      return;
    }
    void launchSequenceStep(candidate.id, candidate.sequence, stepIndex + 1)
      .finally(() => sequenceAdvanceInFlight.current.delete(advanceKey));
  }, [messages, runs, capabilities, online, operatorSession?.status]);

  useEffect(() => {
    if (!principal || !online || approving || approvalLatch) return;
    const candidates: ChatApprovalCandidate[] = [];
    for (const message of messages) {
      const execution = message.execution;
      if (message.proposal && execution?.state === "submitted" && execution.runId) {
        const run = runs.find((item) => item.id === execution.runId);
        if (run?.challenge && run.phase === "awaiting_approval") {
          candidates.push({
            message,
            binding: {
              capabilityId: message.proposal.capabilityId,
              capabilityVersion: message.proposal.capabilityVersion,
              artifactDigest: message.proposal.artifactDigest,
              targetProfileDigest: message.proposal.targetProfileDigest,
              arguments: message.proposal.arguments,
              boundInputs: [] as string[],
            },
            authorizedRunId: execution.runId,
            run,
            challenge: run.challenge,
          });
          continue;
        }
      }
      const sequenceExecution = message.sequenceExecution;
      const sequence = message.sequence;
      if (!sequence || !sequenceExecution) continue;
      const stepIndex = sequenceExecution.currentStepIndex;
      const stepExecution = sequenceExecution.steps[stepIndex];
      const step = sequence.steps[stepIndex];
      if (stepExecution?.state !== "submitted" || !stepExecution.runId || !step) continue;
      const run = runs.find((item) => item.id === stepExecution.runId);
      if (!run?.challenge || run.phase !== "awaiting_approval") continue;
      candidates.push({
        message,
        binding: {
          capabilityId: step.capabilityId,
          capabilityVersion: step.capabilityVersion,
          artifactDigest: step.artifactDigest,
          targetProfileDigest: step.targetProfileDigest,
          arguments: step.literalArguments,
          boundInputs: step.bindings.map((item) => item.targetInput),
        },
        authorizedRunId: stepExecution.runId,
        run,
        challenge: run.challenge,
        sequenceStepIndex: stepIndex,
      });
    }
    const candidate = candidates.find(({ run, challenge }) => !chatApprovalAttempts.current.has(`${run.id}:${challenge.challengeId}`));
    if (!candidate) return;

    const { message, binding, authorizedRunId, run, challenge, sequenceStepIndex } = candidate;
    const attemptKey = `${run.id}:${challenge.challengeId}`;
    // Mark before every validation and network boundary. A rejected, malformed,
    // or uncertain challenge must never become an automatic retry loop.
    chatApprovalAttempts.current.add(attemptKey);
    const reject = (code: string, detail: string): void => {
      const approval = { challengeId: challenge.challengeId, state: "rejected" as const, code, message: detail };
      if (sequenceStepIndex === undefined) setChatApproval(message.id, approval);
      else setSequenceApproval(message.id, sequenceStepIndex, approval);
      setToast("Automatic approval stopped safely. View the run for details.");
    };

    if (
      run.id !== authorizedRunId ||
      challenge.runId !== run.id ||
      run.capabilityId !== binding.capabilityId ||
      run.capabilityVersion !== binding.capabilityVersion ||
      run.artifactDigest !== binding.artifactDigest ||
      run.targetProfileDigest !== binding.targetProfileDigest
    ) {
      reject("CHAT_APPROVAL_BINDING_MISMATCH", "The current run, capability digest, and server challenge do not match the proposal authorized by Send.");
      return;
    }
    if (sequenceStepIndex !== undefined) {
      const sequenceStep = message.sequence?.steps[sequenceStepIndex];
      if (!message.sequence || !sequenceStep || !sequenceRunMatchesStep(run, message.sequence, sequenceStep, sequenceStepIndex)) {
        reject("CHAT_APPROVAL_BINDING_MISMATCH", "The sequence lineage on this approval run does not match the exact step authorized by Send.");
        return;
      }
    }
    const capability = capabilities.find((item) =>
      item.id === binding.capabilityId &&
      item.version === binding.capabilityVersion &&
      item.digest === binding.artifactDigest &&
      item.targetProfileDigest === binding.targetProfileDigest &&
      isRunnable(item),
    );
    if (!capability) {
      reject("CAPABILITY_NOT_APPROVED", "This exact capability version or digest is no longer approved, so the checkpoint was not submitted.");
      return;
    }
    const prepared = sequenceStepIndex === undefined
      ? prepareProposalInputs(capability, binding.arguments)
      : prepareSequenceStepInputs(capability, binding.arguments, binding.boundInputs);
    if (Object.keys(prepared.errors).length > 0) {
      reject("INVALID_PROPOSAL_INPUT", "The originally authorized proposal no longer passes the current input contract.");
      return;
    }
    if (run.effectUncertain) {
      reject("RUN_EFFECT_UNCERTAIN", "The run reports an uncertain effect, so no new approval can be authorized automatically.");
      return;
    }
    if (challenge.summary.length === 0 || challenge.summary.some((item) => !item.reviewable)) {
      reject("APPROVAL_REVIEW_INCOMPLETE", "The service did not provide a complete display-safe review projection for this challenge.");
      return;
    }
    if (new Date(challenge.expiresAt).getTime() <= Date.now()) {
      reject("APPROVAL_EXPIRED", "The server-issued approval challenge expired before it could be submitted.");
      return;
    }
    if (!challenge.authorized) {
      reject(challenge.requirement === "supervisor_confirmation" ? "SUPERVISOR_REQUIRED" : "APPROVAL_NOT_AUTHORIZED", "The service has not authorized this console identity for the retained target-session checkpoint.");
      return;
    }

    setApproving(true);
    const submittingApproval = { challengeId: challenge.challengeId, state: "submitting" as const };
    if (sequenceStepIndex === undefined) setChatApproval(message.id, submittingApproval);
    else setSequenceApproval(message.id, sequenceStepIndex, submittingApproval);
    const generation = authGeneration.current;
    void approveRun(run.id, challenge.challengeId)
      .then((resumed) => {
        if (generation !== authGeneration.current) return;
        if (
          resumed.id !== run.id ||
          resumed.capabilityId !== binding.capabilityId ||
          resumed.capabilityVersion !== binding.capabilityVersion ||
          resumed.artifactDigest !== binding.artifactDigest ||
          resumed.targetProfileDigest !== binding.targetProfileDigest
        ) {
          throw new ApiError(502, "RUN_BINDING_MISMATCH", "The approval response did not preserve the authorized capability binding.");
        }
        if (sequenceStepIndex !== undefined) {
          const sequenceStep = message.sequence?.steps[sequenceStepIndex];
          if (!message.sequence || !sequenceStep || !sequenceRunMatchesStep(resumed, message.sequence, sequenceStep, sequenceStepIndex)) {
            throw new ApiError(502, "SEQUENCE_BINDING_MISMATCH", "The approval response did not preserve the exact sequence lineage.");
          }
        }
        runMutationEpoch.current += 1;
        setRuns((current) => mergeRuns(current, resumed));
        setApprovalLatch({ runId: run.id, challengeId: challenge.challengeId, status: "accepted" });
        const acceptedApproval = { challengeId: challenge.challengeId, state: "accepted" as const };
        if (sequenceStepIndex === undefined) setChatApproval(message.id, acceptedApproval);
        else setSequenceApproval(message.id, sequenceStepIndex, acceptedApproval);
        setToast("The exact server-issued challenge was accepted and is being reconciled.");
      })
      .catch((error: unknown) => {
        if (generation !== authGeneration.current) return;
        if (error instanceof ApiError && error.status === 401) {
          broadcastAuthChange("expired");
          setPrincipal(null);
          clearOperatorData();
          return;
        }
        const uncertain = !(error instanceof ApiError) ||
          error.status === 0 || error.status === 408 || error.status >= 500 || error.code === "UNKNOWN_OUTCOME";
        const code = errorCode(error);
        const detail = uncertain
          ? `${errorMessage(error)} No automatic retry will be made; the console is reconciling the same challenge.`
          : errorMessage(error);
        const failedApproval = {
          challengeId: challenge.challengeId,
          state: uncertain ? "unconfirmed" as const : "rejected" as const,
          code,
          message: detail,
        };
        if (sequenceStepIndex === undefined) setChatApproval(message.id, failedApproval);
        else setSequenceApproval(message.id, sequenceStepIndex, failedApproval);
        if (uncertain) {
          setApprovalLatch({ runId: run.id, challengeId: challenge.challengeId, status: "unconfirmed" });
        } else {
          void loadRun(run.id);
        }
      })
      .finally(() => {
        if (generation === authGeneration.current) setApproving(false);
      });
  }, [
    messages,
    runs,
    capabilities,
    principal,
    online,
    approving,
    approvalLatch,
    clearOperatorData,
    loadRun,
  ]);

  const assistantOpen = view === "workspace" && side === "assistant";
  const openAssistant = () => {
    setView("workspace");
    setSide(assistantOpen ? "activity" : "assistant");
    if (!assistantOpen) {
      window.requestAnimationFrame(() => {
        const panel = sidePanelRef.current;
        if (!panel) return;
        revealRegion(panel);
      });
    }
  };

  if (!authChecked || !principal) {
    return <AuthGate loading={authBusy || !authChecked} error={authError} online={online} onLogin={(accessCode) => void authenticate(accessCode)} />;
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <header className="topbar" ref={topbarRef}>
        <Brand />
        <nav className="primary-nav" aria-label="Primary navigation">
          <button type="button" className={view === "workspace" ? "active" : ""} aria-current={view === "workspace" ? "page" : undefined} onClick={() => setView("workspace")}>Workspace</button>
          <button type="button" className={view === "runs" ? "active" : ""} aria-current={view === "runs" ? "page" : undefined} onClick={() => setView("runs")}>History <span>{runs.length + discoveryRuns.length}</span></button>
        </nav>
        <div className="top-actions">
          <span className={`service-state${online ? "" : " offline"}`}><span aria-hidden="true" />{online ? "Browser online" : "Browser offline"}</span>
          <span className="principal-name" title={principal.id}>{principal.displayName}</span>
          <button className={`assistant-toggle${assistantOpen ? " active" : ""}`} type="button" aria-pressed={assistantOpen} aria-expanded={assistantOpen} onClick={openAssistant}><span aria-hidden="true">✦</span> Assistant</button>
          <button className="signout-button" type="button" disabled={authBusy || signOutBlocked} title={signOutBlocked ? "Sign-out is available when the active run reaches a safe boundary." : "Sign out and revoke the target session"} onClick={() => void signOut()}>Sign out</button>
        </div>
      </header>
      {!online ? <div className="offline-banner" role="alert"><strong>You’re offline.</strong> Existing details remain visible, but no run, approval, or chat request can be sent.</div> : null}
      <main id="main-content" className="main-content">
        <section className="page-intro">
          <div><p className="eyebrow">Deterministic capability runtime</p><h1>{view === "workspace" ? "Operate with a clear safety boundary." : "Inspect every operational outcome."}</h1><p>{view === "workspace" ? "Choose an approved capability, provide only the required business inputs, and watch each verified step." : "Review successful runs, business outcomes, recoveries, and escalations without replaying an action."}</p></div>
          <dl className="summary-metrics">
            <div><dt>Approved</dt><dd>{capabilities.filter((item) => item.approval === "approved").length}</dd></div>
            <div><dt>Active</dt><dd>{runs.filter((run) => !isTerminal(run)).length}</dd></div>
            <div><dt>Needs review</dt><dd>{runs.filter((run) => run.phase === "awaiting_approval" || run.phase === "awaiting_human").length}</dd></div>
          </dl>
        </section>
        <SecureSessionPanel principal={principal} session={operatorSession} profile={sessionProfile} branch={sessionBranch} connecting={sessionConnecting} online={online} handoff={humanHandoff} onProfile={setSessionProfile} onBranch={setSessionBranch} onConnect={() => void connectTargetSession()} />
        {actionError ? <Alert title={actionError.title} action={<button className="icon-button" type="button" aria-label="Dismiss error" onClick={() => setActionError(null)}>×</button>}><p>{actionError.message}</p><code className="error-code">{actionError.code}</code></Alert> : null}
        {view === "runs" ? (
          <section className="history-shell" aria-label="Discovery and replay history">
            <div className="history-kind-tabs" role="tablist" aria-label="History type">
              <button type="button" role="tab" aria-selected={historyKind === "replay"} className={historyKind === "replay" ? "active" : ""} onClick={() => setHistoryKind("replay")}>Replay runs <span>{runs.length}</span></button>
              <button type="button" role="tab" aria-selected={historyKind === "discovery"} className={historyKind === "discovery" ? "active" : ""} onClick={() => setHistoryKind("discovery")}>Discovery runs <span>{discoveryRuns.length}</span></button>
            </div>
            {historyKind === "replay" ? (
              <div className="history-layout"><RunHistory runs={runs} capabilities={capabilities} activeId={activeRunId} loading={runsLoading} error={runsError} onSelect={selectRun} onRetry={() => void loadRuns()} /><div ref={historyDetailRef} tabIndex={-1} role="region" aria-label="Selected replay run details"><RunPanel run={activeRun} capability={activeCapability} connection={connection} liveEvents={liveEvents} loading={runLoading} approving={approving} approvalLatch={approvalLatch} cancelling={cancellingRunId === activeRun?.id} online={online} principal={principal} handoff={humanHandoff} onRunUpdate={acceptReconciliationRun} onUnauthorized={expireConsole} onUnavailable={invalidateUnavailableRun} onRefresh={() => void loadRun(activeRunId, true)} onApprove={() => void approve()} onCancel={() => void cancelActiveRun()} /></div></div>
            ) : (
              <div className="history-layout"><DiscoveryRunHistory runs={discoveryRuns} activeId={activeDiscoveryRunId} loading={discoveryRunsLoading} error={discoveryRunsError} onSelect={selectDiscoveryRun} onRetry={() => void loadDiscoveryRuns()} /><div ref={historyDetailRef} tabIndex={-1} role="region" aria-label="Selected discovery run details"><DiscoveryRunDetail run={activeDiscoveryRun} capability={activeDiscoveryCapability} loading={discoveryRunLoading} /></div></div>
            )}
          </section>
        ) : (
          <div className="workspace-grid">
            <CapabilityCatalog capabilities={capabilities} selectedKey={selectedKey} loading={catalogLoading} error={catalogError} onSelect={chooseCapability} onRetry={() => void loadCatalog()} />
            <GuidedRunForm capability={selectedCapability} values={values} counts={counts} online={online} sessionReady={sessionReady} riskAuthorized={Boolean(selectedCapability && canLaunchCapabilityInSession(selectedCapability, principal?.role, operatorSession?.profile))} submitting={submitting} onValues={setValues} onCounts={setCounts} onSubmit={(inputs) => void start(inputs)} />
            <div className="side-column" ref={sidePanelRef} tabIndex={-1} role="region" aria-label={side === "activity" ? "Live activity panel" : "Operations assistant panel"}>
              <div className="side-tabs" aria-label="Workspace side panel"><button aria-pressed={side === "activity"} className={side === "activity" ? "active" : ""} type="button" onClick={() => setSide("activity")}>Activity</button><button aria-pressed={side === "assistant"} className={side === "assistant" ? "active" : ""} type="button" onClick={() => setSide("assistant")}><span aria-hidden="true">✦</span> Assistant</button></div>
              <div id="workspace-side-panel">
                {side === "activity" ? <RunPanel run={activeRun} capability={activeCapability} connection={connection} liveEvents={liveEvents} loading={runLoading || runsLoading} approving={approving} approvalLatch={approvalLatch} cancelling={cancellingRunId === activeRun?.id} online={online} principal={principal} handoff={humanHandoff} onRunUpdate={acceptReconciliationRun} onUnauthorized={expireConsole} onUnavailable={invalidateUnavailableRun} onRefresh={() => void loadRun(activeRunId, true)} onApprove={() => void approve()} onCancel={() => void cancelActiveRun()} /> : <ChatPanel messages={messages} capabilities={capabilities} runs={runs} activeRunId={activeRunId} connection={connection} draft={chatDraft} sending={chatSending} automationBusy={chatAutomationBusy} error={chatError} online={online} onDraft={setChatDraft} onSend={() => void sendChat()} onCancel={cancelChat} onOpenRun={selectRun} onSelectSequence={continueSequenceSelection} />}
              </div>
            </div>
          </div>
        )}
      </main>
      <footer className="app-footer"><span>Guarded replay · Exact-one targeting · Redacted evidence</span><span>{lastUpdated ? `Last synced ${formatDate(lastUpdated)}` : "Waiting for service"}</span></footer>
      {toast ? <div className="toast" role="status"><span aria-hidden="true">✓</span>{toast}</div> : null}
    </div>
  );
}
