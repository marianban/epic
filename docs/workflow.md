# Epic workflow

An epic runs tasks sequentially, with human approval before implementation and after verification. See [Deterministic Pi epic](pi-epic.md) for configuration, commands, and artifact details.

```mermaid
flowchart TD
    Start["1. Start epic"] --> Classify["2. Classify request"]
    Classify --> Scout["3. Scout repository"]
    Scout --> Plan["4. Draft plan"]
    Plan -->|More context needed; bounded loop| Scout
    Plan --> PlanReview["5. Human plan review"]
    PlanReview -->|Revise findings| PlanRevision["Revise plan"]
    PlanRevision --> PlanReview
    PlanReview -->|Approve and hash plan| Tasks["6. Decompose into tasks"]
    Tasks --> Prereqs{"7. Prerequisites ready?"}
    Prereqs -->|No| Setup["Human approves prerequisite commands; runtime applies them"]
    Setup --> TaskReview
    Prereqs -->|Yes| TaskReview

    subgraph TaskLoop["Repeat for each task"]
        TaskReview["8. Human task review"] -->|Revise findings| TaskRevision["Revise task artifact"]
        TaskRevision --> TaskReview
        TaskReview -->|Approve| Scenarios["9. Plan acceptance scenarios"]
        Scenarios -->|Planning fails| PlanningPause["Pause with diagnostics"]
        PlanningPause -->|Explicit resume| Scenarios
        Scenarios -->|Valid plan persisted| Implement["10. Implement task"]
        Implement --> Checks["11. Run required checks"]
        Checks --> Smoke["12. Browser smoke when required"]
        Smoke --> Verify["13. Verify acceptance criteria"]
        Verify --> Review["14. Independent code review"]
        Review --> Repairable{"Actionable failures and repair allowance?"}
        Repairable -->|Yes| Repair["Repair implementation"]
        Repair --> Checks
        Repairable -->|No| Human["15. Human reviews immutable report"]
        Human -->|Grant repair or rerun verification| Checks
        Human -->|Approve verified task or explicitly accept unresolved results| Checkpoint["16. Create Git checkpoint"]
    end

    Checkpoint --> More{"More tasks?"}
    More -->|Yes| TaskReview
    More -->|No| Final["17. Run final verification, including deferred checks"]
    Final -->|Pass| Done["18. Epic completed"]
    Final -->|Fail or error| Recovery["Pause with recovery diagnostics"]
    Recovery -->|Approve recovery and retry| Final
```

| Step | Description |
| --- | --- |
| 1. Start epic | `/epic <epic>` creates the run and saves the request in `Epic.md`. |
| 2. Classify request | Establish the epic's scope and execution context. |
| 3. Scout repository | Gather read-only evidence about the code, constraints, and available checks. |
| 4. Draft plan | Write the run's `plan.md`; request focused scouting if evidence is missing. |
| 5. Human plan review | Resolve `R:` comments through revision; `/plan-approve` validates and hashes the approved plan. |
| 6. Decompose into tasks | Task Planner turns the approved plan into ordered task artifacts with criteria and check policies. |
| 7. Prepare prerequisites | Detect missing Git setup or dependencies; execute proposed commands only after `/epic-approve-prerequisites`. |
| 8. Human task review | Review the task artifact, refine `R:` findings, and run `/task-approve` before implementation. |
| 9. Plan acceptance scenarios | Independently freeze criteria and persist scenarios before code changes; invalid plans receive bounded corrections. |
| 10. Implement task | The writable, sandboxed Implementer makes the approved changes. |
| 11. Run required checks | Run task-required checks through fast/full suites; record deferred checks for final verification. |
| 12. Browser smoke | When required, supervise the approved development server and browser; check readiness and runtime errors. |
| 13. Verify acceptance | Execute planned scenarios and collect evidence for each criterion, including human-only obligations. |
| 14. Independent code review | Review the implementation and evidence; actionable failures trigger repairs while shared allowances remain. |
| 15. Human results review | Inspect the immutable report; approve verified work, accept the report after manual review or acceptance of known limitations, or grant repairs. Exit hides the dashboard and leaves the task awaiting review. |
| 16. Create checkpoint | Record accepted task changes in Git, then advance to the next task. |
| 17. Final verification | Run repository-wide checks, including checks deferred by individual tasks; failures require recovery approval. |
| 18. Complete epic | Mark the epic completed after final verification passes. |

Repair attempts, infrastructure retries, and verification time share task-wide limits. At the results checkpoint, `/epic-resume` reruns verification with the remaining allowance; `/task-repair` explicitly adds one repair attempt and five minutes. Acceptance criteria remain frozen for the task.

The diagram shows the main path and key loops. Operational errors elsewhere also pause with diagnostics or a task report instead of silently advancing. State, events, evidence, and reports persist under `.pi/epics/runs/<epic-id>/`; `/epic-status` shows the pending action, and `/epic-exit` only hides the dashboard.

Source: [epic orchestration](../pi/extensions/epic/machines/epic-machine.ts), [task execution](../pi/extensions/epic/machines/task-execution-machine.ts), and [verification loop](../pi/extensions/epic/verification-runner.ts).
