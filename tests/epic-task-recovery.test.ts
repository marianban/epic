import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { createActor } from 'xstate'
import { hashPlan } from '../pi/extensions/epic/plan-review.ts'
import {
  appendEvent,
  loadEpicEvents,
} from '../pi/extensions/epic/persistence.ts'
import { bootstrapEpicGitignore } from '../pi/extensions/epic/git-checkpoints.ts'
import { currentTaskArtifactPath } from '../pi/extensions/epic/artifact-paths.ts'
import {
  createEpicServices,
  type EpicServiceDependencies,
} from '../pi/extensions/epic/services.ts'
import { createTaskExecutionMachine } from '../pi/extensions/epic/machines/task-execution-machine.ts'
import type { AgentRunResult } from '../pi/extensions/epic/agents.ts'
import type {
  EpicDomainState,
  EpicTask,
  ResolvedEpicConfiguration,
} from '../pi/extensions/epic/types.ts'

const exec = promisify(execFile)

async function git(root: string, args: string[]): Promise<void> {
  await exec('git', args, { cwd: root })
}

async function gitOutput(root: string, args: string[]): Promise<string> {
  return String((await exec('git', args, { cwd: root })).stdout).trim()
}

function task(): EpicTask {
  return {
    id: 'T1',
    title: 'Create package metadata',
    objective: 'Create package metadata.',
    files: {
      context: [],
      expectedChanges: ['package.json'],
    },
    implementation: [],
    acceptanceCriteria: [],
    verification: [],
    manualReviewSteps: [],
    risks: [],
    requiredChecks: [],
    deferredChecks: [],
    reason: '',
  }
}

function configuration(): ResolvedEpicConfiguration {
  return {
    inspector: { enabled: false, port: 8080, autoOpen: false },
    agentTimeoutMs: 10_000,
    commandTimeoutMs: 10_000,
    maxOutputBytes: 20_000,
    maxScoutRounds: 3,
    maxTaskRepairs: 1,
    maxAcceptancePlanRepairs: 2,
    maxTaskInfrastructureRetries: 1,
    taskVerificationTimeoutMs: 30_000,
    maxTaskPlanRepairs: 2,
    checks: {
      fast: ['true'],
      full: ['true'],
      final: ['true'],
      browserSmoke: {
        startupTimeoutMs: 30_000,
        navigationTimeoutMs: 15_000,
        selectorTimeoutMs: 10_000,
        settleTimeoutMs: 500,
      },
    },
    agents: {},
  }
}

async function fixture(): Promise<{
  root: string
  state: EpicDomainState
  checkpointSha: string
  checkpointTag: string
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'epic-recovery-'))
  await git(root, ['init'])
  await git(root, ['config', 'user.name', 'Epic Test'])
  await git(root, ['config', 'user.email', 'epic-test@example.com'])
  await bootstrapEpicGitignore(root)
  const plan = '# Approved plan\n'
  const runDirectory = path.join(root, '.pi', 'epics', 'runs', 'run-1')
  await fs.mkdir(runDirectory, { recursive: true })
  await fs.writeFile(path.join(runDirectory, 'plan.md'), plan)
  await git(root, ['add', runDirectory, '.gitignore'])
  await git(root, ['commit', '-m', 'plan checkpoint'])
  const checkpointSha = await gitOutput(root, ['rev-parse', 'HEAD'])
  const checkpointTag = 'pi-epic/run-1/plan/checkpoint'
  await git(root, ['tag', checkpointTag])
  await fs.mkdir(path.join(root, '.pi', 'epics', 'runs', 'run-1', 'tasks'), {
    recursive: true,
  })
  const epicTask = task()
  const state: EpicDomainState = {
    epicId: 'run-1',
    epic: 'Recovery test',
    repositoryRoot: root,
    epicComplexity: 'simple',
    scoutRound: 0,
    maxScoutRounds: 3,
    planPath: path.join(runDirectory, 'plan.md'),
    planRevision: 1,
    planApproved: true,
    approvedPlanHash: hashPlan(plan),
    tasks: [epicTask],
    currentTaskIndex: 0,
    taskApproved: true,
    implementationAttempt: 0,
    maxTaskRepairs: 1,
    maxAcceptancePlanRepairs: 2,
    maxTaskInfrastructureRetries: 1,
    taskVerificationTimeoutMs: 30_000,
    checkpoint: {
      kind: 'plan',
      ordinal: 0,
      sha: checkpointSha.slice(0, 10),
      tag: checkpointTag,
    },
  }
  await fs.writeFile(currentTaskArtifactPath(state), '# Task 1\n')
  return { root, state, checkpointSha, checkpointTag }
}

