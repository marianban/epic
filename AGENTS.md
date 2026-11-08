# Repository Agent Rules

- Run Fallow review/audit commands that compare against a Git base with elevated permissions (`sandbox_permissions: "require_escalated"`). They create temporary comparison worktrees and must write to `.git/worktrees`, which the sandbox blocks. An error creating the comparison worktree requires rerunning with elevated permissions.
- Do not implicitly implement backward compatibility in the epic extension. If an older persisted epic state or extension version is incompatible, diagnose and report the incompatibility first. Only add a compatibility migration when the user explicitly requests it.
- When diagnosing an issue, if it is caused by or reveals an epic/extension compatibility problem, clearly inform the user about that compatibility issue, including the affected versions or state when known, before proposing remediation.
- avoid generic entrypoints like index.ts.
- Prefer thin orchestration/composition modules. Extract distinct concerns into modules.
- Use fail-fast behavior. Surface errors explicitly instead of silently ignoring invalid states.
- Provide required constructor/service/function parameters explicitly; avoid hidden defaults for clocks, timeouts, and operational dependencies.
- Compute or inject operational values at composition/call sites; avoid conditional fallback initialization inside application code.
- Update `docs/workflow.md` only when a change alters the workflow or its commands, including workflow steps, decisions, or review and recovery behavior. Update affected descriptions, diagrams, and commands in the same change. Implementation-only changes do not require workflow documentation updates. Code is the source of truth.
