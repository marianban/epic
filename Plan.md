# Implement a Deterministic Multi-Agent Workflow Extension for Pi

## Objective

Create a Pi extension that implements a deterministic, human-gated software-development workflow. The first working phase includes only these roles:

1. Orchestrator
2. Scout
3. Planner

Implementer and Reviewer are deferred until the Orchestrator → Scout → Planner → human approval flow is working and tested.

The workflow must:

* use separate agent contexts for each role;
* support different models or providers per role;
* write the implementation plan into `plan.md` in the repository root;
* pause for human review of `plan.md`;
* allow the user to add review comments directly into `plan.md`;
* recognize user review instructions prefixed with `R:`;
* repeatedly revise `plan.md` until the user explicitly approves it;
* prevent implementation before plan approval;
* run deterministic static-analysis and verification gates;
* run semantic review after deterministic checks pass;
* support bounded repair loops;
* preserve an audit trail of workflow stages and results;
* avoid unnecessary paid-model token usage by using a local Scout for repository discovery.

The first implementation should prioritize clarity, deterministic control flow, testability, and extensibility over UI polish.

---

# 1. High-Level Architecture

Implement the workflow as a Pi TypeScript extension.

The extension owns orchestration. Models must not decide which workflow stage runs next.

```text
User task
    ↓
Orchestrator classifies task
    ↓
Scout investigates repository
    ↓
Planner produces plan.md
    ↓
Human reviews plan.md
    ├── adds R: comments
    ├── requests changes
    └── eventually approves
    ↓
Planner revises plan.md until approved
    ↓
Implementer modifies repository
    ↓
Deterministic verification
    ├── git diff --check
    ├── typecheck
    ├── lint
    ├── focused tests
    ├── build
    └── Fallow
    ↓
Reviewer performs semantic review
    ↓
Repair loop
    ├── deterministic failure → Implementer
    ├── semantic issue → Implementer
    └── repeated failure → escalation
    ↓
Final verification
    ↓
Completion report
```

The Orchestrator should be implemented mostly as TypeScript state transitions rather than as an unrestricted language-model agent.

---

# 2. Extension Commands

Add at least these Pi slash commands:

```text
/workflow <task>
/workflow-status
/workflow-resume
/workflow-cancel
/plan-review
/plan-approve
/plan-revise
```

Recommended semantics:

## `/workflow <task>`

Start a new workflow.

Example:

```text
/workflow Add deterministic diving attacks to EnemyFormation
```

## `/workflow-status`

Display:

* workflow ID;
* current stage;
* active agent;
* repair attempt count;
* plan approval status;
* last verification result;
* pending human action.

## `/workflow-resume`

Resume a previously interrupted workflow from persisted state.

## `/workflow-cancel`

Cancel the current workflow without reverting repository changes automatically.

## `/plan-review`

Read `plan.md`, extract `R:` comments, and ask the Planner to revise it.

## `/plan-approve`

Mark the current plan revision as approved and continue to implementation.

## `/plan-revise`

Force another Planner revision even when no `R:` lines are present.

---

# 3. Repository Files

The extension should use the following files.

```text
.pi/
├── extensions/
│   └── workflow/
│       ├── index.ts
│       ├── workflow.ts
│       ├── state.ts
│       ├── persistence.ts
│       ├── agents.ts
│       ├── prompts.ts
│       ├── tools.ts
│       ├── checks.ts
│       ├── plan-review.ts
│       ├── diff.ts
│       └── types.ts
│
├── workflows/
│   └── runs/
│       └── <workflow-id>/
│           ├── state.json
│           ├── task.md
│           ├── scout-report.json
│           ├── plan-revisions/
│           │   ├── plan-001.md
│           │   ├── plan-002.md
│           │   └── ...
│           ├── checks/
│           │   ├── fast-001.json
│           │   ├── full-001.json
│           │   └── ...
│           ├── reviews/
│           │   ├── review-001.json
│           │   └── ...
│           ├── diffs/
│           │   ├── implementation-001.patch
│           │   └── ...
│           ├── events.jsonl
│           └── workflow.log
│
└── agents/
    ├── scout.md
    ├── planner.md
    ├── implementer.md
    └── reviewer.md
```

The repository root should contain the active plan:

```text
plan.md
```

Add generated workflow-state directories to `.gitignore`, but do not automatically ignore `plan.md`. Let the project owner decide whether plans should be committed.

---

# 4. Workflow State Machine

Use an explicit state machine.

```ts
type WorkflowStage =
  | "idle"
  | "classifying"
  | "scouting"
  | "planning"
  | "awaiting_plan_review"
  | "revising_plan"
  | "awaiting_plan_approval"
  | "implementing"
  | "running_fast_checks"
  | "repairing_fast_checks"
  | "running_full_checks"
  | "repairing_full_checks"
  | "reviewing"
  | "repairing_review"
  | "escalating"
  | "final_verification"
  | "completed"
  | "failed"
  | "cancelled";
```

Define persisted workflow state:

```ts
interface WorkflowState {
  workflowId: string;
  task: string;
  repositoryRoot: string;

  stage: WorkflowStage;

  createdAt: string;
  updatedAt: string;

  taskComplexity: "simple" | "moderate" | "complex";

  scoutReportPath?: string;

  planPath: string;
  planRevision: number;
  planApproved: boolean;
  planApprovedAt?: string;
  approvedPlanHash?: string;

  implementationAttempt: number;
  fastRepairAttempt: number;
  fullRepairAttempt: number;
  semanticRepairAttempt: number;

  maxFastRepairs: number;
  maxFullRepairs: number;
  maxSemanticRepairs: number;

  lastCheckResultPath?: string;
  lastReviewResultPath?: string;
  lastDiffPath?: string;

  pendingHumanAction?:
    | "review_plan"
    | "approve_plan"
    | "resolve_escalation"
    | "none";

  failureReason?: string;
}
```

