import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { redactSecrets } from './tools.ts'

const execFileAsync = promisify(execFile)
const MAX_DIFF_BYTES = 150_000
const MAX_COMMAND_OUTPUT_BYTES = MAX_DIFF_BYTES * 2

export interface DiffSummary {
  readonly filesChanged: number
  readonly linesAdded: number
  readonly linesDeleted: number
}

export function summarizeDiff(diff: string): DiffSummary {
  if (typeof diff !== 'string') throw new Error('Diff must be a string.')

  let filesChanged = 0
  let linesAdded = 0
  let linesDeleted = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) filesChanged += 1
    else if (line.startsWith('+++ ') || line.startsWith('--- ')) continue
    else if (line.startsWith('+')) linesAdded += 1
    else if (line.startsWith('-')) linesDeleted += 1
  }
  return { filesChanged, linesAdded, linesDeleted }
}

function commandError(error: unknown): {
  code?: number | string
  stdout?: string
  stderr?: string
} {
  if (!error || typeof error !== 'object') return {}
  const result = error as {
    code?: number | string
    stdout?: string
    stderr?: string
  }
  return {
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

function isEpicManagedPath(filePath: string): boolean {
  return filePath.startsWith('.pi/epics/')
}

async function getUntrackedPaths(repositoryRoot: string): Promise<string[]> {
  const result = await execFileAsync(
    'git',
    ['ls-files', '--others', '--exclude-standard', '-z'],
    { cwd: repositoryRoot, maxBuffer: MAX_COMMAND_OUTPUT_BYTES }
  )
  return String(result.stdout)
    .split('\0')
    .filter((filePath) => filePath.length > 0 && !isEpicManagedPath(filePath))
}

async function getUntrackedFileDiff(
  repositoryRoot: string,
  filePath: string
): Promise<string> {
  try {
    const result = await execFileAsync(
      'git',
      [
        'diff',
        '--no-ext-diff',
        '--binary',
        '--no-index',
        '--',
        '/dev/null',
        filePath,
      ],
      { cwd: repositoryRoot, maxBuffer: MAX_COMMAND_OUTPUT_BYTES }
    )
    return String(result.stdout)
  } catch (error) {
    const result = commandError(error)
    // git diff --no-index returns 1 when the files differ, which is the
    // expected result for every untracked file compared with /dev/null.
    if (result.code === 1 || result.code === '1')
      return String(result.stdout ?? '')

    const message = `Unable to inspect untracked file ${filePath}: ${
      result.stderr ?? String(error)
    }`
    throw new Error(message, { cause: error })
  }
}

export async function getCurrentDiff(repositoryRoot: string): Promise<string> {
  try {
    const result = await execFileAsync(
      'git',
      ['diff', '--no-ext-diff', '--binary'],
      { cwd: repositoryRoot, maxBuffer: MAX_COMMAND_OUTPUT_BYTES }
    )

    const untrackedPaths = await getUntrackedPaths(repositoryRoot)
    const untrackedDiffs = await Promise.all(
      untrackedPaths.map((filePath) =>
        getUntrackedFileDiff(repositoryRoot, filePath)
      )
    )
    return redactSecrets(
      `${String(result.stdout)}${untrackedDiffs.join('')}`.slice(
        0,
        MAX_DIFF_BYTES
      )
    )
  } catch (error) {
    const result = commandError(error)
    return redactSecrets(
      `${result.stdout ?? ''}\n${result.stderr ?? ''}`.slice(0, MAX_DIFF_BYTES)
    )
  }
}
