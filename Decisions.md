# Decisions

This file tracks implementation choices that should be reviewed if the Pipeline contract changes.

## 2026-08-05

- Pi assistant identity is read from the assistant message's `provider` and `model` fields. A collector rejects a later conflicting identity instead of merging usage into an arbitrary model.
- Pipeline token usage treats a usage record as reliable when it contains an explicit total or at least one recognized input/output/cache counter; absent counters contribute zero, while an absent usage record makes the aggregate unavailable. Reasoning remains separate from total because Pi reports it as an output subset.
- The standalone Pipeline component wraps Agents/Models when it owns focus. The dashboard widget handles the outer cycle explicitly so a focused sequence can be Current Task → Agents → Models → Current Task without making the component aware of its parent.
- Historical lifecycle events without invocation IDs are paired by role/action in timestamp order, with journal order breaking equal timestamps. Their model identity falls back to the profile available to the projection because older events contain no snapshot.