Every state transition must:

1. validate that the transition is allowed;
2. update `state.json`;
3. append an entry to `events.jsonl`;
4. notify the user in Pi;
5. avoid silently skipping mandatory stages.

Example transition validator:

```ts
const ALLOWED_TRANSITIONS: Record<WorkflowStage, WorkflowStage[]> = {
  idle: ["classifying"],
  classifying: ["scouting", "failed", "cancelled"],
  scouting: ["planning", "failed", "cancelled"],
  planning: ["awaiting_plan_review", "failed", "cancelled"],
  awaiting_plan_review: [
    "revising_plan",
    "awaiting_plan_approval",
    "cancelled",
  ],
  revising_plan: ["awaiting_plan_review", "failed", "cancelled"],
  awaiting_plan_approval: [
    "implementing",
    "revising_plan",
    "cancelled",
  ],
  implementing: [
    "running_fast_checks",
    "failed",
    "cancelled",
  ],
  running_fast_checks: [
    "repairing_fast_checks",
    "running_full_checks",
    "failed",
  ],
  repairing_fast_checks: [
    "running_fast_checks",
    "escalating",
    "failed",
  ],
  running_full_checks: [
    "repairing_full_checks",
    "reviewing",
    "failed",
  ],
  repairing_full_checks: [
    "running_full_checks",
    "escalating",
    "failed",
  ],
  reviewing: [
    "repairing_review",
    "final_verification",
    "failed",
  ],
  repairing_review: [
    "running_fast_checks",
    "escalating",
    "failed",
  ],
  escalating: [
    "implementing",
    "awaiting_plan_review",
    "failed",
    "cancelled",
  ],
  final_verification: ["completed", "failed"],
  completed: [],
  failed: [],
  cancelled: [],
};
```

---

# 5. Complete Workflow Pseudocode

```ts
async function runWorkflow(
  task: string,
  context: ExtensionContext,
): Promise<WorkflowResult> {
  const state = await createWorkflowState(task, context.cwd);

  try {
    await transition(state, "classifying");

    state.taskComplexity = classifyTask(task);
    await saveState(state);

    await transition(state, "scouting");

    const scoutReport = await runScout({
      task,
      repositoryRoot: state.repositoryRoot,
      limits: {
        maxFiles: 15,
        maxExcerpts: 30,
        maxLinesPerExcerpt: 140,
        maxApproxTokens: 24_000,
      },
    });

    state.scoutReportPath = await persistScoutReport(state, scoutReport);
    await saveState(state);

    await transition(state, "planning");

    const initialPlan = await runPlanner({
      mode: "create",
      task,
      scoutReport,
      currentPlan: null,
      reviewInstructions: [],
    });

    await writePlanRevision(state, initialPlan);
    await writeActivePlan(state.planPath, initialPlan);

    await transition(state, "awaiting_plan_review");

    state.pendingHumanAction = "review_plan";
    await saveState(state);

    notifyUser(
      [
        "The proposed plan has been written to plan.md.",
        "Review it and add comments beginning with `R:`.",
        "Run `/plan-review` when ready.",
        "Run `/plan-approve` only when satisfied.",
      ].join("\n"),
    );

    return {
      status: "paused",
      reason: "awaiting_plan_review",
      workflowId: state.workflowId,
    };
  } catch (error) {
    await markFailed(state, error);
    throw error;
  }
}
```

The workflow must pause after writing `plan.md`.

It must not continue automatically to implementation.

---

# 6. Human-Gated Plan Review Loop

## Plan file format

The Planner should generate `plan.md` using this structure:

```md
# Implementation Plan

## Status

Draft — awaiting human approval.

## Objective

...

## Scope

### Read

- `src/...`

### Modify

- `src/...`

### Create

- None.

## Repository Findings

...

## Proposed Design

...

## Implementation Steps

1. ...
2. ...
3. ...

## Acceptance Criteria

- [ ] ...
- [ ] ...

## Verification

- `npm run typecheck`
- `npm run lint`
- `npm test -- --run`
- `npm run build`
- `fallow ...`

## Risks and Edge Cases

...

## Open Questions

...

## Human Review Instructions

Add review instructions anywhere in this file using lines beginning with:

R: your instruction here

Remove resolved `R:` lines or mark them as resolved after the plan is revised.
```

## Parsing review comments

Recognize lines matching:

```regex
^\s*R:\s*(.+?)\s*$
```

Case-sensitive `R:` is sufficient for the first version.

Example:

```md
R: Do not create a new service. Extend the existing EnemyFormation class.
R: Add verification for the animation loop.
R: Keep the public API limited to startDive and getActiveDiveCount.
```

Parser:

```ts
interface PlanReviewInstruction {
  lineNumber: number;
  text: string;
  rawLine: string;
}

function extractReviewInstructions(markdown: string): PlanReviewInstruction[] {
  const instructions: PlanReviewInstruction[] = [];

  for (const [index, line] of markdown.split(/\r?\n/).entries()) {
    const match = line.match(/^\s*R:\s*(.+?)\s*$/);

    if (!match) {
      continue;
    }

    instructions.push({
      lineNumber: index + 1,
      text: match[1],
      rawLine: line,
    });
  }

  return instructions;
}
```

