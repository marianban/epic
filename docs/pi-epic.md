# Deterministic Pi epic

This project-local extension provides one sequential, human-gated epic:

`/epic` → Scout → Planner → run-scoped `plan.md` review → approval → Task Planner → prerequisite check/approval → (human task review/approval → Implementer → deterministic checks → optional browser smoke → Reviewer → post-implementation human task review) for each task → final verification.

## Installation

Load the extension from this repository with Pi, or install the project as a Pi package after reviewing the code. The extension entry point is `.pi/extensions/epic/index.ts`. Copy `.pi/epic.config.example.json` to `.pi/epic.config.json` to configure commands and role models.

Each enabled role runs in a separate `pi --mode json --no-session` process. Model/provider profiles are configured independently in the epic config. All roles except the Implementer are read-only. When loaded from another directory with `pi -e`, bundled role prompts are used automatically; project-local `.pi/agents/*.md` files override them.

Implementer sandbox prerequisites are `rg` on macOS, and `rg`, `bubblewrap` (`bwrap`), and `socat` on Linux. Windows Implementers are unsupported; use WSL.

The epic lifecycle is represented by a typed XState v5 actor. The root machine owns planning, prerequisites, sequential task execution, escalation, final verification, and terminal states. Task execution is an invoked child actor with explicit approval, implementation, checks, semantic review, repair, and human-review states. Commands send domain events through the epic runtime adapter; they cannot bypass machine guards.

## Live inspection

The epic can be visualized while it runs with Stately Inspector. Set `inspector.enabled` to `true` in `.pi/epic.config.json`; the extension starts a local WebSocket bridge on port `8080` and opens the inspector automatically. The bridge remains available across epic commands for the lifetime of the Pi extension process. Set `inspector.port` to use another port or `inspector.autoOpen` to control browser opening. Inspection is disabled by default, and context snapshots are sanitized before they are sent to the inspector. For one-off debugging, `PI_EPIC_INSPECTOR=1` enables it and `PI_EPIC_INSPECTOR=0` disables it; the corresponding environment variables can override the port and auto-open setting.

The inspector shows root and child actor transitions as a live state-machine and sequence view. It is intended for local debugging; do not enable it for epics whose event or context data must remain private.

The initial Scout is not necessarily the only discovery pass. A Planner may return a focused `needs_more_context` request; the engine sends only those questions to another read-only Scout and gives the merged evidence back to the Planner. This loop is bounded by `maxScoutRounds` (default: 3). After plan approval, the Task Planner receives the hash-verified plan plus epic/repository context and decomposes it into ordered, independently reviewable tasks.

## Commands

- `/epic <epic>` starts one epic, writes the run's `Epic.md`, and always pauses after writing its run-scoped `plan.md`.
- `/epic-status` shows persisted state and the pending human action.
- `/epic-resume` resumes safe in-progress work or retries a failed pre-plan run as a new audited run.
- `/epic-exit` hides the Epic widgets without changing persisted Epic state.
- `/epic-approve-prerequisites` applies the exact prerequisite commands discovered for the repository after human approval.
- `/plan-review` extracts standalone or trailing inline `R:` comments and asks the Planner to revise.
- `/plan-revise` forces a Planner revision.
- `/task-approve` continues the current task review: it refines `R:` findings automatically, or approves the task when no findings remain.
- `/task-review` applies `R:` findings written into the current task artifact. Before implementation it invokes the task reviewer and pauses again for approval; after implementation it invokes the Implementer and reruns the task’s gates.
- `/plan-approve` continues plan review: it refines `R:` findings automatically, or validates, hashes, and approves the plan when no findings remain.

Plan approval records a hash, then starts implementation. The approved plan hash remains in persisted state so implementation cannot be entered through an unapproved path.

After approval, the Task Planner writes a persisted task manifest and one artifact per task under `.pi/epics/runs/<epic-id>/tasks/`. Before each task’s implementation, the epic pauses for human review of its artifact. Human findings are added as `R:` lines and revised by the task reviewer through `/task-review`; implementation cannot begin until `/task-approve` is run. After implementation and semantic review, the epic pauses again for human review; post-implementation `R:` findings are fixed by the Implementer through `/task-review` before the task can be approved and the epic advances.

