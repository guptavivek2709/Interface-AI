export type ControlRole =
  | "button"
  | "link"
  | "textbox"
  | "combobox"
  | "checkbox"
  | "radio"
  | "heading"
  | "status"
  | "generic";

export interface FrameScopeObservation {
  title: string;
  url: string;
}

export interface ObservedControl {
  ref: string;
  framePath: FrameScopeObservation[];
  role: ControlRole;
  name: string;
  tag: string;
  label: string | null;
  nameAttribute: string | null;
  text: string | null;
  value: string | null;
  disabled: boolean;
}

export interface ObservedFrame {
  framePath: FrameScopeObservation[];
  url: string;
  title: string;
  headings: string[];
  visibleText: string;
}

export interface SurfaceObservation {
  capturedAt: string;
  url: string;
  title: string;
  /** Latest HTTP status observed for the main frame's document response. */
  httpStatus: number | null;
  controls: ObservedControl[];
  frames: ObservedFrame[];
  visibleText: string;
  stateHash: string;
  screenshotPath: string;
}

export interface ActionReceipt {
  startedAt: string;
  completedAt: string;
  targetRef?: string;
  observedValue?: string;
}

export interface EvidenceCapture {
  screenshotPath: string;
  domSnapshotPath: string;
}

/**
 * Discovery-facing computer-use seam. A native desktop/UIA adapter can expose
 * the same observation and action journal contract without changing the model
 * planner or artifact compiler.
 */
export interface DiscoverySurface extends HandoffSurface {
  observe(): Promise<SurfaceObservation>;
  actFromObservation(
    action: import("../model/planner.js").PlannerAction,
    observation: SurfaceObservation,
    inputs: Record<string, string | number | boolean>,
  ): Promise<ActionReceipt>;
}

/** Same-session manual-control seam shared by discovery and replay. */
export interface HandoffSurface {
  readonly sessionId: string;
  readonly sessionRef: string;
  humanClick(accessibleName: string): Promise<ActionReceipt>;
}