## `/plan-review` pseudocode

```ts
async function reviewPlanCommand(ctx: ExtensionContext): Promise<void> {
  const state = await loadActiveWorkflow(ctx.cwd);

  assertStage(state, [
    "awaiting_plan_review",
    "awaiting_plan_approval",
  ]);

  const currentPlan = await fs.readFile(state.planPath, "utf8");
  const instructions = extractReviewInstructions(currentPlan);

  if (instructions.length === 0) {
    state.pendingHumanAction = "approve_plan";
    await transition(state, "awaiting_plan_approval");

    ctx.ui.notify(
      "No R: comments were found. Review the plan and run /plan-approve, or add R: comments and run /plan-review.",
      "info",
    );

    return;
  }

  await transition(state, "revising_plan");

  const scoutReport = await readScoutReport(state);

  const revisedPlan = await runPlanner({
    mode: "revise",
    task: state.task,
    scoutReport,
    currentPlan,
    reviewInstructions: instructions,
  });

  validatePlanRevision({
    previousPlan: currentPlan,
    revisedPlan,
    reviewInstructions: instructions,
  });

  await writePlanRevision(state, revisedPlan);
  await writeActivePlan(state.planPath, revisedPlan);

  state.planRevision += 1;
  state.planApproved = false;
  state.pendingHumanAction = "review_plan";
  await saveState(state);

  await transition(state, "awaiting_plan_review");

  ctx.ui.notify(
    `plan.md was revised to revision ${state.planRevision}. Review it again and add new R: comments if needed.`,
    "info",
  );
}
```

## Planner revision requirements

When revising a plan, the Planner must:

* address every `R:` instruction;
* preserve valid unaffected sections;
* avoid silently discarding constraints;
* update scope, steps, acceptance criteria, risks, and verification where necessary;
* remove handled `R:` lines from the clean output;
* append a revision log.

Example:

```md
## Revision Log

### Revision 2

Addressed:

- Kept dive scheduling in `EnemyFormation`.
- Removed proposed `DiveController.ts`.
- Added animation-loop verification.
```

## `/plan-approve` pseudocode

```ts
async function approvePlanCommand(ctx: ExtensionContext): Promise<void> {
  const state = await loadActiveWorkflow(ctx.cwd);

  assertStage(state, [
    "awaiting_plan_review",
    "awaiting_plan_approval",
  ]);

  const plan = await fs.readFile(state.planPath, "utf8");
  const unresolvedInstructions = extractReviewInstructions(plan);

  if (unresolvedInstructions.length > 0) {
    throw new Error(
      "plan.md still contains unresolved R: comments. Run /plan-review first.",
    );
  }

  validatePlanCompleteness(plan);

  state.planApproved = true;
  state.planApprovedAt = new Date().toISOString();
  state.approvedPlanHash = sha256(plan);
  state.pendingHumanAction = "none";

  await saveState(state);
  await transition(state, "implementing");

  await continueApprovedWorkflow(state, ctx);
}
```

Before every implementation or repair stage, verify that:

```ts
sha256(await fs.readFile("plan.md", "utf8")) === state.approvedPlanHash
```

When the approved plan changes afterward, stop implementation and require approval again.

---

# 7. Approved Workflow Continuation

```ts
async function continueApprovedWorkflow(
  state: WorkflowState,
  ctx: ExtensionContext,
): Promise<void> {
  assertApprovedPlanUnchanged(state);

  const approvedPlan = await fs.readFile(state.planPath, "utf8");
  const scoutReport = await readScoutReport(state);

  state.implementationAttempt += 1;
  await saveState(state);

  await runImplementer({
    mode: "implement",
    task: state.task,
    plan: approvedPlan,
    scoutReport,
    findings: [],
    repositoryRoot: state.repositoryRoot,
  });

  await persistCurrentDiff(state);

  await runVerificationAndReviewLoop(state, ctx);
}
```

---

# 8. Deterministic Verification Pipeline

Use two verification tiers.

## Fast checks

Run after every implementation or repair:

```text
git diff --check
TypeScript compiler
ESLint
focused tests
```

Example configuration:

```ts
const FAST_CHECKS: CheckDefinition[] = [
  {
    name: "diff-check",
    command: "git diff --check",
    required: true,
  },
  {
    name: "typecheck",
    command: "npm run typecheck",
    required: true,
  },
  {
    name: "lint",
    command: "npm run lint",
    required: true,
  },
  {
    name: "focused-tests",
    command: resolveFocusedTestCommand(),
    required: true,
  },
];
```

## Full checks

Run after fast checks pass:

```text
full test suite
production build
Fallow
dependency or security checks when configured
```

Example:

```ts
const FULL_CHECKS: CheckDefinition[] = [
  {
    name: "tests",
    command: "npm test -- --run",
    required: true,
  },
  {
    name: "build",
    command: "npm run build",
    required: true,
  },
  {
    name: "fallow",
    command: resolveFallowCommand(),
    required: true,
  },
];
```

Repository-specific commands should be discovered during project initialization or read from a workflow configuration file.

Suggested config:

```json
{
  "checks": {
    "fast": [
      "git diff --check",
      "npm run typecheck",
      "npm run lint"
    ],
    "full": [
      "npm test -- --run",
      "npm run build",
      "fallow check --format json"
    ]
  }
}
```

