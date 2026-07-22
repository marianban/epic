# Deterministic Pi workflow

This project-local extension provides one sequential, human-gated workflow:

`/workflow` → Scout → Planner → `plan.md` review → approval.

This repository currently implements the planning phase only. Code-change and verification stages will be added after this flow is stable.

## Installation

Load the extension from this repository with Pi, or install the project as a Pi package after reviewing the code. The extension entry point is `.pi/extensions/workflow/index.ts`. Copy `.pi/workflow.config.example.json` to `.pi/workflow.config.json` to configure commands and role models.

Each enabled role runs in a separate `pi --mode json --no-session` process. Model/provider profiles are configured independently in the workflow config. The Orchestrator, Scout, and Planner are read-only. When loaded from another directory with `pi -e`, bundled role prompts are used automatically; project-local `.pi/agents/*.md` files override them.

The initial Scout is not necessarily the only discovery pass. A Planner may return a focused `needs_more_context` request; the engine sends only those questions to another read-only Scout and gives the merged evidence back to the Planner. This loop is bounded by `maxScoutRounds` (default: 3).

## Commands

- `/workflow <task>` starts one workflow and always pauses after writing `plan.md`.
- `/workflow-status` shows persisted state and the pending human action.
- `/workflow-resume` resumes safe in-progress work or retries a failed pre-plan run as a new audited run.
- `/workflow-cancel` cancels without reverting repository changes.
- `/plan-review` extracts lines matching `^\s*R:\s*(.+?)\s*$` and asks the Planner to revise.
- `/plan-revise` forces a Planner revision.
- `/plan-approve` validates the plan, hashes it, and completes the planning phase. Unresolved `R:` lines are rejected.

Plan approval records a hash and completes the planning phase. No repository implementation is performed yet.

## Persistence and checks

Runs are stored under `.pi/workflows/runs/<workflow-id>/`, with atomic `state.json`, append-only `events.jsonl`, detailed `workflow.log`, Scout report, task, and plan revisions. `workflow.log` contains timestamped structured records for state changes, agent lifecycle/output, progress, and verification commands; secrets are redacted before writing. `.pi/workflows/` is ignored; `plan.md` is intentionally not ignored.

Fast checks include `git diff --check` and configured/discovered typecheck, lint, and focused tests. Full checks include configured/discovered tests and build, plus Fallow when configured. Every command has a timeout and bounded output. Missing package scripts are not invented as failures; configure repository-specific commands explicitly when they are required gates.

Repair loops and verification gates are intentionally not active in this phase.

## Security boundaries

The extension rejects paths outside the repository and sensitive paths such as `.env`, SSH keys, credentials, and token files. Agents cannot write `plan.md` or workflow state. Commands never commit, push, install dependencies, or change git history automatically. Review the configured commands and role models before trusting a project-local workflow.
