# XState Migration Plan

## Summary

The workflow already behaves like an explicit state machine. It has validated transitions, persisted state, append-only events, human approval gates, bounded repair loops, task iteration, and terminal states.

Migrating to XState is viable and could improve the representation of hierarchical workflow phases. It is not an urgent requirement, because the current implementation already provides the core safety guarantees. The main benefit would be clearer modeling and maintenance as branching, task-scoped workflows, and resumable activities become more complex.

Recommendation: first extract and document a hierarchical domain model, then migrate incrementally if the resulting orchestration remains difficult to maintain. Do not perform a wholesale rewrite as the first step.

The current recommendation after reviewing the Stately Agent examples is to use raw XState for the workflow engine. `@statelyai/agent` should remain an optional dependency for a future role that needs autonomous, multi-step model reasoning.

## Findings from Stately Agent examples

The examples are useful because they demonstrate that the Agent package is built on the same XState actor model, but adds typed model requests, model-selected events, executor binding, human-input handling, and agent-specific persistence conventions.

### `subflows`

The subflow example is the closest match to the proposed architecture. A parent machine registers a child machine under `actorSources`, invokes it with typed input, and receives typed output through `onDone`:

```ts
actorSources: { child: childMachine }

delegating: {
  invoke: {
    src: "child",
    input: ({ context }) => ({ topic: context.topic }),
    onDone: ({ output }) => ({
      target: "done",
      context: { research: output.research },
    }),
  },
}
```

This maps well to a workflow machine invoking a task-execution submachine or a planning submachine. It also shows that nested machines can inherit the parent host's model executors. The useful architectural idea is child-machine composition, not necessarily the Agent package itself; raw XState actors can provide the same workflow composition without making model calls part of the machine contract.

### Human-in-the-loop example

The human-in-the-loop example models a review state with no active invocation and explicit `APPROVE`/`REJECT` events. The run settles as `idle`, the host persists the snapshot, and a later process resumes it with the human event.

This is directly relevant to:

- plan approval;
- prerequisite approval;
- pre-implementation task approval;
- post-implementation task review;
- escalation resolution.

The example also supports an explicit suspension predicate or tag, such as `awaiting-review`, instead of relying only on idle detection. This suggests that the migration should model human pauses as explicit tagged states and persist a durable pending-action record alongside the machine snapshot.

The example warns that the snapshot must be JSON-serializable, that actions already executed are not replayed on restore, and that invoked actors may be restarted. These behaviors must be reconciled with the existing event journal and exactly-once expectations for agent and command side effects.

### Step-path and durable-host examples

The `ai-sdk-game-host` and related step-path examples advance the machine one model call at a time and return a plain checkpoint after each step. The step helpers are synchronous and deterministic; the host performs the model call, persists the checkpoint, and then advances the machine.

This is potentially useful for long-running Scout, Planner, or Reviewer interactions. It is less important for the current implementation, where each Pi role is already an isolated process with a bounded call and the workflow persists artifacts after meaningful stages. If finer-grained recovery is required later, the step-path approach is a candidate for role-level checkpointing.

### `long-running-onboarding` and snapshot-store examples

The long-running onboarding and file-snapshot-store examples are relevant to the workflow's process boundaries. They demonstrate that a machine can pause for days, persist a JSON snapshot in a file or database-like store, and resume in a different process.

They reinforce two points for this project:

- XState or Agent snapshots can complement the existing `state.json` persistence, but do not replace artifact storage, audit logs, or repository-specific recovery metadata.
- A userland snapshot store is still required; the library does not become the system of record for workflow artifacts.

### `retrofit` migration example

The `retrofit` example is especially relevant to this migration. It refactors a tangled hand-rolled loop incrementally and uses simulation tests to pin before-and-after behavior. The same technique should be used here: introduce a machine or submachine behind an adapter, compare its decisions with the current implementation, and migrate one bounded flow at a time.

### `plan-and-execute`, `react-agent`, and `tool-calling`

These examples model agentic loops where the model selects legal events or tools and the machine enforces budgets and transitions. They are useful references for a future autonomous Planner or Scout, but they do not match the current role contract exactly:

- the current Planner returns a plan artifact or a bounded `needs_more_context` request;
- the current Scout performs bounded read-only discovery;
- the Implementer and Reviewer are invoked by deterministic workflow code;
- models do not decide whether mandatory checks or approvals can be skipped.

Adopting these patterns for the main workflow would risk moving orchestration authority back into model-selected decisions.

### Multi-agent composition and fan-out

The multi-agent examples show three composition styles:

