import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { EpicDomainState, EpicTask } from './types.ts'

const exec = promisify(execFile)
const MANAGED_BEGIN = '# >>> Pi epic managed ignores >>>'
const MANAGED_END = '# <<< Pi epic managed ignores <<<'
const diagnosticPatterns = [
  '.pi/epics/runs/*/agent-runs/',
  '.pi/epics/runs/*/epic.log',
]
const epicArtifactOsPatterns = [
  '.pi/epics/**/.DS_Store',
  '.pi/epics/**/.AppleDouble',
  '.pi/epics/**/.LSOverride',
  '.pi/epics/**/Icon?',
  '.pi/epics/**/._*',
  '.pi/epics/**/Thumbs.db',
  '.pi/epics/**/ehthumbs.db',
  '.pi/epics/**/Desktop.ini',
  '.pi/epics/**/$RECYCLE.BIN/',
  '.pi/epics/**/*~',
  '.pi/epics/**/.fuse_hidden*',
  '.pi/epics/**/.nfs*',
  '.pi/epics/**/.directory',
  '.pi/epics/**/.Trash-*/',
  '.pi/epics/**/.Trash/',
]

async function git(root: string, args: string[]): Promise<string> {
  try {
    // Preserve leading porcelain status columns. They distinguish a tracked
    // modification (` M path`) from the path text itself.
    return String((await exec('git', args, { cwd: root })).stdout).trimEnd()
  } catch (error) {
    const detail = error as { stderr?: string; stdout?: string }
    throw new Error(`git ${args.join(' ')} failed: ${detail.stderr ?? detail.stdout ?? String(error)}`, { cause: error })
  }
}

export type TaskDeltaKind = 'create' | 'modify' | 'delete'

export interface ApplicationChange {
  readonly path: string
  readonly kind: TaskDeltaKind
}

export interface ApplicationWorktreeStatus {
  readonly headSha: string
  readonly changes: readonly ApplicationChange[]
}

function managedIgnoreBlock(): string {
  return [MANAGED_BEGIN, '!.pi/', '!.pi/epic.config.json', '!.pi/epic.config.local.json', '!.pi/epics/', '!.pi/epics/**', ...epicArtifactOsPatterns, ...diagnosticPatterns, MANAGED_END].join('\n')
}

