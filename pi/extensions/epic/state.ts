import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import type { EpicDomainState, EpicRunMetadata, ResolvedEpicConfiguration } from './types.ts'

export function createEpicState(
  repositoryRoot: string,
  epic: string,
  now: string,
  configuration: Pick<ResolvedEpicConfiguration, 'maxScoutRounds' | 'maxTaskRepairs' | 'maxTaskInfrastructureRetries' | 'maxAcceptancePlanRepairs' | 'taskVerificationTimeoutMs'>
): { domain: EpicDomainState; metadata: EpicRunMetadata } {
  const epicId = `${now.replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`
  return {
    domain: {
      epicId,
      epic,
      repositoryRoot,
      epicComplexity: 'moderate',
      scoutRound: 0,
      maxScoutRounds: configuration.maxScoutRounds,
      planPath: path.join(
        repositoryRoot,
        '.pi',
        'epics',
        'runs',
        epicId,
        'plan.md'
      ),
      planRevision: 0,
      planApproved: false,
      currentTaskIndex: 0,
      taskApproved: false,
      implementationAttempt: 0,
      maxTaskRepairs: configuration.maxTaskRepairs,
      maxAcceptancePlanRepairs: configuration.maxAcceptancePlanRepairs,
      maxTaskInfrastructureRetries: configuration.maxTaskInfrastructureRetries,
      taskVerificationTimeoutMs: configuration.taskVerificationTimeoutMs,
    },
    metadata: { epicId, createdAt: now, updatedAt: now },
  }
}
