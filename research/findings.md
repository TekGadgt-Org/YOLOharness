# YOLOharness: public harness research and Codex OAuth feasibility

AI-agent research for Ryan; not human-reviewed. Retrieved 2026-09-04 UTC from live primary documentation and public repository main branches. Publication dates were not exposed. These are documented capabilities, not locally executed integration tests. No credentials were inspected, copied, or created; no installs or external publishing occurred.

## Bottom line

KEEP the fixed small TypeScript/Node kernel, append-only events, capability boundary, resumable tasks, and tiered evidence-backed memory. CHANGE the initial provider abstraction to a **Codex agent-runtime adapter**, not a raw-model API adapter. The official app-server explicitly supports embedding authentication, conversation history, approvals, and streamed agent events.[1]

Recommended first transport: spawn official `codex app-server` as a local child process using stdio. Let Codex own ChatGPT OAuth, token persistence, and refresh: this is explicitly its recommended managed-auth mode.[5] REJECT credential extraction/copying, reverse-engineered subscription endpoints, remote gateway exposure for v0, and claims about unreleased OpenAI internals. No source in this research proves Astra is available to Ryan's account; resolve the requested model against `model/list` and fail clearly if unavailable.[5]

## Exact documented OAuth route and prerequisites

Prerequisites to verify at implementation time:

1. An official Codex executable with `app-server` and schema generation available on PATH; pin the tested release. Generate TypeScript/JSON schemas using that exact binary (`codex app-server generate-ts --out ./schemas` or `generate-json-schema`), because schemas are version-specific.[1]
2. A Node runtime for the kernel; the public TypeScript SDK requires Node.js 18+, though choosing a currently supported Node LTS is the proposed kernel policy, not an app-server protocol requirement.[6][11]
3. A human-controlled ChatGPT account with Codex entitlement and permitted workspace access; ChatGPT login uses subscription access, while API keys use separate usage-based access.[2] Authentication alone is not proof of target-model entitlement.
4. Network reachability to official authentication/service endpoints, and a browser capable of completing the flow. Browser OAuth returns to the app-server's localhost callback; for a headless server prefer the documented device-code flow rather than moving credentials between machines.[5]
5. Codex-owned writable credential/session storage under the intended OS user. Codex supports file, OS keyring, or auto credential storage; file credentials are secrets, and sign-in tokens are refreshed automatically.[2] Proposed policy: kernel never reads these files and never logs login URLs, device codes, account email, or auth payloads.

Protocol sequence (verified against public app-server README, not executed):

- Spawn `codex app-server`; parse newline-delimited JSON messages on stdout and keep stderr separate. The wire omits the `jsonrpc` header.[5]
- Send `initialize` with `clientInfo` (name/version), wait for its response, then send `initialized`. Do not enable experimental APIs by default.[1]
- Send `account/read` with `{ "refreshToken": false }`. Require account type `chatgpt` for this OAuth-only product; `requiresOpenaiAuth` describes provider requirements, not successful authentication.[5]
- If signed out, send `account/login/start` with `{ "type": "chatgpt" }`; open the returned `authUrl` for the human. Alternatively send `{ "type": "chatgptDeviceCode" }`, and display returned `verificationUrl` and `userCode` transiently.[5]
- Wait for matching `account/login/completed` with success, then re-read account state; handle cancellation/errors and `account/updated` without assuming login succeeded because a URL was returned.[5]
- Call `model/list`, resolve the actual offered model identifier, then `thread/start` and `turn/start`; persist returned thread/turn IDs and observe items until `turn/completed`. Resume via `thread/resume`; cancellation uses `turn/interrupt`.[1][5]
- Service server-initiated approval requests through the capability policy and human consent UI. Version-test actual request schemas; do not implement approvals by parsing prose.[1][5]

Feasibility verdict: documented and suitable for a local personal integration; not proof of unrestricted OAuth use as a general OpenAI API. OpenAI recommends API keys for programmatic CLI CI/CD workflows, so OAuth-only v0 should stay local and user-operated, not become a public/CI service without a separate policy review.[2] Enterprise integrations may also need a recognized `clientInfo.name` registration with OpenAI.[1]

## Real comparison for this project's constraints