function context(): never {
  return {
    signal: undefined,
    ui: {
      notify: () => undefined,
      setStatus: () => undefined,
    },
  } as never
}

function dependencies(calls: string[]): EpicServiceDependencies {
  const runAgentActor: EpicServiceDependencies['runAgentActor'] = async (
    input
  ) => {
    calls.push(input.role)
    const result: AgentRunResult = {
      role: input.role,
      exitCode: 0,
      output:
        input.role === 'verification-planner'
          ? JSON.stringify({ version: 1, criterionVersion: 1, criteria: [], obligations: [] })
          : input.role === 'reviewer'
          ? JSON.stringify({
              passed: true,
              summary: 'Recovered implementation is valid.',
              acceptanceCriteria: [],
              reconciliation: [],
              findings: [],
            })
          : JSON.stringify({
              summary: 'Implemented the task.',
              checks: [],
            }),
      stderr: '',
      stdoutLogPath: path.join(input.agentRunDirectory, 'fake.log'),
    }
    return result
  }
  return { runAgentActor, timer: { setTimeout, clearTimeout } }
}

test('task decomposition invokes task-planner with the approved plan and epic context', async () => {
  const { root, state } = await fixture()
  const calls: { role: string; prompt: string }[] = []
  try {
    const runAgentActor: EpicServiceDependencies['runAgentActor'] = async (
      input
    ) => {
      calls.push({ role: input.role, prompt: input.prompt })
      const result: AgentRunResult = {
        role: input.role,
        exitCode: 0,
        output: JSON.stringify({
          tasks: [
            {
              id: 'T1',
              title: 'Create package metadata',
              objective: 'Create package metadata.',
              files: {
                context: [],
                expectedChanges: ['package.json'],
              },
              implementation: ['Create package metadata.'],
              acceptanceCriteria: ['Package metadata exists.'],
              verification: ['test -f package.json'],
              manualReviewSteps: ['Review package metadata.'],
              risks: [],
              requiredChecks: [],
              deferredChecks: [],
              reason: 'This task has no prerequisite tasks.',
            },
          ],
        }),
        stderr: '',
        stdoutLogPath: path.join(input.agentRunDirectory, 'fake.log'),
      }
      return result
    }
    const decompositionServices = createEpicServices(
      context(),
      () => ({ stage: 'decomposing_tasks', wait: 'active' }),
      { now: () => '2026-08-16T00:00:00.000Z', nowMs: () => 0 },
      configuration(),
      { runAgentActor, timer: { setTimeout, clearTimeout } }
    )

    const next = await decompositionServices.decompose(state)

    assert.equal(calls[0]?.role, 'task-planner')
    assert.match(calls[0]?.prompt ?? '', /Epic:\nRecovery test/)
    assert.match(calls[0]?.prompt ?? '', /Approved plan:\n# Approved plan/)
    assert.match(calls[0]?.prompt ?? '', /less capable local LLM/)
    assert.match(calls[0]?.prompt ?? '', /Optimize for reliable execution/)
    assert.match(calls[0]?.prompt ?? '', /Intermediate milestones are valid/)
    assert.doesNotMatch(calls[0]?.prompt ?? '', /fewest cohesive/)
    assert.deepEqual(
      next.tasks?.map((item) => item.id),
      ['T1']
    )
    assert.deepEqual(next.tasks?.[0]?.files, {
      context: [],
      expectedChanges: ['package.json'],
    })
    const artifact = await fs.readFile(currentTaskArtifactPath(next), 'utf8')
    assert.match(artifact, /## Files\n### Context/)
    assert.match(artifact, /### Expected Changes\n- package\.json/)
    assert.doesNotMatch(artifact, /## Scope/)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('task decomposition repairs an invalid check policy before persisting tasks', async () => {
  const { root, state } = await fixture()
  const calls: string[] = []
  try {
    const invalidTask = {
      id: 'T1',
      title: 'Interactive behavior',
      objective: 'Add interaction.',
      files: { context: [], expectedChanges: [] },
      implementation: ['Add interaction.'],
      acceptanceCriteria: ['Interaction works.'],
      verification: ['Browser smoke test'],
      manualReviewSteps: ['Exercise the interaction in a browser.'],
      risks: [],
      requiredChecks: ['focused-tests'],
      deferredChecks: [],
      reason: 'Browser verification is required.',
    }
    const validTask = {
      ...invalidTask,
      requiredChecks: [],
      reason: 'Browser verification is manual.',
    }
    const runAgentActor: EpicServiceDependencies['runAgentActor'] = async (
      input
    ) => {
      calls.push(input.prompt)
      return {
        role: input.role,
        exitCode: 0,
        output: JSON.stringify({
          tasks: [calls.length === 1 ? invalidTask : validTask],
        }),
        stderr: '',
        stdoutLogPath: path.join(input.agentRunDirectory, 'fake.log'),
      }
    }
    const decompositionServices = createEpicServices(
      context(),
      () => ({ stage: 'decomposing_tasks', wait: 'active' }),
      { now: () => '2026-08-16T00:00:00.000Z', nowMs: () => 0 },
      configuration(),
      { runAgentActor, timer: { setTimeout, clearTimeout } }
    )

    const next = await decompositionServices.decompose(state)

    assert.equal(calls.length, 2)
    assert.match(calls[1] ?? '', /Task T1 requires focused-tests/)
    assert.match(calls[1] ?? '', /Previous invalid response/)
    assert.deepEqual(next.tasks?.[0]?.requiredChecks, [])
    const events = await loadEpicEvents(state)
    assert.equal(
      events.filter((event) => event.type === 'task_decomposition_rejected')
        .length,
      1
    )
    assert.equal(
      events.filter((event) => event.type === 'tasks_decomposed').length,
      1
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('task decomposition repairs malformed JSON and escalates after its repair budget', async () => {
  const { root, state } = await fixture()
  let calls = 0
  try {
    const runAgentActor: EpicServiceDependencies['runAgentActor'] = async (
      input
    ) => {
      calls += 1
      return {
        role: input.role,
        exitCode: 0,
        output: 'not-json',
        stderr: '',
        stdoutLogPath: path.join(input.agentRunDirectory, 'fake.log'),
      }
    }
    const decompositionServices = createEpicServices(
      context(),
      () => ({ stage: 'decomposing_tasks', wait: 'active' }),
      { now: () => '2026-08-16T00:00:00.000Z', nowMs: () => 0 },
      configuration(),
      { runAgentActor, timer: { setTimeout, clearTimeout } }
    )

    await assert.rejects(
      decompositionServices.decompose(state),
      /remained invalid after 2 repair attempts/
    )
    assert.equal(calls, 3)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('task decomposition can repair malformed JSON with a valid manifest', async () => {
  const { root, state } = await fixture()
  let calls = 0
  try {
    const runAgentActor: EpicServiceDependencies['runAgentActor'] = async (
      input
    ) => {
      calls += 1
      return {
        role: input.role,
        exitCode: 0,
        output:
          calls === 1
            ? 'not-json'
            : JSON.stringify({
                tasks: [
                  {
                    id: 'T1',
                    title: 'Valid task',
                    objective: 'Produce a valid task.',
                    files: { context: [], expectedChanges: [] },
                    implementation: ['Implement the task.'],
                    acceptanceCriteria: ['The task is complete.'],
                    verification: ['git diff --check'],
                    manualReviewSteps: ['Review the result.'],
                    risks: [],
                    requiredChecks: ['diff-check'],
                    deferredChecks: [],
                    reason: 'The diff must be valid.',
                  },
                ],
              }),
        stderr: '',
        stdoutLogPath: path.join(input.agentRunDirectory, 'fake.log'),
      }
    }
    const decompositionServices = createEpicServices(
      context(),
      () => ({ stage: 'decomposing_tasks', wait: 'active' }),
      { now: () => '2026-08-16T00:00:00.000Z', nowMs: () => 0 },
      configuration(),
      { runAgentActor, timer: { setTimeout, clearTimeout } }
    )

    const next = await decompositionServices.decompose(state)

    assert.equal(calls, 2)
    assert.equal(next.tasks?.[0]?.id, 'T1')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('task decomposition does not retry an agent execution failure', async () => {
  const { root, state } = await fixture()
  let calls = 0
  try {
    const runAgentActor: EpicServiceDependencies['runAgentActor'] = async (
      input
    ) => {
      calls += 1
      return {
        role: input.role,
        exitCode: 1,
        output: '',
        stderr: 'provider unavailable',
        stdoutLogPath: path.join(input.agentRunDirectory, 'fake.log'),
      }
    }
    const decompositionServices = createEpicServices(
      context(),
      () => ({ stage: 'decomposing_tasks', wait: 'active' }),
      { now: () => '2026-08-16T00:00:00.000Z', nowMs: () => 0 },
      configuration(),
      { runAgentActor, timer: { setTimeout, clearTimeout } }
    )

    await assert.rejects(
      decompositionServices.decompose(state),
      /Task decomposition failed: provider unavailable/
    )
    assert.equal(calls, 1)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
}

function services(calls: string[]): ReturnType<typeof createEpicServices> {
  return createEpicServices(
    context(),
    () => ({ stage: 'implementing', wait: 'active' }),
    { now: () => '2026-08-16T00:00:00.000Z', nowMs: () => 0 },
    configuration(),
    dependencies(calls)
  )
}

async function addDirtyPackageFiles(root: string): Promise<void> {
  await fs.writeFile(path.join(root, 'package.json'), '{"name":"recovered"}\n')
  await fs.writeFile(
    path.join(root, 'package-lock.json'),
    '{"lockfileVersion":3}\n'
  )
}

async function journalImplementer(
  state: EpicDomainState,
  invocationId: string,
  exitCode?: number
): Promise<void> {
  await appendEvent(
    state,
    'implementing',
    '2026-08-16T00:00:00.000Z',
    'agent_started',
    {
      invocationId,
      role: 'implementer',
      action: 'implementation',
      taskId: 'T1',
    }
  )
  if (exitCode !== undefined) {
    await appendEvent(
      state,
      'implementing',
      '2026-08-16T00:00:01.000Z',
      'agent_finished',
      {
        invocationId,
        role: 'implementer',
        action: 'implementation',
        taskId: 'T1',
        exitCode,
      }
    )
  }
}

test('successful interrupted implementation is recovered without a duplicate agent run', async () => {
  const { root, state, checkpointSha } = await fixture()
  try {
    await addDirtyPackageFiles(root)
    await journalImplementer(state, 'prior-success', 0)
    const calls: string[] = []

    const next = await services(calls).implement(state)

    assert.deepEqual(calls, [])
    assert.equal(next.taskBaselineSha, checkpointSha)
    assert.equal(next.implementationAttempt, 1)
    const diffPath = next.lastDiffPath
    assert.ok(diffPath)
    assert.match(await fs.readFile(diffPath, 'utf8'), /package\.json/)
    const events = await loadEpicEvents(state)
    assert.equal(
      events.filter((event) => event.type === 'task_diff_updated').length,
      1
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('failed interrupted implementation retries while preserving planned and tool-generated files', async () => {
  const { root, state } = await fixture()
  try {
    await addDirtyPackageFiles(root)
    await journalImplementer(state, 'prior-failure', 1)
    const calls: string[] = []

    const next = await services(calls).implement(state)

    assert.deepEqual(calls, ['implementer'])
    assert.equal(next.implementationAttempt, 1)
    assert.equal(
      await fs.readFile(path.join(root, 'package.json'), 'utf8'),
      '{"name":"recovered"}\n'
    )
    assert.equal(
      await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'),
      '{"lockfileVersion":3}\n'
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('ambiguous dirty recovery fails without changing the worktree or journal', async () => {
  const { root, state } = await fixture()
  try {
    await addDirtyPackageFiles(root)
    const beforePackage = await fs.readFile(
      path.join(root, 'package.json'),
      'utf8'
    )
    const beforeEvents = await loadEpicEvents(state)

    await assert.rejects(
      () => services([]).implement(state),
      /Incomplete task recovery: the event journal has no implementer start/
    )
    assert.equal(
      await fs.readFile(path.join(root, 'package.json'), 'utf8'),
      beforePackage
    )
    assert.deepEqual(await loadEpicEvents(state), beforeEvents)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('recovered task reaches review, checkpoints once, and gives T2 a clean baseline', async () => {
  const { root, state } = await fixture()
  try {
    await addDirtyPackageFiles(root)
    await journalImplementer(state, 'prior-success', 0)
    const secondTask: EpicTask = {
      ...task(),
      id: 'T2',
      title: 'Create second file',
      files: { context: [], expectedChanges: ['second.txt'] },
    }
    const firstTask = state.tasks?.[0]
    assert.ok(firstTask)
    const initial = { ...state, tasks: [firstTask, secondTask] }
    const calls: string[] = []
    const epicServices = services(calls)
    const actor = createActor(createTaskExecutionMachine(epicServices), {
      input: { domain: initial },
    })
    actor.start()
    actor.send({ type: 'TASK.APPROVE' })
    for (let turn = 0; turn < 30; turn += 1) {
      await nextTurn()
      await new Promise<void>((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(actor.getSnapshot().value, 'awaitingReview')
    actor.send({ type: 'TASK.APPROVE' })
    for (let turn = 0; turn < 10 && actor.getSnapshot().status !== 'done'; turn++) { await nextTurn(); await new Promise<void>(resolve => setTimeout(resolve, 20)) }
    assert.equal(actor.getSnapshot().status, 'done')
    const output = actor.getSnapshot().output as {
      kind: string
      domain: EpicDomainState
    }
    assert.equal(output.kind, 'completed')
    assert.deepEqual(calls, ['verification-planner', 'reviewer'])

    const checkpointed = await epicServices.checkpointTask(output.domain)
    assert.equal(checkpointed.checkpoint?.kind, 'task')
    assert.equal(checkpointed.checkpoint?.ordinal, 1)
    const checkpoint = checkpointed.checkpoint
    assert.ok(checkpoint)
    assert.equal(
      await gitOutput(root, ['rev-parse', 'HEAD']),
      await gitOutput(root, ['rev-parse', checkpoint.tag])
    )

    const nextState: EpicDomainState = {
      ...checkpointed,
      currentTaskIndex: 1,
      taskApproved: true,
      taskBaselineSha: undefined,
    }
    await fs.writeFile(currentTaskArtifactPath(nextState), '# Task 2\n')
    const t2 = await epicServices.implement(nextState)
    assert.equal(
      t2.taskBaselineSha,
      await gitOutput(root, ['rev-parse', 'HEAD'])
    )
    assert.deepEqual(calls, ['verification-planner', 'reviewer', 'implementer'])
    actor.stop()
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
