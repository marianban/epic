import { randomUUID } from 'node:crypto'
import type { WorkflowState } from './types.ts'
import {
  WORKFLOW_MACHINE_VERSION,
  WORKFLOW_SCHEMA_VERSION,
} from './machines/workflow-machine.ts'

export function createWorkflowState(
  repositoryRoot: string,
  task: string,
  now = new Date().toISOString()
): WorkflowState {
  const workflowId = `${now.replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`
  return {
    workflowId,
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    machineVersion: WORKFLOW_MACHINE_VERSION,
    task,
    repositoryRoot,
    stage: 'idle',
    createdAt: now,
    updatedAt: now,
    taskComplexity: 'moderate',
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
