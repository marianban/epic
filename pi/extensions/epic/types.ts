export type EpicStage =
  | 'idle'
  | 'classifying'
  | 'scouting'
  | 'planning'
  | 'awaiting_plan_review'
  | 'revising_plan'
  | 'awaiting_plan_approval'
  | 'decomposing_tasks'
  | 'awaiting_task_approval'
  | 'awaiting_task_review'
  | 'revising_task'
  | 'checking_prerequisites'
  | 'awaiting_prerequisite_approval'
  | 'preparing_prerequisites'
  | 'implementing'
  | 'running_fast_checks'
  | 'repairing_fast_checks'
  | 'running_full_checks'
  | 'repairing_full_checks'
  | 'starting_dev_server'
  | 'running_browser_smoke'
  | 'planning_acceptance'
  | 'acceptance_planning_failed'
  | 'verifying_acceptance'
  | 'finalizing_report'
  | 'repairing_browser_smoke'
  | 'reviewing'
  | 'repairing_review'
  | 'escalating'
  | 'recovering'
  | 'final_verification'
  | 'completed'
  | 'failed'

export type EpicComplexity = 'simple' | 'moderate' | 'complex'
export type AgentRole =
  | 'scout'
  | 'planner'
  | 'task-planner'
  | 'plan-reviewer'
  | 'task-reviewer'
  | 'implementer'
  | 'verification-planner'
  | 'verifier'
  | 'reviewer'
export type PendingHumanAction =
  | 'approve_plan'
  | 'approve_prerequisites'
  | 'review_task'
  | 'approve_task'
  | 'resolve_escalation'
  | 'approve_recovery'
  | 'retry_acceptance_planning'
export type CheckSuiteName = 'fast' | 'full' | 'final'
export type Severity = 'error' | 'warning' | 'info'

/** Durable business facts owned by the epic actor. Lifecycle belongs to its snapshot. */
export interface EpicDomainState {
  epicId: string
  epic: string
  repositoryRoot: string
  epicComplexity: EpicComplexity
  scoutRound: number
  maxScoutRounds: number
  scoutReportPath?: string
  planPath: string
  planRevision: number
  planApproved: boolean
  planApprovedAt?: string
  approvedPlanHash?: string
  taskPlanPath?: string
  tasks?: EpicTask[]
  currentTaskIndex: number
  taskApproved: boolean
  taskApprovedAt?: string
  prerequisites?: Prerequisite[]
  prerequisitesApprovedAt?: string
  implementationAttempt: number
  maxRepairsPerItem: number
  maxAcceptancePlanRepairs: number
  maxTaskInfrastructureRetries: number
  taskVerificationTimeoutMs: number
  lastVerificationReportPath?: string
  verificationReadiness?: import('./verification-types.ts').HumanReviewReport['readiness']
  lastCheckResultPath?: string
  lastReviewResultPath?: string
  lastDiffPath?: string
  devServer?: DevServerLaunchSpec
  lastBrowserSmokeResultPath?: string
  /** Immutable Git commit used to calculate the current task's application delta. */
  taskBaselineSha?: string
  /** Descendant HEAD explicitly accepted by a human for the current task. */
  approvedTaskHeadSha?: string
  /** Hash of the baseline-to-worktree diff accepted by semantic review. */
  reviewedTaskDiffHash?: string
  /** Re-enter task execution at checks after repository drift is approved. */
  taskRevalidationRequired?: boolean
  /** Most recently created local checkpoint. */
  checkpoint?: {
    kind: 'plan' | 'task'
    ordinal: number
    sha: string
    tag: string
  }
  failureReason?: string
}

export interface EpicRunMetadata {
  epicId: string
  createdAt: string
  updatedAt: string
}

export interface EpicRunIdentity {
  epicId: string
  repositoryRoot: string
}
export interface RepairAttempts {
  fast: number
  full: number
  semantic: number
}
export interface TaskFailureDiagnostics {
  reason: string
  repairs: RepairAttempts
}

