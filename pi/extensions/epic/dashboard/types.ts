import type { EpicEvent, EpicState } from '../types.ts'

export interface ActiveAgentRun {
  readonly startedAtMs: number
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
  readonly attempts: {
    readonly implementation: number
    readonly repair: number
  }
}

export interface DashboardProjectionInput {
  readonly state: EpicState
  readonly events: readonly EpicEvent[]
  readonly activeAgentRuns?: readonly ActiveAgentRun[]
  readonly completedAt?: string
  readonly now?: string
}

export interface DashboardProjection {
  readonly epic: EpicDashboardState
  readonly actionRequired?: DashboardActionRequest
}
