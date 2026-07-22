# Repository Agent Rules

- Do not implicitly implement backward compatibility in the workflow extension. If an older persisted workflow state or extension version is incompatible, diagnose and report the incompatibility first. Only add a compatibility migration when the user explicitly requests it.
- When diagnosing an issue, if it is caused by or reveals a workflow/extension compatibility problem, clearly inform the user about that compatibility issue, including the affected versions or state when known, before proposing remediation.
