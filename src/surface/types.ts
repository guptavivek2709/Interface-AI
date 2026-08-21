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
  framePath: readonly FrameScopeObservation[];
  role: ControlRole;
  name: string;
  tag: string;
  label: string | null;
  nameAttribute: string | null;
  text: string | null;
  value: string | null;
  disabled: boolean;
}

interface ObservedSemanticTargetBase {
  /** Observation-scoped reference. It is never persisted as a replay locator. */
  ref: string;
  framePath: readonly FrameScopeObservation[];
  /** Privacy-safe display name used only by the planner and policy journal. */
  name: string;
}

/**
 * Durable page semantics that cannot be represented by a globally unique
 * accessibility control. Values and row keys are deliberately excluded.
 */
export type ObservedSemanticTarget =
  | (ObservedSemanticTargetBase & {
      kind: "label_value";
      label: string;
      valueCellOffset: number;
    })
  | (ObservedSemanticTargetBase & {
      kind: "table";
      headers: string[];
      nearText?: string;
    })
  | (ObservedSemanticTargetBase & {
      kind: "table_row_value";
      headers: string[];
      keyColumn: string;
      /** Invocation value is recovered from inputs at action/replay time. */
      keyInputName: string;
      valueColumn: string;
    })
  | (ObservedSemanticTargetBase & {
      kind: "table_row_control";
      headers: string[];
      keyColumn: string;
      /** Invocation value is recovered from inputs at action/replay time. */
      keyInputName: string;
      controlRole: ControlRole;
      controlName: string;
    });

export type ObservedTarget = ObservedControl | ObservedSemanticTarget;

export interface ObservedFrame {
  framePath: readonly FrameScopeObservation[];
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
  semanticTargets?: ObservedSemanticTarget[];
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
  observe(inputs?: Readonly<Record<string, string | number | boolean>>): Promise<SurfaceObservation>;
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
