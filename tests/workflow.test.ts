import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendEvent, loadActiveWorkflow, saveState, transition } from "../.pi/extensions/workflow/persistence.ts";
import { logWorkflow, workflowLogPath } from "../.pi/extensions/workflow/logger.ts";
import { extractReviewInstructions, hashPlan, validatePlanCompleteness } from "../.pi/extensions/workflow/plan-review.ts";
import { normalizeFallowDelta } from "../.pi/extensions/workflow/checks.ts";
import { parsePlannerResponse } from "../.pi/extensions/workflow/agents.ts";
import { assertTransition, canTransition, createWorkflowState } from "../.pi/extensions/workflow/state.ts";
import { assertRepositoryPath, isSafeReadOnlyCommand } from "../.pi/extensions/workflow/tools.ts";

const validPlan = `# Implementation Plan

## Status
Draft — awaiting human approval.
## Objective
Do the thing.
## Scope
### Read
- src/example.ts
### Modify
- src/example.ts
### Create
- None.
### Delete
- None.
## Repository Findings
The existing implementation is the owner.
## Proposed Design
Extend the existing implementation.
## Implementation Steps
1. Update the existing implementation.
## Acceptance Criteria
- [ ] The behavior is covered.
## Verification
- npm test
## Risks and Edge Cases
- None.
## Open Questions
- None.
## Revision Log
### Revision 1
- Initial plan.
`;

test("state machine accepts valid transitions and rejects invalid ones", () => {
  const state = createWorkflowState("/repo", "task", "2026-01-01T00:00:00.000Z");
  assert.equal(canTransition("idle", "classifying"), true);
  assert.equal(canTransition("idle", "implementing"), false);
  assertTransition(state, "classifying");
  state.stage = "completed";
  assert.throws(() => assertTransition(state, "implementing"), /Invalid workflow transition/);
});

test("approved plans can enter implementation and follow every mandatory gate", () => {
  const state = createWorkflowState("/repo", "task", "2026-01-01T00:00:00.000Z");
  const stages = [
    "classifying", "scouting", "planning", "awaiting_plan_review",
    "awaiting_plan_approval", "implementing", "running_fast_checks",
    "running_full_checks", "reviewing", "final_verification", "completed",
  ] as const;
  for (const stage of stages) {
    const previous = state.stage;
    assert.equal(canTransition(previous, stage), true, `${previous} -> ${stage}`);
    state.stage = stage;
  }
  assert.equal(state.stage, "completed");
  assert.equal(canTransition("awaiting_plan_approval", "implementing"), true);
  assert.equal(canTransition("implementing", "completed"), false);
  assert.equal(canTransition("repairing_review", "running_fast_checks"), true);
  assert.equal(canTransition("reviewing", "final_verification"), true);
});

test("R comments preserve line numbers and support Windows line endings", () => {
  const instructions = extractReviewInstructions("one\r\n R: first request \r\nno\r\nR: second request\r\n");
  assert.deepEqual(instructions.map((item) => [item.lineNumber, item.text]), [[2, "first request"], [4, "second request"]]);
});

test("R comments can be appended to plan lines", () => {
  const instructions = extractReviewInstructions(
    "- Support keyboard controls. R: remove pointer controls.\n- Use three lives. R: keep the default lives count.",
  );
  assert.deepEqual(instructions.map((item) => [item.lineNumber, item.text]), [
    [1, "remove pointer controls."],
    [2, "keep the default lives count."],
  ]);
});

test("plan validation and approval hash are deterministic", () => {
  assert.deepEqual(validatePlanCompleteness(validPlan).valid, true);
  assert.equal(hashPlan(validPlan), hashPlan(validPlan));
  assert.notEqual(hashPlan(validPlan), hashPlan(`${validPlan}\nchanged`));
  assert.equal(validatePlanCompleteness(`${validPlan}\nR: resolve this`).valid, false);
  assert.equal(validatePlanCompleteness(validPlan.replace("- src/example.ts", "- ../outside.ts")).valid, false);
});

test("Fallow normalization separates introduced and pre-existing findings", () => {
  const delta = normalizeFallowDelta("ignored text", [{ source: "fallow", severity: "error", file: "src/a.ts", line: 1, message: "old" }]);
  assert.equal(delta.introduced.length, 1);
  assert.equal(delta.preExisting.length, 0);
  const structured = normalizeFallowDelta(JSON.stringify({ introduced: ["new"], preExisting: ["old"], resolved: ["fixed"] }));
  assert.deepEqual(structured.introduced.map((finding) => finding.message), ["new"]);
  assert.deepEqual(structured.preExisting.map((finding) => finding.message), ["old"]);
  assert.deepEqual(structured.resolved.map((finding) => finding.message), ["fixed"]);
});

test("Planner can request bounded focused Scout context", () => {
  const response = parsePlannerResponse(JSON.stringify({
    status: "needs_more_context",
    questions: [{ question: "Where is the game bootstrap?", reason: "The plan must reuse the existing entrypoint." }],
  }));
  assert.equal(typeof response, "object");
  assert.equal((response as { status: string }).status, "needs_more_context");
});

test("persistence writes an active state and append-only event journal", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-"));
  try {
    const state = createWorkflowState(root, "task");
    await saveState(state);
    await appendEvent(state, "workflow_created", { test: true });
    const loaded = await loadActiveWorkflow(root);
    assert.equal(loaded.workflowId, state.workflowId);
    const journal = await readFile(join(root, ".pi", "workflows", "runs", state.workflowId, "events.jsonl"), "utf8");
    assert.equal(journal.trim().split("\n").length, 1);
    const log = await readFile(workflowLogPath(root, state.workflowId), "utf8");
    assert.match(log, /DEBUG Workflow state saved/);
    assert.match(log, /INFO workflow_created/);
    assert.match(log, /"test":true/);
    await logWorkflow(state, "info", "credentials captured", { token: "do-not-write" });
    const redactedLog = await readFile(workflowLogPath(root, state.workflowId), "utf8");
    assert.match(redactedLog, /"token":"\[REDACTED\]"/);
    assert.doesNotMatch(redactedLog, /do-not-write/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("path and read-only command guards block unsafe operations", () => {
  assert.equal(isSafeReadOnlyCommand("git diff --check"), true);
  assert.equal(isSafeReadOnlyCommand("git commit -am bad"), false);
  assert.throws(() => assertRepositoryPath("/repo", "../secret.txt"), /outside repository/);
  assert.throws(() => assertRepositoryPath("/repo", ".env"), /sensitive path/);
});
