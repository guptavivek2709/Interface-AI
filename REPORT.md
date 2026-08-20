## Architecture

This TypeScript/Node.js vertical slice keeps explicit boundaries in one process. A local server supplies an intentionally hostile banking surface: generated IDs, a nested iframe, table layouts, tenant-dependent field order, and injected runtime states. `PlaywrightSurface` turns it into a screenshot plus compact accessibility observation and executes clicks, fills, selections, reads, and key presses. This is a real UI path, not an application API.

Discovery is a bounded observe-decide-act loop. Each model call returns one Zod-validated decision using a current control reference. Step and wall-clock limits bound the loop, unchanged-state detection catches repetition, policy gates every action, and completion requires a visible checkpoint. Anthropic Messages, OpenAI Responses, and authenticated Codex CLI planners share one interface; the scripted planner is explicitly a test double. The journal records decisions and observed controls, not a raw transcript.

The compiler turns a successful journal into a parameterized capability. A separate replay runner validates and executes that artifact without importing a planner or permitting model recovery. A single process makes policy, session ownership, and evidence invariants easy to audit; services and queues would add failure modes without strengthening this proof.

## Artifact schema

The strict JSON artifact is versioned (`schemaVersion: "1.0"`). Capability metadata carries identity, semantic version, approval state, description, and tags. Provenance identifies the discovery run, goal, provider, and model. Compatibility names surface adapter, vendor product, app version, tenant variant, and entry point. Policy travels with the capability so execution cannot inherit a more permissive default.

Inputs and outputs are named, typed, documented, and classified. Inputs may declare an enum or ECMAScript pattern. Actions use a `ValueExpr`: either a reviewed literal or a symbolic caller-input reference, so discovery values do not become constants. The CLI also rejects persistence if serialized artifact text contains a supplied discovery value.

Targets are reusable records with frame path, ordered semantic strategies, exact-one cardinality, and rationale. Steps reference targets and declare action, preconditions, postcondition, timeout, retry policy, and risk. The artifact separately declares its final checkpoint, business outcomes, bounded recoveries, and exceptions with failure or intervention dispositions. Graph validation rejects unknown fields, duplicate IDs, malformed regexes, and dangling target/input/output references.

## Determinism & error handling

Replay validates the artifact and invocation before UI work and performs zero model calls. It enters exact titled frames and tries reviewed strategies in order: exact accessibility role/name, associated label, semantic `name`, then exact text where appropriate. Multiple matches fail immediately; replay never guesses by index or coordinate. Each step checks preconditions, acts under the automation lease, waits for busy state to settle, and verifies its postcondition. Fill and select may retry within declared bounds; clicks are not blindly retried because duplicate effects may be unsafe. Success requires the final checkpoint and every declared output.

Runtime meaning is explicit. `MISSING-0000` returns `MEMBER_NOT_FOUND` as a business outcome. A known notice has one policy-checked dismiss recovery whose condition must clear. Permission denial is a hard failure, session expiry requests intervention, and slow loading is awaited. Invalid input, ambiguity, missing frames, exhausted recovery, condition mismatch, timeout, and missing outputs return structured failures with step, expected state, observed state, and available evidence. Thus a legitimate negative answer is not a crash, and a failed click is not success.

Generated IDs and tenant layout order are excluded from targets, so harmless markup reordering is tolerated. If reviewed semantic identities drift, execution stops with resolution evidence. Artifact version and compatibility fields provide the approval and migration boundary.

## Heterogeneity & multi-tenant

The artifact describes semantic targets, frame paths, actions, values, and conditions rather than Playwright selector strings. That is the portability seam. A desktop adapter could use UI Automation/accessibility APIs; a screenshot-only adapter could add a versioned visual-anchor strategy. Replay orchestration and result taxonomy could remain, though the current runners must first depend on a formal surface/runtime interface instead of the concrete Playwright class.

Vendor product/version is separate from tenant variant. Semantic labels and frame titles let one artifact run on the demo's `summit` and reordered `harbor` layouts. In production I would resolve an immutable vendor/version base artifact with a small reviewed tenant overlay limited to targets, routes, and known outcome text; the resolution would have its own digest and approval. Canary replays would track compatibility by version and tenant, quarantine failed bindings, and require review rather than silently rediscovering in production. The registry and overlays are designed, not built.

## Escalation & handoff

Discovery detects limits, repeated unchanged state, model escalation, policy denial, and unverified completion. Escalation, denial, or a stuck loop can make one bounded handoff attempt. Replay escalates on a declared intervention or unsafe blocked state. The request carries run, capability/goal, step, reason, observed state, screenshot reference, opaque session reference, and timestamp.

`ControlCoordinator` models automation, pausing, waiting, human control, resuming, and termination. Ownership is an increasing epoch lease. Requesting help invalidates automation before exposing the operator endpoint; take-control issues a human lease; every human action rechecks it; resume invalidates it before issuing a new automation lease. Stale or concurrent actors cannot operate the page.

The loopback operator surface uses the same `BrowserContext`, page, cookies, and in-progress state. In the session-expiry demo, the operator takes control, restores the session, and resumes; transfers and action are recorded. Replay then reconciles postcondition or preconditions instead of assuming the page is correct. The surface is deliberately minimal, not production co-browsing.

## Safety

Policy checks exact origins and anchored document routes for direct navigation, frames, redirects, and popups; encoded traversal and credential-bearing URLs are rejected. Every HTTP(S) resource and WebSocket is exact-origin gated, service workers are disabled, and downloads are canceled. Action allowlists have explicit denials, contextual risk must stay below policy maximum, and replay blocks all irreversible steps. This capability stops at review and never creates an account.

The redactor registers classified inputs before recording, recursively removes sensitive keys and common credential/token forms, and covers every JSONL event. Planner prompts replace known raw and URL-encoded invocation values with symbolic input references before provider calls, and artifacts retain symbolic inputs. Screenshots mask inputs and marked outputs; DOM evidence removes live values. Evidence uses safe paths, SHA-256 metadata, and restrictive creation modes.

These controls are not encryption or authorization, and selector masking can miss an incorrectly marked field. Genuine discovery sends synthetic screenshots to the chosen provider. Real deployment needs approved model boundaries, minimized observations, authenticated operator access, encrypted tenant-scoped evidence, retention controls, and signed audits. A write capability also needs an expiring approval bound to tenant, artifact digest, step, and invocation digest.

## Cuts

I did not build queues, worker fleets, a database, capability registry/API, desktop or coordinate automation, tenant-overlay storage, drift canaries, or a polished operator console. They would obscure the evaluated contracts without making this local slice safer. The adapter is web-only, the operator UI handles the injected scenario, offline discovery is only a test double, and replay has no LLM fallback by design.

Next I would formalize the surface interface; add signed artifact approval and write-step tokens; authenticate the operator channel; encrypt and sign evidence; implement immutable base-plus-overlay resolution; and run canaries with quarantine thresholds. Only then would I add a catalog or horizontal infrastructure.
