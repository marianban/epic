export type WorkflowStage =
  | "idle"
  | "classifying"
  | "scouting"
  | "planning"
  | "awaiting_plan_review"
  | "revising_plan"
  | "awaiting_plan_approval"
  | "decomposing_tasks"
  | "awaiting_task_approval"
  | "awaiting_task_review"
  | "revising_task"
  | "checking_prerequisites"
  | "awaiting_prerequisite_approval"
  | "preparing_prerequisites"
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

export type TaskComplexity = "simple" | "moderate" | "complex";
export type AgentRole = "orchestrator" | "scout" | "planner" | "plan-reviewer" | "task-reviewer" | "implementer" | "reviewer";
export type PendingHumanAction = "review_plan" | "approve_plan" | "approve_prerequisites" | "review_task" | "approve_task" | "resolve_escalation" | "none";
export type CheckSuiteName = "fast" | "full" | "final";
export type Severity = "error" | "warning" | "info";

export interface WorkflowState {
  workflowId: string;
  task: string;
  repositoryRoot: string;
  stage: WorkflowStage;
  createdAt: string;
  updatedAt: string;
  taskComplexity: TaskComplexity;
  scoutRound: number;
  maxScoutRounds: number;
  scoutReportPath?: string;
  planPath: string;
  planRevision: number;
  planApproved: boolean;
  planApprovedAt?: string;
  approvedPlanHash?: string;
  taskPlanPath?: string;
  tasks?: WorkflowTask[];
  currentTaskIndex: number;
  taskApproved: boolean;
  taskApprovedAt?: string;
  pendingHumanAction?: PendingHumanAction;
  prerequisites?: Prerequisite[];
  prerequisitesApprovedAt?: string;
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
  failureReason?: string;
}

export interface WorkflowTask {
  id: string;
  title: string;
  objective: string;
  scope: { read: string[]; modify: string[]; create: string[]; delete: string[] };
  implementation: string[];
  acceptanceCriteria: string[];
  verification: string[];
  manualReviewSteps: string[];
  risks: string[];
}

export interface Prerequisite {
  kind: "git" | "node_dependencies";
  command: "git init" | "npm ci" | "npm install" | "pnpm install" | "yarn install";
  reason: string;
}

export interface PlanReviewInstruction {
  lineNumber: number;
  text: string;
  rawLine: string;
}

export interface Finding {
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

export interface CheckDefinition {
  name: string;
  command: string;
  required: boolean;
  timeoutMs?: number;
}

export interface CheckResult {
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
  skipped?: boolean;
}

export interface CheckSuiteResult {
  suite: CheckSuiteName;
  passed: boolean;
  checks: CheckResult[];
  introducedFindings: Finding[];
  preExistingFindings: Finding[];
}

export interface FallowDelta {
  introduced: Finding[];
  resolved: Finding[];
  preExisting: Finding[];
}

export interface AgentProfile {
  role: AgentRole;
  provider?: string;
  model?: string;
  systemPromptPath: string;
  tools: string[];
  readOnly: boolean;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  temperature?: number;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  timeoutMs?: number;
}

export interface ScoutReport {
  taskSummary: string;
  relevantFiles: Array<{ path: string; purpose: string; symbols: string[]; reason: string }>;
  codeExcerpts: Array<{ path: string; startLine: number; endLine: number; reason: string; content: string }>;
  callPaths: string[];
  dataFlow: string[];
  existingPatterns: string[];
  tests: Array<{ path: string; relevance: string }>;
  verificationCommands: string[];
  architectureConstraints: string[];
  risks: string[];
  uncertainties: Array<{ question: string; importance: string }>;
}

export interface PlannerContextRequest {
  status: "needs_more_context";
  questions: Array<{ question: string; reason: string }>;
}

export interface ReviewResult {
  passed: boolean;
  summary: string;
  acceptanceCriteria: Array<{ criterion: string; status: "met" | "partially_met" | "not_met"; evidence: string }>;
  findings: Array<{
    severity: "blocker" | "major" | "minor" | "suggestion";
    category: string;
    file?: string;
    lineStart?: number;
    lineEnd?: number;
    symbol?: string;
    message: string;
    failureScenario: string;
    requiredFix: string;
  }>;
  requiresPlanRevision: boolean;
}

export interface WorkflowEvent {
  id: string;
  workflowId: string;
  timestamp: string;
  type: string;
  stage: WorkflowStage;
  payload: Record<string, unknown>;
}

export interface WorkflowConfig {
  maxScoutRounds?: number;
  commandTimeoutMs?: number;
  agentTimeoutMs?: number;
  maxOutputBytes?: number;
  maxFastRepairs?: number;
  maxFullRepairs?: number;
  maxSemanticRepairs?: number;
  checks?: { fast?: string[]; full?: string[]; final?: string[]; focusedTests?: string; fallow?: string; fallowBaseline?: string };
  agents?: Partial<Record<AgentRole, Partial<AgentProfile>>>;
}
