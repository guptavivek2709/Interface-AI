# MERIDIAN Upgrade Design Report

## Outcome

The upgrade turns the supplied legacy UI into an authenticated, asynchronous capability service and operator console. It does not scrape a page ad hoc for every request. Reviewed target knowledge is compiled into immutable V2 artifacts; replay loads one exact artifact digest and executes it without a planner.

The acceptance-floor read path—sign-on, member selection, record, and balances—has completed against the supplied live target with zero model calls during replay. All eight required capability contracts are implemented. Live irreversible commits were intentionally not posted to the shared environment.

There was no `ANTHROPIC_API_KEY` in the build environment. The MERIDIAN artifacts therefore retain honest `source: "authored"` provenance from guarded live reconnaissance rather than claiming a model discovery that did not occur. The existing core's genuine provider-backed V1 discovery evidence is retained, Anthropic is fully integrated at the new intent seam, and V2 provenance supports a future discovery run ID/provider/model. The deliberate remaining promotion step is to run an approved Anthropic discovery/review job, diff its canonical V2 draft, canary the reads, and publish the resulting digest. This is a documented boundary, not a mocked success claim.

## Decisions implemented

1. **Anthropic at the intent boundary.** The Anthropic Messages API is the primary natural-language router when configured. It returns either a reply or one strict tool proposal. It is not the browser controller and does not replace REST/SSE.
2. **React and Vite for the user surface.** The console uses catalog-driven typed forms, accessible states, SSE with polling fallback, explicit review, run history, and a responsive layout. Production remains same-origin with the API.
3. **Fastify REST plus SSE.** Submission is `202 Accepted`; queue, execution, recovery, approval, and terminal transitions are durable for the manager retention window and replayable from an SSE event ID.
4. **A model-free V2 runtime.** `ReplayRunnerV2` depends on `ReplayRuntimeV2`, not Playwright or a model. Effects, retry, routes, states, approvals, checkpoints, and outputs are artifact data.
5. **One server-owned target session per console principal.** MERIDIAN cookies and credentials stay in memory and never cross the API. Each session is serialized even when global concurrency is greater than one.
6. **Exact identity and ownership.** Console authentication is separate from MERIDIAN authentication. Every run and evidence read is owner-scoped. The local static provider can be replaced by enterprise identity through `ConsoleIdentityProvider`.
7. **Explicit write authority.** Idempotency is bound to session, capability, version, artifact digest, and inputs. Approval is bound to the current challenge and cannot be supplied by chat. Supervisor-only work is rejected before browser action unless both identity layers are supervisor.
8. **Typed output projection.** Raw runtime values are not blindly serialized. The API projects only declared outputs, applies table-column classification, removes unknown keys, withholds secret fields, and marks an authenticated projection safe for display.

## Capability contract

`CapabilityArtifactV2` is the stable contract between discovery/review and execution. It contains:

- capability identity, semantic version, approval status, risk, and compatibility;
- authored provenance and target product/version;
- recursively typed and classified fields, including structured arrays and money;
- targets with role, label, semantic name, label/value, table, and row-scoped control strategies;
- conditions over targets, routes, text, document HTTP status, and boolean composition;
- steps with preconditions, postcondition, effect, timeout, retry, and optional approval;
- exact origin, route, method, and query policy;
- typed business outcomes, failures, escalations, and bounded recovery actions;
- a final checkpoint and declared outputs.

Graph validation rejects duplicate or dangling identifiers, unsafe effects, writes without approval, invalid patterns, undeclared actions, missing recovery policy, and incompatible routes. Catalog startup reparses artifacts, hides non-approved entries, freezes values, computes canonical digests, and prevents path/symlink escape when loading from disk.

## Legacy target adaptation

The supplied application is MERIDIAN Core v4.2.1: server-rendered HTML, table-based layout, no test IDs, and repeated `Select` links. The adapter therefore prioritizes stable form semantics rather than generated selectors.

- Sign-on uses the reviewed form names `operator`, `password`, and `branch` and exact `Sign On` control.
- Inquiry uses `by` and `q`. Last-name search can return several rows.
- A member is selected with a table locator keyed by the `Member No.` cell in the same row; link text or ordinal position is never sufficient.
- Record values use exact label/value relationships. Shares are extracted from the exact header set `Share ID`, `Type`, `Balance`, and `Status`.
- Transfers, new shares, and holds use native review-to-post forms and require the hidden `_token` to be present. The token is an ephemeral browser value, never a capability input.
- Member update is a direct post, but the local approval boundary still requires explicit user confirmation before the save.
- Main-document response status is tracked separately from subresources so a failed image or frame cannot misclassify the business page.

