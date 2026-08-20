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
  evidenceFinalizationStatus,
  evidenceUrl,
  eventsUrl,
  getCapabilities,
  getEvidence,
  getAuthState,
  getRun,
  getRuns,
  login,
  logout,
  normalizeLiveEvent,
  normalizeRun,
  postChat,
  type EvidenceItem,
} from "./api";
import {
  type ArrayCounts,
  type FlatFormValues,
  fieldDomId,
  fieldPath,
  flattenProposal,
  humanize,
  isRunnable,
  serializeInputs,
} from "./form";
import {
  AbortableRequestLatch,
  isRetainedRunUnavailable,
  nextRunSelection,
  withoutRun,
} from "./lifecycle";
import {
  containsCredentialMaterial,
  containsProtectedMaterial,
  contractValues,
  isProtectedField,
  isProtectedKey,
  redactForDisplay,
} from "./security";
import type {
  ApprovalChallenge,
  Capability,
  CapabilityField,
  ChatMessage,
  ConsolePrincipal,
  ConnectionState,
  FieldType,
  JsonValue,
  LiveEvent,
  OperatorSession,
  RiskLevel,
  RunRecord,
} from "./types";

const RISK_LABELS: Record<RiskLevel, string> = {
  read: "Read only",
  write: "Writes data",
  irreversible: "Confirmation required",
  supervisor_only: "Supervisor only",
};

const PHASES = ["queued", "running", "awaiting_approval", "completed"] as const;
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

function shortId(value: string): string {
  return value.length > 15 ? `${value.slice(0, 7)}…${value.slice(-5)}` : value;
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}

const DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});