---

# 9. Check Result Normalization

Normalize every shell result.

```ts
type Severity = "error" | "warning" | "info";

interface Finding {
  source: string;
  category?: string;
  severity: Severity;
  rule?: string;
  file?: string;
  line?: number;
  column?: number;
  message: string;
  raw?: string;
  introduced?: boolean;
}

interface CheckResult {
  name: string;
  command: string;
  passed: boolean;
  required: boolean;
  exitCode: number;
  durationMs: number;
  stdoutPreview: string;
  stderrPreview: string;
  findings: Finding[];
  outputTruncated: boolean;
}

interface CheckSuiteResult {
  suite: "fast" | "full" | "final";
  passed: boolean;
  checks: CheckResult[];
  introducedFindings: Finding[];
  preExistingFindings: Finding[];
}
```

Do not send unlimited raw output to agents.

Apply:

* line limits;
* character limits;
* duplicate suppression;
* grouping by file and rule;
* baseline comparison where supported;
* extraction of only actionable failures.

For Fallow, distinguish:

```ts
interface FallowDelta {
  introduced: Finding[];
  resolved: Finding[];
  preExisting: Finding[];
}
```

Normal task gates should primarily block on findings introduced by the current change.

---

# 10. Verification and Repair Loop

```ts
async function runVerificationAndReviewLoop(
  state: WorkflowState,
  ctx: ExtensionContext,
): Promise<void> {
  const approvedPlan = await readApprovedPlan(state);

  while (true) {
    await transition(state, "running_fast_checks");

    const fast = await runCheckSuite("fast", state.repositoryRoot);
    await persistCheckSuite(state, fast);

    if (!fast.passed) {
      if (state.fastRepairAttempt >= state.maxFastRepairs) {
        await escalateWorkflow(state, {
          reason: "fast_checks_exhausted",
          evidence: fast,
        });
        return;
      }

      state.fastRepairAttempt += 1;
      await saveState(state);
      await transition(state, "repairing_fast_checks");

      await runImplementer({
        mode: "repair",
        task: state.task,
        plan: approvedPlan,
        scoutReport: await readScoutReport(state),
        findings: fast.introducedFindings,
        repositoryRoot: state.repositoryRoot,
      });

      await persistCurrentDiff(state);
      continue;
    }

    await transition(state, "running_full_checks");

    const full = await runCheckSuite("full", state.repositoryRoot);
    await persistCheckSuite(state, full);

    if (!full.passed) {
      if (state.fullRepairAttempt >= state.maxFullRepairs) {
        await escalateWorkflow(state, {
          reason: "full_checks_exhausted",
          evidence: full,
        });
        return;
      }

      state.fullRepairAttempt += 1;
      await saveState(state);
      await transition(state, "repairing_full_checks");

      await runImplementer({
        mode: "repair",
        task: state.task,
        plan: approvedPlan,
        scoutReport: await readScoutReport(state),
        findings: full.introducedFindings,
        repositoryRoot: state.repositoryRoot,
      });

      await persistCurrentDiff(state);
      continue;
    }

    await transition(state, "reviewing");

    const review = await runReviewer({
      task: state.task,
      approvedPlan,
      scoutReport: await readScoutReport(state),
      diff: await getCurrentDiff(state.repositoryRoot),
      deterministicChecks: {
        fast,
        full,
      },
    });

    await persistReview(state, review);

    if (!review.passed) {
      if (state.semanticRepairAttempt >= state.maxSemanticRepairs) {
        await escalateWorkflow(state, {
          reason: "semantic_review_exhausted",
          evidence: review,
        });
        return;
      }

      state.semanticRepairAttempt += 1;
      await saveState(state);
      await transition(state, "repairing_review");

      await runImplementer({
        mode: "repair",
        task: state.task,
        plan: approvedPlan,
        scoutReport: await readScoutReport(state),
        findings: review.findings,
        repositoryRoot: state.repositoryRoot,
      });

      await persistCurrentDiff(state);
      continue;
    }

    await transition(state, "final_verification");

    const finalResult = await runCheckSuite(
      "final",
      state.repositoryRoot,
    );

    await persistCheckSuite(state, finalResult);

    if (!finalResult.passed) {
      await markFailed(
        state,
        new Error("Final verification failed after review approval."),
      );
      return;
    }

    await transition(state, "completed");

    ctx.ui.notify(
      buildCompletionSummary({
        state,
        review,
        finalResult,
      }),
      "info",
    );

    return;
  }
}
```

Recommended default limits:

```ts
const DEFAULT_REPAIR_LIMITS = {
  fast: 2,
  full: 2,
  semantic: 2,
};
```

---

# 11. Escalation Policy

Escalation should be explicit and bounded.

Possible escalation reasons:

```ts
type EscalationReason =
  | "scout_uncertain"
  | "planner_uncertain"
  | "fast_checks_exhausted"
  | "full_checks_exhausted"
  | "semantic_review_exhausted"
  | "implementation_blocked"
  | "approved_plan_invalidated";
```

Escalation options:

1. Ask the human to revise the plan.
2. Invoke a stronger Planner.
3. Invoke Codex CLI in read-only mode for diagnosis.
4. Invoke a stronger Implementer.
5. End the workflow as failed.

Do not silently switch to an expensive model.

At escalation, pause and show:

* reason;
* attempts already made;
* current diff;
* failing checks;
* reviewer findings;
* suggested next actions.

