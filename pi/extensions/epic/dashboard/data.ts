import { loadEpicEvents, loadOptionalActiveEpic } from '../persistence.ts'
import { activeAgentRuns } from '../agent-activity.ts'
import { isEpicOperationActive } from '../operation-status.ts'
import { DashboardState } from './state.ts'
import { projectActorSystemSnapshot } from '../machines/actor-system-projection.ts'
import { domainFromActorSnapshot } from '../domain-validation.ts'
import { resolveEpicConfiguration } from '../configuration.ts'
import { resolveAgentProfiles } from '../agent-profiles.ts'

const TERMINAL_STAGES = new Set(['completed', 'failed'])

export async function loadActiveDashboardState(
  repositoryRoot: string,
  now: string
): Promise<DashboardState | undefined> {
  const envelope = await loadOptionalActiveEpic(repositoryRoot)
  if (envelope === undefined) return undefined
  const snapshot = envelope.snapshot as {
    value: unknown
    children?: Record<string, unknown>
  }
  const domain = domainFromActorSnapshot(snapshot)
  const boundary = projectActorSystemSnapshot(snapshot)
  const configuration = await resolveEpicConfiguration(repositoryRoot)

  return DashboardState.fromRun({
    domain,
    metadata: envelope,
    boundary,
    events: await loadEpicEvents(
      domain
    ),
    agentProfiles: resolveAgentProfiles(configuration),
    activeAgentRuns: activeAgentRuns(
      repositoryRoot,
      envelope.epicId,
      Date.parse(now)
    ),
    activeOperation: isEpicOperationActive(envelope.epicId),
    ...(TERMINAL_STAGES.has(boundary.stage)
      ? { completedAt: envelope.updatedAt }
      : {}),
    now,
  })
}
