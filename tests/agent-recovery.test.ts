import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { appendEvent, loadEpicEvents } from '../pi/extensions/epic/persistence.ts'
import {
  INTERRUPTED_AGENT_FAILURE_REASON,
  recoverInterruptedAgentRuns,
} from '../pi/extensions/epic/agent-recovery.ts'
import { projectDashboardState } from '../pi/extensions/epic/dashboard/projection.ts'
import { projectPipelineState } from '../pi/extensions/epic/dashboard/pipeline-projection.ts'
import type { ActiveAgentRun } from '../pi/extensions/epic/agent-activity.ts'
import type {
  AgentProfile,
  EpicDomainState,
  EpicRunIdentity,
} from '../pi/extensions/epic/types.ts'

function profile(): AgentProfile {
  return {
    role: 'task-planner',
    provider: 'openai-codex',
    model: 'gpt-5.6-luna',
    thinking: 'high',
    systemPromptPath: '.pi/agents/task-planner.md',
    tools: [],
    readOnly: true,
  }
}

function domain(repositoryRoot: string): EpicDomainState {
  return {
    epicId: 'run-1',
    epic: 'Recovery test',
    repositoryRoot,
    epicComplexity: 'simple',
    scoutRound: 0,
    maxScoutRounds: 3,
    planPath: path.join(
      repositoryRoot,
      '.pi',
      'epics',
      'runs',
      'run-1',
      'plan.md'
    ),
    planRevision: 1,
    planApproved: false,
    currentTaskIndex: 0,
    taskApproved: false,
    implementationAttempt: 0,
    maxFastRepairs: 1,
    maxFullRepairs: 1,
    maxSemanticRepairs: 1,
  }
}

async function fixture(): Promise<EpicRunIdentity> {
  const repositoryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'epic-agent-recovery-')
  )
  await fs.mkdir(
    path.join(repositoryRoot, '.pi', 'epics', 'runs', 'run-1'),
    { recursive: true }
  )
  return { repositoryRoot, epicId: 'run-1' }
}

async function removeFixture(state: EpicRunIdentity): Promise<void> {
  await fs.rm(state.repositoryRoot, { recursive: true, force: true })
}

test('resume recovery persists a terminal finish and freezes dashboard time', async () => {
  const state = await fixture()
  try {
    const startedAt = '2026-08-16T14:08:51.088Z'
    const recoveredAt = '2026-08-16T14:18:51.088Z'
    await appendEvent(state, 'decomposing_tasks', startedAt, 'agent_started', {
      invocationId: 'planner-1',
      role: 'task-planner',
      action: 'task decomposition',
      provider: 'openai-codex',
      model: 'gpt-5.6-luna',
      thinking: 'high',
    })

    assert.equal(
      await recoverInterruptedAgentRuns(
        state,
        recoveredAt,
        Date.parse(recoveredAt),
        []
      ),
      1
    )

    const events = await loadEpicEvents(state)
    const finish = events[1]
    assert.equal(finish?.type, 'agent_finished')
    assert.equal(finish?.payload.exitCode, 1)
    assert.equal(finish?.payload.failureReason, INTERRUPTED_AGENT_FAILURE_REASON)
    assert.equal(finish?.payload.durationMs, 600_000)

    const later = Date.parse('2026-08-16T15:18:51.088Z')
    const pipeline = projectPipelineState(
      events,
      [],
      [profile()],
      later
    )
    assert.equal(pipeline.agents[0]?.status, 'failed')
    assert.equal(pipeline.agents[0]?.agentTimeMs, 600_000)

    const dashboard = projectDashboardState({
      domain: domain(state.repositoryRoot),
      metadata: {
        epicId: state.epicId,
        createdAt: startedAt,
        updatedAt: recoveredAt,
      },
      boundary: {
        stage: 'awaiting_plan_review',
        wait: 'awaiting-human',
        pendingHumanAction: 'approve_plan',
      },
      events,
      agentProfiles: [profile()],
      now: new Date(later).toISOString(),
    })
    assert.equal(dashboard.epic.agentTimeMs, 600_000)
  } finally {
    await removeFixture(state)
  }
})

test('resume recovery leaves a live invocation untouched', async () => {
  const state = await fixture()
  try {
    const startedAt = '2026-08-16T14:08:51.088Z'
    await appendEvent(state, 'decomposing_tasks', startedAt, 'agent_started', {
      invocationId: 'planner-1',
      role: 'task-planner',
      action: 'task decomposition',
    })
    const liveRun: ActiveAgentRun = {
      repositoryRoot: state.repositoryRoot,
      epicId: state.epicId,
      invocationId: 'planner-1',
      startedAtMs: Date.parse(startedAt),
      role: 'task-planner',
      action: 'task decomposition',
    }

    assert.equal(
      await recoverInterruptedAgentRuns(
        state,
        '2026-08-16T14:18:51.088Z',
        Date.parse('2026-08-16T14:18:51.088Z'),
        [liveRun]
      ),
      0
    )
    assert.equal((await loadEpicEvents(state)).length, 1)
  } finally {
    await removeFixture(state)
  }
})