/** Add only the engine's own rules before the first checkpoint. */
export async function bootstrapEpicGitignore(root: string): Promise<string> {
  const target = path.join(root, '.gitignore')
  let current = ''
  try { current = await fs.readFile(target, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const block = managedIgnoreBlock()
  const expression = new RegExp(`${MANAGED_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${MANAGED_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`)
  const next = expression.test(current) ? current.replace(expression, `${block}\n`) : `${current}${current && !current.endsWith('\n') ? '\n' : ''}${block}\n`
  if (next !== current) await fs.writeFile(target, next, 'utf8')
  return target
}

export async function assertGitPreflight(root: string): Promise<void> {
  await git(root, ['rev-parse', '--is-inside-work-tree'])
  const identity = await Promise.all([git(root, ['config', '--get', 'user.name']), git(root, ['config', '--get', 'user.email'])])
  if (identity.some((value) => !value)) throw new Error('Git user.name and user.email must be configured before creating epic checkpoints.')
  const tracked = await git(root, ['ls-files', '--', ...diagnosticPatterns])
  if (tracked) throw new Error(`Diagnostic epic artifacts are already tracked and must be removed from the index before continuing: ${tracked.split('\n').join(', ')}.`)
}

interface PorcelainEntry {
  readonly indexStatus: string
  readonly worktreeStatus: string
  readonly path: string
  readonly otherPath?: string
}

function parsePorcelainStatus(raw: string): PorcelainEntry[] {
  const tokens = raw.split('\0')
  const entries: PorcelainEntry[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token) continue
    if (token.length < 4 || token[2] !== ' ')
      throw new Error(`Unable to parse Git porcelain status entry: ${JSON.stringify(token)}`)
    const indexStatus = token[0]
    const worktreeStatus = token[1]
    const path = token.slice(3)
    const renamed = indexStatus === 'R' || indexStatus === 'C' || worktreeStatus === 'R' || worktreeStatus === 'C'
    const otherPath = renamed ? tokens[index + 1] : undefined
    if (renamed && !otherPath)
      throw new Error(`Git reported an incomplete rename/copy status for ${path}.`)
    if (renamed) index += 1
    entries.push({ indexStatus, worktreeStatus, path, ...(otherPath === undefined ? {} : { otherPath }) })
  }
  return entries
}

function applicationPath(filePath: string): boolean {
  return !filePath.startsWith('.pi/')
}

function classifyPorcelainEntry(entry: PorcelainEntry): ApplicationChange[] {
  const statuses = `${entry.indexStatus}${entry.worktreeStatus}`
  const changes: ApplicationChange[] = []
  const add = (filePath: string, kind: TaskDeltaKind): void => {
    if (applicationPath(filePath)) changes.push({ path: filePath, kind })
  }

  if (entry.indexStatus === 'R' || entry.worktreeStatus === 'R') {
    add(entry.otherPath ?? entry.path, 'delete')
    add(entry.path, 'create')
    return changes
  }
  if (entry.indexStatus === 'C' || entry.worktreeStatus === 'C') {
    add(entry.path, 'create')
    return changes
  }
  if (statuses.includes('U'))
    throw new Error(`Unmerged Git state cannot be used for an epic task: ${entry.path}`)
  if (statuses.includes('D')) add(entry.path, 'delete')
  else if (statuses.includes('A') || statuses === '??') add(entry.path, 'create')
  else add(entry.path, 'modify')
  return changes
}

export async function resolveGitCommit(root: string, revision: string): Promise<string> {
  if (!revision.trim()) throw new Error('Git commit revision must not be empty.')
  return git(root, ['rev-parse', '--verify', `${revision}^{commit}`])
}

export async function inspectApplicationWorktree(root: string): Promise<ApplicationWorktreeStatus> {
  const [headSha, rawStatus] = await Promise.all([
    resolveGitCommit(root, 'HEAD'),
    git(root, ['status', '--porcelain=v1', '-z']),
  ])
  const changes = parsePorcelainStatus(rawStatus)
    .flatMap(classifyPorcelainEntry)
  const unique = new Map<string, ApplicationChange>()
  for (const change of changes) {
    const previous = unique.get(change.path)
    if (previous?.kind === 'delete' || change.kind === 'delete') unique.set(change.path, { path: change.path, kind: 'delete' })
    else if (previous?.kind === 'create' || change.kind === 'create') unique.set(change.path, { path: change.path, kind: 'create' })
    else unique.set(change.path, change)
  }
  return { headSha, changes: [...unique.values()] }
}

export async function assertCleanWorktree(root: string): Promise<void> {
  const status = await inspectApplicationWorktree(root)
  // The actor snapshot is persisted after each transition. It is engine-owned
  // state, not an application change, and will be included by the next
  // checkpoint. Everything else must be clean before an implementer starts.
  if (status.changes.length) {
    const found = status.changes.map(({ kind, path: filePath }) => `${kind} ${filePath}`)
    throw new Error(`Epic checkpoints require a clean index and worktree. Found: ${found.join(', ')}`)
  }
}

function safeScopePath(value: string): string {
  const normalized = value.replaceAll('\\', '/')
  if (!normalized || path.isAbsolute(value) || normalized.split('/').includes('..') || normalized === '.git' || normalized.startsWith('.git/')) throw new Error(`Invalid task scope path: ${value}`)
  return normalized
}
function permits(scope: readonly string[], file: string): boolean {
  return scope.map(safeScopePath).some((allowed) => file === allowed || file.startsWith(`${allowed}/`))
}

export async function validateTaskDelta(root: string, baselineSha: string, task: EpicTask): Promise<string[]> {
  const resolvedBaseline = await resolveGitCommit(root, baselineSha)
  const status = await inspectApplicationWorktree(root)
  if (status.headSha !== resolvedBaseline) throw new Error(`HEAD moved since task baseline ${baselineSha}; refusing to validate a mixed task delta.`)
  const rootReal = await fs.realpath(root)
  for (const change of status.changes) {
    const file = change.path
    const kind = change.kind
    if (!permits(task.scope[kind], file)) throw new Error(`Task ${task.id} changed ${file}, but scope.${kind} does not allow it.`)
    const real = path.resolve(root, file)
    let existing = real
    while (true) {
      try {
        const resolved = await fs.realpath(existing)
        if (resolved !== rootReal && !resolved.startsWith(`${rootReal}${path.sep}`)) throw new Error(`Task path escapes repository through symlink: ${file}`)
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        const parent = path.dirname(existing)
        if (parent === existing) throw error
        existing = parent
      }
    }
  }
  return status.changes.map(({ path: file }) => file)
}

export async function createCheckpoint(root: string, state: EpicDomainState, kind: 'plan' | 'task', ordinal: number, applicationPaths: readonly string[]): Promise<{ sha: string; tag: string }> {
  await assertGitPreflight(root)
  const allowlist = [
    ...applicationPaths,
    ...(kind === 'plan' ? ['plan.md', '.gitignore'] : []),
    '.pi/epic.config.json', '.pi/epic.config.local.json', '.pi/epics/active.json', `.pi/epics/runs/${state.epicId}`,
  ]
  const existing = await Promise.all(allowlist.map(async (file) => { try { await fs.lstat(path.join(root, file)); return file } catch { return undefined } }))
  const files = existing.filter((file): file is string => Boolean(file))
  if (files.length) await git(root, ['add', '--', ...files])
  const staged = await git(root, ['diff', '--cached', '--name-only'])
  const invalid = staged.split('\n').filter(Boolean).filter((file) => !files.some((allowed) => file === allowed || file.startsWith(`${allowed}/`)) || diagnosticPatterns.some((pattern) => pattern.includes('agent-runs') ? file.includes('/agent-runs/') : file.endsWith('/epic.log')))
  if (invalid.length) throw new Error(`Checkpoint staging contains unexpected or diagnostic paths: ${invalid.join(', ')}`)
  if (staged) await git(root, ['commit', '--no-verify', '-m', `pi(epic): checkpoint ${kind} ${ordinal}\n\nEpic-Id: ${state.epicId}\nEpic-Task: ${ordinal}`])
  const sha = await git(root, ['rev-parse', '--short', 'HEAD'])
  const tag = kind === 'plan' ? `pi-epic/${state.epicId}/plan/${sha}` : `pi-epic/${state.epicId}/task-${ordinal}-${state.tasks?.[ordinal - 1]?.id ?? 'unknown'}/${sha}`
  await git(root, ['tag', tag])
  return { sha, tag }
}
