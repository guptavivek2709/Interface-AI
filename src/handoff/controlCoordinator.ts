import { randomUUID } from "node:crypto";

export type ControlOwner = "automation" | "human" | "none";
export type ControlPhase =
  | "automation_active"
  | "pausing"
  | "awaiting_human"
  | "human_active"
  | "resuming"
  | "terminal";

export interface ControlLease {
  sessionId: string;
  owner: Exclude<ControlOwner, "none">;
  ownerId: string;
  epoch: number;
}

export interface InterventionContext {
  runId: string;
  capabilityId: string;
  goal: string;
  stepId: string;
  reasonCode: string;
  reason: string;
  screenshotPath: string;
  observedState: string;
}

export interface InterventionRequest extends InterventionContext {
  interventionId: string;
  sessionId: string;
  createdAt: string;
  phase: "awaiting_human" | "human_active";
  operatorId: string | null;
  leaseEpoch: number;
}

export interface ControlEvent {
  type: string;
  actor: "system" | "automation" | "human";
  data: Record<string, unknown>;
}

export type ControlEventSink = (event: ControlEvent) => void | Promise<void>;

export class ControlCoordinator {
  readonly sessionId: string;
  readonly #automationId: string;
  readonly #sink: ControlEventSink;
  #phase: ControlPhase = "automation_active";
  #owner: ControlOwner = "automation";
  #ownerId: string;
  #epoch = 1;
  #intervention: InterventionRequest | null = null;
  #resumeWaiters: Array<() => void> = [];
  #humanActionInFlight = false;

  constructor(options: {
    sessionId: string;
    automationId?: string;
    eventSink?: ControlEventSink;
  }) {
    this.sessionId = options.sessionId;
    this.#automationId = options.automationId ?? "replay-engine";
    this.#ownerId = this.#automationId;
    this.#sink = options.eventSink ?? (() => undefined);
  }

  get phase(): ControlPhase {
    return this.#phase;
  }

  get intervention(): InterventionRequest | null {
    return this.#intervention ? { ...this.#intervention } : null;
  }

  automationLease(): ControlLease {
    if (this.#phase !== "automation_active" || this.#owner !== "automation") {
      throw new Error(`Automation does not own session ${this.sessionId}; phase=${this.#phase}`);
    }
    return {
      sessionId: this.sessionId,
      owner: "automation",
      ownerId: this.#ownerId,
      epoch: this.#epoch,
    };
  }

  assertLease(lease: ControlLease): void {
    if (
      lease.sessionId !== this.sessionId ||
      lease.epoch !== this.#epoch ||
      lease.owner !== this.#owner ||
      lease.ownerId !== this.#ownerId
    ) {
      throw new Error(
        `Stale control lease: expected ${this.#owner}/${this.#ownerId}@${this.#epoch}, ` +
          `received ${lease.owner}/${lease.ownerId}@${lease.epoch}`,
      );
    }
  }

  async requestIntervention(context: InterventionContext): Promise<InterventionRequest> {
    if (this.#phase !== "automation_active") {
      throw new Error(`Cannot request intervention while phase=${this.#phase}`);
    }
    this.#phase = "pausing";
    this.#owner = "none";
    this.#ownerId = "";
    this.#epoch += 1;
    await this.#sink({
      type: "control.pausing",
      actor: "automation",
      data: { sessionId: this.sessionId, stepId: context.stepId, reasonCode: context.reasonCode },
    });
    this.#phase = "awaiting_human";
    this.#intervention = {
      ...context,
      interventionId: randomUUID(),
      sessionId: this.sessionId,
      createdAt: new Date().toISOString(),
      phase: "awaiting_human",
      operatorId: null,
      leaseEpoch: this.#epoch,
    };
    await this.#sink({
      type: "intervention.requested",
      actor: "system",
      data: { ...this.#intervention },
    });
    return { ...this.#intervention };
  }

  async takeHumanControl(operatorId: string): Promise<ControlLease> {
    if (!operatorId.trim()) throw new Error("operatorId is required");
    if (this.#phase !== "awaiting_human" || !this.#intervention) {
      throw new Error(`No intervention is awaiting a human; phase=${this.#phase}`);
    }
    this.#phase = "human_active";
    this.#owner = "human";
    this.#ownerId = operatorId;
    this.#epoch += 1;
    this.#intervention = {
      ...this.#intervention,
      phase: "human_active",
      operatorId,
      leaseEpoch: this.#epoch,
    };
    const lease: ControlLease = {
      sessionId: this.sessionId,
      owner: "human",
      ownerId: operatorId,
      epoch: this.#epoch,
    };
    await this.#sink({
      type: "control.transferred",
      actor: "human",
      data: { sessionId: this.sessionId, operatorId, epoch: this.#epoch },
    });
    return lease;
  }

  async recordHumanAction(
    lease: ControlLease,
    description: string,
    execute: () => Promise<unknown>,
  ): Promise<void> {
    this.assertLease(lease);
    if (this.#humanActionInFlight) throw new Error("A human action is already in flight");
    this.#humanActionInFlight = true;
    try {
      await this.#sink({
        type: "human.action.started",
        actor: "human",
        data: { sessionId: this.sessionId, operatorId: lease.ownerId, description },
      });
      this.assertLease(lease);
      await execute();
      this.assertLease(lease);
      await this.#sink({
        type: "human.action.completed",
        actor: "human",
        data: { sessionId: this.sessionId, operatorId: lease.ownerId, description },
      });
    } finally {
      this.#humanActionInFlight = false;
    }
  }

  async resumeAutomation(lease: ControlLease): Promise<ControlLease> {
    this.assertLease(lease);
    if (this.#humanActionInFlight) throw new Error("Cannot resume while a human action is in flight");
    if (this.#phase !== "human_active" || lease.owner !== "human") {
      throw new Error(`Only the active human operator can resume; phase=${this.#phase}`);
    }
    this.#phase = "resuming";
    this.#owner = "none";
    this.#ownerId = "";
    this.#epoch += 1;
    await this.#sink({
      type: "control.resuming",
      actor: "human",
      data: { sessionId: this.sessionId, operatorId: lease.ownerId, epoch: this.#epoch },
    });
    this.#phase = "automation_active";
    this.#owner = "automation";
    this.#ownerId = this.#automationId;
    this.#epoch += 1;
    this.#intervention = null;
    const automationLease = this.automationLease();
    await this.#sink({
      type: "control.transferred",
      actor: "automation",
      data: {
        sessionId: this.sessionId,
        automationId: this.#automationId,
        epoch: this.#epoch,
      },
    });
    for (const resolve of this.#resumeWaiters.splice(0)) resolve();
    return automationLease;
  }

  async waitForAutomation(timeoutMs = 120_000): Promise<ControlLease> {
    if (this.#phase === "automation_active") return this.automationLease();
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#resumeWaiters = this.#resumeWaiters.filter((waiter) => waiter !== done);
        reject(new Error(`Human intervention timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const done = () => {
        clearTimeout(timeout);
        resolve();
      };
      this.#resumeWaiters.push(done);
    });
    return this.automationLease();
  }

  async terminate(): Promise<void> {
    this.#phase = "terminal";
    this.#owner = "none";
    this.#ownerId = "";
    this.#epoch += 1;
    await this.#sink({
      type: "control.terminal",
      actor: "system",
      data: { sessionId: this.sessionId, epoch: this.#epoch },
    });
  }
}