| Surface | Documented strengths | Costs / cautions (design inference unless stated) | Keep / change / reject |
|---|---|---|---|
| Codex CLI / app-server | Existing coding execution, streamed items, approval requests, thread resume/fork, model catalog, skill support, managed OAuth.[1][5] | You are embedding a complete agent, not controlling every model-loop detail. App-server WebSocket is explicitly experimental/unsupported; public docs and repository main can differ.[1][5] | KEEP official runtime and local stdio. CHANGE adapter semantics to agent-runtime. Pin schemas. |
| Codex TypeScript SDK | Wraps CLI, exchanges JSONL, offers `runStreamed`, structured outputs, and persistent thread resume; Node 18+.[11] | Simpler job API but app-server is explicitly the rich-client interface for auth and approvals.[1] Adding SDK plus custom app-server simultaneously creates duplicate control paths (inference). | KEEP as fallback for bounded coding jobs; use one adapter path in v0. |
| Hermes | Bounded curated memory plus session search, reusable agent-created skills, broad tools/MCP, isolated delegation, programmatic tool calling, and scheduling.[3][10] | Breadth creates more policy/configuration surface than this local-only kernel needs (inference). Docs warn against two agents writing the same Hermes home.[10] | KEEP frozen session-memory snapshot, on-demand recall, skill improvement with review, and bounded delegation. CHANGE memory to explicit evidence/provenance. REJECT wholesale framework transplant. |
| OpenClaw | Gateway control plane for tools/sessions/events/channels; extensible tools, skills, plugins.[4] Markdown durable and daily memory plus consolidation.[8] Background subagents return evidence to parent, with nesting/concurrency controls and restricted child tool access.[9] | Main-session tools run on host unless sandbox configured (documented).[4] Children share gateway resources; queued acceptance is not delivery (documented).[9] Broad channels/device integrations are unnecessary initial scope (inference). | KEEP control-plane separation, child result as untrusted evidence, explicit delivery state, and inspectable memory. REJECT host-exec-by-default and gateway scope in v0. |

Memory evidence nuance: Hermes landing page describes recall with LLM summarization, while its detailed memory page says session-search returns actual DB messages without summarization.[3][10] Prefer the specific current feature page when designing recall; do not repeat marketing shorthand as an implementation guarantee. Codex thread history and skills are documented, but this review did not establish a general evidence-backed memory system equivalent to the proposed design.[5]

## Proposed minimal architecture (recommendations, not existing product claims)

- Kernel owns Task state machine, capability grants, event journal, budgets, evidence memory, and CLI; Codex owns its agent loop, tool execution inside approved sandbox scope, OAuth, and conversation persistence.
- Adapter exposes initialize/status/login/start/resume/interrupt plus typed events, not a pretend raw `complete(messages, tools)` API. Keep a provider escape hatch in the type design without implementing extra providers.
- Append-only events carry schema version, task ID, sequence, timestamp, correlation ID, provider thread/turn/item IDs, outcome, and evidence/artifact references. Redact BEFORE journaling. Store reduced auth status only; never raw auth responses.
- Replay reconstructs kernel state, not external side effects. After crash, read/resume provider thread and reconcile completed items; if an action's outcome is ambiguous, mark reconciliation-needed instead of blindly retrying. A thread ID is not an exactly-once transaction guarantee.
- Capability enforcement must cover BOTH kernel tools and Codex's own execution. Set restrictive Codex sandbox/approval policy explicitly and use OS isolation for stronger guarantees; a TypeScript allowlist alone cannot constrain tools already executing inside Codex.
- Memory tiers: bounded stable user/project facts; per-task working state; searchable evidence/history. Each promoted fact needs origin/event handle, observed time, scope, confidence/source-claim label, and supersedes/expiry metadata. Freeze startup memory; append newly retrieved evidence as current context instead of rewriting the cached prefix.
- Skills are reviewed/versioned procedures with provenance, prerequisites, capability needs, and a smoke test. Skills are not authority to widen permissions.
- Orchestration starts with one active task/turn; add bounded independent child tasks only after restart/cancellation correctness. Children report artifact handles plus evidence, never automatically trusted success.

## First implementation acceptance gates (not run)

1. Real pinned Codex handshake/schema smoke test; mock-only success is insufficient.
2. Human-completed OAuth login, subsequent account read, and a harmless real model turn using an actually offered model ID; explicit unavailable-Astra failure path.
3. Approval denied => operation does not run; out-of-workspace write and unapproved network access fail under actual execution policy.
4. Interrupt and process-crash recovery reconcile provider state without duplicate side effects.
5. Journal replay reproduces task state; auth URL/device code/token/PII never enter logs or memory.
6. Memory recall cites original evidence; changed facts supersede old facts without silently rewriting history.

## Retrieval and uncertainty

The supplied developers.openai.com app-server/auth URLs redirected during extraction to learn.chatgpt.com. Public repository app-server README was then retrieved directly with curl for auth specifics (local `codex-app-server.source.md`); SDK README is `codex-sdk.source.md`. An extraction-service 429 for OpenClaw subagents succeeded on a subsequent request. Main-branch sources are moving targets, not a tested release contract. In particular, remote Code Mode host details differ between website and repository README; this proposal intentionally does not depend on them. No claim is made about private Astra prompts, hidden tools, training, model optimality, local installed Codex version, or Ryan's live account entitlements.

## Sources

[1] https://learn.chatgpt.com/docs/app-server
[2] https://learn.chatgpt.com/docs/auth
[3] https://hermes-agent.nousresearch.com/docs
[4] https://github.com/openclaw/openclaw
[5] https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server/README.md
[6] https://developers.openai.com/codex/sdk
[8] https://docs.openclaw.ai/concepts/memory
[9] https://docs.openclaw.ai/tools/subagents
[10] https://hermes-agent.nousresearch.com/docs/user-guide/features/memory
[11] https://raw.githubusercontent.com/openai/codex/main/sdk/typescript/README.md
