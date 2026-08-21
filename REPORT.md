# MERIDIAN Adaptation Report

## Outcome

The core now runs end to end against hosted MERIDIAN Core v4.2.1. Eight approved V2 capabilities cover sign-on, both member-search modes, records/balances, transfer, share opening, member update, and supervisor-gated account hold. A typed Fastify API exposes them; the Anthropic-only assistant drives that API; model-free Playwright replay operates MERIDIAN; and the React dashboard exposes sessions, live work, discovery and replay history, approvals, handoff, reconciliation, and evidence.

This was an adaptation, not a replacement engine. Existing artifact, policy, replay, approval, evidence, session, and run-manager boundaries stayed central. Target work remained concentrated in the MERIDIAN profile, semantic observations, eight reviewer recipes, typed extraction, and declared exception rules.

## Target adaptation and V1-to-V2 lifecycle

MERIDIAN is server-rendered, table-oriented, and has no test IDs. Repeated `Select` links made positional selection unsafe, so the adapter uses exact labels, label/value relationships, table headers, and row controls keyed by reviewed business columns such as `Member No.`. It addresses forms by stable names and roles, classifies the main document independently from assets, and constrains navigation to the configured origin and reviewed routes.

The per-transaction hidden `_token` remains ephemeral: native form submission requires it, but it never becomes an artifact/API/model input or appears in logs or evidence. Transfer, share opening, and hold preserve the target's review→post boundary. Member update posts directly in MERIDIAN, so the artifact adds a local pre-write approval checkpoint.

Discovery is fully V2. Anthropic observations are projected to a privacy-safe `DiscoveryTraceV2`, which owns observed targets, actions, ordering, derived step postconditions, and a safe checkpoint candidate. One explicit recipe per capability supplies reviewed compatibility, field types, route/action policy, runtime/effect annotations, approval rules, and table semantics. Neither the model nor compiler may invent a commit, receipt, recovery, or authorization rule.

| Earlier boundary | V2 implementation |
| --- | --- |
| Discovery result | Privacy-safe trace and canonical digest; raw invocation values are excluded. |
| Reusable artifact | Trace-derived draft plus an explicit reviewed MERIDIAN recipe. |
| Acceptance | Ordered `draft_created → reviewed → canary_passed → approved` external lineage. |
| Replay confidence | Read-only canary in the exact authenticated context, stopping before persistence. |
| Deployment | Immutable artifact/lineage publication to separate roots and catalog revalidation. |

Promotion rejects test doubles, failed/mismatched canaries, skipped stages, changed digests, and raw-value leakage. Non-sign-on discovery/canary resolves the published `session.sign_on@2.0.0` and retains that authenticated context; credentials come only from the selected role's environment profile. Startup requires all eight approved discovery artifacts and matching canonical lineage.

## API, assistant, and dashboard

The API accepts capability ID/version, typed business arguments, target session, and catalog digest bindings, then returns `202 Accepted` with a structured run snapshot. Identity-scoped list/detail routes expose owned runs plus a subject-bound run during its active delegation; replayable SSE exposes queue, execution, recovery, approval, intervention, and terminal events. OpenAPI also documents authentication, sessions, exact approve/cancel, evidence, same-session handoff, and read-only reconciliation.

`POST /api/v1/chat` returns an Anthropic reply, one exact proposal, or a sequence of at most three approved capabilities; it does not itself create a run. The authenticated React client validates version, artifact and target-profile digests, arguments, and bindings, then immediately submits the exact operation authorized by **Send**. It establishes and verifies the server-owned target session first when required. Sequences stop on non-success and pause for authenticated selection when a search is ambiguous.

A chat-authorized write submits its challenge once only after rechecking proposal/run lineage, inputs, safe review projection, expiry, session, and supervisor role. Uncertain responses are not repeated. Workspace remains the explicit form path with separate **Start**, review, **Approve and continue**, and **Cancel safely** controls.