---

# 12. Agent Invocation Abstraction

Create a unified role configuration.

```ts
type AgentRole =
  | "scout"
  | "planner"
  | "implementer"
  | "reviewer"
  | "escalation";

interface AgentProfile {
  role: AgentRole;
  provider: string;
  model: string;
  systemPromptPath: string;
  tools: string[];
  readOnly: boolean;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  temperature?: number;
}
```

Example:

```ts
const AGENT_PROFILES: Record<AgentRole, AgentProfile> = {
  scout: {
    role: "scout",
    provider: "local-llama",
    model: "qwen3.6-35b-a3b",
    systemPromptPath: ".pi/agents/scout.md",
    tools: ["list", "read", "grep", "git"],
    readOnly: true,
    temperature: 0.1,
  },

  planner: {
    role: "planner",
    provider: "openai-codex",
    model: "codex-model",
    systemPromptPath: ".pi/agents/planner.md",
    tools: ["request_more_scout_context"],
    readOnly: true,
    temperature: 0.1,
  },

  implementer: {
    role: "implementer",
    provider: "local-llama",
    model: "qwen3.6-35b-a3b",
    systemPromptPath: ".pi/agents/implementer.md",
    tools: ["read", "grep", "edit", "write", "git_diff"],
    readOnly: false,
    temperature: 0.1,
  },

  reviewer: {
    role: "reviewer",
    provider: "local-llama",
    model: "review-model",
    systemPromptPath: ".pi/agents/reviewer.md",
    tools: [],
    readOnly: true,
    temperature: 0.1,
  },

  escalation: {
    role: "escalation",
    provider: "codex-cli",
    model: "default",
    systemPromptPath: ".pi/agents/escalation.md",
    tools: ["read", "grep", "git_diff"],
    readOnly: true,
    temperature: 0.1,
  },
};
```

The workflow should allow changing these profiles without modifying orchestration code.

---

# 13. Orchestrator System Prompt

The Orchestrator should be thin. Most sequencing belongs in TypeScript.

Save as:

```text
.pi/agents/orchestrator.md
```

Content:

```md
# Role

You are the workflow Orchestrator for a deterministic software-development pipeline.

You do not implement code, perform broad repository investigation, or independently rewrite the implementation plan.

The TypeScript workflow engine owns stage transitions. Your role is limited to classification, concise routing decisions, escalation summaries, and human-facing status communication.

# Responsibilities

- Classify tasks as simple, moderate, or complex.
- Identify whether planning is required.
- Identify whether an escalation should return to planning, implementation, or human review.
- Summarize workflow state for the user.
- Preserve the approved scope and acceptance criteria.
- Prefer local agents and deterministic tools when they are sufficient.
- Recommend paid-model escalation only when evidence justifies it.

# Prohibited Actions

- Do not modify repository files.
- Do not perform the Scout's repository investigation.
- Do not produce the Planner's implementation design.
- Do not implement fixes.
- Do not approve your own plan.
- Do not skip human plan approval.
- Do not mark a workflow completed when required checks failed.
- Do not silently increase repair limits.
- Do not silently invoke expensive models.

# Classification Rules

Simple:
- one small, well-localized change;
- known files and symbols;
- low architectural risk;
- no public API or data-flow change.

Moderate:
- several files;
- new behavior;
- existing patterns must be located;
- tests or lifecycle behavior may change.

Complex:
- cross-module architecture;
- concurrency, persistence, security, or migration concerns;
- public API changes;
- substantial ambiguity;
- repeated implementation failure.

# Output Contract

Return JSON only:

{
  "classification": "simple | moderate | complex",
  "planningRequired": true,
  "reason": "brief explanation",
  "recommendedNextStage": "scouting | planning | implementation | human_review | escalation",
  "escalationTarget": "none | planner | implementer | human | codex"
}
```

---

# 14. Scout System Prompt

Save as:

```text
.pi/agents/scout.md
```

Content:

```md
# Role

You are a read-only repository Scout.

Your purpose is to gather precise repository evidence for the Planner and Implementer while minimizing context volume.

You investigate. You do not design the final solution and you never modify files.

# Objectives

For the supplied task:

1. Locate the relevant files and symbols.
2. Trace important call paths and data flow.
3. Identify existing patterns that should be reused.
4. Identify tests, build scripts, lint commands, and verification commands.
5. Identify architectural boundaries and risky dependencies.
6. Identify uncertainties that require focused follow-up research.
7. Produce a compact evidence package.

# Tool Policy

You may use only read-only tools:

- list files;
- search text and symbols;
- read targeted file sections;
- inspect git status and diff;
- inspect package scripts and configuration;
- inspect static-analysis reports.

Do not:

- edit files;
- write files;
- run destructive commands;
- install dependencies;
- perform implementation;
- propose broad refactors.

# Research Strategy

- Begin with repository structure and targeted search.
- Prefer symbol search and call-site search over reading entire files.
- Read only relevant sections.
- Locate analogous existing implementations.
- Locate tests near affected code.
- Record exact paths and symbol names.
- Separate observed facts from inference.
- State when evidence is incomplete.

# Context Limits

Unless explicitly expanded:

- inspect no more than 15 primary files;
- include no more than 30 code excerpts;
- include no more than 140 lines per excerpt;
- avoid copying entire large files;
- deduplicate repeated code;
- prioritize code directly relevant to the task.

# Required Output

Return valid JSON:

{
  "taskSummary": "brief normalized task",
  "relevantFiles": [
    {
      "path": "path/to/file",
      "purpose": "why it matters",
      "symbols": ["SymbolName"],
      "reason": "task relevance"
    }
  ],
  "codeExcerpts": [
    {
      "path": "path/to/file",
      "startLine": 1,
      "endLine": 20,
      "reason": "why this excerpt matters",
      "content": "source excerpt"
    }
  ],
  "callPaths": [
    "Caller.method -> Service.method -> Repository.method"
  ],
  "dataFlow": [
    "description of important data movement"
  ],
  "existingPatterns": [
    "pattern already used in repository"
  ],
  "tests": [
    {
      "path": "test path",
      "relevance": "what it verifies"
    }
  ],
  "verificationCommands": [
    "command"
  ],
  "architectureConstraints": [
    "constraint"
  ],
  "risks": [
    "risk"
  ],
  "uncertainties": [
    {
      "question": "focused missing fact",
      "importance": "why it matters"
    }
  ]
}

# Quality Rules

- Do not invent symbols or files.
- Do not claim a test exists unless found.
- Do not infer architecture without supporting evidence.
- Keep findings concise.
- Preserve exact file paths and symbol names.
- Mark inference explicitly.
```

