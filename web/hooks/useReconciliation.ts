import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, getReconciliation, startReconciliation } from "../api";
import type { ReconciliationRecord, RunRecord } from "../types";

export interface ReconciliationController {
  sourceRunId: string;
  record: ReconciliationRecord | null;
  busy: boolean;
  checking: boolean;
  error: string;
  start(): Promise<void>;
  refresh(): Promise<void>;
}

export interface UseReconciliationOptions {
  run: RunRecord | undefined;
  online: boolean;
  onRun(run: RunRecord, focus: boolean): void;
  onUnauthorized(): void;
}

function reconciliationSource(run: RunRecord | undefined): string {
  if (run?.phase === "completed" && run.terminalStatus === "failure" && run.effectUncertain) return run.id;
  return run?.orchestration?.kind === "reconciliation" ? run.orchestration.sourceRunId : "";
}

export function useReconciliation({
  run,
  online,
  onRun,
  onUnauthorized,
}: UseReconciliationOptions): ReconciliationController {
  const sourceRunId = reconciliationSource(run);
  const [record, setRecord] = useState<ReconciliationRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const requestRef = useRef(false);

  useEffect(() => {
    setRecord(null);
    setError("");
  }, [sourceRunId]);

  const applyError = useCallback((caught: unknown) => {
    if (caught instanceof ApiError && caught.status === 401) {
      onUnauthorized();
      return;
    }
    setError(caught instanceof Error ? caught.message : "The reconciliation request could not be completed.");
  }, [onUnauthorized]);

  const refresh = useCallback(async () => {
    if (!sourceRunId || !online || requestRef.current) return;
    requestRef.current = true;
    setChecking(true);
    try {
      const response = await getReconciliation(sourceRunId);
      setRecord(response.reconciliation);
      setError("");
      if (response.run) onRun(response.run, false);
    } catch (caught) {
      applyError(caught);
    } finally {
      requestRef.current = false;
      setChecking(false);
    }
  }, [sourceRunId, online, onRun, applyError]);

  useEffect(() => {
    if (!sourceRunId || !online) return;
    void refresh();
  }, [sourceRunId, online, run?.phase, run?.revision, refresh]);

  useEffect(() => {
    if (!sourceRunId || !online || !record || !["running", "running_or_complete"].includes(record.status)) return;
    const timer = window.setInterval(() => void refresh(), 2_500);
    return () => window.clearInterval(timer);
  }, [sourceRunId, online, record?.status, refresh]);

  const start = useCallback(async () => {
    if (!sourceRunId || !online || busy || requestRef.current) return;
    requestRef.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await startReconciliation(sourceRunId);
      setRecord(response.reconciliation);
      if (response.run) onRun(response.run, true);
    } catch (caught) {
      applyError(caught);
    } finally {
      requestRef.current = false;
      setBusy(false);
    }
  }, [sourceRunId, online, busy, onRun, applyError]);

  return { sourceRunId, record, busy, checking, error, start, refresh };
}
