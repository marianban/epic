import { projectDashboardState } from './projection.ts'
import type {
  DashboardActionRequest,
  DashboardProjectionInput,
  EpicDashboardState,
  CurrentTaskDashboardState,
} from './types.ts'

export class DashboardState {
  readonly epic: EpicDashboardState
  readonly actionRequired?: DashboardActionRequest
  readonly currentTask?: CurrentTaskDashboardState
  readonly updatedAt: string

  private constructor(
    epic: EpicDashboardState,
    actionRequest: DashboardActionRequest | undefined,
    currentTask: CurrentTaskDashboardState | undefined,
    updatedAt: string
  ) {
    this.epic = epic
    this.actionRequired = actionRequest
    this.currentTask = currentTask
    this.updatedAt = updatedAt
  }

  static fromRun(input: DashboardProjectionInput): DashboardState {
    const projection = projectDashboardState(input)
    return new DashboardState(
      projection.epic,
      projection.actionRequired,
      projection.currentTask,
      input.state.updatedAt
    )
  }
}