---

# 15. Planner System Prompt

Save as:

```text
.pi/agents/planner.md
```

Content:

```md
# Role

You are a software implementation Planner.

You create and revise `plan.md` using the task, Scout evidence, repository constraints, and human review instructions.

You do not modify application code.

# Primary Objective

Produce a bounded, implementable, verifiable plan that the Implementer can follow without repeating broad repository discovery.

# Inputs

You may receive:

- original task;
- Scout evidence package;
- current `plan.md`;
- human instructions extracted from `R:` lines;
- deterministic-analysis context;
- previous implementation or review failures.

# Planning Rules

- Treat the user's task and explicit constraints as authoritative.
- Base repository claims on Scout evidence.
- Reuse existing repository patterns.
- Minimize affected files.
- Avoid unrelated refactors.
- Distinguish files to read, modify, create, and delete.
- Define concrete implementation steps.
- Define observable acceptance criteria.
- Define verification commands.
- Identify risks and edge cases.
- Identify unresolved questions.
- Do not hide uncertainty.

# Revision Rules

When revising an existing plan:

1. Address every `R:` instruction.
2. Preserve valid unaffected sections.
3. Update all impacted sections consistently.
4. Remove resolved `R:` lines from the clean plan.
5. Add a Revision Log entry.
6. Do not silently reject a human instruction.
7. When an instruction conflicts with another constraint, state the conflict in Open Questions.
8. Never mark the plan approved yourself.

# Additional Scout Context

When critical evidence is missing, return a structured context request instead of guessing:

{
  "status": "needs_more_context",
  "questions": [
    {
      "question": "focused repository question",
      "reason": "why planning depends on it"
    }
  ]
}

Do not request broad repository scans. Request only focused missing facts.

# Plan Output Format

Return Markdown only using this exact structure:

# Implementation Plan

## Status

Draft — awaiting human approval.

## Objective

...

## Scope

### Read

- ...

### Modify

- ...

### Create

- None.

### Delete

- None.

## Repository Findings

...

## Proposed Design

...

## Implementation Steps

1. ...
2. ...
3. ...

## Acceptance Criteria

- [ ] ...
- [ ] ...

## Verification

- `command`

## Risks and Edge Cases

- ...

## Open Questions

- None.

## Revision Log

### Revision N

- ...

## Human Review Instructions

Add review instructions anywhere in this file using:

R: instruction

Run `/plan-review` after adding comments.
Run `/plan-approve` only when the plan is satisfactory.

# Plan Quality Requirements

A valid plan must:

- name concrete files or explicitly state when file discovery remains;
- identify the owning component for new behavior;
- avoid vague steps such as "update logic";
- describe how existing behavior is preserved;
- contain testable acceptance criteria;
- contain verification commands;
- state whether new dependencies are permitted;
- state whether new files are required;
- state unresolved assumptions.
```

---

# 16. Implementer System Prompt

Save as:

```text
.pi/agents/implementer.md
```

Content:

```md
# Role

You are a repository implementation agent.

You implement the approved `plan.md` using the smallest correct change.

The approved plan, task, acceptance criteria, and repair findings are authoritative.

# Preconditions

Before changing code:

- confirm that the plan is marked approved by the workflow engine;
- confirm that the plan hash matches the approved revision;
- inspect only the files and symbols needed for the current implementation or repair;
- review the supplied Scout evidence.

When the plan is not approved or its hash changed, stop and report the problem.

# Implementation Rules

- Follow the approved plan.
- Reuse existing patterns, APIs, naming, and architecture.
- Make targeted edits.
- Do not refactor unrelated code.
- Do not create files unless the plan permits it.
- Do not add dependencies unless the plan permits it.
- Preserve public behavior not explicitly changed.
- Keep types precise.
- Handle edge cases listed in the plan.
- Keep changes within scope.
- Do not modify `plan.md`.
- Do not alter workflow state files.
- Do not disable or weaken tests, lint rules, compiler settings, or static-analysis rules merely to pass gates.
- Do not suppress diagnostics without addressing their cause.
- Do not claim verification that was not performed.

# Repair Mode

When supplied deterministic or reviewer findings:

- fix only actionable issues introduced by the current change;
- do not clean unrelated pre-existing issues;
- preserve already-correct implementation behavior;
- address root causes;
- inspect the current diff before editing;
- avoid broad rewrites;
- report findings that cannot be fixed without changing the approved plan.

# Tool Strategy

- Prefer targeted reads and searches.
- Prefer patch-based edits.
- Inspect the diff after editing.
- Avoid rewriting complete files unless necessary.
- Do not run unapproved destructive commands.
- Do not commit, push, or create branches unless explicitly instructed.

# Required Final Response

Return JSON only:

{
  "status": "implemented | repaired | blocked",
  "summary": "brief summary",
  "filesChanged": [
    {
      "path": "path",
      "change": "brief description"
    }
  ],
  "acceptanceCriteriaAddressed": [
    "criterion"
  ],
  "verificationSuggested": [
    "command"
  ],
  "unresolvedIssues": [
    "issue"
  ],
  "planChangeRequired": false
}

Set `planChangeRequired` to true when a correct solution requires changing the approved plan.
```