## State and error semantics

The runner distinguishes an expected negative business result from a technical failure:

| Signal | Contract treatment |
| --- | --- |
| Search miss at HTTP 200 | `MEMBER_NOT_FOUND` business outcome. |
| Natural validation at HTTP 400 | Typed validation business outcome. |
| Record HTTP 404 | `RECORD_NOT_FOUND` business outcome. |
| HTTP 403 | `SUPERVISOR_REQUIRED` escalation. |
| HTTP 440 | Before commit, revoke session and restart after sign-on; after a commit attempt, `EFFECT_UNKNOWN`. |
| HTTP 503 with `Continue` | One policy-checked recovery to menu, then restart. |
| HTTP 500 | Hard `APPLICATION_ERROR` before commit; `EFFECT_UNKNOWN` after a commit attempt. |
| Ambiguous final commit | `EFFECT_UNKNOWN`, non-retryable. |

Recoveries are declared in the artifact and bounded. There is no model fallback during replay. A condition mismatch, ambiguous target, route escape, exhausted recovery, missing output, or deadline produces structured evidence and a fail-closed result.

## Authentication and authorization

The built-in `StaticConsoleIdentityProvider` is suitable for a loopback or controlled demonstration:

- teller and supervisor access codes are independently configured;
- codes must be at least 16 characters and are held as SHA-256 digests;
- comparisons are timing safe;
- repeated failed logins are rate-limited;
- browser login creates a random, server-stored, idle/absolute-expiring session and an HttpOnly, SameSite=Strict cookie;
- the built-in provider rejects access codes used as bearer credentials; an enterprise provider may add a separately designed machine-authentication mechanism;

All business routes require an authenticated principal. A custom same-origin mutation header plus Origin/Host comparison provides an additional CSRF intent boundary. This is not presented as full institutional IAM. A deployment should supply an OIDC/SAML/mTLS implementation, centralized session storage, MFA/step-up policy, tenant claims, and audited role administration without changing run contracts.

The console identity authorizes which configured MERIDIAN profile may be used. Target-system credentials remain environment/secret-manager data. The API never returns MERIDIAN operator IDs, passwords, session references, cookies, or tokens.

The sign-on queue receives only non-secret symbolic fields. Its password is held in a short-lived server resolver and hydrated inside runner construction, then cleared. Public run DTOs omit input digests; sign-on evidence carries a session-bound opaque audit digest rather than an unkeyed password verifier. Passive SSE, polling, and history reads do not refresh the console idle TTL—only explicit operator activity does.

## Approval and exactly-once posture

A step may pause only before its declared write effect. The challenge includes an unpredictable ID, exact run and step, requirement, expiry, and reviewed summary. The browser must echo that challenge ID with `decision: approve`; an older click cannot approve a newer checkpoint.

The authority signs a one-time token over challenge ID, run ID, artifact digest, input digest, target session, step, approval kind, actor, roles, issue time, and expiry. Consumption verifies all fields with a timing-safe HMAC check and records the approval ID as used.

The token itself remains inside the run manager. A final commit is attempted once. Only read/draft actions with declared retry semantics can repeat. Business request idempotency prevents ambiguous client retries from enqueuing a second run. The API namespaces keys by authenticated subject, binds them to target session, capability version, artifact digest, and normalized inputs, and persists the binding before enqueue. Run-history expiry and ordinary process restart therefore cannot make the key reusable. The bundled file ledger is fail-closed and suitable for a single local process; a multi-instance deployment must provide a transactional shared implementation of the same interface.

## Anthropic boundary

The chat catalog omits any capability with secret fields, including sign-on. Money is exposed to the model as a decimal string; the API alone converts it to canonical `{currency, amount, minorUnits}` and verifies consistency and bounds.

Before the provider call, the router:

- rejects current messages containing credentials;
- redacts history and suspicious secret forms;
- builds strict JSON tool schemas only from approved catalog entries;
- limits message, history, schema, and tool-call sizes;
- disables parallel tool use and hidden SDK retries.

The canonical Zod contract is never mutated for provider convenience. An Anthropic-specific compiler applies the SDK's supported-schema transformation, converts unsupported value constraints such as `pattern` into bounded provider guidance, restores supported enumerations, and preflights strict-tool count, optional/union parameter, size, node, depth, reference, and keyword limits. Unsupported future structure fails before the HTTP call. Model arguments are then validated against the untouched local Zod schema, so provider compatibility cannot weaken email, phone, money, enum, or explicit regular-expression rules.

