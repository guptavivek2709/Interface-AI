import type { ReactNode } from "react";
import { ApiError } from "../api";
import { humanize } from "../form";
import { isProtectedKey, redactForDisplay } from "../security";
import type { ConnectionState, JsonValue, RiskLevel } from "../types";

export const RISK_LABELS: Record<RiskLevel, string> = {
  read: "Read only",
  write: "Writes data",
  irreversible: "Confirmation required",
  supervisor_only: "Supervisor only",
};

const DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});

export function shortId(value: string): string {
  return value.length > 15 ? `${value.slice(0, 7)}…${value.slice(-5)}` : value;
}

export function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}

export function formatDate(value?: string): string {
  if (!value) return "Not available";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not available";
  return DATE_FORMATTER.format(date);
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return "Something went wrong while contacting the service.";
}

export function Brand(): ReactNode {
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

export function RiskBadge({ risk }: { risk: RiskLevel }): ReactNode {
  return <span className={`badge risk-${risk}`}>{RISK_LABELS[risk]}</span>;
}

export function ConnectionBadge({ state }: { state: ConnectionState }): ReactNode {
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

export function EmptyState({ icon, title, detail }: { icon: string; title: string; detail: string }): ReactNode {
  return (
    <div className="empty-state">
      <span className="empty-icon" aria-hidden="true">{icon}</span>
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}

export function LoadingRows({ count = 3 }: { count?: number }): ReactNode {
  return (
    <div className="loading-rows" aria-label="Loading" role="status">
      {Array.from({ length: count }, (_, index) => <span key={index} />)}
    </div>
  );
}

export function Alert({
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

function scalar(value: JsonValue): string {
  if (value === null) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

export function ValueView({ value, label = "Structured output" }: { value: JsonValue; label?: string }): ReactNode {
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