---

# 17. Reviewer System Prompt

Save as:

```text
.pi/agents/reviewer.md
```

Content:

```md
# Role

You are a strict, read-only semantic code Reviewer.

You review the current diff against:

- the original task;
- the approved `plan.md`;
- acceptance criteria;
- Scout evidence;
- deterministic check results;
- repository conventions.

You do not modify files.

# Review Priorities

Review for:

1. correctness;
2. missing acceptance criteria;
3. behavioral regressions;
4. lifecycle and state-management errors;
5. incorrect data flow;
6. concurrency or timing issues;
7. missing edge-case handling;
8. architecture violations;
9. misuse of existing APIs;
10. unnecessary complexity;
11. suspicious diagnostic suppression;
12. tests that do not validate the intended behavior.

Do not repeat compiler, linter, or static-analysis findings unless their semantic consequence matters.

# Scope Rules

- Report only actionable issues introduced or exposed by the current change.
- Do not request unrelated cleanup.
- Do not reject code merely because you prefer another style.
- Do not recommend broad refactoring unless necessary for correctness.
- Distinguish blockers from suggestions.
- Cite concrete files, symbols, and line ranges when available.
- Explain the failure scenario.
- Map findings to acceptance criteria where relevant.

# Severity

Use:

- blocker: implementation cannot be accepted;
- major: likely incorrect behavior or missing requirement;
- minor: limited but actionable issue;
- suggestion: optional improvement that must not block completion.

Only blocker, major, and explicitly configured minor findings should fail the review.

# Required Output

Return valid JSON:

{
  "passed": true,
  "summary": "brief review summary",
  "acceptanceCriteria": [
    {
      "criterion": "criterion text",
      "status": "met | partially_met | not_met",
      "evidence": "brief evidence"
    }
  ],
  "findings": [
    {
      "severity": "blocker | major | minor | suggestion",
      "category": "correctness | regression | lifecycle | architecture | testing | complexity | security | other",
      "file": "path",
      "lineStart": 1,
      "lineEnd": 1,
      "symbol": "optional symbol",
      "message": "actionable issue",
      "failureScenario": "how the issue appears",
      "requiredFix": "specific correction"
    }
  ],
  "requiresPlanRevision": false
}

Set `passed` to false when any blocker or major finding exists.

Set `requiresPlanRevision` to true when the implementation cannot be fixed without changing the approved design or scope.
```

---

# 18. Plan Validation

Implement deterministic validation before approval.

```ts
interface PlanValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}
```

Required sections:

```ts
const REQUIRED_PLAN_SECTIONS = [
  "# Implementation Plan",
  "## Status",
  "## Objective",
  "## Scope",
  "## Repository Findings",
  "## Proposed Design",
  "## Implementation Steps",
  "## Acceptance Criteria",
  "## Verification",
  "## Risks and Edge Cases",
  "## Open Questions",
  "## Revision Log",
];
```

Validation rules:

* no unresolved `R:` lines;
* at least one implementation step;
* at least one acceptance criterion;
* at least one verification command;
* explicit `Create` section;
* explicit `Delete` section;
* no contradictory status such as `Approved` written by Planner;
* no path traversal or absolute paths outside repository;
* no instructions to weaken checks;
* no unbounded language such as "refactor as needed" without scope;
* no placeholder text such as `TODO` or `TBD` unless listed under Open Questions.

---

# 19. Security and Sandbox Rules

Pi extensions execute with the permissions of the Pi process.

Implement these safeguards:

* validate repository root;
* reject paths outside repository;
* restrict Scout to read-only tools;
* restrict Planner to no repository-write tools;
* restrict Reviewer to no tools or read-only evidence;
* allow Implementer writes only inside repository;
* block access to `.env`, credentials, SSH keys, browser profiles, and home-directory secrets unless explicitly authorized;
* redact secrets from logs;
* cap command execution time;
* cap output size;
* disallow destructive shell commands;
* record every command;
* require explicit user permission for network access;
* do not automatically commit or push.

Optional stronger isolation:

* run local agents in a container;
* run Scout and Reviewer with read-only repository mounts;
* run Implementer in a dedicated Git worktree;
* run Codex escalation in read-only mode unless explicitly chosen for implementation.

---

# 20. Event Journal

Append every event as one JSON line.

