# Current direction: a one-shot agent

Ryan's clarification after the initial design jam supersedes the companion/chat-oriented portions of DESIGN.md and the original research recommendations. The first executable vertical slice is implemented in `src/`; live provider and container integration remain separate work.

```sh
yolo "<prompt>"
yolo -t 10 "<prompt>"
```

One invocation, one goal, bounded autonomous work, a final result and artifacts, then exit. No ongoing chat interface, gateway, or task-management dashboard. Proposed default time budget: 10 minutes, subject to implementation validation. `-t` is a wall-clock maximum, not a requirement to keep working after completion; cancellation and stopping active tools must be real, not merely stopping output. Setup/auth is separate from the work budget. At deadline, report the verified partial result, remaining work, and any uncertain effects rather than claim success.

Keep the original design's useful pieces: scoped tools, evidence-backed memory, compact context, budgets, inspectable events, and isolated experimentation. Memory can persist across invocations without introducing a chat product. Do not add a large framework to support a small command.

## Correction: direct device-code auth is a real option

The original jam chose official Codex app-server for a documented integration boundary. That was a conservative architecture choice, **not a technical requirement that Codex be installed for subscription authentication**. We should have inspected Hermes's direct implementation before locking that choice.

Read-only inspection of the installed Hermes source at revision `c5c9aa8d44e03f4e8b5fe7f230cfd97ab2dde0bf` found:

- `hermes_cli/auth.py::_codex_device_code_login` performs HTTP requests itself: request a user/device code, show the verification URL, poll for authorization, then exchange the authorization code and verifier at the OAuth token endpoint. This function does not launch Codex CLI.
- The provider uses `https://chatgpt.com/backend-api/codex`; Hermes has its own Responses-format adapter/transport and token-refresh handling.
- Official Hermes provider documentation describes fresh device-code login through `hermes auth add openai-codex`.

References:
- https://hermes-agent.nousresearch.com/docs/integrations/providers
- https://github.com/NousResearch/hermes-agent/blob/c5c9aa8d44e03f4e8b5fe7f230cfd97ab2dde0bf/hermes_cli/auth.py
- https://github.com/NousResearch/hermes-agent/blob/c5c9aa8d44e03f4e8b5fe7f230cfd97ab2dde0bf/agent/transports/codex.py

Preferred next investigation: a narrow direct auth + Responses transport informed by Hermes, so YOLOharness can own its agent loop without shipping Codex CLI. Validate client registration/use conditions, protocol compatibility, model availability, refresh concurrency, revocation, error handling, and source licensing before implementation. Observing a working open-source integration is not a guarantee of an indefinitely supported third-party API contract. Device-code login solves authentication, not the whole model/tool execution protocol.

Do not copy existing Hermes credentials into the project or commit auth state. No login, refresh, token reading, or live model request was performed during this inspection. Codex app-server remains an optional alternative, not a mandatory prerequisite.

## Container-first execution

Target a disposable container for each run. Docker may be installed later by Ryan; no installation is requested now. Mount only the selected project, not the whole home, SSH directory, Docker socket, or credential store. Run without privilege, constrain resources, and make network access deliberate. Keep provider credentials outside the untrusted tool-execution environment; assess a small host-side auth/model broker rather than giving arbitrary shell tools access to refresh tokens. A container alone is not a complete sandbox.

The shipped Linux MVP is an installable, container-only CLI. The historical prototype remains a local deterministic fixture and is not part of the package; neither path is a safe autonomous host-shell agent fallback. Skills are limited to project/shared roots, project precedence, bounded regular-file snapshots, and container-side loading.

## Current authorization

Ryan authorized local Git initialization, creation of a new public repository in TekGadgt-Org, and pushing this snapshot. The organization/PAT setup does not allow private repositories. This is not authorization to implement the live agent, install Docker, change credentials, deploy, or publish a package.
