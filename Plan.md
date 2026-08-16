# Task Resume With an Existing Worktree

## Objective

Allow an interrupted task to resume or retry with its legitimate files still in the worktree, while retaining strict clean-worktree enforcement when a new task begins.

The fix should be local to task workspace validation. It should not add new XState states, a new persistence protocol, or a compatibility migration.

## Root Cause

`createEpicServices().implement()` in `pi/extensions/epic/services.ts` calls `assertCleanWorktree()` whenever `taskBaselineSha` is absent.

In the reported run, the implementer created `package.json` and `package-lock.json`, but the returned domain state was never persisted. On resume, the runner therefore had no `taskBaselineSha` and incorrectly treated the current task's output as unrelated pre-task dirt.

The clean-worktree rule is valid when opening a new task. It is not valid when resuming or retrying a task that has already run in the same runner-owned worktree.

## Intended Behavior

```text
new task
  -> require clean application worktree
  -> record HEAD as task baseline
  -> run implementer

resume/retry current task
  -> do not require clean worktree
  -> verify HEAD still matches the task/checkpoint baseline
  -> validate all existing changes against current task scope
  -> preserve and continue from those changes

task accepted
  -> run checks and review
  -> checkpoint task
  -> clear task baseline
  -> require clean worktree when the next task begins
```

## Implementation

### 1. Distinguish a new task from a resumed task

Add a focused helper in `pi/extensions/epic/services.ts` or `pi/extensions/epic/git-checkpoints.ts` that resolves the current task baseline.

- If `state.taskBaselineSha` exists, this is an in-progress task. Skip `assertCleanWorktree()`, verify that `HEAD` still equals the recorded baseline, and validate the current delta against the task scope.
- If no baseline exists and the application worktree is clean, this is a new task. Run the existing clean preflight and record the full `HEAD` SHA as the baseline.
- If no baseline exists and the worktree is dirty, treat it as an interrupted-task recovery candidate rather than immediately reporting a generic dirty-worktree error.

The clean preflight applies at the beginning of every new task, not only T1. After a successful T1 checkpoint, T2 receives its own clean boundary and baseline.

### 2. Recover the reported missing-baseline run conservatively

For a dirty worktree with no persisted baseline, accept the files as current-task output only when the repository provides enough evidence:

- the event journal contains an `agent_started` event for the current task and implementer role;
- the latest plan/task checkpoint resolves to the current `HEAD`;
- `HEAD` has not moved since that checkpoint; and
- every application change is allowed by the current task's `scope.create`, `scope.modify`, or `scope.delete` list.

When those checks pass:

- use the current checkpoint/`HEAD` commit as `taskBaselineSha`;
- validate and preserve the existing task delta;
- set `implementationAttempt` to at least `1`;
- persist the implementation diff and `task_diff_updated` event;
- continue to task checks without rejecting `package.json` or `package-lock.json`.

If the journal contains a successful `agent_finished` event for that invocation, do not rerun the implementer. The existing output is the completed implementation and should proceed to checks.

If the implementer started but did not finish successfully, retain the valid scoped files and retry the implementer against that worktree.

If any recovery condition is missing, preserve the files and escalate with an explicit incomplete-task recovery error. Do not delete, reset, stash, or silently accept ambiguous changes.

### 3. Keep scope and Git validation strict

Refactor `validateTaskDelta()` in `pi/extensions/epic/git-checkpoints.ts` only as needed to support validation before a resumed implementer runs.

- Require current `HEAD` to equal the resolved task baseline.
- Continue classifying every path as create, modify, or delete.
- Continue enforcing the task's corresponding scope list.
- Continue excluding engine-owned `.pi` paths.
- Preserve the current invalid-path and symlink-escape protections.
- Reject unrelated files even on resume or retry.

Do not weaken or remove `assertCleanWorktree()`. Change only when it is called.

### 4. Persist the reconciled task result

Reuse the existing implementation-success path in `services.ts` after resolving or recovering the baseline:

- call `validateTaskDelta()`;
- obtain the current diff;
- write the implementation diff artifact;
- set `lastDiffPath`;
- append `task_diff_updated`;
- return the updated domain state to the existing task machine.

The existing `fastChecks -> fullChecks -> reviewing -> checkpointing` workflow remains unchanged. Once the returned state reaches the next human boundary, normal snapshot persistence records the recovered baseline, attempt, and diff path.

### 5. Preserve task transition behavior

Keep the current checkpoint rules:

- checks and review must pass before a task checkpoint is created;
- only validated task paths may be staged;
- `currentTaskIndex` advances exactly once after the checkpoint;
- `taskBaselineSha`, task approval, and task-local state are cleared before T2 begins.

No recovery path may fabricate checks, a checkpoint, or a T2 transition.

## Files

- `pi/extensions/epic/services.ts`
  - choose new-task, resume, retry, or recovery behavior;
  - skip the implementer when a journaled successful invocation already produced the current scoped delta;
  - reuse existing diff persistence and check transitions.
- `pi/extensions/epic/git-checkpoints.ts`
  - expose the clean/dirty application status or structured delta needed by baseline resolution;
  - retain strict `HEAD`, scope, path, and symlink validation.
- `pi/extensions/epic/persistence.ts`
  - use `loadEpicEvents()` for current-task implementer evidence; no persisted-envelope format change.
- `tests/git-checkpoints.test.ts`
  - cover clean new tasks and scoped/invalid dirty resumes.
- `tests/epic.test.ts` or a focused service test file
  - cover successful interrupted-run reconciliation through checks and checkpointing.

## Tests

1. A new task with a dirty application worktree still fails the clean preflight.
2. A resumed task with a persisted baseline accepts allowed `package.json` and `package-lock.json` creates.
3. A resumed task rejects a moved `HEAD`.
4. A resumed task rejects any out-of-scope tracked or untracked file.
5. A missing-baseline recovery succeeds when the implementer journal entry, checkpoint, `HEAD`, and scope agree.
6. A successful prior implementer is not invoked twice; its existing delta proceeds to fast and full checks.
7. An interrupted or failed prior implementer retries without cleaning its valid scoped output.
8. Ambiguous recovery escalates explicitly and leaves all files untouched.
9. Successful recovery persists the diff, completes task checks and review, creates the T1 checkpoint, and transitions to T2 exactly once.
10. T2 again requires a clean worktree before establishing its own baseline.

## Compatibility

This change should not alter the XState machine topology or persisted envelope shape. Keep schema/machine version `5/8` and do not add a compatibility migration.

The reported state did not reveal a schema or machine incompatibility. The missing baseline is an interrupted-operation recovery problem within the current version.

## Verification

```sh
npm test
npm run typecheck
npm run lint
```

## Acceptance Criteria

- Clean-worktree enforcement occurs when each new task begins, but not when the same task resumes or retries.
- Existing task files are accepted only when `HEAD`, checkpoint/journal evidence, and task scope agree.
- The reported `package.json` and `package-lock.json` files survive resume and reach task checks without a second successful implementer run.
- Unrelated or ambiguous changes still fail explicitly and are never deleted.
- T1 is checkpointed and T2 starts exactly once after the normal checks and review succeed.
- No persisted-state version change or implicit compatibility migration is introduced.
