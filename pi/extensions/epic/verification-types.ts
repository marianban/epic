import type {
  BrowserSmokeResult,
  CheckSuiteResult,
  EpicDomainState,
  ReviewResult,
} from './types.ts'
import type { BrowserProbe, RecordedBrowserConclusion } from './browser-evidence-types.ts'

export type VerificationMethod =
  'automated' | 'agent_browser' | 'static' | 'human_only'
export type EvidenceGap =
  'human_only' | 'blocked' | 'not_attempted' | 'inconclusive'
export type CriterionStatus =
  'met' | 'partially_met' | 'not_met' | 'manual_review_pending'
export type EvidenceOutcome = 'pass' | 'fail' | 'likely-fail' | 'inconclusive'
export interface SuspectedFailure {
  contradiction: string
  uncertainty: string
  confirmationCheck: string
}
export interface ApprovedCriterion {
  id: string
  text: string
}
export type BrowserStep =
  | { action: 'click' | 'press'; selector: string; value: string }
  | { action: 'text' | 'visible'; selector: string; value: string }
  | { action: 'pointer'; x: number; y: number }
  | { action: 'mouse_down' | 'mouse_up'; button: 'left' | 'middle' | 'right' }
  | { action: 'click_at'; x: number; y: number; button: 'left' | 'middle' | 'right' }
  | { action: 'hold'; keys: string[]; durationMs: number }
  | { action: 'resize'; width: number; height: number }
  | { action: 'playwright'; code: string }
  | { action: 'inspect' | 'observe' | 'fixture'; expression: string }
  | { action: 'key_down' | 'key_up'; key: string }
  | { action: 'wait'; durationMs: number }
  | { action: 'capture'; selector?: string; count: number; intervalMs: number }