## Persistence and checks

Runs are stored under `.pi/epics/runs/<epic-id>/`, with atomic `state.json`, append-only `events.jsonl`, detailed `epic.log`, per-invocation filtered diagnostic JSONL files under `agent-runs/`, `Epic.md`, the active `plan.md`, task artifacts, and plan revisions. Each agent diagnostic log retains complete prompts, responses, tool starts and results, lifecycle events, errors, and unexpected output while discarding redundant streaming and aggregate records. Retained records are written incrementally to a new private file for every role invocation so they remain available if the parent process crashes. `.pi/epics/` owns all run artifacts, including the active plan.

`state.json` contains a versioned hierarchical XState persisted snapshot together with durable epic context and artifact references. The current schema/machine version is `6/11`. Older or malformed snapshots, including machine version `10`, are reported as incompatible and are not silently migrated; start a new epic unless an explicit migration is added later.

Fast checks include `git diff --check`, dependency installation when `package.json` exists, and configured/discovered typecheck, lint, and focused tests. Full checks include dependency installation, configured/discovered tests and build, plus Fallow when configured. Installation uses the repository lockfile when present. Every command has a timeout and bounded output. Missing package scripts are not invented as failures; configure repository-specific commands explicitly when they are required gates. Each decomposed task declares `requiredChecks`, `deferredChecks`, and a dependency-based `reason`; task-local suites execute only required checks, while other discovered checks are skipped. Deferred checks are recorded as skipped for that task and are always run by final verification.

Tasks with browser-observable runtime behavior declare the stable `browser-smoke` check and include an exact development-server command in their human-approved `verification` list. The Implementer returns a matching structured loopback launch specification but does not start the server or introduce a new command. After fast and full checks pass, the epic runtime launches and supervises that process, waits for HTTP readiness, and uses its own `playwright-core` dependency with an installed Chrome or Chromium executable. Smoke verification waits for the declared CSS readiness selector and rejects page exceptions, console errors, failed same-origin requests, same-origin HTTP errors, page crashes, and timeouts before semantic or human review. The browser and server are stopped on every exit path, and results plus a successful screenshot are stored with the run artifacts.

Browser discovery prefers `checks.browserSmoke.executablePath`, then documented Chrome/Chromium installation locations, then compatible executables on `PATH`. Discovery never downloads a browser or silently skips the gate. `checks.browserSmoke` also configures `startupTimeoutMs`, `navigationTimeoutMs`, `selectorTimeoutMs`, and `settleTimeoutMs`; resolved defaults are shown in `pi/epic.config.example.json`.

After plan approval, the epic checks for a Git repository and declared Node dependencies. In a new or non-Git directory it proposes `git init`; when `package.json` dependencies are missing it proposes the appropriate lockfile-aware install command (`npm ci`, `npm install`, `pnpm install`, or `yarn install`). These repository-level prerequisite commands are persisted in the run artifacts and never execute until `/epic-approve-prerequisites` is run. If an approved implementation task creates its own manifest and explicitly includes dependency installation, the writable Implementer may run that task-local install inside its OS sandbox.

Fast, full, semantic-repair, and final-verification stages are persisted independently. Each repair class is bounded by configuration; exhausting a limit pauses in `escalating` and requires `/epic-resume`. Exit is UI-only, so an exited Epic remains resumable.

## Security boundaries

The extension rejects paths outside the repository and sensitive paths such as `.env`, SSH keys, credentials, and token files. Scout, Planner, Task Planner, and Reviewer cannot write; the Implementer may write repository files but cannot write the run plan, epic state, or `.git`. Implementer processes are sandboxed with macOS `sandbox-exec` or Linux `bubblewrap`; writes are limited to the repository, temporary files, and Pi's global agent directory (needed for Pi settings and credential lock files), while network access is unrestricted. This means the Implementer can modify global Pi settings or authentication storage and reach any external service; review the configured commands and role models before trusting a project-local epic. Native Windows is unsupported for Implementers; run Pi from WSL. If the OS sandbox cannot initialize, the Implementer fails instead of falling back to an unrestricted process. Repository-level `git init` and dependency installation still require the dedicated human approval command, while an explicitly approved task-local install is permitted for the Implementer.
