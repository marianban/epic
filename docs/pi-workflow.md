# Deterministic Pi workflow

This project-local extension provides one sequential, human-gated workflow:

`/workflow` → Scout → Planner → `plan.md` review → approval → task decomposition → prerequisite check/approval → (human task review/approval → Implementer → deterministic checks → Reviewer → post-implementation human task review) for each task → final verification.

## Installation

Load the extension from this repository with Pi, or install the project as a Pi package after reviewing the code. The extension entry point is `.pi/extensions/workflow/index.ts`. Copy `.pi/workflow.config.example.json` to `.pi/workflow.config.json` to configure commands and role models.

Each enabled role runs in a separate `pi --mode json --no-session` process. Model/provider profiles are configured independently in the workflow config. The Orchestrator, Scout, and Planner are read-only. When loaded from another directory with `pi -e`, bundled role prompts are used automatically; project-local `.pi/agents/*.md` files override them.

The workflow lifecycle is represented by a typed XState v5 actor. The root machine owns planning, prerequisites, sequential task execution, escalation, final verification, and terminal states. Task execution is an invoked child actor with explicit approval, implementation, checks, semantic review, repair, and human-review states. Commands send domain events through the workflow runtime adapter; they cannot bypass machine guards.

## Live inspection

The workflow can be visualized while it runs with Stately Inspector. Set `inspector.enabled` to `true` in `.pi/workflow.config.json`; the extension starts a local WebSocket bridge on port `8080` and opens the inspector automatically. The bridge remains available across workflow commands for the lifetime of the Pi extension process. Set `inspector.port` to use another port or `inspector.autoOpen` to control browser opening. Inspection is disabled by default, and context snapshots are sanitized before they are sent to the inspector. For one-off debugging, `PI_WORKFLOW_INSPECTOR=1` enables it and `PI_WORKFLOW_INSPECTOR=0` disables it; the corresponding environment variables can override the port and auto-open setting.

The inspector shows root and child actor transitions as a live state-machine and sequence view. It is intended for local debugging; do not enable it for workflows whose event or context data must remain private.

The initial Scout is not necessarily the only discovery pass. A Planner may return a focused `needs_more_context` request; the engine sends only those questions to another read-only Scout and gives the merged evidence back to the Planner. This loop is bounded by `maxScoutRounds` (default: 3).

## Commands

- `/workflow <task>` starts one workflow and always pauses after writing `plan.md`.
- `/workflow-status` shows persisted state and the pending human action.
- `/workflow-resume` resumes safe in-progress work or retries a failed pre-plan run as a new audited run.
- `/workflow-approve-prerequisites` applies the exact prerequisite commands discovered for the repository after human approval.
- `/workflow-cancel` cancels without reverting repository changes.
- `/plan-review` extracts standalone or trailing inline `R:` comments and asks the Planner to revise.
- `/plan-revise` forces a Planner revision.
- `/task-approve` approves the current task specification before implementation, or approves the completed implementation after following its manual review steps.
- `/task-review` applies `R:` findings written into the current task artifact. Before implementation it invokes the task reviewer and pauses again for approval; after implementation it invokes the Implementer and reruns the task’s gates.
- `/plan-approve` validates the plan, hashes it, and completes the planning phase. Unresolved `R:` lines are rejected.

Plan approval records a hash, then starts implementation. The approved plan hash remains in persisted state so implementation cannot be entered through an unapproved path.

After approval, the Planner writes a persisted task manifest and one artifact per task under `.pi/workflows/runs/<workflow-id>/tasks/`. Before each task’s implementation, the workflow pauses for human review of its artifact. Human findings are added as `R:` lines and revised by the task reviewer through `/task-review`; implementation cannot begin until `/task-approve` is run. After implementation and semantic review, the workflow pauses again for human review; post-implementation `R:` findings are fixed by the Implementer through `/task-review` before the task can be approved and the workflow advances.

## Persistence and checks

Runs are stored under `.pi/workflows/runs/<workflow-id>/`, with atomic `state.json`, append-only `events.jsonl`, detailed `workflow.log`, Scout report, task, and plan revisions. `workflow.log` contains timestamped structured records for state changes, agent lifecycle/output, progress, and verification commands; secrets are redacted before writing. `.pi/workflows/` is ignored; `plan.md` is intentionally not ignored.

`state.json` contains a versioned hierarchical XState persisted snapshot together with durable workflow context and artifact references. The current schema/machine version is `2/3`. Older or malformed snapshots, including partial-migration snapshots, are reported as incompatible and are not silently migrated; start a new workflow unless an explicit migration is added later.

Fast checks include `git diff --check` and configured/discovered typecheck, lint, and focused tests. Full checks include configured/discovered tests and build, plus Fallow when configured. Every command has a timeout and bounded output. Missing package scripts are not invented as failures; configure repository-specific commands explicitly when they are required gates.

After plan approval, the workflow checks for a Git repository and declared Node dependencies. In a new or non-Git directory it proposes `git init`; when `package.json` dependencies are missing it proposes the appropriate lockfile-aware install command (`npm ci`, `npm install`, `pnpm install`, or `yarn install`). These commands are persisted in the run artifacts and never execute until `/workflow-approve-prerequisites` is run.

Fast, full, semantic-repair, and final-verification stages are persisted independently. Each repair class is bounded by configuration; exhausting a limit pauses in `escalating` and requires `/workflow-resume` or `/workflow-cancel`.

## Security boundaries

The extension rejects paths outside the repository and sensitive paths such as `.env`, SSH keys, credentials, and token files. Scout, Planner, and Reviewer cannot write; the Implementer may write repository files but cannot write `plan.md` or workflow state. Commands never commit, push, or change git history automatically; `git init` and dependency installation require the dedicated human approval command. Review the configured commands and role models before trusting a project-local workflow.
