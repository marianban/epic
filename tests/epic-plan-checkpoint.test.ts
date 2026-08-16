import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import {
  bootstrapEpicGitignore,
  createCheckpoint,
} from '../pi/extensions/epic/git-checkpoints.ts'
import type { EpicDomainState } from '../pi/extensions/epic/types.ts'

const exec = promisify(execFile)

async function git(root: string, args: string[]): Promise<string> {
  return String((await exec('git', args, { cwd: root })).stdout).trim()
}

function state(root: string): EpicDomainState {
  return {
    epicId: 'run-1',
    epic: 'Run-scoped plan',
    repositoryRoot: root,
    epicComplexity: 'simple',
    scoutRound: 0,
    maxScoutRounds: 1,
    planPath: path.join(root, '.pi', 'epics', 'runs', 'run-1', 'plan.md'),
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

test('plan checkpoints stage the plan inside the epic run', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'epic-plan-checkpoint-'))
  try {
    await exec('git', ['init'], { cwd: root })
    await exec('git', ['config', 'user.name', 'Epic Test'], { cwd: root })
    await exec('git', ['config', 'user.email', 'epic-test@example.com'], { cwd: root })
    await fs.writeFile(path.join(root, 'README.md'), 'initial\n')
    await exec('git', ['add', 'README.md'], { cwd: root })
    await exec('git', ['commit', '-m', 'initial'], { cwd: root })
    await bootstrapEpicGitignore(root)

    const current = state(root)
    await fs.mkdir(path.dirname(current.planPath), { recursive: true })
    await fs.writeFile(current.planPath, '# Implementation Plan\n')
    await fs.writeFile(path.join(root, 'plan.md'), 'legacy root plan\n')

    const checkpoint = await createCheckpoint(root, current, 'plan', 0, [])
    const files = await git(root, [
      'ls-tree',
      '-r',
      '--name-only',
      checkpoint.sha,
    ])

    assert.match(files, /\.pi\/epics\/runs\/run-1\/plan\.md/)
    assert.doesNotMatch(files, /^plan\.md$/m)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
