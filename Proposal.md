# Proposal: acceptance verification before human review

Date: 2026-10-04. Status: hardened proposal; interview decisions accepted, awaiting final confirmation of shared understanding. No workflow or application changes implemented.

## Recommendation

Keep browser smoke mandatory for tasks that introduce or change browser-observable behavior. Add a separate acceptance-verification phase that exercises observable behavior before human review. Give the agent a configurable number of repair attempts, then always present the latest results, remaining issues, and every acceptance criterion to the user.

The first release must include behavioral acceptance verification, bounded repair, and a complete human-review report. Reporting-only work is an implementation milestone, not completion of this feature.

Start with a hybrid approach: short, repeatable scenarios for objective requirements, plus bounded browser exploration where scripted verification is impractical. Preserve human review for subjective judgments and explicitly unverified requirements. Do not require every criterion to be automated, and do not treat a screenshot or a successful build as proof of interactive behavior.

## What the Arkanoid run exposed

For run `20261004085319-298e00f2`, task 3:

- The implementer ran `npm run build` and `git diff --check`. The runtime repeated checks and ran browser smoke.
- Smoke observed a visible `#game canvas`, checked startup errors, and captured a screenshot. Its recorded duration was 1.313 seconds. It did not exercise controls or assert collisions and scoring.
- The semantic reviewer inspected code but reported all five criteria as `manual_review_pending`, with no findings and `passed: true`.
- The reviewer was explicitly instructed not to perform the manual review steps. Its pass meant no actionable defect was identified, not that acceptance was verified.
- The saved task actor stopped at `awaitingReview`, awaiting human review. It did not automatically approve task 3.
- A missed defect exists in `hitBrick`: the bricks are ordinary Phaser rectangles, but the handler calls `brick.disableBody(...)`, a method those objects do not have in installed Phaser 3.90.0. The call occurs before removal and score update. This conclusion comes from application and installed dependency source inspection, not a new browser reproduction.

More repair loops alone would not have helped: the existing checks never exposed the failure, so there was no failure evidence to trigger repair.

Relevant implementation sources:

- [Browser smoke](pi/extensions/epic/browser-smoke.ts)
- [Reviewer instructions](pi/agents/reviewer.md) and [review prompt](pi/extensions/epic/prompts.ts)
- [Task orchestration](pi/extensions/epic/machines/task-execution-machine.ts)
- [Configuration](pi/extensions/epic/configuration.ts)
- [Result validation](pi/extensions/epic/review-validation.ts)

## Alternatives

| Approach | Description | Advantages | Limits / cost |
| --- | --- | --- | --- |
| A. Improve review and extend smoke | Ask the reviewer to inspect dependency APIs more carefully; use a longer passive browser observation window. | Smallest change; longer observation could catch this first-collision exception. | Still does not test controls or prove scoring. Fixed waits are slow and unreliable. More review passes can repeat the same blind spot. |
| B. Agent browser verification | Give a verifier browser interaction tools and have it execute task acceptance scenarios, recording observations and errors. | Flexible; useful for new projects without a test harness; lower setup cost. | Agent observations can be inconsistent, expensive, or hard to replay. Canvas behavior needs more than DOM selectors. |
| C. Scripted acceptance scenarios | Define criterion-linked, repeatable browser or local tests and execute them through the runtime. | Strong evidence, reproducibility, regression protection, objective retry decisions. | Requires scenario authoring and sometimes small test hooks; can become excessive for subjective or low-impact requirements. |
| D. Hybrid, recommended | Script critical objective behavior; use bounded browser exploration for the rest; report genuine manual-only checks. | Balances confidence, implementation effort, and honest reporting. | Needs a clear evidence contract and limits on both exploration and repair. |

Keep smoke simple and stable; task-specific acceptance assertions belong in a separate phase. The selected design uses one task-wide verification/repair time allowance rather than adding longer smoke waits or separate phase timeout settings.

## Separate three kinds of verification

**Browser smoke:** mandatory startup health check. It checks configured page/canvas readiness, console errors, uncaught exceptions, same-origin failed requests and HTTP errors, and page crashes. It runs on each browser task and after repairs affecting that task. Demonstrated application failures are recorded and eligible for bounded repair; infrastructure failures use the infrastructure retry policy; it must never be silently skipped or relabeled as passed.