export type RecoveryOperation =
  | 'classify'
  | 'scout'
  | 'plan'
  | 'review-plan'
  | 'approve-plan'
  | 'decompose'
  | 'check-prerequisites'
  | 'prepare-prerequisites'
  | 'task-execution'
  | 'checkpoint-task'
  | 'final-verification'

export type RecoveryAction =
  | 'retry'
  | 'adopt-head'
  | 'adopt-and-revalidate'

export interface RecoveryDiagnostics {
  operation: RecoveryOperation
  reason: string
  action: RecoveryAction
  baselineSha?: string
  candidateHeadSha?: string
  changedPaths: ApplicationChange[]
  requiresRevalidation: boolean
}

export interface ApplicationChange {
  path: string
  kind: 'create' | 'modify' | 'delete'
}

export interface EpicClock {
  now(): string
  nowMs(): number
}

export interface EpicTimer {
  setTimeout(
    callback: () => void,
    timeoutMs: number
  ): ReturnType<typeof setTimeout>
  clearTimeout(timer: ReturnType<typeof setTimeout>): void
}

export interface PersistedEpicEnvelope extends EpicRunMetadata {
  schemaVersion: 13
  machineVersion: 14
  snapshot: unknown
}

export type EpicWait = 'active' | 'awaiting-human' | 'terminal'
export interface TaskDisplayState {
  state: string
  repairs?: { fast: number; full: number; semantic: number }
  failureReason?: string
}
export interface EpicBoundaryView {
  stage: EpicStage
  wait: EpicWait
  pendingHumanAction?: PendingHumanAction
  task?: TaskDisplayState
  failureDiagnostics?: TaskFailureDiagnostics
  recoveryDiagnostics?: RecoveryDiagnostics
}

export interface EpicTask {
  id: string
  title: string
  objective: string
  files: {
    context: string[]
    expectedChanges: string[]
  }
  implementation: string[]
  acceptanceCriteria: string[]
  /** Suggested verification commands; the implementer chooses the server launch. */
  verification: string[]
  manualReviewSteps: string[]
  risks: string[]
  requiredChecks: string[]
  deferredChecks: string[]
  reason: string
}

export interface DevServerLaunchSpec {
  command: string
  args: string[]
  url: string
  readySelector: string
}

export interface ImplementerResult {
  summary: string
  checks: string[]
  devServer?: DevServerLaunchSpec
}

export interface DevServerDiagnostics {
  command: string
  args: string[]
  url: string
  pid?: number
  stdoutPreview: string
  stderrPreview: string
  outputTruncated: boolean
}

export interface BrowserIdentity {
  executablePath: string
  version: string
}

export interface BrowserSmokeResult {
  passed: boolean
  url: string
  readySelector: string
  durationMs: number
  browser?: BrowserIdentity
  screenshotPath?: string
  findings: Finding[]
  server: DevServerDiagnostics
}

export interface Prerequisite {
  kind: 'git' | 'node_dependencies'
  command:
    'git init' | 'npm ci' | 'npm install' | 'pnpm install' | 'yarn install'
  reason: string
}

export interface PlanReviewInstruction {
  lineNumber: number
  text: string
  rawLine: string
}

export interface Finding {
  source: string
  category?: string
  severity: Severity
  rule?: string
  file?: string
  line?: number
  column?: number
  message: string
  raw?: string
  introduced?: boolean
}

export interface CheckDefinition {
  name: string
  command: string
  required: boolean
  timeoutMs?: number
  skipped?: boolean
  skipReason?: string
}

export interface CheckResult {
  name: string
  command: string
  passed: boolean
  required: boolean
  exitCode: number
  durationMs: number
  stdoutPreview: string
  stderrPreview: string
  findings: Finding[]
  outputTruncated: boolean
  skipped?: boolean
  skipReason?: string
}

