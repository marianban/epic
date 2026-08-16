# Epic run stuck after T1

## Findings

Epic run `20260809083210-6ff2fec3` stopped after task T1.

- The implementer created `package.json` and `package-lock.json` successfully.
- `npm install` and `npm ci` failed with `EPERM` while creating `node_modules`.
- The implementer nevertheless exited with code 0 and the task baseline/diff was not persisted.
- The persisted state remained `active/escalating`, with `implementationAttempt: 0` and no `taskBaselineSha`.
- On resume, the runner called its clean-worktree preflight and rejected the legitimate T1 outputs as:
  `?? package-lock.json, ?? package.json`.
- No task checks, task checkpoint, or T2 transition was recorded.

The old run deletions under `.pi/` were not the reported cause; the preflight excludes `.pi` paths. No persisted epic schema/machine incompatibility was found.

## Recommended fixes

1. Make the repository workspace writable for npm, or configure the epic runner to install dependencies in a writable workspace. Resolve the `EPERM` failure first.
2. Persist `taskBaselineSha` before launching the implementer, and persist the task transition/diff even if the agent or a later check fails.
3. On retries, validate existing changes against the recorded task baseline and approved task scope instead of treating them as unrelated dirty worktree changes.
4. If the runner has no baseline after an interruption, report an explicit incomplete-task recovery state. Do not silently delete or discard task outputs.
5. Recover this run explicitly by preserving the two package files and reconciling/checkpointing T1, or restart from the plan checkpoint after fixing permissions. A blind resume is expected to reproduce the same preflight error.

## Relevant evidence

- `/Users/marianban/src/arkanoid/.pi/epics/runs/20260809083210-6ff2fec3/state.json`
- `/Users/marianban/src/arkanoid/.pi/epics/runs/20260809083210-6ff2fec3/events.jsonl`
- `/Users/marianban/src/arkanoid/.pi/epics/runs/20260809083210-6ff2fec3/agent-runs/2026-08-09T08-36-44-362Z-implementer-259f48aa-9bda-47ae-97ca-cbd24fa35efa.stdout.log`
- Epic extension preflight: `/Users/marianban/src/agent-test/pi/extensions/epic/services.ts:447`
- Clean-worktree check: `/Users/marianban/src/agent-test/pi/extensions/epic/git-checkpoints.ts:67`
