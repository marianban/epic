import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createActor } from 'xstate'
import type {
  ScoutReport,
  EpicEvent,
  EpicState,
  EpicTask,
} from './types.ts'
import { logEpic } from './logger.ts'
import {
  machineStage,
  epicMachine,
  EPIC_MACHINE_VERSION,
  EPIC_SCHEMA_VERSION,
} from './machines/epic-machine.ts'

function runDirectory(root: string, epicId: string): string {
  return path.join(root, '.pi', 'epics', 'runs', epicId)
}
function epicStatePath(root: string, id: string): string {
  return path.join(runDirectory(root, id), 'state.json')
}

async function ensureEpicDirectories(
  root: string,
  id: string
): Promise<string> {
  const dir = runDirectory(root, id)
  await fs.mkdir(path.join(dir, 'plan-revisions'), { recursive: true })
  await fs.mkdir(path.join(dir, 'checks'), { recursive: true })
  await fs.mkdir(path.join(dir, 'reviews'), { recursive: true })
  await fs.mkdir(path.join(dir, 'diffs'), { recursive: true })
  await fs.mkdir(path.join(dir, 'tasks'), { recursive: true })
  return dir
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  await fs.writeFile(temporary, content, 'utf8')
  await fs.rename(temporary, filePath)
}

export async function saveState(state: EpicState): Promise<void> {
  if (
    state.schemaVersion !== EPIC_SCHEMA_VERSION ||
    state.machineVersion !== EPIC_MACHINE_VERSION
  ) {
    throw incompatibleState(
      state,
      `unsupported persistence version ${state.schemaVersion ?? 'missing'}/${state.machineVersion ?? 'missing'}`
    )
  }
  if (!state.machineSnapshot) {
    if (state.stage !== 'idle')
      throw incompatibleState(state, 'missing XState machine snapshot')
    const actor = createActor(epicMachine, { input: { state } })
    actor.start()
    state.machineSnapshot = actor.getPersistedSnapshot()
    actor.stop()
  }
  await ensureEpicDirectories(state.repositoryRoot, state.epicId)
  state.updatedAt = new Date().toISOString()
  await atomicWrite(
    epicStatePath(state.repositoryRoot, state.epicId),
    `${JSON.stringify(state, null, 2)}\n`
  )
  await atomicWrite(
    path.join(state.repositoryRoot, '.pi', 'epics', 'active.json'),
    `${JSON.stringify({ epicId: state.epicId }, null, 2)}\n`
  )
  await logEpic(state, 'debug', 'Epic state saved', {
    stage: state.stage,
  })
}

async function loadState(
  root: string,
  epicId: string
): Promise<EpicState> {
  const raw = await fs.readFile(epicStatePath(root, epicId), 'utf8')
  try {
    const state = JSON.parse(raw) as EpicState
    if (
      state.schemaVersion !== EPIC_SCHEMA_VERSION ||
      state.machineVersion !== EPIC_MACHINE_VERSION
    ) {
      throw incompatibleState(
        state,
        `unsupported persistence version ${state.schemaVersion ?? 'missing'}/${state.machineVersion ?? 'missing'}`
      )
    }
    if (!state.machineSnapshot)
      throw incompatibleState(state, 'missing XState machine snapshot')
    const snapshotStage = machineStage(
      state.machineSnapshot as { context: { state: EpicState } }
    )
    if (snapshotStage !== state.stage)
      throw incompatibleState(
        state,
        `stage mismatch between durable state (${state.stage}) and machine snapshot (${snapshotStage})`
      )
    return state
  } catch (error) {
    throw new Error(
      `Corrupt epic state at ${epicStatePath(root, epicId)}: ${String(error)}`,
      { cause: error }
    )
  }
}

export async function loadActiveEpic(root: string): Promise<EpicState> {
  const active = JSON.parse(
    await fs.readFile(
      path.join(root, '.pi', 'epics', 'active.json'),
      'utf8'
    )
  ) as { epicId?: string }
  if (!active.epicId)
    throw new Error('Active epic pointer is missing epicId.')
  return loadState(root, active.epicId)
}

