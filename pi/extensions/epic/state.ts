import { randomUUID } from 'node:crypto'
import type { EpicState } from './types.ts'
import {
  EPIC_MACHINE_VERSION,
  EPIC_SCHEMA_VERSION,
} from './machines/epic-machine.ts'

export function createEpicState(
  repositoryRoot: string,
  epic: string,
  now = new Date().toISOString()
): EpicState {
  const epicId = `${now.replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`
  return {
    epicId,
    schemaVersion: EPIC_SCHEMA_VERSION,
    machineVersion: EPIC_MACHINE_VERSION,
    epic,
    repositoryRoot,
    stage: 'idle',
    createdAt: now,
    updatedAt: now,
    epicComplexity: 'moderate',
    scoutRound: 0,
    maxScoutRounds: 3,
    planPath: `${repositoryRoot}/plan.md`,
    planRevision: 0,
    planApproved: false,
    currentTaskIndex: 0,
    taskApproved: false,
    pendingHumanAction: 'none',
    implementationAttempt: 0,
    fastRepairAttempt: 0,
    fullRepairAttempt: 0,
    semanticRepairAttempt: 0,
    maxFastRepairs: 2,
    maxFullRepairs: 1,
    maxSemanticRepairs: 2,
  }
}
