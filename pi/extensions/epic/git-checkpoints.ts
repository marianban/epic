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

async function git(root: string, args: string[]): Promise<string> {
  try {
    return String((await exec('git', args, { cwd: root })).stdout).trim()
  } catch (error) {
    const detail = error as { stderr?: string; stdout?: string }
    throw new Error(`git ${args.join(' ')} failed: ${detail.stderr ?? detail.stdout ?? String(error)}`, { cause: error })
  }
}

function managedIgnoreBlock(): string {
  return [MANAGED_BEGIN, '!.pi/', '!.pi/epic.config.json', '!.pi/epic.config.local.json', '!.pi/epics/', '!.pi/epics/**', ...diagnosticPatterns, MANAGED_END].join('\n')
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

export async function assertCleanWorktree(root: string): Promise<void> {
  const status = await git(root, ['status', '--porcelain=v1'])
  // The actor snapshot is persisted after each transition. It is engine-owned
  // state, not an application change, and will be included by the next
  // checkpoint. Everything else must be clean before an implementer starts.
  const applicationChanges = status.split('\n').filter(Boolean).filter((line) => !line.slice(3).startsWith('.pi/'))
  if (applicationChanges.length) throw new Error(`Epic checkpoints require a clean index and worktree. Found: ${applicationChanges.join(', ')}`)
}

function safeScopePath(value: string): string {
  if (!value || path.isAbsolute(value) || value.split('/').includes('..') || value === '.git' || value.startsWith('.git/')) throw new Error(`Invalid task scope path: ${value}`)
  return value.replaceAll('\\', '/')
}
function permits(scope: readonly string[], file: string): boolean {
  return scope.map(safeScopePath).some((allowed) => file === allowed || file.startsWith(`${allowed}/`))
}

export async function validateTaskDelta(root: string, baselineSha: string, task: EpicTask): Promise<string[]> {
  const head = await git(root, ['rev-parse', 'HEAD'])
  if (head !== baselineSha) throw new Error(`HEAD moved since task baseline ${baselineSha}; refusing to validate a mixed task delta.`)
  const tracked = await git(root, ['diff', '--name-status', '-z', baselineSha, '--'])
  const untracked = await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])
  const entries = tracked.split('\0').filter(Boolean).flatMap((entry) => entry.split('\t').slice(-1)).concat(untracked.split('\0').filter(Boolean))
  for (const file of new Set(entries)) {
    if (file.startsWith('.pi/')) continue
    const status = tracked.includes(`D\t${file}\0`) ? 'delete' : tracked.includes(`A\t${file}\0`) || untracked.split('\0').includes(file) ? 'create' : 'modify'
    if (!permits(task.scope[status], file)) throw new Error(`Task ${task.id} changed ${file}, but scope.${status} does not allow it.`)
    const real = path.resolve(root, file)
    const rootReal = await fs.realpath(root)
    try { if (!path.resolve(await fs.realpath(real)).startsWith(`${rootReal}${path.sep}`)) throw new Error(`Task path escapes repository through symlink: ${file}`) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  return [...new Set(entries)].filter((file) => !file.startsWith('.pi/'))
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
