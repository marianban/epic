import {
  loadEpicEvents,
  loadLatestCheckResult,
  loadOptionalActiveEpic,
} from '../persistence.ts'
import { DashboardState } from './state.ts'

const TERMINAL_STAGES = new Set(['completed', 'failed', 'cancelled'])

export async function loadActiveDashboardState(
  repositoryRoot: string,
  now: string
): Promise<DashboardState | undefined> {
  const state = await loadOptionalActiveEpic(repositoryRoot)
  if (state === undefined) return undefined

  const latestCheck = await loadLatestCheckResult(state)
  return DashboardState.fromRun({
    state,
    events: await loadEpicEvents(state),
    checkResults: latestCheck === undefined ? [] : [latestCheck],
    humanWaitMs: 0,
    ...(TERMINAL_STAGES.has(state.stage)
      ? { completedAt: state.updatedAt }
      : {}),
    now,
  })
}