1. A child agent machine invoked as a typed child actor.
2. A host-owned tool that delegates to another agent implementation.
3. Sibling child actors coordinating through events.

The current workflow should prefer the first style only where a role genuinely deserves its own stateful subflow. Parallel fan-out is not an immediate fit because tasks modify the same repository and checks have ordering and audit requirements. Parallel Scout work could be considered later, but would need explicit result aggregation, cancellation, resource limits, and deterministic event ordering.

## Current state

The current implementation uses:

- A flat `WorkflowStage` union and `ALLOWED_TRANSITIONS` table.
- Imperative orchestration in `workflow.ts`.
- Persisted workflow context in `state.json`.
- Append-only audit events in `events.jsonl`.
- Human-gated plan, prerequisite, and task approvals.
- A `currentTaskIndex` for sequential task execution.
- Separate counters and limits for fast checks, full checks, and semantic repairs.
- Explicit failure, cancellation, escalation, and resume behavior.

The state hierarchy is currently implicit. Planning, task execution, checking, review, and repair phases are represented as sibling stages, while nested behavior is implemented through functions and loops.

## Proposed XState model

The main machine should own the complete workflow lifecycle. Nested machines should own cohesive subflows rather than every individual operation.

```text
workflow
├── classifying
├── planning
│   ├── scouting
│   ├── planning
│   ├── awaitingReview
│   ├── revising
│   └── awaitingApproval
├── decomposingTasks
├── prerequisites
│   ├── checking
│   ├── awaitingApproval
│   └── preparing
├── taskExecution
│   ├── awaitingTaskApproval
│   ├── implementing
│   ├── fastChecks
│   ├── fullChecks
│   ├── semanticReview
│   ├── awaitingTaskReview
│   └── taskRepair
├── escalation
├── finalVerification
└── terminal
    ├── completed
    ├── failed
    └── cancelled
```

The task execution machine is the strongest candidate for extraction because the same lifecycle repeats for each task:

```text
task approval
  → implementation
  → fast checks
  → full checks
  → semantic review
  → human task review
  → next task or final verification
```

Repair transitions should remain guarded by persisted attempt counters and configured maximums. Semantic repair must continue to route through fast and full checks before another semantic review.

The Stately `subflows` pattern suggests a concrete composition boundary:

```text
main workflow machine
├── planning submachine
├── prerequisite submachine
└── task execution submachine
    └── invoked role service: Pi Scout/Planner/Implementer/Reviewer process
```

The child submachines should expose typed inputs and outputs, while the host remains responsible for Pi process execution, filesystem artifacts, notifications, command approval, and event journaling.

## Migration principles

1. Preserve the existing workflow behavior and approval boundaries.
2. Keep agent execution, filesystem persistence, command execution, and notifications outside the machine definition.
3. Treat machine events as intent, and keep side effects in explicit actions or invoked services.
4. Keep persisted workflow state separate from transient XState runtime state where practical.
5. Make every transition auditable with the existing event journal.
6. Do not silently reinterpret old persisted workflow runs under the new schema.
7. Prefer incremental replacement with behavior-equivalence tests over a full rewrite.

## Proposed migration phases

### Phase 1: Baseline and invariants

- Record the current transition graph and command-to-stage rules.
- Identify all persisted fields and artifact dependencies.
- Add or expand tests for:
  - valid and invalid transitions;
  - approval guards;
  - task iteration;
  - repair-limit escalation;
  - resume behavior;
  - cancellation and failure handling;
  - final verification;
  - incompatible persisted state.
- Treat the current behavior as the compatibility baseline.

### Phase 2: Define a hierarchical domain model

- Define workflow events such as `START`, `SCOUT_COMPLETE`, `PLAN_APPROVE`, `TASK_APPROVE`, `CHECKS_FAILED`, `REVIEW_FAILED`, `HUMAN_REVIEW`, `RESUME`, and `CANCEL`.
- Group existing flat stages into planning, prerequisite, task execution, escalation, and final verification domains.
- Define guards for plan hashes, task manifests, approval state, pending human actions, and repair limits.
- Define the persisted context contract independently from the XState machine configuration.

### Phase 3: Introduce XState behind an adapter

- Add an adapter that maps the existing persisted `WorkflowState` to machine context.
- Map current commands to machine events.
- Keep existing persistence and event journaling as the source of durable audit history.
- Run the machine in shadow mode or through targeted tests before allowing it to control production transitions.
- Compare machine decisions with the existing transition validator.

### Phase 4: Extract the task execution submachine

