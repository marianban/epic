export type WorkflowStage =
  | "idle"
  | "classifying"
  | "scouting"
  | "planning"
  | "awaiting_plan_review"
  | "revising_plan"
  | "awaiting_plan_approval"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskComplexity = "simple" | "moderate" | "complex";
export type AgentRole = "orchestrator" | "scout" | "planner";
export type PendingHumanAction = "review_plan" | "approve_plan" | "none";
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
  pendingHumanAction?: PendingHumanAction;
  failureReason?: string;
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
  checks?: { fast?: string[]; full?: string[]; final?: string[]; focusedTests?: string; fallow?: string; fallowBaseline?: string };
  agents?: Partial<Record<AgentRole, Partial<AgentProfile>>>;
}