**Acceptance verification:** exercise relevant interactions and assert outcomes. Derive scenarios from the approved criteria, not from the implementation's own description of what it does. Keep console/error monitoring active throughout the scenarios.

**Semantic review:** inspect the final diff, dependency contracts, verification evidence, and changes to the tests themselves. Continue looking for code defects even if some observations remain unverified. Manual-only absence is not itself an application defect, but objectively testable behavior should not be delegated to the human merely because the task originally listed it as a manual step.

The runtime must own dev-server and browser lifetimes. Today the server is scoped to the smoke phase and smoke closes its own browser; acceptance verification cannot inherit a live session from that phase. The implementation must establish an explicit runtime-owned execution scope rather than assuming existing lifecycle reuse. A verifier should not independently start a competing server. Use one runtime-owned server/browser scope per verification cycle, with isolated browser contexts for scenarios. Close that scope before repair and open a fresh one for reverification. Non-browser verification does not require a browser/server scope; its criteria still receive an explicit verification plan and report entry.

## Acceptance criteria and evidence

Freeze approved criteria and give each a stable ID. Agents may refine verification scenarios while preserving criterion meaning; changing expected behavior requires user approval. An approved change versions the criteria, regenerates affected scenarios, and invalidates current evidence while preserving task allowance usage. Additional repair or time allowances require explicit grants. Report unresolved ambiguity as inconclusive. Give each criterion an explicit verification plan: scenario/command, expected result, and verification method (`automated`, `agent_browser`, `static`, or `human_only`). A separate verifier derives scenarios from approved criteria before implementation. Repairing implementers may change fixtures and test mechanics; changes to assertions require independent review against the frozen criteria. Scenario changes are versioned so the report exposes what changed.

Preserve combined criteria and identify their independently checkable obligations with separate evidence entries. Build success does not establish the gameplay obligation of a combined build/gameplay criterion. Aggregate current obligation results into one criterion status: all pass means `met`; any demonstrated failure means `not_met`; some pass and others remain unverified means `partially_met`; none established means `manual_review_pending`.

Retain the current visible statuses (`met`, `partially_met`, `not_met`, `manual_review_pending`), but record why evidence is missing separately:

- `human_only`: subjective judgment or access requiring the user.
- `blocked`: browser/tool/server unavailable, with the exact blocker.
- `not_attempted`: verification was not executed, with the reason.
- `inconclusive`: scenario ran but did not establish the expected outcome.

Do not report a blocked check as a demonstrated product failure. Do not report an unexecuted check as a pass. `manual_review_pending` alone must not trigger repeated application edits.

Each result should include criterion ID, expected and actual behavior, evidence artifact, execution method, attempt number, and a unique verification attempt identity. Verification is advisory: candidate file changes do not invalidate evidence, block human decisions, or stop repairs. Results are bound to their verification attempt, scenario plan, and criterion version; human decisions are bound to the current report. Rerunning verification requires a fresh acceptance decision even when candidate files are unchanged. Failures should include reproduction steps and the relevant exception/assertion. Screenshots support visual evidence; they do not establish a sequence of interactions by themselves.

Validate that every criterion is represented exactly once in the final summary, evidence references exist and belong to the identified revision, and statuses agree with the observations. Reject unsupported success claims from invalid verifier output. Preserve independently valid results and explicitly classify missing, invalid, or stale evidence as unverified. Produce a fallback report with every approved criterion, trustworthy results, and exact evidence problems; missing evidence alone is not a demonstrated application defect and must not trigger speculative application edits. Block ordinary approval while evidence gaps remain; explicitly acknowledged acceptance with unresolved results remains available. Malformed or incomplete verifier output is eligible for the single shared infrastructure retry when the allowance and time remain. Give the verifier the validation errors without editing the application; if retry fails or is unavailable, use the fallback report. Persist retry consumption before invocation so resume cannot recreate the allowance. Keep semantic findings, infrastructure blockers, and acceptance results distinct; the current review contract requires an actionable repair whenever `passed` is false and cannot represent every verification blocker cleanly.

## Example: task 3 verification