export interface CheckSuiteResult {
  suite: CheckSuiteName
  passed: boolean
  checks: CheckResult[]
  introducedFindings: Finding[]
  preExistingFindings: Finding[]
  deferredChecks: string[]
}

export interface FallowDelta {
  introduced: Finding[]
  resolved: Finding[]
  preExisting: Finding[]
}

export interface AgentProfile {
  role: AgentRole
  provider?: string
  model?: string
  systemPromptPath: string
  tools: string[]
  readOnly: boolean
  maxInputTokens?: number
  maxOutputTokens?: number
  temperature?: number
  thinking?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  timeoutMs?: number
}

export interface ScoutReport {
  epicSummary: string
  relevantFiles: {
    path: string
    purpose: string
    symbols: string[]
    reason: string
  }[]
  codeExcerpts: {
    path: string
    startLine: number
    endLine: number
    reason: string
    content: string
  }[]
  callPaths: string[]
  dataFlow: string[]
  existingPatterns: string[]
  tests: { path: string; relevance: string }[]
  verificationCommands: string[]
  architectureConstraints: string[]
  risks: string[]
  uncertainties: { question: string; importance: string }[]
}

export interface PlannerContextRequest {
  status: 'needs_more_context'
  questions: { question: string; reason: string }[]
}

export interface FindingDisposition {
  id: string
  disposition: 'open' | 'resolved' | 'superseded' | 'not_assessed'
  reason: string
  evidence?: string
  canonicalId?: string
}

export interface ReviewResult {
  reconciliation: FindingDisposition[]
  passed: boolean
  summary: string
  acceptanceCriteria: {
    criterion: string
    status: 'met' | 'partially_met' | 'not_met' | 'manual_review_pending'
    evidence: string
  }[]
  findings: {
    id: string
    severity: 'blocker' | 'major' | 'minor' | 'suggestion'
    category: string
    file?: string
    lineStart?: number
    lineEnd?: number
    symbol?: string
    message: string
    failureScenario: string
    requiredFix: string
    affectedPaths: string[]
    repairPaths: string[]
  }[]
}

export interface EpicEvent {
  id: string
  epicId: string
  timestamp: string
  type: string
  stage: EpicStage
  payload: Record<string, unknown>
}

export interface EpicConfig {
  inspector?: {
    enabled?: boolean
    port?: number
    autoOpen?: boolean
  }
  maxScoutRounds?: number
  commandTimeoutMs?: number
  agentTimeoutMs?: number
  maxOutputBytes?: number
  maxRepairsPerItem?: number
  maxAcceptancePlanRepairs?: number
  maxTaskInfrastructureRetries?: number
  taskVerificationTimeoutMs?: number
  maxTaskPlanRepairs?: number
  checks?: {
    fast?: string[]
    full?: string[]
    final?: string[]
    focusedTests?: string
    fallow?: string
    fallowBaseline?: string
    browserSmoke?: {
      executablePath?: string
      startupTimeoutMs?: number
      navigationTimeoutMs?: number
      selectorTimeoutMs?: number
      settleTimeoutMs?: number
    }
  }
  agents?: Partial<Record<AgentRole, Partial<AgentProfile>>>
}
export interface ResolvedEpicConfiguration {
  inspector: { enabled: boolean; port: number; autoOpen: boolean }
  agentTimeoutMs: number
  commandTimeoutMs: number
  maxOutputBytes: number
  maxScoutRounds: number
  maxRepairsPerItem: number
  maxAcceptancePlanRepairs: number
  maxTaskInfrastructureRetries: number
  taskVerificationTimeoutMs: number
  maxTaskPlanRepairs: number
  checks: Omit<NonNullable<EpicConfig['checks']>, 'browserSmoke'> & {
    browserSmoke: {
      executablePath?: string
      startupTimeoutMs: number
      navigationTimeoutMs: number
      selectorTimeoutMs: number
      settleTimeoutMs: number
    }
  }
  agents: Partial<Record<AgentRole, Partial<AgentProfile>>>
}