```ts
interface WorkflowEvent {
  id: string;
  workflowId: string;
  timestamp: string;
  type:
    | "workflow_created"
    | "stage_changed"
    | "agent_started"
    | "agent_completed"
    | "plan_written"
    | "plan_review_requested"
    | "plan_revised"
    | "plan_approved"
    | "command_started"
    | "command_completed"
    | "check_failed"
    | "repair_started"
    | "review_completed"
    | "escalation_requested"
    | "workflow_completed"
    | "workflow_failed"
    | "workflow_cancelled";
  stage: WorkflowStage;
  payload: Record<string, unknown>;
}
```

Never store hidden reasoning or model chain-of-thought.

Store only:

* prompts sent;
* structured responses;
* tool calls;
* commands;
* exit codes;
* summaries;
* diffs;
* decisions;
* token usage where available.

---

# 21. Testing Requirements

Add tests for:

## State machine

* valid transitions succeed;
* invalid transitions fail;
* completed and cancelled workflows cannot resume incorrectly.

## Plan review parser

* extracts valid `R:` lines;
* ignores non-`R:` text;
* preserves line numbers;
* handles multiple comments;
* handles Windows and Unix line endings;
* rejects approval while comments remain.

## Plan approval

* hashes approved plan;
* prevents implementation when plan changes afterward;
* allows revision and reapproval;
* persists approval timestamp.

## Repair limits

* retries only up to configured maximum;
* escalates after limit;
* does not reset counters accidentally.

## Verification

* hard gates fail on non-zero exit;
* output truncation works;
* findings normalize correctly;
* Fallow baseline separates introduced and pre-existing issues.

## Persistence

* interrupted workflow resumes;
* journal remains append-only;
* state writes are atomic;
* corrupt state produces a clear error.

## Agent boundaries

* Scout cannot write;
* Planner cannot modify repository;
* Reviewer cannot modify repository;
* Implementer cannot modify workflow state or `plan.md`.

---

# 22. Acceptance Criteria

The implementation is complete when:

* `/workflow <task>` creates a persisted workflow;
* the Scout produces a structured repository report;
* the Planner writes `plan.md`;
* the workflow pauses before implementation;
* the user can add one or more `R:` lines to `plan.md`;
* `/plan-review` revises `plan.md`;
* review can repeat multiple times;
* `/plan-approve` refuses approval while unresolved `R:` lines remain;
* approval stores a hash of the plan;
* implementation cannot begin without approval;
* modification of an approved plan invalidates approval;
* the Implementer follows the approved plan;
* fast checks run after implementation;
* failed checks trigger bounded repairs;
* full checks include Fallow when configured;
* the Reviewer receives the diff, plan, Scout report, and check results;
* semantic review failures trigger bounded repairs;
* final verification runs after review passes;
* workflow state can resume after interruption;
* all stages are recorded in an append-only event journal;
* no role can silently skip mandatory gates;
* model profiles are configurable independently from workflow code.

---

# 23. Implementation Order

Implement in this order:

1. Types and persisted workflow state.
2. Atomic persistence and event journal.
3. State-transition validation.
4. Pi slash commands.
5. Plan creation and `plan.md` writing.
6. `R:` parser.
7. Plan revision loop.
8. Plan approval and hashing.
9. Agent-profile abstraction.
10. Scout invocation.
11. Planner invocation.
12. Implementer invocation.
13. Deterministic shell checks.
14. Check-result normalization.
15. Fallow integration.
16. Reviewer invocation.
17. Repair loops.
18. Escalation.
19. Resume support.
20. Tests and documentation.

---

# 24. Non-Goals for the First Version

Do not initially implement:

* parallel Implementers;
* automatic Git commits;
* automatic pull-request creation;
* distributed execution;
* remote workflow dashboard;
* automatic merge;
* autonomous dependency installation;
* unrestricted network research;
* dynamic prompt generation;
* more than one active workflow per repository;
* complex task graph scheduling.

Keep the first version focused on one reliable sequential workflow with strong human plan approval.

---

# 25. Final Deliverables

Create:

```text
.pi/extensions/workflow/index.ts
.pi/extensions/workflow/workflow.ts
.pi/extensions/workflow/state.ts
.pi/extensions/workflow/persistence.ts
.pi/extensions/workflow/agents.ts
.pi/extensions/workflow/prompts.ts
.pi/extensions/workflow/tools.ts
.pi/extensions/workflow/checks.ts
.pi/extensions/workflow/plan-review.ts
.pi/extensions/workflow/diff.ts
.pi/extensions/workflow/types.ts

.pi/agents/orchestrator.md
.pi/agents/scout.md
.pi/agents/planner.md
.pi/agents/implementer.md
.pi/agents/reviewer.md

.pi/workflow.config.example.json
docs/pi-workflow.md
```

Also update:

```text
.gitignore
package.json
```

only where required.

Do not add unrelated dependencies or refactor unrelated Pi-extension code.

---

# 26. Final Verification

Run the repository's actual equivalent commands:

```text
npm run typecheck
npm run lint
npm test
npm run build
```

Also execute an end-to-end dry run using a small test task:

```text
/workflow Add a harmless exported helper with one unit test
```

Verify this sequence:

1. Scout runs.
2. `plan.md` is written.
3. Workflow pauses.
4. Add:

```text
R: Rename the helper to a different explicit name.
```

5. Run `/plan-review`.
6. Confirm the plan is revised.
7. Run `/plan-approve`.
8. Confirm implementation begins.
9. Confirm checks run.
10. Confirm Reviewer runs.
11. Confirm final verification passes.
12. Confirm workflow completes and journal files exist.
