import type { ManualReview, ManualReviewStatus, TaskVerificationRecord } from '../verification-types.ts'
import type {
  AgentProfile,
  EpicBoundaryView,
  EpicDomainState,
  EpicEvent,
  EpicRunMetadata,
} from '../types.ts'

export interface ActiveAgentRun {
  readonly invocationId: string
  readonly startedAtMs: number
  readonly role: string
  readonly action: string
  readonly taskId?: string
  readonly provider?: string
  readonly model?: string
  readonly thinking?: NonNullable<AgentProfile['thinking']>
}

export type EpicDashboardStatus =
  | 'review'
  | 'refinement'
  | 'decomposing'
  | 'decomposed'
  | 'in-progress'
  | 'completed'
  | 'failed'
  | 'escalating'

export interface ProgressMetric {
  readonly completed: number
  readonly total: number
  readonly percent: number
}

export interface TokenUsage {
  readonly total: number
  readonly input?: number
  readonly output?: number
  readonly cached?: number
  readonly reasoning?: number
}

export type PipelineAgentStatus =
  | 'idle'
  | 'running'
  | 'failed'

export interface PipelineAgentDashboardState {
  readonly role: string
  readonly provider?: string
  readonly model?: string
  readonly thinking?: AgentProfile['thinking']
  readonly status: PipelineAgentStatus
  readonly runCount: number
  readonly agentTimeMs: number
  readonly tokens?: TokenUsage
}

export interface PipelineModelDashboardState {
  readonly id: string
  readonly provider?: string
  readonly model?: string
  readonly thinkingLevels: readonly NonNullable<AgentProfile['thinking']>[]
  readonly roles: readonly string[]
  readonly status: PipelineAgentStatus
  readonly runCount: number
  readonly agentTimeMs: number
  readonly tokens?: TokenUsage
}

export interface PipelineDashboardState {
  readonly agents: readonly PipelineAgentDashboardState[]
  readonly models: readonly PipelineModelDashboardState[]
}

export type TaskDashboardStatus =
  | 'initial-review'
  | 'refinement'
  | 'pending'
  | 'in-progress'
  | 'completed'
  | 'failed'

export interface TaskDiffDashboardState {
  readonly filesChanged: number
  readonly linesAdded: number
  readonly linesDeleted: number
  readonly hasWarning?: boolean
}

export interface CurrentTaskDashboardState {
  readonly id: string
  readonly index: number
  readonly totalTasks: number
  readonly name: string
  readonly status: TaskDashboardStatus
  /** Cumulative execution time of all agent runs associated with this task. */
  readonly agentTimeMs: number
  readonly attempt: {
    readonly current: number
    readonly max?: number
  }
  readonly criteria: ProgressMetric
  readonly agent?: string
  readonly diff?: TaskDiffDashboardState
}

export type FailureReviewStatus = 'not_checked' | 'passed' | 'failed' | 'ignored'

export interface FailureReviewItem {
  readonly id: string
  readonly text: string
  readonly status: FailureReviewStatus
  readonly observation: string
}

export interface DashboardAction {
  readonly disabled?: boolean
  readonly manualReview?: ManualReview
  readonly itemId?: string
  readonly failureStatus?: FailureReviewStatus
  readonly status?: ManualReviewStatus
  readonly id: string
  readonly label: string
  readonly command?: string
  readonly kind?: 'primary' | 'secondary' | 'danger'
}

export interface DashboardActionRequest {
  readonly id: string
  readonly severity: 'info' | 'warning' | 'critical'
  readonly title: string
  readonly message?: string
  readonly manualReview?: ManualReview
  readonly failureReviewItems?: readonly FailureReviewItem[]
  readonly manualReviewSteps?: readonly string[]
  readonly verificationReportLink?: string
  readonly verificationStatus?: string
  readonly actions: readonly DashboardAction[]
}

export interface EpicDashboardState {
  readonly id: string
  readonly runDirectory: string
  readonly name: string
  readonly status: EpicDashboardStatus
  readonly startedAt?: string
  readonly completedAt?: string
  readonly agentTimeMs: number
  readonly tasks: ProgressMetric
  readonly criteria: ProgressMetric
  readonly tokens: TokenUsage
}

export interface DashboardProjectionInput {
  readonly verificationRecord?: TaskVerificationRecord
  readonly domain: EpicDomainState
  readonly metadata: EpicRunMetadata
  readonly boundary: EpicBoundaryView
  readonly events: readonly EpicEvent[]
  readonly agentProfiles: readonly AgentProfile[]
  readonly activeAgentRuns?: readonly ActiveAgentRun[]
  readonly activeOperation?: boolean
  readonly completedAt?: string
  readonly now?: string
}

export interface DashboardProjection {
  readonly epic: EpicDashboardState
  readonly pipeline: PipelineDashboardState
  readonly actionRequired?: DashboardActionRequest
  readonly currentTask?: CurrentTaskDashboardState
}