- Migrate the repeated task lifecycle first.
- Move fast-check, full-check, semantic-review, and repair-loop decisions into nested states and guards.
- Keep implementer and reviewer processes as invoked asynchronous services.
- Preserve `currentTaskIndex`, repair counters, artifacts, and human review pauses.
- Verify that semantic repair still reruns all required deterministic gates.

### Phase 5: Extract planning and approval subflows

- Model Scout and Planner interaction, including bounded focused Scout follow-up rounds.
- Model plan review, `R:` comment handling, plan revision, and approval hash validation.
- Preserve the mandatory pause after writing `plan.md`.
- Keep plan artifacts and revision history unchanged unless a separate artifact migration is approved.

### Phase 6: Switch orchestration ownership

- Route command handlers through the machine adapter.
- Remove duplicated transition logic only after equivalent tests pass.
- Continue writing the existing state and event artifacts during the transition period.
- Add a machine/schema version to newly persisted runs.
- Document how interrupted runs are resumed and how unsupported versions are reported.

### Phase 7: Cleanup and operational validation

- Remove obsolete flat transition code after migration confidence is established.
- Review logs and status output for useful hierarchical state names.
- Measure whether the new model reduces branching complexity and regression risk.
- Reassess whether all planned submachines are still justified; avoid modeling trivial operations unnecessarily.

## Persistence and compatibility

XState does not remove the need for durable persistence. The workflow must continue to persist:

- current workflow state;
- current task and task manifest;
- plan approval hash and revision;
- repair counters and limits;
- pending human action;
- prerequisite information;
- check and review artifact paths;
- failure and escalation reasons;
- append-only audit events.

Persisted state should include an explicit schema or machine version. On load:

- supported versions may be restored;
- unsupported or structurally incompatible versions must fail clearly;
- no automatic compatibility migration should be added unless explicitly designed, tested, and requested;
- the user should be told which workflow version or persisted state is incompatible and how to recover.

The existing task-manifest incompatibility guard is a useful precedent. The migration should preserve that behavior rather than silently inventing missing task data.

## Benefits

- Explicit hierarchical state representation.
- Clearer guards and event-driven transitions.
- Better visualization and state-graph testing.
- More reusable task, review, and approval subflows.
- Less manual branching for repeated task execution and repairs.
- Easier future support for workflow variants or controlled concurrency.

## Costs and risks

- Significant migration effort across orchestration, persistence, commands, and tests.
- Additional dependency and conceptual overhead.
- More abstraction around asynchronous agents and shell commands.
- Potentially harder debugging due to indirection between events, actors, actions, and persistence.
- State serialization and machine-version migration become explicit responsibilities.
- Incorrect modeling could weaken approval or security boundaries if guards are omitted.
- Parallel execution would introduce repository-conflict and audit-order concerns.
- `@statelyai/agent` adds AI-specific schemas, executor binding, provider/runtime assumptions, and an alpha API surface that are not required by the current fixed-role architecture.

## Maintenance assessment

XState is likely to reduce maintenance cost for complex branching and nested task flows. It may increase maintenance cost for simple sequential behavior and for contributors unfamiliar with state-machine libraries.

The migration is worthwhile if the workflow continues to gain:

- multiple workflow variants;
- more nested approval or review stages;
- richer recovery and resume paths;
- concurrent activities;
- reusable subflows;
- a need for visual state inspection.

If the workflow remains sequential and mostly human-gated, refactoring the current code into smaller domain-specific state modules may provide most of the benefit without adopting XState.

## Success criteria

The migration should not be considered successful merely because the machine runs. It should demonstrate:

- no implementation before explicit plan and task approval;
- no prerequisite command without approval;
- all mandatory checks and reviews remain enforced;
- repair limits still escalate deterministically;
- cancellation never reverts repository changes automatically;
- persisted runs resume or fail with clear compatibility diagnostics;
- event journals retain a complete and understandable audit trail;
- behavior-equivalence tests pass for all existing workflow paths;
- status output remains useful to users.

## Final recommendation

Do not migrate the entire workflow immediately. Begin with raw XState, a hierarchical model, and a task-execution submachine behind an adapter. Use the Stately Agent `subflows` pattern as a design reference for typed child-machine boundaries and the `retrofit` example as a migration/testing reference.

Do not add `@statelyai/agent` to the main workflow initially. Reconsider it only if a specific role becomes an autonomous multi-step agent that needs model-selected legal events, built-in request schemas, executor inheritance, or Agent-specific human-input handling. Even then, keep it inside an invoked role actor; the outer workflow machine must continue to own approvals, deterministic verification, repair limits, security boundaries, and terminal transitions.
