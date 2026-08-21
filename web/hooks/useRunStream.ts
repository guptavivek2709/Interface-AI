import { useEffect, useState } from "react";
import { eventsUrl, normalizeLiveEvent, normalizeRun } from "../api";
import type { ConnectionState, LiveEvent, RunRecord } from "../types";

const RUN_EVENT_TYPES = [
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
  "intervention.requested",
  "intervention.taken",
  "intervention.action_completed",
  "intervention.resume_accepted",
  "state.recovering",
  "state.business_outcome",
  "state.escalation",
  "evidence.captured",
  "replay.v2.finished",
  "replay.v2.failed",
] as const;

export interface ParsedRunStreamEvent {
  sequence: number;
  live: LiveEvent;
  snapshot?: RunRecord;
}

export function parseRunStreamEvent(
  data: string,
  eventType: string,
  lastEventId: string,
  expectedRunId: string,
  highestSequence: number,
): ParsedRunStreamEvent | null {
  let payload: unknown;
  try { payload = JSON.parse(data) as unknown; } catch { return null; }
  const envelope = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  const runEnvelope = envelope.run && typeof envelope.run === "object" && !Array.isArray(envelope.run) ? envelope.run as Record<string, unknown> : {};
  const reportedRun = typeof runEnvelope.id === "string" ? runEnvelope.id : typeof envelope.runId === "string" ? envelope.runId : "";
  if (reportedRun && reportedRun !== expectedRunId) return null;
  const sequence = typeof envelope.sequence === "number" ? envelope.sequence : Number(lastEventId || 0);
  if (sequence && sequence <= highestSequence) return null;
  const snapshot = normalizeRun(envelope.snapshot);
  return {
    sequence: Math.max(highestSequence, sequence || highestSequence),
    live: normalizeLiveEvent(envelope.event ?? payload, eventType || "message", lastEventId),
    ...(snapshot?.id === expectedRunId ? { snapshot } : {}),
  };
}

export interface UseRunStreamOptions {
  activeRunId: string;
  activeRun: RunRecord | undefined;
  online: boolean;
  authGeneration: number;
  onSnapshot(run: RunRecord): void;
  onRefresh(runId: string): void;
  onUnauthorized(): void;
}

export interface RunStreamState {
  connection: ConnectionState;
  liveEvents: LiveEvent[];
}

export function useRunStream({
  activeRunId,
  activeRun,
  online,
  authGeneration,
  onSnapshot,
  onRefresh,
  onUnauthorized,
}: UseRunStreamOptions): RunStreamState {
  const [connection, setConnection] = useState<ConnectionState>("idle");
  const [liveEvents, setLiveEvents] = useState<LiveEvent[]>([]);

  useEffect(() => {
    setLiveEvents([]);
    if (!activeRunId || !online || activeRun?.phase === "completed") {
      setConnection("idle");
      return;
    }
    setConnection("connecting");
    const source = new EventSource(eventsUrl(activeRunId), { withCredentials: true });
    let highestSequence = 0;
    let refreshTimer: number | undefined;
    const scheduleRefresh = () => {
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => onRefresh(activeRunId), 180);
    };
    const receive = (event: MessageEvent<string>) => {
      const parsed = parseRunStreamEvent(event.data, event.type, event.lastEventId, activeRunId, highestSequence);
      if (!parsed) return;
      highestSequence = parsed.sequence;
      setLiveEvents((current) => current.some((item) => item.id === parsed.live.id) ? current : [...current, parsed.live].slice(-120));
      if (parsed.snapshot) onSnapshot(parsed.snapshot);
      else scheduleRefresh();
    };
    source.onopen = () => { setConnection("live"); scheduleRefresh(); };
    source.onmessage = receive;
    for (const type of RUN_EVENT_TYPES) source.addEventListener(type, receive as EventListener);
    source.addEventListener("auth.expired", () => {
      source.close();
      onUnauthorized();
    });
    source.onerror = () => setConnection(navigator.onLine ? "disconnected" : "idle");
    return () => {
      source.close();
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
    };
  }, [activeRunId, activeRun?.phase, online, authGeneration, onSnapshot, onRefresh, onUnauthorized]);

  useEffect(() => {
    if (connection !== "disconnected" || !activeRunId || !online) return;
    const timer = window.setInterval(() => onRefresh(activeRunId), 6_000);
    return () => window.clearInterval(timer);
  }, [connection, activeRunId, online, onRefresh]);

  return { connection, liveEvents };
}