| Criterion | Suggested observation |
| --- | --- |
| Generated board entities and score | Capture the visible game and confirm expected entity counts/visibility, using scene inspection if needed for canvas contents. |
| Arrow keys, A/D, pointer, and bounds | Drive each input separately, observe paddle position changes, and test both boundaries; include a scaled viewport for pointer coordinates. |
| Wall and paddle bounces | Place the ball near each collision target, advance actual physics, and assert reflected velocity and containment. |
| Brick removal and scoring | Cause a real ball-brick collision; assert one fewer active/visible brick, score increased by one, and no uncaught exception. |
| No duplicate collision effects and build | Continue for several physics steps/repeated relevant interactions, assert stable score for the removed brick, and record build success separately. |

Use bounded polling for outcomes rather than an arbitrary long sleep. For canvas games, a narrow test-only scene inspection/control hook may be justified. It should observe state or establish a fixture; it must not replace physics with a direct call to `hitBrick`, because that would leave the collider wiring untested. The verifier should inspect method availability against the installed dependency as an additional static check.

These scenarios cover task 3. Lives, win, game-over, and restart belong to the next task and should not be incorrectly reported as task 3 failures.

## Bounded repair behavior

Proposed sequence:

1. Derive verification scenarios from the frozen approved criteria, then implement the approved task.
2. Start the task-wide deadline and run required local checks and mandatory browser smoke for browser tasks.
3. Run acceptance verification where the application is executable, then semantic review while time remains. If startup or tooling blocks behavioral scenarios, retain static review where possible and record the blocked scenarios.
4. If actionable failures exist and the budget remains, send the implementer structured reproduction evidence and attempt a focused repair.
5. Rerun all required checks, smoke, acceptance scenarios, and relevant regressions against the new revision. Review the final diff again.
6. When the results are sufficient, or the repair budget is exhausted, prepare the human-review report. If startup/build failure prevents scenarios, report those criteria as blocked and still produce the report.

A failed check must not short-circuit creation of the human-facing report. Conversely, generating the report must not mark the task completed or its failed checks successful.

Define `maxTaskRepairs` as one task-wide allowance for all automatic code repair invocations after initial implementation, regardless of whether fast checks, full checks, smoke, acceptance verification, or semantic review exposed the failure. One invocation addressing several failure categories consumes one attempt. The configurable default is 6 repair invocations; 0 means verify and report without automatic repair. Validate it as a non-negative integer and resolve it at composition time; inject limits, clocks, and timeouts explicitly.

Use this single allowance from the first release, replacing phase-specific repair allowances rather than adding `maxAcceptanceRepairs`. A build failure may consume the allowance before behavioral verification; disclose the resulting blockers in the report. Infrastructure retries have a separate bounded allowance and never silently increase the code repair allowance.

Current counters are initialized anew when a task actor is replaced, and human review/resume paths can invoke implementation without charging those counters. Persist allowance usage across resume, actor replacement, and revalidation of the same task. Changing failure category must not reset usage. A human-requested extra repair cycle must explicitly grant an additional bounded allowance; ordinary resume grants none. Persist consumption before launching each repair; interrupted invocations count. Keep the allowance ledger at task scope rather than within a replaceable execution actor. Additional grants specify a numeric allowance and preserve all previous usage.

A verification-tool failure uses the separate task-wide infrastructure retry allowance when eligible. It should not provoke speculative application changes. Use one configurable task-wide time allowance, defaulting to 30 minutes, starting with the first verification after initial implementation. It covers required checks, browser work, semantic review, infrastructure retries, and repairs. Each operation receives the remaining time rather than a separate scenario or cycle timeout setting. Persist the deadline across restart; downtime counts, while time at an explicit human checkpoint is excluded. Additional repair grants specify additional time. A stalled operation may consume the remaining allowance; record later checks as unattempted rather than claiming coverage.

Default to one configurable task-wide infrastructure retry, shared across verification cycles and preserved across resume. It consumes the same time allowance but no code repair attempt. Repair only failures supported by reproduction evidence or a concrete code defect; retry demonstrated infrastructure failures. Ambiguous failures remain inconclusive and reach the human report without speculative application edits. Stop early when there is no actionable repair, and explain why; do not spend every available attempt just to retry identical inconclusive observations.

## Human review after exhaustion

