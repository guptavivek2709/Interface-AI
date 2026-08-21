import { useEffect, type Dispatch, type SetStateAction } from "react";
import { ApiError, getAuthState, getRun } from "../api";
import type { OperatorSession, RunRecord } from "../types";

export interface UseTargetSessionObserverOptions {
  session: OperatorSession | null;
  setSession: Dispatch<SetStateAction<OperatorSession | null>>;
  online: boolean;
  authGeneration: number;
  onRun(run: RunRecord): void;
  onUnauthorized(): void;
  onToast(message: string): void;
}

/**
 * Reconciles an asynchronous server-owned sign-on run with the independently
 * reported authenticated target session. It never treats run success alone as
 * proof that the requested role and branch became active.
 */
export function useTargetSessionObserver({
  session,
  setSession,
  online,
  authGeneration,
  onRun,
  onUnauthorized,
  onToast,
}: UseTargetSessionObserverOptions): void {
  useEffect(() => {
    if (!session || session.status !== "provisioning" || !online) return;
    let stopped = false;
    let polling = false;
    let missingChecks = 0;
    const check = async () => {
      if (polling) return;
      polling = true;
      try {
        if (session.runId) {
          const run = await getRun(session.runId);
          if (stopped) return;
          onRun(run);
          if (run.phase === "completed") {
            if (run.terminalStatus === "success") {
              const auth = await getAuthState();
              if (stopped) return;
              if (!auth) {
                onUnauthorized();
                return;
              }
              const target = auth.meridianSession;
              if (target?.status === "active" && target.profile === session.profile && target.branch === session.branch) {
                setSession((current) => current?.runId === run.id ? { ...current, status: "active" } : current);
                onToast("Secure target session is active. Capability runs are now enabled.");
              } else if (target?.status === "active") {
                setSession((current) => current?.runId === run.id ? { ...current, status: "failed", message: "The verified target session did not match the requested role and branch." } : current);
              }
            } else {
              setSession((current) => current?.runId === run.id ? { ...current, status: "failed", message: run.message ?? "Secure sign-on did not complete." } : current);
            }
          }
        } else {
          const auth = await getAuthState();
          if (stopped) return;
          if (!auth) {
            onUnauthorized();
          } else if (!auth.meridianSession) {
            missingChecks += 1;
            if (missingChecks >= 3) {
              setSession((current) => current ? { ...current, status: "failed", message: "The target session is not active on the service." } : current);
            }
          } else if (auth.meridianSession.status === "active" && auth.meridianSession.profile && auth.meridianSession.branch) {
            missingChecks = 0;
            if (auth.meridianSession.profile === session.profile && auth.meridianSession.branch === session.branch) {
              setSession({ profile: auth.meridianSession.profile, branch: auth.meridianSession.branch, status: "active" });
              onToast("Secure target session is active. Capability runs are now enabled.");
            } else {
              setSession((current) => current ? { ...current, status: "failed", message: "The verified target session did not match the requested role and branch." } : current);
            }
          } else {
            missingChecks = 0;
          }
        }
      } catch (error) {
        if (!stopped && error instanceof ApiError && error.status === 401) onUnauthorized();
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
  }, [
    session?.runId,
    session?.status,
    session?.profile,
    session?.branch,
    online,
    authGeneration,
    setSession,
    onRun,
    onUnauthorized,
    onToast,
  ]);
}
