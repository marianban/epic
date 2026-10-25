# Deterministic Pi epic

See the [overall workflow diagram](workflow.md) for a visual overview and concise descriptions of each step.

This project-local extension provides one sequential, human-gated epic:

`/epic` → Scout → Planner → run-scoped `plan.md` review → approval → Task Planner → prerequisite check/approval → (human task review/approval → independent scenario planning → Implementer → required checks → mandatory smoke for browser tasks → acceptance verification → Reviewer → post-implementation human task review) for each task → final verification.

## Installation

Load the extension from this repository with Pi, or install the project as a Pi package after reviewing the code. The extension entry point is `pi/extensions/epic/index.ts`. Copy `pi/epic.config.example.json` to `.pi/epic.config.json` to configure commands and role models.

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
- `/epic-resume` retries failed acceptance planning in a fresh bounded batch, revalidates a task at its verification checkpoint, or resumes the current workflow boundary.
- `/epic-exit` hides the Epic widgets without changing persisted Epic state.
- `/epic-approve-prerequisites` applies the exact prerequisite commands discovered for the repository after human approval.
- `/plan-review` extracts standalone or trailing inline `R:` comments and asks the Planner to revise.
- `/plan-revise` forces a Planner revision.
- `/task-approve` continues the current task review: it refines `R:` findings automatically, or approves the task when no findings remain.
- `/task-review` refines pre-implementation task-artifact `R:` findings. After implementation, code repairs require an explicit `/task-repair` grant; ordinary resume does not grant attempts.
- `/plan-approve` continues plan review: it refines `R:` findings automatically, or validates, hashes, and approves the plan when no findings remain.

Plan approval records a hash, then starts implementation. The approved plan hash remains in persisted state so implementation cannot be entered through an unapproved path.

After approval, the Task Planner writes a persisted task manifest and one artifact per task under `.pi/epics/runs/<epic-id>/tasks/`. Before each task’s implementation, the epic pauses for human review of its artifact. Human findings are added as `R:` lines and revised by the task reviewer through `/task-review`; implementation cannot begin until `/task-approve` is run. After implementation and semantic review, the epic pauses again for human review; the immutable verification report shows every criterion and the current readiness. Further repairs require an explicit bounded grant before the task can advance.

## Persistence and checks

Runs are stored under `.pi/epics/runs/<epic-id>/`, with atomic `state.json`, append-only `events.jsonl`, detailed `epic.log`, per-invocation filtered diagnostic JSONL files under `agent-runs/`, `Epic.md`, the active `plan.md`, task artifacts, and plan revisions. Each agent diagnostic log retains complete prompts, responses, tool starts and results, lifecycle events, errors, and unexpected output while discarding redundant streaming and aggregate records. Retained records are written incrementally to a new private file for every role invocation so they remain available if the parent process crashes. `.pi/epics/` owns all run artifacts, including the active plan.

Successful check progress and dependency JSON are retained in check artifacts rather than reported as findings. Explicit warning/error lines remain findings; failed checks retain their diagnostic output. Reviewer prompts, repair feedback, and check-completion logs use compact summaries, with bounded failure previews and artifact references instead of repeated raw output or domain snapshots. Full verification evidence remains in the run artifacts.

`state.json` contains a versioned hierarchical XState persisted snapshot together with durable epic context and artifact references. The current schema/machine version is `8/13`. Older or malformed snapshots, including schema 7 / machine 12, are reported as incompatible and are not silently migrated; start a new epic unless an explicit migration is added later.

Fast checks include `git diff --check`, dependency installation when `package.json` exists, and configured/discovered typecheck, lint, and focused tests. Full checks include dependency installation, configured/discovered tests and build, plus Fallow when configured. Prerequisite installation uses the repository lockfile when present. During task verification, the install gate checks installed dependency health with `npm ls --all --json` rather than reinstalling and changing candidate inputs. Every command has a timeout and bounded output. Missing package scripts are not invented as failures; configure repository-specific commands explicitly when they are required gates. Each decomposed task declares `requiredChecks`, `deferredChecks`, and a dependency-based `reason`; task-local suites execute only required checks, while other discovered checks are skipped. Deferred checks are recorded as skipped for that task and are always run by final verification.

Tasks with browser-observable runtime behavior declare the stable `browser-smoke` check and include an exact development-server command in their human-approved `verification` list. The Implementer returns a matching structured loopback launch specification but does not start the server or introduce a new command. During each verification cycle, the epic runtime launches and supervises that process, waits for HTTP readiness, and uses its own `playwright-core` dependency with an installed Chrome or Chromium executable. Smoke verification waits for the declared CSS readiness selector and rejects page exceptions, console errors, failed same-origin requests, same-origin HTTP errors, page crashes, and timeouts before semantic or human review. The browser and server are stopped on every exit path, and results plus a successful screenshot are stored with the run artifacts.

Browser discovery prefers `checks.browserSmoke.executablePath`, then documented Chrome/Chromium installation locations, then compatible executables on `PATH`. Discovery never downloads a browser or silently skips the gate. Task verification operations receive the remaining shared time allowance. Legacy standalone smoke helpers retain their configured startup/navigation/selector settings; these do not create separate task verification allowances.

After plan approval, the epic checks for a Git repository and declared Node dependencies. In a new or non-Git directory it proposes `git init`; when `package.json` dependencies are missing it proposes the appropriate lockfile-aware install command (`npm ci`, `npm install`, `pnpm install`, or `yarn install`). These repository-level prerequisite commands are persisted in the run artifacts and never execute until `/epic-approve-prerequisites` is run. If an approved implementation task creates its own manifest and explicitly includes dependency installation, the writable Implementer may run that task-local install inside its OS sandbox.

