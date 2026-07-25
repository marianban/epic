import { loadEpicEvents, loadOptionalActiveEpic } from '../persistence.ts'
import { activeAgentRuns } from '../agent-activity.ts'
import { DashboardState } from './state.ts'

const TERMINAL_STAGES = new Set(['completed', 'failed', 'cancelled'])

export async function loadActiveDashboardState(
  repositoryRoot: string,
  now: string
): Promise<DashboardState | undefined> {
  const state = await loadOptionalActiveEpic(repositoryRoot)
  if (state === undefined) return undefined

  return DashboardState.fromRun({
    state,
    events: await loadEpicEvents(state),
    activeAgentRuns: activeAgentRuns(repositoryRoot, state.epicId, Date.parse(now)),
    ...(TERMINAL_STAGES.has(state.stage)
      ? { completedAt: state.updatedAt }
      : {}),
    now,
  })
}
