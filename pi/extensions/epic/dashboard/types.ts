import type { EpicEvent, EpicState } from '../types.ts'

export interface ActiveAgentRun {
  readonly startedAtMs: number
  readonly taskId?: string
  readonly role?: string
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

export interface DashboardAction {
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
  readonly state: EpicState
  readonly events: readonly EpicEvent[]
  readonly activeAgentRuns?: readonly ActiveAgentRun[]
  readonly activeOperation?: boolean
  readonly completedAt?: string
  readonly now?: string
}

export interface DashboardProjection {
  readonly epic: EpicDashboardState
  readonly actionRequired?: DashboardActionRequest
  readonly currentTask?: CurrentTaskDashboardState
}