export interface VerificationObligation {
  id: string
  criterionId: string
  expected: string
  method: VerificationMethod
  command?: string
  /** Optional starting suggestions for agent_browser; executable steps for automated. */
  steps?: BrowserStep[]
  reason?: string
}
export interface VerificationPlan {
  version: number
  criterionVersion: number
  criteria: ApprovedCriterion[]
  obligations: VerificationObligation[]
}
export interface AcceptanceEvidence {
  obligationId: string
  criterionId: string
  expected: string
  actual: string
  outcome: EvidenceOutcome
  suspectedFailure?: SuspectedFailure
  gap?: EvidenceGap
  method: VerificationMethod
  artifacts: string[]
  attachments?: string[]
  attempt: number
  /** Verification attempt identifier, independent of candidate file contents. */
  identity: string
  reproduction?: string
  conclusion?: RecordedBrowserConclusion
}
export interface VerificationWorkItem {
  id: string
  kind: 'criterion' | 'check' | 'smoke' | 'semantic'
  criterionId?: string
  feedback: string
  action: 'repair' | 'verify'
}
export interface VerificationSchedule {
  phase: 'initial_full' | 'targeted' | 'final_full' | 'done'
  queue: VerificationWorkItem[]
  deferred: VerificationWorkItem[]
  finalRequired: boolean
  processedCycleId?: string
  repairInvocationId?: string
}
export interface VerificationProblem {
  stage: 'fast' | 'full' | 'browser_setup' | 'browser_smoke' | 'browser_exploration' | 'obligation' | 'semantic_review' | 'evidence_review' | 'interruption'
  obligationIds: string[]
  message: string
}
export interface BrowserEvidenceReview {
  identity: string
  obligationIds: string[]
  result: ReviewResult
  limitations: string[]
}
export interface VerificationCycle {
  kind: 'initial_full' | 'targeted' | 'final_full'
  target?: VerificationWorkItem
  repairInvocationId?: string
  completed: boolean
  candidateRevision: number
  id: string
  /** Verification attempt identifier, independent of candidate file contents. */
  identity: string
  attempt: number
  fast?: CheckSuiteResult
  full?: CheckSuiteResult
  smoke?: BrowserSmokeResult
  review?: ReviewResult
  evidenceReviews: BrowserEvidenceReview[]
  browserOpened?: true
  evidence: AcceptanceEvidence[]
  problems: VerificationProblem[]
  artifacts: string[]
  state: EpicDomainState
  plan?: VerificationPlan
  invalidated?: string
  probes?: BrowserProbe[]
}
export interface AllowanceGrant {
  repairs: number
  timeMs: number
  reason: string
  at: number
  afterInvocationId?: string
}
export interface AllowanceInvocation {
  id: string
  kind: 'repair' | 'infrastructure'
  reason: string
  at: number
  completed: boolean
}
export type FailureDisposition = 'request_fix' | 'false_positive' | 'accepted_noncritical'
export interface HumanDecision {
  /** Legacy accept_unresolved/confirm/defer decisions remain audit data only. */
  kind: 'approve' | 'accept_unresolved' | 'confirm' | 'defer' | FailureDisposition
  /** Verification attempt identifier, independent of candidate file contents. */
  identity: string
  reportId: string
  obligations: string[]
  reason: string
  at: number
}
export type ManualReviewStatus = 'not_checked' | 'passed' | 'failed'
export interface ManualReviewItem {
  id: string
  text: string
  status: ManualReviewStatus
  observation: string
  updatedAt: number
}
export interface ManualReview {
  taskId: string
  identity: string
  reportId: string
  items: ManualReviewItem[]
  createdAt: number
}
export interface HumanRepairRequest {
  identity: string
  reportId: string
  feedback: string
  at: number
  invocationId?: string
  completed: boolean
}
export interface TaskVerificationRecord {
  formatVersion: 2
  schedule: VerificationSchedule
  manualReviews: ManualReview[]
  humanRepairRequests: HumanRepairRequest[]
  taskId: string
  criteria: ApprovedCriterion[]
  criterionVersion: number
  plan?: VerificationPlan
  plans: { plan: VerificationPlan; artifact: string }[]
  repairsLimit: number
  infrastructureLimit: number
  timeAllowanceMs: number
  startedAt?: number
  deadline?: number
  pausedAt?: number
  invocations: AllowanceInvocation[]
  grants: AllowanceGrant[]
  cycles: VerificationCycle[]
  report?: HumanReviewReport
  decisions: HumanDecision[]
  state?: EpicDomainState
}
export interface HumanReviewReport {
  id: string
  taskId: string
  /** Verification attempt identifier, independent of candidate file contents. */
  identity: string
  criterionVersion: number
  scenarioVersion?: number
  readiness: 'verified' | 'issues_remaining' | 'needs_manual_confirmation'
  criteria: {
    id: string
    text: string
    status: CriterionStatus
    evidence: AcceptanceEvidence[]
  }[]
  unresolved: string[]
  problems: string[]
  cycle?: VerificationCycle
  history: VerificationCycle[]
  usage: {
    repairs: number
    infrastructure: number
    repairsLimit: number
    infrastructureLimit: number
    remainingMs: number
    consumedMs: number
  }
  grants: AllowanceGrant[]
  artifacts: string[]
  invocations: AllowanceInvocation[]
}
export interface VerificationOperation {
  signal: AbortSignal
  remainingMs(): number
  bridge?: { url: string; token: string; invocationId: string }
}
export type TaskDecisionRequest =
  | { kind: 'approve' }
  | {
      kind: 'review_failure'
      identity: string
      reportId: string
      failureId: string
      disposition: FailureDisposition
      reason: string
    }
  | {
      kind: 'update_manual_review'
      identity: string
      reportId: string
      itemId: string
      status: ManualReviewStatus
      observation: string
      reason: string
    }
  | {
      kind: 'grant'
      identity: string
      reportId: string
      repairs: number
      timeMs: number
      reason: string
    }
  | {
      kind: 'revise_criteria'
      identity: string
      reportId: string
      criteria: string[]
      reason: string
    }
