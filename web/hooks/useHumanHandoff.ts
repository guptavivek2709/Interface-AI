import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  createHandoffInvitation,
  performHandoffAction,
  redeemHandoffInvitation,
  resumeHumanControl,
  takeHumanControl,
  type HandoffInvitation,
} from "../api";
import type { HumanIntervention, RunRecord } from "../types";

export type HandoffOperation = "taking" | "acting" | "resuming" | "inviting" | "redeeming";

export interface HumanHandoffController {
  busy: HandoffOperation | null;
  error: string;
  invitation: HandoffInvitation | null;
  take(): Promise<void>;
  perform(): Promise<void>;
  resume(): Promise<void>;
  createInvitation(): Promise<void>;
  redeem(token: string): Promise<void>;
  clearInvitation(): void;
}

export interface UseHumanHandoffOptions {
  run: RunRecord | undefined;
  authEpoch: number;
  onRun(run: RunRecord): void;
  onUnauthorized(): void;
}

function currentIntervention(run: RunRecord | undefined): HumanIntervention | undefined {
  return run?.phase === "awaiting_human" && run.intervention?.runId === run.id
    ? run.intervention
    : undefined;
}

export function useHumanHandoff({ run, authEpoch, onRun, onUnauthorized }: UseHumanHandoffOptions): HumanHandoffController {
  const [busy, setBusy] = useState<HandoffOperation | null>(null);
  const [error, setError] = useState("");
  const [invitation, setInvitation] = useState<HandoffInvitation | null>(null);
  const runRef = useRef(run);
  const authEpochRef = useRef(authEpoch);
  const busyRef = useRef<HandoffOperation | null>(null);
  runRef.current = run;
  authEpochRef.current = authEpoch;

  useEffect(() => {
    if (!invitation) return;
    const intervention = currentIntervention(run);
    if (
      !intervention ||
      invitation.runId !== run?.id ||
      invitation.interventionId !== intervention.interventionId
    ) setInvitation(null);
  }, [run?.id, run?.intervention?.interventionId, run?.phase, invitation]);

  const begin = useCallback((operation: HandoffOperation): boolean => {
    if (busyRef.current) return false;
    busyRef.current = operation;
    setBusy(operation);
    setError("");
    return true;
  }, []);

  const finish = useCallback(() => {
    busyRef.current = null;
    setBusy(null);
  }, []);

  const fail = useCallback((caught: unknown) => {
    if (caught instanceof ApiError && caught.status === 401) {
      onUnauthorized();
      return;
    }
    setError(caught instanceof Error ? caught.message : "The handoff request could not be completed.");
  }, [onUnauthorized]);

  const withCurrent = useCallback(async (
    operation: HandoffOperation,
    expectedState: HumanIntervention["state"],
    request: (runId: string, intervention: HumanIntervention) => Promise<RunRecord>,
  ) => {
    if (!begin(operation)) return;
    try {
      const requestEpoch = authEpochRef.current;
      const current = runRef.current;
      const intervention = currentIntervention(current);
      if (!current || !intervention || intervention.state !== expectedState) {
        throw new ApiError(409, "INTERVENTION_NOT_CURRENT", "Refresh the run before continuing this handoff.");
      }
      const updated = await request(current.id, intervention);
      if (requestEpoch === authEpochRef.current) onRun(updated);
    } catch (caught) {
      fail(caught);
    } finally {
      finish();
    }
  }, [begin, fail, finish, onRun]);

  const take = useCallback(() => withCurrent(
    "taking",
    "awaiting_human",
    (runId, intervention) => takeHumanControl(runId, intervention.interventionId),
  ), [withCurrent]);

  const perform = useCallback(() => withCurrent(
    "acting",
    "human_active",
    (runId, intervention) => performHandoffAction(runId, intervention.interventionId, intervention.action),
  ), [withCurrent]);

  const resume = useCallback(() => withCurrent(
    "resuming",
    "action_completed",
    (runId, intervention) => resumeHumanControl(runId, intervention.interventionId),
  ), [withCurrent]);

  const createInvitation = useCallback(async () => {
    if (!begin("inviting")) return;
    try {
      const requestEpoch = authEpochRef.current;
      const current = runRef.current;
      const intervention = currentIntervention(current);
      if (
        !current ||
        !intervention ||
        intervention.action !== "authenticate_supervisor" ||
        !intervention.requiredRole
      ) {
        throw new ApiError(409, "INTERVENTION_NOT_DELEGATABLE", "This run does not have a current delegated-role handoff.");
      }
      const created = await createHandoffInvitation(current.id, intervention.interventionId);
      if (requestEpoch === authEpochRef.current) setInvitation(created);
    } catch (caught) {
      fail(caught);
    } finally {
      finish();
    }
  }, [begin, fail, finish]);

  const redeem = useCallback(async (token: string) => {
    if (!begin("redeeming")) return;
    try {
      const requestEpoch = authEpochRef.current;
      const updated = await redeemHandoffInvitation(token.trim());
      if (requestEpoch === authEpochRef.current) onRun(updated);
    } catch (caught) {
      fail(caught);
    } finally {
      finish();
    }
  }, [begin, fail, finish, onRun]);

  return {
    busy,
    error,
    invitation,
    take,
    perform,
    resume,
    createInvitation,
    redeem,
    clearInvitation: useCallback(() => setInvitation(null), []),
  };
}
