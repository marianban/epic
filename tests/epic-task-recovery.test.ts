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
    scope: {
      read: [],
      modify: [],
      create: ['package.json', 'package-lock.json'],
      delete: [],
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
    maxFastRepairs: 1,
    maxFullRepairs: 1,
    maxSemanticRepairs: 1,
    checks: { fast: ['true'], full: ['true'], final: ['true'] },
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
  await fs.writeFile(path.join(root, 'plan.md'), plan)
  await git(root, ['add', 'plan.md', '.gitignore'])
  await git(root, ['commit', '-m', 'plan checkpoint'])
  const checkpointSha = await gitOutput(root, ['rev-parse', 'HEAD'])
  const checkpointTag = 'pi-epic/run-1/plan/checkpoint'
  await git(root, ['tag', checkpointTag])
  await fs.mkdir(path.join(root, '.pi', 'epics', 'runs', 'run-1', 'tasks'), { recursive: true })
  const epicTask = task()
  const state: EpicDomainState = {
    epicId: 'run-1',
    epic: 'Recovery test',
    repositoryRoot: root,
    epicComplexity: 'simple',
    scoutRound: 0,
    maxScoutRounds: 3,
    planPath: path.join(root, 'plan.md'),
    planRevision: 1,
    planApproved: true,
    approvedPlanHash: hashPlan(plan),
    tasks: [epicTask],
    currentTaskIndex: 0,
    taskApproved: true,
    implementationAttempt: 0,
    maxFastRepairs: 1,
    maxFullRepairs: 1,
    maxSemanticRepairs: 1,
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

function dependencies(
  calls: string[]
): EpicServiceDependencies {
  const runAgentActor: EpicServiceDependencies['runAgentActor'] = async (input) => {
    calls.push(input.role)
    const result: AgentRunResult = {
      role: input.role,
      exitCode: 0,
      output: input.role === 'reviewer'
        ? JSON.stringify({
            passed: true,
            summary: 'Recovered implementation is valid.',
            acceptanceCriteria: [],
            findings: [],
            requiresPlanRevision: false,
          })
        : '',
      stderr: '',
      stdoutLogPath: path.join(input.agentRunDirectory, 'fake.log'),
    }
    return result
  }
  return { runAgentActor }
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
}

function services(
  calls: string[]
): ReturnType<typeof createEpicServices> {
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
  await fs.writeFile(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}\n')
}

async function journalImplementer(
  state: EpicDomainState,
  invocationId: string,
  exitCode?: number
): Promise<void> {
  await appendEvent(state, 'implementing', '2026-08-16T00:00:00.000Z', 'agent_started', {
    invocationId,
    role: 'implementer',
    action: 'implementation',
    taskId: 'T1',
  })
  if (exitCode !== undefined) {
    await appendEvent(state, 'implementing', '2026-08-16T00:00:01.000Z', 'agent_finished', {
      invocationId,
      role: 'implementer',
      action: 'implementation',
      taskId: 'T1',
      exitCode,
    })
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
    assert.equal(events.filter((event) => event.type === 'task_diff_updated').length, 1)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('failed interrupted implementation retries while preserving scoped files', async () => {
  const { root, state } = await fixture()
  try {
    await addDirtyPackageFiles(root)
    await journalImplementer(state, 'prior-failure', 1)
    const calls: string[] = []

    const next = await services(calls).implement(state)

    assert.deepEqual(calls, ['implementer'])
    assert.equal(next.implementationAttempt, 1)
    assert.equal(await fs.readFile(path.join(root, 'package.json'), 'utf8'), '{"name":"recovered"}\n')
    assert.equal(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'), '{"lockfileVersion":3}\n')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('ambiguous dirty recovery fails without changing the worktree or journal', async () => {
  const { root, state } = await fixture()
  try {
    await addDirtyPackageFiles(root)
    const beforePackage = await fs.readFile(path.join(root, 'package.json'), 'utf8')
    const beforeEvents = await loadEpicEvents(state)

    await assert.rejects(
      () => services([]).implement(state),
      /Incomplete task recovery: the event journal has no implementer start/
    )
    assert.equal(await fs.readFile(path.join(root, 'package.json'), 'utf8'), beforePackage)
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
      scope: { read: [], modify: [], create: ['second.txt'], delete: [] },
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
    await nextTurn()
    assert.equal(actor.getSnapshot().status, 'done')
    const output = actor.getSnapshot().output as {
      kind: string
      domain: EpicDomainState
    }
    assert.equal(output.kind, 'completed')
    assert.deepEqual(calls, ['reviewer'])

    const checkpointed = await epicServices.checkpointTask(output.domain)
    assert.equal(checkpointed.checkpoint?.kind, 'task')
    assert.equal(checkpointed.checkpoint?.ordinal, 1)
    const checkpoint = checkpointed.checkpoint
    assert.ok(checkpoint)
    assert.equal(await gitOutput(root, ['rev-parse', 'HEAD']), await gitOutput(root, ['rev-parse', checkpoint.tag]))

    const nextState: EpicDomainState = {
      ...checkpointed,
      currentTaskIndex: 1,
      taskApproved: true,
      taskBaselineSha: undefined,
    }
    await fs.writeFile(currentTaskArtifactPath(nextState), '# Task 2\n')
    const t2 = await epicServices.implement(nextState)
    assert.equal(t2.taskBaselineSha, await gitOutput(root, ['rev-parse', 'HEAD']))
    assert.deepEqual(calls, ['reviewer', 'implementer'])
    actor.stop()
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
