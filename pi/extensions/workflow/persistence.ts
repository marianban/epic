import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createActor } from 'xstate'
import type {
  ScoutReport,
  WorkflowEvent,
  WorkflowState,
  WorkflowTask,
} from './types.ts'
import { logWorkflow } from './logger.ts'
import {
  machineStage,
  workflowMachine,
  WORKFLOW_MACHINE_VERSION,
  WORKFLOW_SCHEMA_VERSION,
} from './machines/workflow-machine.ts'

export function runDirectory(root: string, workflowId: string): string {
  return path.join(root, '.pi', 'workflows', 'runs', workflowId)
}
export function workflowStatePath(root: string, id: string): string {
  return path.join(runDirectory(root, id), 'state.json')
}

export async function ensureWorkflowDirectories(
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

export async function saveState(state: WorkflowState): Promise<void> {
  if (
    state.schemaVersion !== WORKFLOW_SCHEMA_VERSION ||
    state.machineVersion !== WORKFLOW_MACHINE_VERSION
  ) {
    throw incompatibleState(
      state,
      `unsupported persistence version ${state.schemaVersion ?? 'missing'}/${state.machineVersion ?? 'missing'}`
    )
  }
  if (!state.machineSnapshot) {
    if (state.stage !== 'idle')
      throw incompatibleState(state, 'missing XState machine snapshot')
    const actor = createActor(workflowMachine, { input: { state } })
    actor.start()
    state.machineSnapshot = actor.getPersistedSnapshot()
    actor.stop()
  }
  await ensureWorkflowDirectories(state.repositoryRoot, state.workflowId)
  state.updatedAt = new Date().toISOString()
  await atomicWrite(
    workflowStatePath(state.repositoryRoot, state.workflowId),
    `${JSON.stringify(state, null, 2)}\n`
  )
  await atomicWrite(
    path.join(state.repositoryRoot, '.pi', 'workflows', 'active.json'),
    `${JSON.stringify({ workflowId: state.workflowId }, null, 2)}\n`
  )
  await logWorkflow(state, 'debug', 'Workflow state saved', {
    stage: state.stage,
  })
}

export async function loadState(
  root: string,
  workflowId: string
): Promise<WorkflowState> {
  const raw = await fs.readFile(workflowStatePath(root, workflowId), 'utf8')
  try {
    const state = JSON.parse(raw) as WorkflowState
    if (
      state.schemaVersion !== WORKFLOW_SCHEMA_VERSION ||
      state.machineVersion !== WORKFLOW_MACHINE_VERSION
    ) {
      throw incompatibleState(
        state,
        `unsupported persistence version ${state.schemaVersion ?? 'missing'}/${state.machineVersion ?? 'missing'}`
      )
    }
    if (!state.machineSnapshot)
      throw incompatibleState(state, 'missing XState machine snapshot')
    const snapshotStage = machineStage(
      state.machineSnapshot as { context: { state: WorkflowState } }
    )
    if (snapshotStage !== state.stage)
      throw incompatibleState(
        state,
        `stage mismatch between durable state (${state.stage}) and machine snapshot (${snapshotStage})`
      )
    return state
  } catch (error) {
    throw new Error(
      `Corrupt workflow state at ${workflowStatePath(root, workflowId)}: ${String(error)}`,
      { cause: error }
    )
  }
}

export async function loadActiveWorkflow(root: string): Promise<WorkflowState> {
  const active = JSON.parse(
    await fs.readFile(
      path.join(root, '.pi', 'workflows', 'active.json'),
      'utf8'
    )
  ) as { workflowId?: string }
  if (!active.workflowId)
    throw new Error('Active workflow pointer is missing workflowId.')
  return loadState(root, active.workflowId)
}

export async function appendEvent(
  state: WorkflowState,
  type: string,
  payload: Record<string, unknown> = {}
): Promise<void> {
  const event: WorkflowEvent = {
    id: randomUUID(),
    workflowId: state.workflowId,
    timestamp: new Date().toISOString(),
    type,
    stage: state.stage,
    payload,
  }
  await fs.appendFile(
    path.join(
      runDirectory(state.repositoryRoot, state.workflowId),
      'events.jsonl'
    ),
    `${JSON.stringify(event)}\n`,
    'utf8'
  )
  await logWorkflow(state, 'info', type, { stage: state.stage, ...payload })
}

function incompatibleState(
  state: Partial<WorkflowState>,
  reason: string
): Error {
  return new Error(
    `Workflow ${state.workflowId ?? 'unknown'} is incompatible with XState persistence: ${reason}. Required schema/machine version ${WORKFLOW_SCHEMA_VERSION}/${WORKFLOW_MACHINE_VERSION}; no compatibility migration was applied.`
  )
}

export async function persistJsonArtifact(
  state: WorkflowState,
  relativePath: string,
  value: unknown
): Promise<string> {
  const filePath = path.join(
    runDirectory(state.repositoryRoot, state.workflowId),
    relativePath
  )
  await atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`)
  return filePath
}

export async function persistScoutReport(
  state: WorkflowState,
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

export async function persistTask(state: WorkflowState): Promise<string> {
  const filePath = path.join(
    runDirectory(state.repositoryRoot, state.workflowId),
    'task.md'
  )
  await atomicWrite(filePath, `# Workflow Task\n\n${state.task}\n`)
  return filePath
}

export async function persistWorkflowTasks(
  state: WorkflowState,
  tasks: WorkflowTask[]
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
      `## Manual Review Steps\n${task.manualReviewSteps.map((item, i) => `${i + 1}. ${item}`).join('\n')}`,
      '',
      `## Risks\n${list(task.risks)}`,
      '',
      '## Human Review Instructions',
      '',
    ].join('\n')
    await atomicWrite(
      path.join(
        runDirectory(state.repositoryRoot, state.workflowId),
        'tasks',
        `task-${String(index + 1).padStart(3, '0')}.md`
      ),
      `${markdown}\n`
    )
  }
  return manifest
}

export async function writePlanRevision(
  state: WorkflowState,
  markdown: string
): Promise<string> {
  const revision = state.planRevision + 1
  const filePath = path.join(
    runDirectory(state.repositoryRoot, state.workflowId),
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