export async function appendEvent(
  state: EpicState,
  type: string,
  payload: Record<string, unknown> = {}
): Promise<void> {
  const event: EpicEvent = {
    id: randomUUID(),
    epicId: state.epicId,
    timestamp: new Date().toISOString(),
    type,
    stage: state.stage,
    payload,
  }
  await fs.appendFile(
    path.join(
      runDirectory(state.repositoryRoot, state.epicId),
      'events.jsonl'
    ),
    `${JSON.stringify(event)}\n`,
    'utf8'
  )
  await logEpic(state, 'info', type, { stage: state.stage, ...payload })
}

function incompatibleState(
  state: Partial<EpicState>,
  reason: string
): Error {
  return new Error(
    `Epic ${state.epicId ?? 'unknown'} is incompatible with XState persistence: ${reason}. Required schema/machine version ${EPIC_SCHEMA_VERSION}/${EPIC_MACHINE_VERSION}; no compatibility migration was applied.`
  )
}

export async function persistJsonArtifact(
  state: EpicState,
  relativePath: string,
  value: unknown
): Promise<string> {
  const filePath = path.join(
    runDirectory(state.repositoryRoot, state.epicId),
    relativePath
  )
  await atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`)
  return filePath
}

export async function persistScoutReport(
  state: EpicState,
  report: ScoutReport
): Promise<string> {
  const latest = await persistJsonArtifact(state, 'scout-report.json', report)
  await persistJsonArtifact(
    state,
    `scout-reports/scout-${String(state.scoutRound).padStart(3, '0')}.json`,
    report
  )
  return latest
}

export async function persistEpic(state: EpicState): Promise<string> {
  const filePath = path.join(
    runDirectory(state.repositoryRoot, state.epicId),
    'Epic.md'
  )
  await atomicWrite(filePath, `# Epic\n\n${state.epic}\n`)
  return filePath
}

export async function persistEpicTasks(
  state: EpicState,
  tasks: EpicTask[]
): Promise<string> {
  const manifest = await persistJsonArtifact(state, 'tasks/tasks.json', tasks)
  for (const [index, task] of tasks.entries()) {
    const list = (items: string[]) =>
      items.map((item) => `- ${item}`).join('\n') || '- None.'
    const markdown = [
      `# Task ${index + 1}: ${task.title}`,
      '',
      `## Objective\n${task.objective}`,
      '',
      '## Scope',
      `### Read\n${list(task.scope.read)}`,
      `### Modify\n${list(task.scope.modify)}`,
      `### Create\n${list(task.scope.create)}`,
      `### Delete\n${list(task.scope.delete)}`,
      '',
      `## Implementation\n${list(task.implementation)}`,
      '',
      `## Acceptance Criteria\n${task.acceptanceCriteria.map((item) => `- [ ] ${item}`).join('\n')}`,
      '',
      `## Verification\n${list(task.verification)}`,
      '',
      '## Check Policy',
      `### Required Checks\n${list(task.requiredChecks)}`,
      `### Deferred Checks\n${list(task.deferredChecks)}`,
      `### Reason\n${task.reason}`,
      '',
      `## Manual Review Steps\n${task.manualReviewSteps.map((item, i) => `${i + 1}. ${item}`).join('\n')}`,
      '',
      `## Risks\n${list(task.risks)}`,
      '',
      '## Human Review Instructions',
      '',
    ].join('\n')
    await atomicWrite(
      path.join(
        runDirectory(state.repositoryRoot, state.epicId),
        'tasks',
        `task-${String(index + 1).padStart(3, '0')}.md`
      ),
      `${markdown}\n`
    )
  }
  return manifest
}

export async function writePlanRevision(
  state: EpicState,
  markdown: string
): Promise<string> {
  const revision = state.planRevision + 1
  const filePath = path.join(
    runDirectory(state.repositoryRoot, state.epicId),
    'plan-revisions',
    `plan-${String(revision).padStart(3, '0')}.md`
  )
  await atomicWrite(
    filePath,
    markdown.endsWith('\n') ? markdown : `${markdown}\n`
  )
  state.planRevision = revision
  await saveState(state)
  await appendEvent(state, 'plan_written', { revision, path: filePath })
  return filePath
}