Acceptance scenarios are planned independently before implementation. The verifier must return one valid JSON object with the frozen criteria and explicit browser-step fields such as `{"action":"inspect","expression":"document.querySelector('#game-container') !== null"}`. `maxAcceptancePlanRepairs` defaults to 2 (one initial call plus two corrections), accepts zero, and is persisted per epic. Only invalid JSON or scenario-contract failures receive automatic corrections with field-specific validation issues. Invocation, timeout, storage, and persisted-criteria failures pause immediately. These calls never consume verification infrastructure retries, code repairs, or the verification deadline.

Failed or interrupted planning pauses at `acceptance_planning_failed`, with diagnostics and a **Retry acceptance planning** action using `/epic-resume`. Task approval and report-bound decisions are unavailable there; no acceptance report is produced. Resume retains the approved task and frozen criteria, starts a fresh bounded batch, and proceeds to implementation only after a valid plan is persisted. Reopening a planning failure preserves it; reopening interrupted planning pauses without running agents. A valid plan already persisted before interruption is reused on explicit resume. Attempt events retain batch/attempt IDs, validation issues, agent invocation IDs, and available log references.

Task verification persists a task-owned allowance ledger, versioned criterion/scenario plans, cycle evidence, and immutable JSON/Markdown human reports. `maxTaskRepairs` defaults to 6, `maxTaskInfrastructureRetries` to 1, and `taskVerificationTimeoutMs` to 1800000. Counts may be zero. Obsolete phase-specific repair settings are rejected.

Repairs and infrastructure retries are charged before invocation. The shared deadline starts at first verification after initial implementation. Active downtime counts; human-checkpoint waiting does not. Resume revalidates with remaining allowances; interrupted invocations remain charged. During verification, exhaustion, cancellation, timeout, and tool failures produce a report instead of automatically accepting or editing the application. Exit remains UI-only.

Ordinary `/task-approve` requires all criteria met, passing mandatory checks, and no actionable findings. Other decisions use JSON arguments copied from the current report:

- `/task-accept {"identity":"...","reportId":"...","obligations":["each unresolved ID"],"reason":"I checked it manually, or accept the remaining limitations"}` accepts the current report and continues to checkpoint creation. It replaces `/task-confirm` and `/task-accept-unresolved`: manual review and acceptance of known limitations use the same action. Every unresolved result must be acknowledged; acceptance preserves the report and its findings instead of marking unverified or failed checks as passed. The report includes a command with the current identity, report ID, and unresolved IDs. Existing decision records retain their meaning; the replaced commands are no longer registered.
- `/task-repair` takes no arguments. It uses the current task's latest report, grants one additional repair attempt and five additional minutes, and resumes verification and repair of unresolved issues. It rejects arguments and an already verified task. Usage history is retained.

To review later, use `/epic-exit` to hide the dashboard. The task remains awaiting review without recording a decision.

Verification is advisory. Each cycle has a unique attempt identifier; evidence and human decisions are bound to that attempt and its report, not a hash of candidate contents. Source, dependency, configuration, and generated-file changes do not discard results or block decisions or checkpoints. Rerunning verification creates a new attempt and report requiring a fresh acceptance decision. Acceptance criteria remain frozen for the task.

Scripted browser scenarios and verifier `browser_verify` tools share one runtime-owned server/browser scope per cycle, with isolated contexts per scenario. Interactions retain console errors, exceptions, failed same-origin requests, screenshots, and traces. The loopback bridge is authenticated and closed with the scope. Static/local commands and genuine human-only obligations also receive explicit evidence entries.

For `agent_browser` obligations, the plan fixes the expected behavior and leaves the verifier free to choose interactions and assertions. Planned steps are optional suggestions. The verifier can inspect diagnostic values with `observe`, correct a faulty selector or assertion, and retry an equivalent check within the same invocation without spending an implementation repair. Diagnostic observations alone cannot pass an obligation. Every probe retains its artifact; the latest result per obligation supplies acceptance evidence. Automated scenarios still execute their prescribed steps and require assertions.

The repository-owned `tests/fixtures/` counter exercises the release gate: startup smoke passes on faulty behavior, clicking exposes an exception, a charged test repair fixes it, and all checks rerun. `npm test` requires an installed Chrome/Chromium and local server access; the real-browser gate is never skipped. No external game project is required.

## Security boundaries

The extension rejects paths outside the repository and sensitive paths such as `.env`, SSH keys, credentials, and token files. Scout, Planner, Task Planner, and Reviewer cannot write; the Implementer may write repository files but cannot write the run plan, epic state, or `.git`. Implementer processes are sandboxed with macOS `sandbox-exec` or Linux `bubblewrap`; writes are limited to the repository, temporary files, and Pi's global agent directory (needed for Pi settings and credential lock files), while network access is unrestricted. This means the Implementer can modify global Pi settings or authentication storage and reach any external service; review the configured commands and role models before trusting a project-local epic. Native Windows is unsupported for Implementers; run Pi from WSL. If the OS sandbox cannot initialize, the Implementer fails instead of falling back to an unrestricted process. Repository-level `git init` and dependency installation still require the dedicated human approval command, while an explicitly approved task-local install is permitted for the Implementer.