function formatDate(value?: string): string {
  if (!value) return "Not available";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not available";
  return DATE_FORMATTER.format(date);
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return "Something went wrong while contacting the service.";
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

interface ApprovalLatch {
  runId: string;
  challengeId: string;
  status: "accepted" | "unconfirmed";
}

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

function Brand(): ReactNode {
  return (
    <div className="brand">
      <div className="brand-mark" aria-hidden="true"><span>B</span></div>
      <div>
        <strong>Bridge Console</strong>
        <span>Guarded operations</span>
      </div>
    </div>
  );
}

function RiskBadge({ risk }: { risk: RiskLevel }): ReactNode {
  return <span className={`badge risk-${risk}`}>{RISK_LABELS[risk]}</span>;
}

function ConnectionBadge({ state }: { state: ConnectionState }): ReactNode {
  const labels: Record<ConnectionState, string> = {
    idle: "No live run",
    connecting: "Connecting",
    live: "Live",
    disconnected: "Updates delayed",
  };
  return (
    <span className={`connection connection-${state}`} role="status">
      <span aria-hidden="true" />{labels[state]}
    </span>
  );
}

function EmptyState({ icon, title, detail }: { icon: string; title: string; detail: string }): ReactNode {
  return (
    <div className="empty-state">
      <span className="empty-icon" aria-hidden="true">{icon}</span>
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}

function LoadingRows({ count = 3 }: { count?: number }): ReactNode {
  return (
    <div className="loading-rows" aria-label="Loading" role="status">
      {Array.from({ length: count }, (_, index) => <span key={index} />)}
    </div>
  );
}

function Alert({
  tone = "critical",
  title,
  children,
  action,
}: {
  tone?: "critical" | "warning" | "info" | "positive";
  title: string;
  children: ReactNode;
  action?: ReactNode;
}): ReactNode {
  return (
    <div className={`alert alert-${tone}`} role={tone === "critical" ? "alert" : "status"}>
      <span className="alert-symbol" aria-hidden="true">{tone === "positive" ? "✓" : tone === "info" ? "i" : "!"}</span>
      <div><strong>{title}</strong><div className="alert-copy">{children}</div></div>
      {action ? <div className="alert-action">{action}</div> : null}
    </div>
  );
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
      {managedAuthentication ? (
        <Alert tone="info" title="Authentication is service-managed">This capability is cataloged for auditability, but sign-in credentials are resolved outside this user interface.</Alert>
      ) : null}
      {!managedAuthentication && capability.schemaVersion !== "2.0" ? (
        <Alert tone="warning" title="Recorded contract is view-only">This earlier artifact remains visible for traceability. Promote it to a V2 approved contract before starting a new run.</Alert>
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

function scalar(value: JsonValue): string {
  if (value === null) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

function ValueView({ value, label = "Structured output" }: { value: JsonValue; label?: string }): ReactNode {
  if (Array.isArray(value)) {
    const sample = value.slice(0, 100);
    const rows = sample.filter((item): item is Record<string, JsonValue> => Boolean(item) && typeof item === "object" && !Array.isArray(item));
    if (rows.length === sample.length && rows.length > 0) {
      const columnSample = value.slice(0, 250).filter((item): item is Record<string, JsonValue> => Boolean(item) && typeof item === "object" && !Array.isArray(item));
      const allColumns = [...new Set(columnSample.flatMap((row) => Object.keys(row).filter((key) => !isProtectedKey(key))))];
      const columns = allColumns.slice(0, 12);
      return (
        <><div className="table-scroll"><table><caption className="visually-hidden">{label}</caption><thead><tr>{columns.map((column) => <th key={column}>{humanize(column)}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{columns.map((column) => <td key={column}><ValueView value={row[column] ?? null} label={column} /></td>)}</tr>)}</tbody></table></div>{value.length > 100 || allColumns.length > 12 || value.length > 250 ? <p className="value-limit">Showing the first {Math.min(value.length, 100)} of {value.length} rows and up to {Math.min(allColumns.length, 12)} display-safe columns{value.length > 250 ? " discovered from the first 250 rows" : ""}.</p> : null}</>
      );
    }
    return <><ul className="value-list">{sample.map((item, index) => <li key={index}><ValueView value={item} /></li>)}</ul>{value.length > 100 ? <p className="value-limit">Showing the first 100 of {value.length} items.</p> : null}</>;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([key]) => !isProtectedKey(key));
    return <><dl className="value-grid">{entries.slice(0, 250).map(([key, item]) => <div key={key}><dt>{humanize(key)}</dt><dd><ValueView value={item} label={key} /></dd></div>)}</dl>{entries.length > 250 ? <p className="value-limit">Showing the first 250 of {entries.length} display-safe fields.</p> : null}</>;
  }
  const safe = redactForDisplay(value, label);
  return <span className={safe === "[Protected]" ? "protected-value" : "scalar-value"}>{scalar(safe)}</span>;
}

function ApprovalPanel({
  challenge,
  approving,
  latchStatus,
  blockedByOtherApproval,
  canApproveSupervisor,
  cancelling,
  online,
  onApprove,
  onCancel,
}: {
  challenge: ApprovalChallenge;
  approving: boolean;
  latchStatus: ApprovalLatch["status"] | null;
  blockedByOtherApproval: boolean;
  canApproveSupervisor: boolean;
  cancelling: boolean;
  online: boolean;
  onApprove(): void;
  onCancel(): void;
}): ReactNode {
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
  const authorized = !supervisor || canApproveSupervisor;
  const reviewable = challenge.summary.length > 0 && challenge.summary.every((item) => item.reviewable);
  const confirmed = confirmedChallengeId === challenge.challengeId;
  return (
    <section className="approval-card" aria-labelledby="approval-title">
      <div className="approval-heading"><span className="approval-icon" aria-hidden="true">!</span><div><p className="eyebrow">Execution paused safely</p><h3 id="approval-title">{challenge.stepTitle}</h3></div><span className={`expiry${expired ? " expired" : ""}`}>{expired ? "Expired" : `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`}</span></div>
      <p>{supervisor && !authorized ? "This run cannot switch identity mid-flight. A console supervisor must establish a supervisor target session and start a new run from the beginning." : reviewable ? "Review the exact prepared values. Approval is bound to this run and expires automatically." : "Approval remains blocked because the service did not provide a complete, authorized review projection."}</p>
      {challenge.summary.length ? (
        <dl className="approval-summary">{challenge.summary.map((item) => <div key={item.targetId}><dt>{humanize(item.targetId)}</dt><dd>{item.reviewable ? <ValueView value={item.value} /> : <span className="protected-value">Protected value</span>}</dd></div>)}</dl>
      ) : <p className="muted">The target review checkpoint is ready. No display-safe summary values were returned.</p>}
      {!authorized ? <Alert tone="warning" title="Supervisor restart required">This run remains stopped. Do not retry it as a teller; a separately authenticated supervisor must start a new run with a supervisor target session.</Alert> : (
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

function Outcome({ run }: { run: RunRecord }): ReactNode {
  if (!run.terminalStatus) return null;
  if (run.terminalStatus === "success") return <Alert tone="positive" title="Run completed">The approved capability reached its verified checkpoint.</Alert>;
  if (run.effectUncertain) return <Alert title="Commit outcome is unknown">Do not retry this operation. Reconcile it with the target system before taking another action.</Alert>;
  const tone = run.terminalStatus === "business_outcome" ? "warning" : "critical";
  const title = run.terminalStatus === "business_outcome" ? "Action needs different information" : run.terminalStatus === "escalation" ? "Human attention required" : "Run stopped safely";
  return <Alert tone={tone} title={title}><p>{run.message ?? "The run ended without changing any further target state."}</p>{run.code ? <code className="error-code">{run.code}</code> : null}</Alert>;
}

function RunPanel({
  run,
  capability,
  connection,
  liveEvents,
  loading,
  approving,
  approvalLatch,
  canApproveSupervisor,
  cancelling,
  online,
  onUnauthorized,
  onUnavailable,
  onRefresh,
  onApprove,
  onCancel,
}: {
  run: RunRecord | undefined;
  capability: Capability | undefined;
  connection: ConnectionState;
  liveEvents: LiveEvent[];
  loading: boolean;
  approving: boolean;
  approvalLatch: ApprovalLatch | null;
  canApproveSupervisor: boolean;
  cancelling: boolean;
  online: boolean;
  onUnauthorized(): void;
  onUnavailable(runId: string): void;
  onRefresh(): void;
  onApprove(): void;
  onCancel(): void;
}): ReactNode {
  const [evidence, setEvidence] = useState<EvidenceItem[]>([]);
  const [evidenceFinalized, setEvidenceFinalized] = useState(false);
  const [evidenceRunId, setEvidenceRunId] = useState("");
  const [evidenceRefresh, setEvidenceRefresh] = useState(0);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [evidenceError, setEvidenceError] = useState("");
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
          <PhaseTracker run={run} />
          {run.phase === "queued" ? <div className="safe-stop-row queued-stop"><p>This request has not entered a browser step and can be removed safely.</p><button className="button quiet cancel-button" type="button" disabled={!online || cancelling} onClick={onCancel}>{cancelling ? <><span className="spinner" aria-hidden="true" />Cancelling…</> : "Cancel queued run"}</button></div> : null}
          {run.phase === "recovering" ? <Alert tone="warning" title="Safe recovery in progress">The runner detected a recoverable target state and is restarting only from an approved checkpoint.</Alert> : null}
          {run.phase === "awaiting_human" ? <Alert tone="warning" title="Human handoff requested">Automation is paused and no further actions will run until control is reconciled.</Alert> : null}
          <Outcome run={run} />
          {run.phase === "awaiting_approval" && run.challenge ? <ApprovalPanel challenge={run.challenge} approving={approving} latchStatus={approvalLatch?.runId === run.id && approvalLatch.challengeId === run.challenge.challengeId ? approvalLatch.status : null} blockedByOtherApproval={Boolean(approvalLatch && (approvalLatch.runId !== run.id || approvalLatch.challengeId !== run.challenge.challengeId))} canApproveSupervisor={canApproveSupervisor} cancelling={cancelling} online={online} onApprove={onApprove} onCancel={onCancel} /> : null}
          {run.incidents.length ? <section className="incidents" aria-labelledby="incidents-title"><h3 id="incidents-title">Incidents & recovery</h3>{run.incidents.map((incident, index) => <div className={`incident incident-${incident.category}`} key={`${incident.code}-${index}`}><span aria-hidden="true">{incident.category === "recoverable" ? "↻" : "!"}</span><div><strong>{humanize(incident.code)}</strong><p>{incident.message}</p>{incident.recoveryAttempt ? <small>Recovery attempt {incident.recoveryAttempt}</small> : null}</div></div>)}</section> : null}
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

function ChatPanel({ messages, draft, sending, error, online, onDraft, onSend, onCancel, onApply }: { messages: ChatMessage[]; draft: string; sending: boolean; error: string; online: boolean; onDraft(value: string): void; onSend(): void; onCancel(): void; onApply(message: ChatMessage): void }): ReactNode {
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: preferredScrollBehavior() });
  }, [messages]);
  return (
    <section className="panel assistant-panel" aria-labelledby="assistant-title">
      <div className="panel-heading"><div><p className="eyebrow">Model-routed · server guarded</p><h2 id="assistant-title">Operations assistant</h2></div><span className="assistant-spark" aria-hidden="true">✦</span></div>
      <div className="assistant-safety"><span aria-hidden="true">◆</span><p><strong>Keep credentials out of chat.</strong> Passwords, tokens, and sign-in details are resolved only by the service.</p></div>
      <div className="message-log" role="log" aria-live="polite" ref={logRef}>
        {messages.length === 0 ? <div className="assistant-welcome"><span aria-hidden="true">✦</span><h3>How can I help?</h3><p>Describe the outcome you need. The assistant can find an approved capability and prepare its inputs, but it cannot approve or bypass a safety gate.</p><div className="suggestions">{["Show available read capabilities", "How do approvals work?", "Prepare a member balance lookup"].map((suggestion) => <button type="button" key={suggestion} onClick={() => onDraft(suggestion)}>{suggestion}</button>)}</div></div> : null}
        {messages.map((message) => <article className={`message message-${message.role}`} key={message.id}><span>{message.role === "assistant" ? "Bridge" : "You"}</span><p>{message.text}</p>{message.routing?.fallbackFrom ? <p className="routing-note" role="status">Degraded routing: {humanize(message.routing.provider)} handled this response because {humanize(message.routing.fallbackFrom)} was unavailable.</p> : null}{message.proposal ? <button className="button quiet small" type="button" onClick={() => onApply(message)}>Review capability request <span aria-hidden="true">→</span></button> : null}<time dateTime={message.createdAt}>{formatDate(message.createdAt)}</time></article>)}
        {sending ? <div className="thinking" role="status"><span /><span /><span /><span className="visually-hidden">Assistant is thinking</span></div> : null}
      </div>
      {error ? <p className="chat-error" role="alert"><span aria-hidden="true">!</span>{error}</p> : null}
      <form className="chat-composer" onSubmit={(event) => { event.preventDefault(); onSend(); }}>
        <label className="visually-hidden" htmlFor="assistant-message">Message the operations assistant</label>
        <textarea id="assistant-message" value={draft} maxLength={8_000} rows={3} placeholder="Describe an operation — never include passwords or tokens" onChange={(event) => onDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); onSend(); } }} />
        <div><small>{draft.length.toLocaleString()} / 8,000</small>{sending ? <button className="button quiet small chat-cancel-button" type="button" onClick={onCancel}>Cancel request</button> : <button className="send-button" type="submit" disabled={!draft.trim() || !online} aria-label="Send message">↑</button>}</div>
      </form>
      <p className="assistant-footnote">Suggestions are reviewed locally before a deterministic run begins.</p>
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

function SecureSessionPanel({
  principal,
  session,
  profile,
  branch,
  connecting,
  online,
  onProfile,
  onBranch,
  onConnect,
}: {
  principal: ConsolePrincipal;
  session: OperatorSession | null;
  profile: "teller" | "supervisor";
  branch: OperatorSession["branch"];
  connecting: boolean;
  online: boolean;
  onProfile(value: "teller" | "supervisor"): void;
  onBranch(value: OperatorSession["branch"]): void;
  onConnect(): void;
}): ReactNode {
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
    </section>
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
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [selectedKey, setSelectedKey] = useState("");
  const [activeRunId, setActiveRunId] = useState("");
  const [view, setView] = useState<"workspace" | "runs">("workspace");
  const [side, setSide] = useState<"activity" | "assistant">("activity");
  const [values, setValues] = useState<FlatFormValues>({});
  const [counts, setCounts] = useState<ArrayCounts>({});
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [runsLoading, setRunsLoading] = useState(true);
  const [runLoading, setRunLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [approving, setApproving] = useState(false);
  const [cancellingRunId, setCancellingRunId] = useState("");
  const [approvalLatch, setApprovalLatch] = useState<ApprovalLatch | null>(null);
  const [catalogError, setCatalogError] = useState("");
  const [runsError, setRunsError] = useState("");
  const [actionError, setActionError] = useState<{ title: string; message: string; code: string } | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("idle");
  const [liveEvents, setLiveEvents] = useState<LiveEvent[]>([]);
  const [lastUpdated, setLastUpdated] = useState("");
  const [toast, setToast] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatDraft, setChatDraft] = useState("");
  const [chatSending, setChatSending] = useState(false);
  const [chatError, setChatError] = useState("");
  const pendingRunRequests = useRef<Map<string, string>>(new Map());
  const chatRequestLatch = useRef(new AbortableRequestLatch());
  const cancellingRunRef = useRef("");
  const authGeneration = useRef(0);
  const runMutationEpoch = useRef(0);
  const runListRequest = useRef(0);
  const runDetailRequest = useRef(0);
  const reconciledTerminalRuns = useRef<Set<string>>(new Set());
  const sidePanelRef = useRef<HTMLDivElement>(null);
  const historyDetailRef = useRef<HTMLDivElement>(null);
  const topbarRef = useRef<HTMLElement>(null);

  const selectedCapability = capabilities.find((item) => capabilityKey(item) === selectedKey);
  const activeRun = runs.find((run) => run.id === activeRunId);
  const activeCapability = activeRun
    ? capabilities.find((item) =>
        item.contractValid &&
        item.id === activeRun.capabilityId &&
        item.version === activeRun.capabilityVersion &&
        item.digest === activeRun.artifactDigest,
      )
    : undefined;
  const sessionReady = operatorSession?.status === "active" && !sessionConnecting;
  const supervisorReady = principal?.role === "supervisor" && sessionReady && operatorSession.profile === "supervisor";
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
    setCapabilities([]);
    setActiveRunId("");
    setSelectedKey("");
    setValues({});
    setCounts({});
    setMessages([]);
    setChatDraft("");
    setChatError("");
    setChatSending(false);
    setLiveEvents([]);
    setApprovalLatch(null);
    setActionError(null);
    setToast("");
    setLastUpdated("");
    setCatalogLoading(false);
    setRunsLoading(false);
    setRunLoading(false);
    setSubmitting(false);
    setApproving(false);
    setCancellingRunId("");
    setSessionConnecting(false);
    setAuthBusy(false);
    setAuthError("");
    setConnection("idle");
    setView("workspace");
    setSide("activity");
    pendingRunRequests.current.clear();
    runMutationEpoch.current += 1;
    runListRequest.current += 1;
    runDetailRequest.current += 1;
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
    setLiveEvents([]);
    setConnection("idle");
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
      return;
    }
    const controller = new AbortController();
    void loadCatalog(controller.signal);
    void loadRuns(controller.signal);
    return () => controller.abort();
  }, [principal, loadCatalog, loadRuns]);

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
    setLiveEvents([]);
    if (!activeRunId || !online || isTerminal(activeRun)) {
      setConnection("idle");
      return;
    }
    setConnection("connecting");
    const generation = authGeneration.current;
    const source = new EventSource(eventsUrl(activeRunId), { withCredentials: true });
    let highestSequence = 0;
    let refreshTimer: number | undefined;
    const scheduleRefresh = () => {
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => void loadRun(activeRunId), 180);
    };
    const receive = (event: MessageEvent<string>) => {
      if (generation !== authGeneration.current) return;
      let payload: unknown;
      try { payload = JSON.parse(event.data) as unknown; } catch { return; }
      const envelope = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
      const runEnvelope = envelope.run && typeof envelope.run === "object" && !Array.isArray(envelope.run) ? envelope.run as Record<string, unknown> : {};
      const reportedRun = typeof runEnvelope.id === "string" ? runEnvelope.id : typeof envelope.runId === "string" ? envelope.runId : "";
      if (reportedRun && reportedRun !== activeRunId) return;
      const sequence = typeof envelope.sequence === "number" ? envelope.sequence : Number(event.lastEventId || 0);
      if (sequence && sequence <= highestSequence) return;
      highestSequence = Math.max(highestSequence, sequence || highestSequence);
      const live = normalizeLiveEvent(envelope.event ?? payload, event.type || "message", event.lastEventId);
      setLiveEvents((current) => current.some((item) => item.id === live.id) ? current : [...current, live].slice(-120));
      const snapshot = normalizeRun(envelope.snapshot);
      if (snapshot && snapshot.id === activeRunId) {
        setRuns((current) => mergeRuns(current, snapshot));
        setLastUpdated(new Date().toISOString());
      } else {
        scheduleRefresh();
      }
    };
    source.onopen = () => { setConnection("live"); scheduleRefresh(); };
    source.onmessage = receive;
    for (const type of [
      "run.event",
      "run.started",
      "run.submitted",
      "run.running",
      "run.recovering",
      "run.resuming",
      "run.completed",
      "run.manager_failed",
      "run.cancelled",
      "replay.v2.started",
      "step.started",
      "step.succeeded",
      "step.failed",
      "approval.requested",
      "approval.consumed",
      "approval.accepted",
      "state.recovering",
      "state.business_outcome",
      "state.escalation",
      "evidence.captured",
      "replay.v2.finished",
      "replay.v2.failed",
    ]) source.addEventListener(type, receive as EventListener);
    source.addEventListener("auth.expired", () => {
      source.close();
      expireConsole();
    });
    source.onerror = () => setConnection(navigator.onLine ? "disconnected" : "idle");
    return () => {
      source.close();
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
    };
  }, [activeRunId, activeRun?.phase, online, loadRun, expireConsole]);

  useEffect(() => {
    if (connection !== "disconnected" || !activeRunId || !online) return;
    const timer = window.setInterval(() => void loadRun(activeRunId), 6_000);
    return () => window.clearInterval(timer);
  }, [connection, activeRunId, online, loadRun]);

  useEffect(() => {
    if (!operatorSession || operatorSession.status !== "provisioning" || !online) return;
    let stopped = false;
    let polling = false;
    let missingChecks = 0;
    const check = async () => {
      if (polling) return;
      polling = true;
      const generation = authGeneration.current;
      try {
        if (operatorSession.runId) {
          const run = await getRun(operatorSession.runId);
          if (stopped || generation !== authGeneration.current) return;
          setRuns((current) => mergeRuns(current, run));
          if (run.phase === "completed") {
            if (run.terminalStatus === "success") {
              const auth = await getAuthState();
              if (stopped || generation !== authGeneration.current) return;
              if (!auth) {
                broadcastAuthChange("expired");
                clearOperatorData();
                setPrincipal(null);
                return;
              }
              const target = auth?.meridianSession;
              if (target?.status === "active" && target.profile === operatorSession.profile && target.branch === operatorSession.branch) {
                setOperatorSession((current) => current?.runId === run.id ? { ...current, status: "active" } : current);
                setToast("Secure target session is active. Capability runs are now enabled.");
              } else if (target?.status === "active") {
                setOperatorSession((current) => current?.runId === run.id ? { ...current, status: "failed", message: "The verified target session did not match the requested role and branch." } : current);
              }
            } else {
              setOperatorSession((current) => current?.runId === run.id ? { ...current, status: "failed", message: run.message ?? "Secure sign-on did not complete." } : current);
            }
          }
        } else {
          const auth = await getAuthState();
          if (stopped || generation !== authGeneration.current) return;
          if (!auth) {
            broadcastAuthChange("expired");
            clearOperatorData();
            setPrincipal(null);
          } else if (!auth.meridianSession) {
            missingChecks += 1;
            if (missingChecks >= 3) {
              setOperatorSession((current) => current ? { ...current, status: "failed", message: "The target session is not active on the service." } : current);
            }
          } else if (auth.meridianSession.status === "active" && auth.meridianSession.profile && auth.meridianSession.branch) {
            missingChecks = 0;
            if (auth.meridianSession.profile === operatorSession.profile && auth.meridianSession.branch === operatorSession.branch) {
              setOperatorSession({ profile: auth.meridianSession.profile, branch: auth.meridianSession.branch, status: "active" });
              setToast("Secure target session is active. Capability runs are now enabled.");
            } else {
              setOperatorSession((current) => current ? { ...current, status: "failed", message: "The verified target session did not match the requested role and branch." } : current);
            }
          } else {
            missingChecks = 0;
          }
        }
      } catch (error) {
        if (generation !== authGeneration.current) return;
        if (!stopped && error instanceof ApiError && error.status === 401) {
          broadcastAuthChange("expired");
          clearOperatorData();
          setPrincipal(null);
        }
      } finally {
        polling = false;
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), 2_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [operatorSession?.runId, operatorSession?.status, operatorSession?.profile, operatorSession?.branch, online, clearOperatorData]);

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

  const connectTargetSession = async () => {
    if (!principal || sessionConnecting || !online) return;
    if (sessionProfile === "supervisor" && principal.role !== "supervisor") {
      setActionError({ title: "Supervisor access required", message: "This console identity cannot establish a supervisor target session.", code: "ROLE_REQUIRED" });
      return;
    }
    setSessionConnecting(true);
    setActionError(null);
    const generation = authGeneration.current;
    try {
      const created = await createSession(sessionProfile, sessionBranch);
      if (generation !== authGeneration.current) return;
      const status: OperatorSession["status"] = created.run.phase === "completed" && created.run.terminalStatus !== "success"
        ? "failed"
        : "provisioning";
      setOperatorSession({
        runId: created.run.id,
        profile: sessionProfile,
        branch: sessionBranch,
        status,
        ...(status === "failed" ? { message: created.run.message ?? "Secure sign-on did not complete." } : {}),
      });
      runMutationEpoch.current += 1;
      setRuns((current) => mergeRuns(current, created.run));
      setActiveRunId(created.run.id);
      setSide("activity");
      setToast("Secure sign-on queued. Runs remain disabled until the owned target session is independently verified.");
    } catch (error) {
      if (generation !== authGeneration.current) return;
      if (error instanceof ApiError && error.status === 401) {
        broadcastAuthChange("expired");
        setPrincipal(null);
        clearOperatorData();
        return;
      }
      const uncertain = error instanceof ApiError &&
        (error.status === 0 || error.status === 408 || error.status >= 500 || error.code === "SESSION_ALREADY_ACTIVE");
      if (uncertain) {
        setOperatorSession({ profile: sessionProfile, branch: sessionBranch, status: "provisioning" });
      }
      setActionError({
        title: uncertain ? "Secure session status not confirmed" : "Secure session unavailable",
        message: uncertain
          ? `${errorMessage(error)} Do not retry. The console is reconciling the server-owned session state.`
          : errorMessage(error),
        code: errorCode(error),
      });
    } finally {
      if (generation === authGeneration.current) setSessionConnecting(false);
    }
  };

  const start = async (inputs: Record<string, JsonValue>) => {
    if (!selectedCapability || operatorSession?.status !== "active" || sessionConnecting || submitting || !online) return;
    if (selectedCapability.risk === "supervisor_only" && !supervisorReady) {
      setActionError({ title: "Supervisor session required", message: "Authenticate as a supervisor and establish a supervisor target session before starting this operation.", code: "SUPERVISOR_REQUIRED" });
      return;
    }
    if (containsProtectedMaterial(inputs)) {
      setActionError({
        title: "Protected material blocked",
        message: "One or more business inputs appear to contain a credential or protected authentication field. Remove it before starting the run.",
        code: "PROTECTED_INPUT_BLOCKED",
      });
      return;
    }
    setSubmitting(true);
    setActionError(null);
    const generation = authGeneration.current;
    let fingerprint = "";
    try {
      fingerprint = await requestFingerprint(selectedCapability, inputs);
      const retainedKey = pendingRunRequests.current.get(fingerprint);
      if (!retainedKey && pendingRunRequests.current.size >= 20) {
        throw new ApiError(409, "UNRESOLVED_REQUEST_LIMIT", "Twenty run requests still have unconfirmed outcomes. Reconcile run history or sign out before starting another operation.");
      }
      const idempotencyKey = retainedKey ?? crypto.randomUUID();
      pendingRunRequests.current.set(fingerprint, idempotencyKey);
      const created = await createRun({ capability: selectedCapability, inputs, idempotencyKey });
      if (generation !== authGeneration.current) return;
      runMutationEpoch.current += 1;
      setRuns((current) => mergeRuns(current, created));
      setActiveRunId(created.id);
      setSide("activity");
      setToast("Run started with an idempotent request.");
      pendingRunRequests.current.delete(fingerprint);
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
      setActionError({
        title: outcomeUnconfirmed ? "Run status not confirmed" : idempotencyConflict ? "Request binding changed" : "Run did not start",
        message:
          outcomeUnconfirmed
            ? `${errorMessage(error)} If you try again with the same inputs, the console will reuse the original idempotency key.`
            : idempotencyConflict
              ? "The service rejected this key because it was already bound to different reviewed details. Inspect run history, then submit again to create a new request identity."
            : errorMessage(error),
        code: errorCode(error),
      });
    } finally {
      if (generation === authGeneration.current) setSubmitting(false);
    }
  };

  const approve = async () => {
    if (!activeRun?.challenge || approving || approvalLatch) return;
    const runId = activeRun.id;
    const challengeId = activeRun.challenge.challengeId;
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
    setActiveRunId(run.id);
    setSide("activity");
    void loadRun(run.id, true);
    if (window.matchMedia("(max-width: 980px)").matches) {
      window.requestAnimationFrame(() => {
        if (historyDetailRef.current) revealRegion(historyDetailRef.current);
      });
    }
  };

  const sendChat = async () => {
    const text = chatDraft.trim();
    if (!text || chatSending || chatRequestLatch.current.active || !online) return;
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
        ...(response.routing ? { routing: response.routing } : {}),
      };
      setMessages((current) => [...current, assistant]);
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

  const applyProposal = (message: ChatMessage) => {
    if (!message.proposal) return;
    const capability = capabilities.find(
      (item) =>
        item.id === message.proposal!.capabilityId &&
        item.version === message.proposal!.capabilityVersion &&
        item.digest === message.proposal!.artifactDigest &&
        isRunnable(item),
    );
    if (!capability) {
      setChatError("That capability is not currently approved for launch.");
      return;
    }
    const flattened = flattenProposal(capability, message.proposal.arguments);
    setSelectedKey(capabilityKey(capability));
    setValues(flattened.values);
    setCounts(flattened.counts);
    setView("workspace");
    setSide("activity");
    setToast("Assistant proposal loaded for your review. Nothing has run yet.");
    window.requestAnimationFrame(() => {
      const firstField = capability.inputs.find((field) => !isProtectedField(field));
      const target = firstField
        ? document.getElementById(fieldDomId(fieldPath([firstField.name])))
        : document.getElementById("guided-operation-panel");
      if (target) revealRegion(target);
    });
  };

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
          <button type="button" className={view === "runs" ? "active" : ""} aria-current={view === "runs" ? "page" : undefined} onClick={() => setView("runs")}>Run history <span>{runs.length}</span></button>
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
        <SecureSessionPanel principal={principal} session={operatorSession} profile={sessionProfile} branch={sessionBranch} connecting={sessionConnecting} online={online} onProfile={setSessionProfile} onBranch={setSessionBranch} onConnect={() => void connectTargetSession()} />
        {actionError ? <Alert title={actionError.title} action={<button className="icon-button" type="button" aria-label="Dismiss error" onClick={() => setActionError(null)}>×</button>}><p>{actionError.message}</p><code className="error-code">{actionError.code}</code></Alert> : null}
        {view === "runs" ? (
          <div className="history-layout"><RunHistory runs={runs} capabilities={capabilities} activeId={activeRunId} loading={runsLoading} error={runsError} onSelect={selectRun} onRetry={() => void loadRuns()} /><div ref={historyDetailRef} tabIndex={-1} role="region" aria-label="Selected run details"><RunPanel run={activeRun} capability={activeCapability} connection={connection} liveEvents={liveEvents} loading={runLoading} approving={approving} approvalLatch={approvalLatch} canApproveSupervisor={supervisorReady} cancelling={cancellingRunId === activeRun?.id} online={online} onUnauthorized={expireConsole} onUnavailable={invalidateUnavailableRun} onRefresh={() => void loadRun(activeRunId, true)} onApprove={() => void approve()} onCancel={() => void cancelActiveRun()} /></div></div>
        ) : (
          <div className="workspace-grid">
            <CapabilityCatalog capabilities={capabilities} selectedKey={selectedKey} loading={catalogLoading} error={catalogError} onSelect={chooseCapability} onRetry={() => void loadCatalog()} />
            <GuidedRunForm capability={selectedCapability} values={values} counts={counts} online={online} sessionReady={sessionReady} riskAuthorized={selectedCapability?.risk !== "supervisor_only" || supervisorReady} submitting={submitting} onValues={setValues} onCounts={setCounts} onSubmit={(inputs) => void start(inputs)} />
            <div className="side-column" ref={sidePanelRef} tabIndex={-1} role="region" aria-label={side === "activity" ? "Live activity panel" : "Operations assistant panel"}>
              <div className="side-tabs" aria-label="Workspace side panel"><button aria-pressed={side === "activity"} className={side === "activity" ? "active" : ""} type="button" onClick={() => setSide("activity")}>Activity</button><button aria-pressed={side === "assistant"} className={side === "assistant" ? "active" : ""} type="button" onClick={() => setSide("assistant")}><span aria-hidden="true">✦</span> Assistant</button></div>
              <div id="workspace-side-panel">
                {side === "activity" ? <RunPanel run={activeRun} capability={activeCapability} connection={connection} liveEvents={liveEvents} loading={runLoading || runsLoading} approving={approving} approvalLatch={approvalLatch} canApproveSupervisor={supervisorReady} cancelling={cancellingRunId === activeRun?.id} online={online} onUnauthorized={expireConsole} onUnavailable={invalidateUnavailableRun} onRefresh={() => void loadRun(activeRunId, true)} onApprove={() => void approve()} onCancel={() => void cancelActiveRun()} /> : <ChatPanel messages={messages} draft={chatDraft} sending={chatSending} error={chatError} online={online} onDraft={setChatDraft} onSend={() => void sendChat()} onCancel={cancelChat} onApply={applyProposal} />}
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
