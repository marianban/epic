import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { redactSecrets } from './tools.ts'

const execFileAsync = promisify(execFile)
const MAX_DIFF_BYTES = 150_000

export async function getCurrentDiff(repositoryRoot: string): Promise<string> {
  try {
    const result = await execFileAsync(
      'git',
      ['diff', '--no-ext-diff', '--binary'],
      { cwd: repositoryRoot, maxBuffer: MAX_DIFF_BYTES * 2 }
    )
    return redactSecrets(String(result.stdout).slice(0, MAX_DIFF_BYTES))
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string }
    return redactSecrets(
      `${result.stdout ?? ''}\n${result.stderr ?? ''}`.slice(0, MAX_DIFF_BYTES)
    )
  }
}

export async function getDiffCheck(
  repositoryRoot: string
): Promise<{ passed: boolean; output: string }> {
  try {
    const result = await execFileAsync('git', ['diff', '--check'], {
      cwd: repositoryRoot,
      maxBuffer: 30_000,
    })
    return { passed: true, output: String(result.stdout) }
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string }
    return {
      passed: false,
      output: redactSecrets(`${result.stdout ?? ''}\n${result.stderr ?? ''}`),
    }
  }
}
