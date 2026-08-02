import assert from 'node:assert/strict'
import test from 'node:test'
import { projectDashboardState } from '../pi/extensions/epic/dashboard/projection.ts'
import type {
  EpicBoundaryView,
  EpicDomainState,
  EpicRunMetadata,
} from '../pi/extensions/epic/types.ts'

const metadata: EpicRunMetadata = {
  epicId: 'run',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T01:00:00.000Z',
}
function domain(): EpicDomainState {
  return {
    epicId: 'run',
    epic: 'Ship it',
    repositoryRoot: '/repo',
    epicComplexity: 'simple',
    scoutRound: 0,
    maxScoutRounds: 3,
    planPath: '/repo/plan.md',
    planRevision: 1,
    planApproved: true,
    currentTaskIndex: 0,
    taskApproved: false,
    implementationAttempt: 0,
    maxFastRepairs: 1,
    maxFullRepairs: 1,
    maxSemanticRepairs: 1,
  }
}
function boundary(stage: EpicBoundaryView['stage']): EpicBoundaryView {
  return {
    stage,
    wait:
      stage === 'completed' || stage === 'failed'
        ? 'terminal'
        : stage.startsWith('awaiting')
          ? 'awaiting-human'
          : 'active',
    ...(stage === 'awaiting_task_approval'
      ? { pendingHumanAction: 'approve_task' as const }
      : {}),
  }
}
test('dashboard projects waiting, active, and terminal boundary read models', () => {
  const waiting = projectDashboardState({
    domain: domain(),
    metadata,
    boundary: boundary('awaiting_task_approval'),
    events: [],
    now: '2026-01-01T02:00:00.000Z',
  })
  assert.equal(waiting.epic.status, 'review')
  assert.equal(waiting.actionRequired?.id, 'task-action-required')
  const active = projectDashboardState({
    domain: domain(),
    metadata,
    boundary: boundary('implementing'),
    events: [],
    now: '2026-01-01T02:00:00.000Z',
  })
  assert.equal(active.epic.status, 'in-progress')
  const terminal = projectDashboardState({
    domain: domain(),
    metadata,
    boundary: boundary('completed'),
    events: [],
    completedAt: '2026-01-01T01:00:00.000Z',
    now: '2026-01-01T02:00:00.000Z',
  })
  assert.equal(terminal.epic.completedAt, '2026-01-01T01:00:00.000Z')
})
