# Epic Task Acceptance

The language used to verify approved task requirements and hand the results to a human reviewer.

## Language

**Approved acceptance criterion**:
A requirement whose expected behavior the user has approved. Refining how it is checked does not authorize changing its meaning.
_Avoid_: Agent-adjustable requirement

**Repair item allowance**:
The bounded number of repair attempts for one acceptance criterion, required check, smoke failure, or canonical review finding. Attempts for one item do not reduce another item’s allowance.
_Avoid_: Task-wide repair budget, per-phase repair budget

**Infrastructure retry allowance**:
A separate bounded allowance for retrying verification infrastructure operations. It does not grant additional code repairs.

**Ordinary approval**:
The user's acceptance of a task with no unresolved verification results.
_Avoid_: Automatic approval

**Acceptance with unresolved results**:
The user's explicitly recorded acceptance of a task while acknowledging its failed or unverified checks. The decision preserves the verification results.
_Avoid_: Verified approval, passing override

**Verification obligation**:
An independently checkable part of an approved acceptance criterion. Its evidence contributes to the criterion's overall status without changing the approved requirement.

**Verification cycle**:
A round of required checks, acceptance verification, and semantic review of one candidate task revision.

**Human confirmation**:
The user's recorded evidence that a human-only verification obligation is satisfied for the reviewed revision.

**Task verification time allowance**:
The shared time available for automatic verification and repair after initial implementation. It includes infrastructure retries and downtime across restart, excludes waiting at a human checkpoint, and can increase only through an explicit additional grant.

**Review readiness**:
The overall assessment derived from a task's current verification results: verified, needing manual confirmation, or having issues remaining. It describes the evidence available to the user and does not itself approve the task.

**Human-review checkpoint**:
The point at which the user receives the task's verification report and chooses whether to approve, accept unresolved results, or grant further bounded work. The task waits here until the user chooses to continue.
