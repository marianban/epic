import { projectDashboardState } from './projection.ts'
import type {
  DashboardActionRequest,
  DashboardProjectionInput,
  EpicDashboardState,
} from './types.ts'

export class DashboardState {
  readonly epic: EpicDashboardState
  readonly actionRequired?: DashboardActionRequest
  readonly updatedAt: string

  private constructor(
    epic: EpicDashboardState,
    actionRequest: DashboardActionRequest | undefined,
    updatedAt: string
  ) {
    this.epic = epic
    this.actionRequired = actionRequest
    this.updatedAt = updatedAt
  }

  static fromRun(input: DashboardProjectionInput): DashboardState {
    const projection = projectDashboardState(input)
    return new DashboardState(
      projection.epic,
      projection.actionRequired,
      input.state.updatedAt
    )
  }
}
