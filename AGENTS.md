# Repository Agent Rules

- Do not implicitly implement backward compatibility in the epic extension. If an older persisted epic state or extension version is incompatible, diagnose and report the incompatibility first. Only add a compatibility migration when the user explicitly requests it.
- When diagnosing an issue, if it is caused by or reveals an epic/extension compatibility problem, clearly inform the user about that compatibility issue, including the affected versions or state when known, before proposing remediation.
- avoid generic entrypoints like index.ts.
- Prefer thin orchestration/composition modules. Extract distinct concerns into modules.
- Use fail-fast behavior. Surface errors explicitly instead of silently ignoring invalid states.
- Provide required constructor/service/function parameters explicitly; avoid hidden defaults for clocks, timeouts, and operational dependencies.
- Compute or inject operational values at composition/call sites; avoid conditional fallback initialization inside application code.
- After every code change, check `docs/workflow.md` against the implementation and update any affected workflow descriptions, diagrams, commands, and review or recovery behavior in the same change. Code is the source of truth.