Authenticated **History** separates real **Discovery** and **Replay** records. Discovery history is projected only from validated published lineage/artifacts; it shows privacy-safe input contracts with invocation values explicitly withheld, the approved typed output contract and lifecycle digests, the complete promotion timeline, and persisted evidence references. Replay history remains live identity-scoped detail for owned and active delegated runs, including status, events, results, approvals, interventions, and reconciliation; finalized evidence downloads remain owner-only.

## Reliability, safety, evidence, and escalation

Artifacts distinguish business outcomes from control and infrastructure states. An HTTP-200 search miss becomes `MEMBER_NOT_FOUND`; validation `400` is non-applied; record `404` is not found. Permission `403` and pre-commit expiry `440` pause and request same-session supervisor authentication or restoration. Maintenance `503` permits one declared pre-commit recovery. A pre-commit `500` is a hard error. Any ambiguous response or `440`/`500`/`503` after the single commit attempt becomes `EFFECT_UNKNOWN`, never an automatic retry.

Write authority is model-independent. Each challenge binds an unpredictable ID, run/step, display-safe summary, state nonce, requirement, and expiry. A one-use HMAC approval binds actor/role, session, artifact, normalized inputs, step, state, and summary. Idempotency binds owner, session, capability/version, artifact/target digests, and inputs before queueing. Final commit executes once.

An intervention retains the live browser session. The owner handles `restore_session` directly. A required-role `authenticate_supervisor` handoff allows the owner to issue a one-time invitation valid for at most 120 seconds; the authenticated supervisor redeems it and obtains the lease for that exact run. Both paths permit only the server-selected action and resume after artifact-declared revalidation. Automation cannot control the session simultaneously.

Effect-uncertain writes can launch an idempotent read-only balance/record reconciliation. Retained pre-commit markers are compared with current state to report `applied`, `not_applied`, or `still_unknown`; this never authorizes another write.

Credentials, cookies, hidden tokens, session references, and approval material stay server-side. Chat blocks credential-shaped content; run access is identity-scoped to owners or an unexpired delegation, while evidence remains owner-only. Screenshots are masked, DOM is inert, text/JSON are redacted, and the closed append-only event stream is hashed before the manifest is written last.

## Demonstration and verification

The guarded scenario runner accepts only the hosted target, requires explicit enablement and both public role profiles, and uses the production catalog with `plannerCallsAllowed: false`. Finalized `evidence/v2` bundles cover all eleven scenarios: `balance-success`, `member-not-found`, `maintenance-recovery`, `session-timeout`, `application-error`, `supervisor-required`, `validation-rejected`, `transfer-success`, `share-open-success`, `member-update-success`, and `hold-supervisor-handoff`. Together they prove reads, deliberate business outcomes, bounded recovery, hard failure, same-session escalation, and four reviewed writes with read-after-write checks.

The runner reports `verified` only after scenario assertions, manifest re-hash, unlisted-file rejection, and sensitive-value scanning. `npm run check` type-checks, tests, and builds both bundles; local fixtures demonstrate code behavior, not live effects.

The submitted [`evidence/ui/live-anthropic-auto-run.png`](evidence/ui/live-anthropic-auto-run.png) is a privacy-safe compiled-dashboard capture after real console authentication, Anthropic routing, automatic target sign-on, deterministic execution, and verified completion. Proposed inputs and verified outputs were removed from the isolated retained capture.

The companion [`evidence/ui/discovery-history.png`](evidence/ui/discovery-history.png) is a compiled-console capture of all eight validated discovery records and one full typed contract, with invocation values explicitly withheld.

## Deliberate limits and next steps

The deliverable is intentionally lightweight and single-process. Static console identity, memory-resident run/session state, a file idempotency ledger, local evidence, and process-secret approval signing suit a controlled demonstration, not institutional deployment. No screen recording is included; reproducible commands, the dashboard capture, and hash-bound bundles are the demonstration record.

Next I would add enterprise identity/MFA, transactional shared state, encrypted session brokering and evidence, KMS/HSM approvals, signed catalog releases, tenant policy, and centralized audit/SLOs. These replace infrastructure behind existing interfaces without placing a model in replay or weakening capability contracts.