Use a report-producing human-review checkpoint for success, exhaustion, unavailable infrastructure, invalid verification output, timeout, and interruption. Derive readiness mechanically from current validated results:

| Outcome | Rule |
| --- | --- |
| `issues_remaining` | Any demonstrated acceptance/product failure or unresolved actionable semantic finding. |
| `needs_manual_confirmation` | No demonstrated product failure, but evidence, required checks, or human confirmations remain missing, blocked, or inconclusive. |
| `verified` | Every criterion met, mandatory checks passed, and no unresolved actionable findings. |

Evaluate `issues_remaining` first; it takes precedence when failures and missing evidence coexist. A failed mandatory check always prevents `verified`. Infrastructure unavailability and invalid verifier output do not alone establish a product failure. The readiness label is derived, not independently asserted by an agent, and never completes a task automatically.

The report should always show:

- Latest build, diff, smoke, and acceptance results, including failures and skips.
- Every criterion, its status, and concise evidence or blocker.
- Remaining issues, severity, reproduction steps, and affected files.
- Repairs attempted, what changed, repair and infrastructure retry usage, time consumed/remaining, and any additional grants.
- Links to the final diff, logs, screenshots/traces, and previous attempts.
- Remaining human-only review steps.

Possible actions: request another bounded repair cycle, revise the task, defer the work, or explicitly accept with unresolved results. Acceptance with unresolved results is a distinct recorded user decision requiring acknowledgment of the failed or unverified checks. Preserve those results; do not rewrite them as passes. Ordinary approval is unavailable while results remain unresolved. Require acknowledgment of the specific failed or unverified results and a reason. Bind the decision to the reviewed revision and report; any subsequent change requires a fresh decision. Human-only criteria can receive recorded human confirmation as evidence. Ordinary approval requires current passing mandatory checks, every criterion met, and no unresolved actionable findings.

Mandatory smoke is scheduled for every browser task and every changed revision. If timeout, cancellation, or an infrastructure blocker prevents execution, report that explicitly; it remains an unmet verification requirement, never a pass. A task with failed or unavailable smoke can still be presented to the user, but cannot follow the ordinary verified-approval path. This preserves mandatory verification without hiding the result behind a dead-end failure state.

## Architecture and implementation scope

Keep task orchestration thin. Extract scenario execution, evidence validation, repair-budget policy, and report construction into focused modules. Reuse the current server/browser ownership rather than duplicating lifecycle management.

Model the execution flow as: approved criteria/scenarios → initial implementation → verification cycle → validated results → either a bounded repair or the human-review report. Each repair returns to all required checks on a fresh candidate. Infrastructure retries stay on the verification path and consume no code repair attempt. A parent verification scope owns the deadline; runtime-owned browser/server resources live within its browser execution scope. Timeout, cancellation, service exceptions, and exhausted allowances all converge on local report finalization. Keep the task allowance ledger outside the replaceable execution actor. Ordinary approval and acceptance with unresolved results are distinct user events at the checkpoint, with report-bound guards.

This requires changing current failure routing: exhausted repair budgets enter escalation and service exceptions can terminate as failed; neither path currently guarantees the proposed report-producing checkpoint. Full-check repairs must also rerun fast checks, which the current flow skips. Persist evidence and a task-scoped allowance ledger that survives replacement execution actors; derive dashboard presentation from the actor state. Cancellation must stop active operations, dispose browser/server resources, preserve completed artifacts and consumed allowances, and present an interrupted report. Reopening does not automatically continue repairs. Explicit resume starts fresh verification within the remaining allowance and does not automatically repeat the interrupted repair. Timeout stops automatic verification and repair, terminates owned resources, and then constructs the report locally from saved results. Cleanup and local report finalization may finish after the deadline, but must launch no further agent work or verification. Finalization errors must be surfaced explicitly alongside the retained results. Any code change invalidates all earlier verification evidence in the first release; the final report must clearly distinguish current results from historical ones.

The saved run and current extension both use schema version 6 and machine version 11. No compatibility mismatch was identified. The new persisted ledger, criterion/evidence shapes, and state topology change the contract; bump schema and machine versions for incompatible changes. Runs saved under schema 6 / machine 11 may then be incompatible and must be diagnosed explicitly before any recovery proposal. Diagnose incompatible old runs explicitly; do not implicitly migrate them. Any migration requires a separate explicit request under repository rules.

