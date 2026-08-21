import { isRunnable } from "./form";
import type {
  Capability,
  ChatSequenceExecution,
  ChatSequencePlan,
  ChatSequenceStep,
  ChatSequenceStepExecution,
  RunRecord,
} from "./types";

export function resolveSequenceCapability(
  capabilities: readonly Capability[],
  step: ChatSequenceStep,
): Capability | undefined {
  return capabilities.find((capability) =>
    capability.id === step.capabilityId &&
    capability.version === step.capabilityVersion &&
    capability.digest === step.artifactDigest &&
    capability.targetProfileDigest === step.targetProfileDigest &&
    isRunnable(capability),
  );
}

export function initialSequenceExecution(plan: ChatSequencePlan): ChatSequenceExecution {
  return {
    state: "connecting",
    currentStepIndex: 0,
    steps: plan.steps.map((step) => ({ stepId: step.stepId, state: "pending" })),
  };
}

export function updateSequenceStep(
  execution: ChatSequenceExecution,
  stepIndex: number,
  step: ChatSequenceStepExecution,
  state: ChatSequenceExecution["state"] = execution.state,
): ChatSequenceExecution {
  if (stepIndex < 0 || stepIndex >= execution.steps.length || execution.steps[stepIndex]?.stepId !== step.stepId) {
    return {
      ...execution,
      state: "rejected",
      code: "SEQUENCE_EXECUTION_MISMATCH",
      message: "The local sequence state no longer matches the reviewed plan.",
    };
  }
  const { selection: _selection, ...withoutSelection } = execution;
  return {
    ...(state === "selection_required" ? execution : withoutSelection),
    state,
    currentStepIndex: stepIndex,
    steps: execution.steps.map((current, index) => index === stepIndex ? step : current),
  };
}

export function sequenceRunMatchesStep(
  run: RunRecord,
  plan: ChatSequencePlan,
  step: ChatSequenceStep,
  stepIndex: number,
): boolean {
  return run.capabilityId === step.capabilityId &&
    run.capabilityVersion === step.capabilityVersion &&
    run.artifactDigest === step.artifactDigest &&
    run.targetProfileDigest === step.targetProfileDigest &&
    run.orchestration?.kind === "chat_sequence" &&
    run.orchestration.sequenceId === plan.sequenceId &&
    run.orchestration.stepId === step.stepId &&
    run.orchestration.stepIndex === stepIndex &&
    run.orchestration.stepCount === plan.steps.length;
}
