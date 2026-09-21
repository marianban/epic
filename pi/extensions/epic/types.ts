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
  | 'reviewing'
  | 'repairing_review'
  | 'escalating'
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
  | 'reviewer'
export type PendingHumanAction =
  | 'approve_plan'
  | 'approve_prerequisites'
  | 'review_task'
  | 'approve_task'
  | 'resolve_escalation'
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
  maxFastRepairs: number
  maxFullRepairs: number
  maxSemanticRepairs: number
  lastCheckResultPath?: string
  lastReviewResultPath?: string
  lastDiffPath?: string
  /** Immutable Git commit used to calculate the current task's application delta. */
  taskBaselineSha?: string
  /** Most recently created local checkpoint. */
  checkpoint?: { kind: 'plan' | 'task'; ordinal: number; sha: string; tag: string }
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
export interface RepairAttempts { fast: number; full: number; semantic: number }
export interface TaskFailureDiagnostics { reason: string; repairs: RepairAttempts }

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
  schemaVersion: 5
  machineVersion: 8
  snapshot: unknown
}

export type EpicWait = 'active' | 'awaiting-human' | 'terminal'
export interface TaskDisplayState {
  state: string
  repairs?: { fast: number; full: number; semantic: number }
}
export interface EpicBoundaryView {
  stage: EpicStage
  wait: EpicWait
  pendingHumanAction?: PendingHumanAction
  task?: TaskDisplayState
  failureDiagnostics?: TaskFailureDiagnostics
}

export interface EpicTask {
  id: string
  title: string
  objective: string
  scope: {
    read: string[]
    modify: string[]
    create: string[]
    delete: string[]
  }
  implementation: string[]
  acceptanceCriteria: string[]
  verification: string[]
  manualReviewSteps: string[]
  risks: string[]
  requiredChecks: string[]
  deferredChecks: string[]
  reason: string
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

export interface ReviewResult {
  passed: boolean
  summary: string
  acceptanceCriteria: {
    criterion: string
    status: 'met' | 'partially_met' | 'not_met' | 'manual_review_pending'
    evidence: string
  }[]
  findings: {
    severity: 'blocker' | 'major' | 'minor' | 'suggestion'
    category: string
    file?: string
    lineStart?: number
    lineEnd?: number
    symbol?: string
    message: string
    failureScenario: string
    requiredFix: string
    repairPaths: string[]
  }[]
  requiresPlanRevision: boolean
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
  maxFastRepairs?: number
  maxFullRepairs?: number
  maxSemanticRepairs?: number
  checks?: {
    fast?: string[]
    full?: string[]
    final?: string[]
    focusedTests?: string
    fallow?: string
    fallowBaseline?: string
  }
  agents?: Partial<Record<AgentRole, Partial<AgentProfile>>>
}
export interface ResolvedEpicConfiguration {
  inspector: { enabled: boolean; port: number; autoOpen: boolean }
  agentTimeoutMs: number
  commandTimeoutMs: number
  maxOutputBytes: number
  maxScoutRounds: number
  maxFastRepairs: number
  maxFullRepairs: number
  maxSemanticRepairs: number
  checks: NonNullable<EpicConfig['checks']>
  agents: Partial<Record<AgentRole, Partial<AgentProfile>>>
}