## Suggested rollout and validation

1. Add evidence classification and a complete report at the existing human checkpoint. Clarify that semantic pass does not mean acceptance verified.
2. Add bounded browser acceptance verification and the single `maxTaskRepairs` allowance. Pilot it on objective scenarios such as the Arkanoid brick collision. Steps 1 and 2 are both required for the first release.
3. Promote useful scenarios to repeatable tests based on operational experience.

The first release is complete only after the behavioral pilot and workflow validation below pass. Reporting-only delivery is insufficient.

| Validation case | Required observation |
| --- | --- |
| Successful first verification | All criteria represented with current evidence; report is `verified`; task still awaits human approval. |
| Repair and reverification | Consumption persisted before repair; all required checks rerun against the changed candidate. |
| Three-repair exhaustion | No fourth repair; complete report retains failures, prior attempts, and usage. |
| Zero repair allowance | Verification and reporting execute; no repair invocation. |
| Single timeout | Every operation uses remaining task time; deadline stops work; local finalization produces the report without further agent calls. |
| Infrastructure failure | At most one shared retry by default; no speculative application changes. |
| Invalid evidence | Missing criterion, missing artifact, stale identity, and contradictory success claims fail validation; valid independent results survive; fallback report remains complete. |
| Human-only confirmation | User confirmation becomes attempt-bound evidence; ordinary approval opens only when all requirements are met. |
| Acceptance with unresolved results | Specific checks and reason recorded against revision/report; failed checks remain failed. |
| Category changes and actor replacement | Task usage survives both; ordinary resume grants no new repairs or retries. |
| Cancellation and restart | Resources disposed; artifacts and charged attempts retained; no automatic repair on reopening; active downtime counts against the persisted deadline. |
| Changed code or criteria | Current evidence invalidated; approval rejects stale report identity; prior allowance usage remains. |
| Incompatible persisted run | Explicit version diagnosis; no implicit migration. |
 For the Arkanoid pilot, deliberately retain the invalid rectangle method and confirm verification detects the exception before human review, then confirm the repaired collision removes one brick and scores exactly once.

This proposal does not require a new framework-specific test suite for every task. The goal is a small amount of relevant behavioral evidence, bounded autonomous repair, and an honest final handoff.

## Decision record

The user accepted the hardening interview decisions Q1–Q22, including Q18 after clarification. The design frontier is settled:

- First release includes behavioral verification, bounded repair, and a complete human-review report.
- Approved criteria remain frozen; separately authored scenarios and independently reviewed assertions establish evidence without redefining requirements.
- Combined criteria retain their identity and aggregate obligation evidence using the status rules above.
- Candidate changes do not invalidate advisory verification evidence; current results and user decisions are bound to the verification attempt and report.
- Configurable defaults are 6 task repairs, 1 task-wide infrastructure retry, and one 30-minute verification/repair time allowance. No separate scenario or cycle timeout settings are added.
- Repair/retry usage survives actor replacement and resume; interrupted repairs count. Additional allowances require explicit recorded grants.
- Runtime owns one browser/server scope per verification cycle and isolated contexts per scenario; repairs receive fresh execution resources.
- Invalid output cannot establish success, but independently valid evidence survives. The shared infrastructure retry may correct verifier output; otherwise the report exposes the gaps.
- Derived readiness controls ordinary approval. Explicit acceptance with unresolved results preserves failures and records the acknowledged checks and reason.
- Cancellation, timeout, exhausted allowances, and exceptions retain results and lead to local reporting. Finalization can finish after the deadline without new agent work.
- The release gate includes the Arkanoid defect/repair pilot and the workflow cases above. Incompatible persisted changes require explicit version diagnosis without migration.

Supporting terminology is in [GLOSSARY.md](GLOSSARY.md). Architectural trade-offs are recorded in [the task-wide allowance ADR](docs/adr/0001-task-wide-repair-allowance.md) and [the unresolved-results acceptance ADR](docs/adr/0002-acceptance-with-unresolved-results.md).

No policy questions from the interview remain open. Final confirmation of shared understanding is pending; implementation is a separate task.