After the call, local code validates the provider envelope, content-block types and sizes, tool name, tool-call count, argument schema, protected keys, output text, and stop reason. A wall-clock controller bounds even a non-cooperative injected provider client; SDK retry is zero, logout/disconnect cancels the call, and per-principal concurrency prevents orphaned duplicates. The intent-only call uses configurable effort (low by default) for responsive routing; model effort cannot weaken any local policy. Only classified transport, timeout, rate-limit, `408`/`409`, or server outages may fall back to the deterministic router. Cancellation, ordinary provider `4xx`, and invalid model output remain errors. Public responses and logs expose only fixed classifications, never raw provider payloads or identifiers. The resulting route is a proposal; a separate explicit REST request starts work.

## UX principles

The console is optimized for safe speed:

- catalog fields generate the form, so a new approved capability does not require a hand-written screen;
- protected inputs are rendered as server-managed rather than password controls;
- money, enum, nested, and array fields have type-appropriate controls and local errors;
- risky capabilities display their effect before submission;
- idempotency keys survive an uncertain network response for a safe retry;
- SSE shows live progress, while bounded polling covers disconnects;
- business outcomes, recoveries, failures, and escalations have distinct language;
- approval is disabled if any declared summary value lacks an authorized display projection;
- queued and approval-paused work has an owner-scoped **Cancel safely** action, while running commits cannot be interrupted through that control;
- run history shows exact submitted field names with protected values instead of retaining raw invocation PII;
- terminal history is not silently selected after authentication, stale `RUN_NOT_FOUND` selections are invalidated, and visible-tab refresh keeps unselected run state current;
- owner-scoped evidence is listed as downloads, while DOM snapshots are forced to inert text attachments;
- supervisor work is disabled with a direct restart-as-supervisor explanation;
- offline and rendering failures stop safely and never imply that a transaction ran.

Accessibility uses semantic labels, focusable error targets, live status regions, keyboard operation, responsive layouts, reduced-motion treatment, and non-color-only state text.

## Scalability seams

The current process is intentionally deployable locally, but the boundaries support larger infrastructure:

| Current component | Replacement seam |
| --- | --- |
| `ChatRouter` | Another hosted model, local model, rules engine, or ensemble. |
| `ReplayRuntimeV2` | Desktop UI Automation, mobile, terminal, or another browser driver. |
| `CapabilityCatalog` | Signed registry, base-plus-tenant overlays, rollout channels, and compatibility canaries. |
| `ConsoleIdentityProvider` | OIDC/SAML/mTLS gateway and step-up authentication. |
| `RunManager` | Durable queue/workers with the same snapshot/event contract; the current idempotency ledger is already replaceable independently. |
| `SessionManager` | Encrypted session broker with affinity and distributed leases. |
| `EvidenceStore` | Encrypted object storage, WORM retention, legal hold, and audit signing. |
| `ApprovalAuthority` | HSM/KMS or external authorization service. |
| Fastify API | Horizontal same-origin service behind a trusted gateway. |
| React catalog form | Additional role/tenant views driven by the same field contract. |

The next production steps are durable run and ownership storage, enterprise identity, KMS-backed approvals, encrypted evidence, signed artifact promotion, tenant isolation, observability/SLOs, and controlled canary replay. None require placing an LLM inside deterministic execution.

## Verification boundary

The local gate type-checks server and web code, runs unit/integration/e2e tests, and builds both bundles. A live read-only replay successfully returned the selected member record and three share rows from the supplied target with `plannerCallsAllowed: false`. A second live read-only run for synthetic member `999999` terminated deliberately as `business_outcome / MEMBER_NOT_FOUND`, also with no planner in replay.

Reconnaissance verified final control labels, review routes, hidden tokens, role behavior, and error pages without posting live writes. Consequently, write capability outputs are deliberately empty unless the target's post-commit confirmation has been safely observed. This avoids inventing confirmation selectors or claiming an external side effect that was not tested.

The retained V1 synthetic evidence remains a separate, reproducible demonstration of genuine discovery, cross-layout replay, recovery, failure evidence, and same-session human control. The V2 dashboard currently lists live replay runs; provider-backed V2 discovery history is the explicit promotion boundary described above rather than a fabricated dashboard record.
