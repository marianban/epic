import type {
  BrowserSmokeResult,
  CheckSuiteResult,
  EpicDomainState,
  ReviewResult,
} from './types.ts'

export type VerificationMethod =
  'automated' | 'agent_browser' | 'static' | 'human_only'
export type EvidenceGap =
  'human_only' | 'blocked' | 'not_attempted' | 'inconclusive'
export type CriterionStatus =
  'met' | 'partially_met' | 'not_met' | 'manual_review_pending'
export interface ApprovedCriterion {
  id: string
  text: string
}
export type BrowserStep =
  | { action: 'click' | 'press'; selector: string; value: string }
  | { action: 'text' | 'visible'; selector: string; value: string }
  | { action: 'pointer'; x: number; y: number }
  | { action: 'inspect' | 'fixture'; expression: string }
export interface VerificationObligation {
  id: string
  criterionId: string
  expected: string
  method: VerificationMethod
  command?: string
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
  outcome: 'pass' | 'fail' | 'unverified'
  gap?: EvidenceGap
  method: VerificationMethod
  artifacts: string[]
  attachments?: string[]
  attempt: number
  /** Verification attempt identifier, independent of candidate file contents. */
  identity: string
  reproduction?: string
}
export interface VerificationCycle {
  id: string
  /** Verification attempt identifier, independent of candidate file contents. */
  identity: string
  attempt: number
  fast?: CheckSuiteResult
  full?: CheckSuiteResult
  smoke?: BrowserSmokeResult
  review?: ReviewResult
  evidence: AcceptanceEvidence[]
  problems: string[]
  artifacts: string[]
  state: EpicDomainState
  plan?: VerificationPlan
  invalidated?: string
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
export interface HumanDecision {
  kind: 'approve' | 'accept_unresolved' | 'confirm' | 'defer'
  /** Verification attempt identifier, independent of candidate file contents. */
  identity: string
  reportId: string
  obligations: string[]
  reason: string
  at: number
}
export interface TaskVerificationRecord {
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
  bridge?: { url: string; token: string }
}
export type TaskDecisionRequest =
  | { kind: 'approve' }
  | {
      kind: 'accept_unresolved' | 'confirm'
      identity: string
      reportId: string
      obligations: string[]
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
  | { kind: 'defer'; identity: string; reportId: string; reason: string }
  | {
      kind: 'revise_criteria'
      identity: string
      reportId: string
      criteria: string[]
      reason: string
    }
