import { useEffect, useRef, type ReactNode } from "react";
import { humanize, isRunnable } from "../form";
import { contractValues } from "../security";
import type { Capability, ChatApprovalExecution, ChatMessage, ConnectionState, JsonValue, RunRecord } from "../types";
import { Outcome } from "./RunDetail";
import {
  Alert,
  ConnectionBadge,
  RISK_LABELS,
  RiskBadge,
  ValueView,
  formatDate,
  shortId,
} from "./common";

type ChatProposal = NonNullable<ChatMessage["proposal"]>;

function resolveProposalCapability(
  capabilities: readonly Capability[],
  proposal: ChatProposal,
): Capability | undefined {
  return capabilities.find(
    (item) =>
      item.id === proposal.capabilityId &&
      item.version === proposal.capabilityVersion &&
      item.digest === proposal.artifactDigest &&
      item.targetProfileDigest === proposal.targetProfileDigest &&
      isRunnable(item),
  );
}

function preferredScrollBehavior(): ScrollBehavior {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

function ChatRunCard({
  run,
  capability,
  approval,
  active,
  connection,
  onOpen,
}: {
  run: RunRecord | undefined;
  capability: Capability | undefined;
  approval: ChatApprovalExecution | undefined;
  active: boolean;
  connection: ConnectionState;
  onOpen(run: RunRecord): void;
}): ReactNode {
  if (!run) {
    return <Alert tone="info" title="Run record unavailable">Refresh run history before starting a replacement operation.</Alert>;
  }
  const latest = run.journal.at(-1);
  const displayOutputs = run.outputsDisplaySafe === true
    ? contractValues(run.outputs, capability?.outputs)
    : undefined;
  const boundApproval = run.challenge && approval?.challengeId === run.challenge.challengeId
    ? approval
    : undefined;
  const phaseCopy = run.phase === "queued"
    ? "The approved request is queued and has not entered a browser step."
    : run.phase === "running"
      ? latest?.title ?? "The deterministic runner is executing the approved artifact."
      : run.phase === "recovering"
        ? "A bounded recovery is in progress from an approved checkpoint."
        : run.phase === "awaiting_approval"
          ? boundApproval?.state === "submitting"
            ? "The exact server challenge is being submitted once under this authenticated Send authorization."
            : boundApproval?.state === "accepted"
              ? "The bound approval was accepted. The console is waiting for the next authoritative run snapshot."
              : boundApproval?.state === "unconfirmed"
                ? "The approval outcome is unconfirmed. The console will reconcile it without another automatic attempt."
                : boundApproval?.state === "rejected"
                  ? "Automatic approval stopped safely at this checkpoint."
                  : "The console is validating the exact server-issued approval challenge."
          : run.phase === "awaiting_human"
            ? "Automation paused because this state requires human attention."
            : "The run reached a terminal state.";
  return (
    <section className={`chat-run-card chat-run-${run.terminalStatus ?? run.phase}`} aria-label={`Run ${shortId(run.id)} status`}>
      <div className="chat-run-heading">
        <div><span className={`status-orb status-${run.terminalStatus ?? run.phase}`} aria-hidden="true" /><div><strong>{capability?.name ?? humanize(run.capabilityId)}</strong><small>Run {shortId(run.id)}</small></div></div>
        {active && run.phase !== "completed" ? <ConnectionBadge state={connection} /> : <span className="chat-run-phase">{humanize(run.terminalStatus ?? run.phase)}</span>}
      </div>
      {run.terminalStatus ? <Outcome run={run} /> : <div className="chat-run-copy" role="status">{phaseCopy}</div>}
      {run.phase === "awaiting_approval" && boundApproval?.state === "submitting" ? <Alert tone="warning" title="Submitting bound approval">Only this run ID and server-issued challenge ID are being sent. The model cannot provide approval material.</Alert> : null}
      {run.phase === "awaiting_approval" && boundApproval?.state === "accepted" ? <Alert tone="info" title="Bound approval accepted">The service accepted this challenge. No second approval will be sent while its state is reconciled.</Alert> : null}
      {run.phase === "awaiting_approval" && boundApproval?.state === "unconfirmed" ? <Alert tone="warning" title="Approval status unconfirmed">{boundApproval.message ?? "No automatic retry will be made for this challenge."}{boundApproval.code ? ` (${boundApproval.code})` : ""}</Alert> : null}
      {run.phase === "awaiting_approval" && boundApproval?.state === "rejected" ? <Alert title="Automatic approval stopped">{boundApproval.message ?? "The exact challenge did not pass the local authorization checks."}{boundApproval.code ? ` (${boundApproval.code})` : ""}</Alert> : null}
      {run.phase === "awaiting_approval" && !boundApproval ? <Alert tone="warning" title="Validating approval checkpoint">The console will fail closed unless the run, capability digest, review projection, session role, and challenge all match this authenticated request.</Alert> : null}
      {displayOutputs ? <div className="chat-run-output"><strong>Verified output</strong><ValueView value={displayOutputs} label="Run output" /></div> : null}
      {run.outputs && !displayOutputs ? <Alert tone="info" title="Output withheld">The service did not mark this result as display-safe under the approved output contract.</Alert> : null}
      <button className="button quiet small" type="button" onClick={() => onOpen(run)}>View run details <span aria-hidden="true">→</span></button>
    </section>
  );
}

function valueAtPath(root: JsonValue | undefined, path: readonly string[]): JsonValue | undefined {
  let current = root;
  for (const segment of path) {
    if (!current || typeof current !== "object" || Array.isArray(current) || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

export interface ChatPanelProps {
  messages: ChatMessage[];
  capabilities: Capability[];
  runs: RunRecord[];
  activeRunId: string;
  connection: ConnectionState;
  draft: string;
  sending: boolean;
  automationBusy: boolean;
  error: string;
  online: boolean;
  onDraft(value: string): void;
  onSend(): void;
  onCancel(): void;
  onOpenRun(run: RunRecord): void;
  onSelectSequence(messageId: string, selectionIndex: number): void;
}

export function ChatPanel({
  messages,
  capabilities,
  runs,
  activeRunId,
  connection,
  draft,
  sending,
  automationBusy,
  error,
  online,
  onDraft,
  onSend,
  onCancel,
  onOpenRun,
  onSelectSequence,
}: ChatPanelProps): ReactNode {
  const logRef = useRef<HTMLDivElement>(null);
  const observedRunState = messages.map((message) => {
    const run = message.execution?.runId ? runs.find((item) => item.id === message.execution?.runId) : undefined;
    return run ? `${run.id}:${run.revision ?? run.updatedAt ?? run.phase}` : message.execution?.state ?? "";
  }).join("|");
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: preferredScrollBehavior() });
  }, [messages, observedRunState]);
  return (
    <section className="panel assistant-panel" aria-labelledby="assistant-title">
      <div className="panel-heading"><div><p className="eyebrow">Model-routed · server guarded</p><h2 id="assistant-title">Operations assistant</h2></div><span className="assistant-spark" aria-hidden="true">✦</span></div>
      <div className="assistant-safety"><span aria-hidden="true">◆</span><p><strong>Keep credentials out of chat.</strong> Passwords, tokens, and sign-in details are resolved only by the service.</p></div>
      <div className="message-log" role="log" aria-live="polite" ref={logRef}>
        {messages.length === 0 ? <div className="assistant-welcome"><span aria-hidden="true">✦</span><h3>How can I help?</h3><p>Describe the outcome you need. An authenticated Send can start an exact approved capability, while the service keeps credentials, session authority, and approval challenges outside the model.</p><div className="suggestions">{["Show available read capabilities", "How do approvals work?", "Look up member balances"].map((suggestion) => <button type="button" key={suggestion} onClick={() => onDraft(suggestion)}>{suggestion}</button>)}</div></div> : null}
        {messages.map((message) => {
          const capability = message.proposal ? resolveProposalCapability(capabilities, message.proposal) : undefined;
          const run = message.execution?.runId ? runs.find((item) => item.id === message.execution?.runId) : undefined;
          const displayArguments = message.proposal && capability
            ? contractValues(message.proposal.arguments, capability.inputs)
            : undefined;
          return (
            <article className={`message message-${message.role}`} key={message.id}>
              <span>{message.role === "assistant" ? "Bridge" : "You"}</span>
              <p>{message.text}</p>
              {message.proposal ? (
                <section className="chat-proposal-card" aria-label="Capability proposal">
                  <div className="chat-proposal-heading"><div><strong>{capability?.name ?? humanize(message.proposal.capabilityId)}</strong><small>v{message.proposal.capabilityVersion} · {capability ? RISK_LABELS[capability.risk] : "Unavailable"}</small></div>{capability ? <RiskBadge risk={capability.risk} /> : null}</div>
                  {displayArguments ? <div className="chat-proposal-inputs"><strong>Proposed inputs</strong><ValueView value={displayArguments} label="Proposed inputs" /></div> : null}
                  {message.execution?.state === "connecting" ? <div className="chat-proposal-note" role="status"><span className="spinner" aria-hidden="true" /> Establishing the authorized server-managed target session…</div> : null}
                  {message.execution?.state === "starting" ? <div className="chat-proposal-note" role="status"><span className="spinner" aria-hidden="true" /> Starting the exact approved capability…</div> : null}
                  {!message.execution ? <div className="chat-proposal-note" role="status">The validated request is being prepared for deterministic execution.</div> : null}
                  {message.execution?.state === "unconfirmed" ? <div className="chat-proposal-warning" role="alert">{message.execution.message ?? "The run start was not confirmed. Reconcile it with the same idempotent request before starting anything else."}</div> : null}
                  {message.execution?.state === "rejected" ? <div className="chat-proposal-error" role="alert">{message.execution.message ?? "The run did not start."}{message.execution.code ? <code>{message.execution.code}</code> : null}</div> : null}
                  {message.execution?.runId ? <ChatRunCard run={run} capability={capability} approval={message.execution.approval} active={activeRunId === message.execution.runId} connection={connection} onOpen={onOpenRun} /> : null}
                </section>
              ) : null}
              {message.sequence && message.sequenceExecution ? (() => {
                const sequence = message.sequence;
                const execution = message.sequenceExecution;
                const selection = execution.selection;
                const sourceIndex = selection ? sequence.steps.findIndex((step) => step.stepId === selection.sourceStepId) : -1;
                const sourceExecution = sourceIndex >= 0 ? execution.steps[sourceIndex] : undefined;
                const sourceRun = sourceExecution?.runId ? runs.find((item) => item.id === sourceExecution.runId) : undefined;
                const sourceCapability = sourceIndex >= 0 ? resolveProposalCapability(capabilities, {
                  capabilityId: sequence.steps[sourceIndex]!.capabilityId,
                  capabilityVersion: sequence.steps[sourceIndex]!.capabilityVersion,
                  artifactDigest: sequence.steps[sourceIndex]!.artifactDigest,
                  targetProfileDigest: sequence.steps[sourceIndex]!.targetProfileDigest,
                  arguments: sequence.steps[sourceIndex]!.literalArguments,
                }) : undefined;
                const safeSourceOutput = sourceRun?.outputsDisplaySafe === true
                  ? contractValues(sourceRun.outputs, sourceCapability?.outputs)
                  : undefined;
                const selectionRows = selection ? valueAtPath(safeSourceOutput, selection.sourceCollectionPath) : undefined;
                const selectableRows = Array.isArray(selectionRows) && selectionRows.length === selection?.count
                  ? selectionRows
                  : undefined;
                return (
                  <section className="chat-sequence-card" aria-label="Capability sequence">
                    <div className="chat-sequence-heading">
                      <div><strong>{sequence.steps.length}-step approved sequence</strong><small>Sequential · stop on non-success</small></div>
                      <span className={`chat-sequence-state sequence-${execution.state}`}>{humanize(execution.state)}</span>
                    </div>
                    <ol className="chat-sequence-steps">
                      {sequence.steps.map((step, index) => {
                        const stepExecution = execution.steps[index];
                        const stepCapability = resolveProposalCapability(capabilities, {
                          capabilityId: step.capabilityId,
                          capabilityVersion: step.capabilityVersion,
                          artifactDigest: step.artifactDigest,
                          targetProfileDigest: step.targetProfileDigest,
                          arguments: step.literalArguments,
                        });
                        const stepRun = stepExecution?.runId ? runs.find((item) => item.id === stepExecution.runId) : undefined;
                        const displayLiterals = stepCapability ? contractValues(step.literalArguments, stepCapability.inputs) : undefined;
                        return (
                          <li className={`chat-sequence-step step-${stepExecution?.state ?? "pending"}`} key={step.stepId}>
                            <div className="chat-sequence-step-heading"><span>{index + 1}</span><div><strong>{stepCapability?.name ?? humanize(step.capabilityId)}</strong><small>{step.bindings.length ? `${step.bindings.length} prior-step binding${step.bindings.length === 1 ? "" : "s"}` : "Literal inputs only"}</small></div><em>{humanize(stepExecution?.state ?? "pending")}</em></div>
                            {displayLiterals && Object.keys(displayLiterals).length ? <details><summary>Reviewed literal inputs</summary><ValueView value={displayLiterals} label={`Step ${index + 1} inputs`} /></details> : null}
                            {stepExecution?.message ? <Alert title={stepExecution.state === "unconfirmed" ? "Step status unconfirmed" : "Sequence step stopped"}>{stepExecution.message}{stepExecution.code ? ` (${stepExecution.code})` : ""}</Alert> : null}
                            {stepRun ? <ChatRunCard run={stepRun} capability={stepCapability} approval={stepExecution?.approval} active={activeRunId === stepRun.id} connection={connection} onOpen={onOpenRun} /> : null}
                          </li>
                        );
                      })}
                    </ol>
                    {execution.state === "selection_required" && selection ? (
                      <section className="sequence-selection" aria-labelledby={`selection-${message.id}`}>
                        <Alert tone="warning" title="Choose one verified result">The prior step returned {selection.count} rows. Select one row to authorize only its index for the exact next step.</Alert>
                        <h4 id={`selection-${message.id}`}>Authenticated result selection</h4>
                        {selectableRows ? <div className="sequence-options">{selectableRows.map((row, index) => (
                          <button type="button" key={index} disabled={!online} onClick={() => onSelectSequence(message.id, index)}><span>Result {index + 1}</span><ValueView value={row} label={`Result ${index + 1}`} /></button>
                        ))}</div> : <Alert title="Selection projection unavailable">The source run did not provide an exact display-safe projection for all candidate rows. No selection can be submitted from this console.</Alert>}
                      </section>
                    ) : null}
                    {execution.message && execution.state !== "selection_required" ? <Alert title={execution.state === "completed" ? "Sequence completed" : "Sequence stopped"}>{execution.message}{execution.code ? ` (${execution.code})` : ""}</Alert> : null}
                  </section>
                );
              })() : null}
              <time dateTime={message.createdAt}>{formatDate(message.createdAt)}</time>
            </article>
          );
        })}
        {sending ? <div className="thinking" role="status"><span /><span /><span /><span className="visually-hidden">Assistant is thinking</span></div> : null}
      </div>
      {error ? <p className="chat-error" role="alert"><span aria-hidden="true">!</span>{error}</p> : null}
      <form className="chat-composer" onSubmit={(event) => { event.preventDefault(); onSend(); }}>
        <label className="visually-hidden" htmlFor="assistant-message">Message the operations assistant</label>
        <textarea id="assistant-message" value={draft} maxLength={8_000} rows={3} disabled={automationBusy} placeholder={automationBusy ? "The current assistant operation is being started…" : "Describe an operation — never include passwords or tokens"} onChange={(event) => onDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); onSend(); } }} />
        <div><small>{automationBusy ? "Starting validated operation…" : `${draft.length.toLocaleString()} / 8,000`}</small>{sending ? <button className="button quiet small chat-cancel-button" type="button" onClick={onCancel}>Cancel request</button> : <button className="send-button" type="submit" disabled={!draft.trim() || !online || automationBusy} aria-label="Send message">↑</button>}</div>
      </form>
      <p className="assistant-footnote">Authenticated Send authorizes only the exact validated proposal or bounded sequence returned for that request.</p>
    </section>
  );
}
