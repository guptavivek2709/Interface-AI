import type { RunIncident } from "./types.js";

export function incidentPresentation(category: RunIncident["category"]): {
  icon: string;
  label: string;
} {
  switch (category) {
    case "recoverable":
      return { icon: "↻", label: "Recovery" };
    case "intervention":
      return { icon: "⇄", label: "Human handoff" };
    case "escalation":
      return { icon: "!", label: "Escalation" };
    default:
      return { icon: "!", label: "Failure" };
  }
}
