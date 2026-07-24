# Repository Agent Rules

- Do not implicitly implement backward compatibility in the epic extension. If an older persisted epic state or extension version is incompatible, diagnose and report the incompatibility first. Only add a compatibility migration when the user explicitly requests it.
- When diagnosing an issue, if it is caused by or reveals an epic/extension compatibility problem, clearly inform the user about that compatibility issue, including the affected versions or state when known, before proposing remediation.
