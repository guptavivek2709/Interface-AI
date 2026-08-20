import type { RunRecord } from "./types";

/**
 * Keeps an existing owned selection, but never makes an old terminal record look
 * like the current workspace operation after an authentication boundary.
 */
export function nextRunSelection(
  currentRunId: string,
  runs: readonly Pick<RunRecord, "id" | "phase">[],
): string {
  if (currentRunId && runs.some((run) => run.id === currentRunId)) return currentRunId;
  return runs.find((run) => run.phase !== "completed")?.id ?? "";
}

export function withoutRun<T extends Pick<RunRecord, "id">>(runs: readonly T[], runId: string): T[] {
  return runs.filter((run) => run.id !== runId);
}

export function isRetainedRunUnavailable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const source = error as { status?: unknown; code?: unknown };
  return source.status === 404 && source.code === "RUN_NOT_FOUND";
}

/** A synchronous gate around one abortable request, independent of React render timing. */
export class AbortableRequestLatch {
  #controller: AbortController | null = null;

  get active(): boolean {
    return this.#controller !== null;
  }

  begin(): AbortController | null {
    if (this.#controller) return null;
    this.#controller = new AbortController();
    return this.#controller;
  }

  cancel(reason = "cancelled"): void {
    this.#controller?.abort(reason);
  }

  release(controller: AbortController): void {
    if (this.#controller === controller) this.#controller = null;
  }

  reset(reason = "lifecycle_reset"): void {
    const controller = this.#controller;
    this.#controller = null;
    controller?.abort(reason);
  }
}
