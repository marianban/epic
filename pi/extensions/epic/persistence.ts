import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  ScoutReport,
  EpicEvent,
  EpicDomainState,
  EpicRunIdentity,
  PersistedEpicEnvelope,
  EpicTask,
} from './types.ts'
import { logEpic } from './logger.ts'
import { EPIC_MACHINE_VERSION, EPIC_SCHEMA_VERSION } from './persistence-version.ts'
import { projectActorSystemSnapshot } from './machines/actor-system-projection.ts'
import { domainFromActorSnapshot } from './domain-validation.ts'

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

export async function saveState(
  identity: EpicRunIdentity,
  envelope: PersistedEpicEnvelope
): Promise<void> {
  parsePersistedEpicEnvelope(envelope)
  if (identity.epicId !== envelope.epicId)
    throw new Error('Persisted epic identity does not match its envelope.')
  await ensureEpicDirectories(identity.repositoryRoot, identity.epicId)
  await atomicWrite(
    epicStatePath(identity.repositoryRoot, identity.epicId),
    `${JSON.stringify(envelope, null, 2)}\n`
  )
  await atomicWrite(
    path.join(identity.repositoryRoot, '.pi', 'epics', 'active.json'),
    `${JSON.stringify({ epicId: identity.epicId }, null, 2)}\n`
  )
}

async function loadState(
  root: string,
  epicId: string
): Promise<PersistedEpicEnvelope> {
  const raw = await fs.readFile(epicStatePath(root, epicId), 'utf8')
  try {
    const envelope = parsePersistedEpicEnvelope(JSON.parse(raw))
    if (envelope.epicId !== epicId)
      throw new Error('State envelope epicId does not match active pointer.')
    return envelope
  } catch (error) {
    throw new Error(
      `Corrupt epic state at ${epicStatePath(root, epicId)}: ${String(error)}`,
      { cause: error }
    )
  }
}

export async function loadActiveEpic(
  root: string
): Promise<PersistedEpicEnvelope> {
  const active = JSON.parse(
    await fs.readFile(path.join(root, '.pi', 'epics', 'active.json'), 'utf8')
  ) as { epicId?: string }
  if (!active.epicId) throw new Error('Active epic pointer is missing epicId.')
  return loadState(root, active.epicId)
}

export async function loadOptionalActiveEpic(
  root: string
): Promise<PersistedEpicEnvelope | undefined> {
  let activeRaw: string
  try {
    activeRaw = await fs.readFile(
      path.join(root, '.pi', 'epics', 'active.json'),
      'utf8'
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }

  const active = JSON.parse(activeRaw) as { epicId?: string }
  if (!active.epicId) throw new Error('Active epic pointer is missing epicId.')
  return loadState(root, active.epicId)
}

export async function loadEpicEvents(
  state: EpicRunIdentity
): Promise<readonly EpicEvent[]> {
  const filePath = path.join(
    runDirectory(state.repositoryRoot, state.epicId),
    'events.jsonl'
  )
  let contents: string
  try {
    contents = await fs.readFile(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return contents.split('\n').flatMap((line, index) => {
    if (line.trim().length === 0) return []
    try {
      return [JSON.parse(line) as EpicEvent]
    } catch (error) {
      throw new Error(
        `Invalid event journal entry ${index + 1} in ${filePath}.`,
        { cause: error }
      )
    }
  })
}

export async function appendEvent(
  state: EpicRunIdentity,
  stage: import('./types.ts').EpicStage,
  timestamp: string,
  type: string,
  payload: Record<string, unknown> = {}
): Promise<void> {
  const event: EpicEvent = {
    id: randomUUID(),
    epicId: state.epicId,
    timestamp,
    type,
    stage,
    payload,
  }
  await fs.appendFile(
    path.join(runDirectory(state.repositoryRoot, state.epicId), 'events.jsonl'),
    `${JSON.stringify(event)}\n`,
    'utf8'
  )
  await logEpic(state, timestamp, 'info', type, { stage, ...payload })
}

function incompatibleState(
  state: Partial<PersistedEpicEnvelope>,
  reason: string
): Error {
  return new Error(
    `Epic ${state.epicId ?? 'unknown'} is incompatible with XState persistence: ${reason}. Required schema/machine version ${EPIC_SCHEMA_VERSION}/${EPIC_MACHINE_VERSION}; no compatibility migration was applied.`
  )
}

export function parsePersistedEpicEnvelope(value: unknown): PersistedEpicEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Persisted epic envelope must be an object.')
  const envelope = value as Record<string, unknown>
  const keys = ['schemaVersion', 'machineVersion', 'epicId', 'createdAt', 'updatedAt', 'snapshot']
  if (Object.keys(envelope).some((key) => !keys.includes(key)) || keys.some((key) => !(key in envelope)))
    throw new Error('Persisted epic envelope has missing or unsupported fields.')
  const schema = envelope.schemaVersion
  const machine = envelope.machineVersion
  if (schema !== EPIC_SCHEMA_VERSION || machine !== EPIC_MACHINE_VERSION)
    throw incompatibleState(
      envelope as Partial<PersistedEpicEnvelope>,
      `found schema/machine version ${String(schema ?? 'missing')}/${String(machine ?? 'missing')}`
    )
  if (
    typeof envelope.epicId !== 'string' || !envelope.epicId ||
    typeof envelope.createdAt !== 'string' || !envelope.createdAt ||
    typeof envelope.updatedAt !== 'string' || !envelope.updatedAt ||
    !envelope.snapshot || typeof envelope.snapshot !== 'object'
  )
    throw incompatibleState(envelope as Partial<PersistedEpicEnvelope>, 'missing envelope metadata or snapshot')
  const typed = envelope as unknown as PersistedEpicEnvelope
  const domain = domainFromActorSnapshot(typed.snapshot)
  if (domain.epicId !== typed.epicId)
    throw incompatibleState(
      typed,
      'snapshot domain identity is missing or does not match the envelope'
    )
  try {
    projectActorSystemSnapshot(
      typed.snapshot as {
        value: unknown
        children?: Record<string, unknown>
      }
    )
  } catch (error) {
    throw new Error('Malformed persisted actor-system snapshot.', {
      cause: error,
    })
  }
  return typed
}

export async function persistJsonArtifact(
  state: EpicRunIdentity,
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
  state: EpicRunIdentity & Pick<EpicDomainState, 'scoutRound'>,
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

export async function persistEpic(
  state: Pick<EpicDomainState, 'repositoryRoot' | 'epicId' | 'epic'>
): Promise<string> {
  const filePath = path.join(
    runDirectory(state.repositoryRoot, state.epicId),
    'Epic.md'
  )
  await atomicWrite(filePath, `# Epic\n\n${state.epic}\n`)
  return filePath
}

export async function persistEpicTasks(
  state: EpicRunIdentity,
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
      '## Files',
      `### Context\n${list(task.files.context)}`,
      `### Expected Changes\n${list(task.files.expectedChanges)}`,
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
  state: EpicDomainState,
  markdown: string,
  timestamp: string
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
  await appendEvent(state, 'planning', timestamp, 'plan_written', {
    revision,
    path: filePath,
  })
  return filePath
}
