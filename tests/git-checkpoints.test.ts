import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import test from 'node:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  assertCleanWorktree,
  bootstrapEpicGitignore,
  validateTaskDelta,
} from '../pi/extensions/epic/git-checkpoints.ts'
import type { EpicTask } from '../pi/extensions/epic/types.ts'

const exec = promisify(execFile)

async function git(root: string, args: string[]): Promise<void> {
  await exec('git', args, { cwd: root })
}

async function gitOutput(root: string, args: string[]): Promise<string> {
  return String((await exec('git', args, { cwd: root })).stdout).trim()
}

function scopedTask(
  scope: Partial<EpicTask['scope']> = {}
): EpicTask {
  return {
    id: 'T1',
    title: 'Task one',
    objective: 'Test task',
    scope: {
      read: [],
      modify: [],
      create: [],
      delete: [],
      ...scope,
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

test('clean-worktree checks ignore persisted epic state but reject application files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'epic-git-checkpoints-'))
  try {
    await git(root, ['init'])
    await git(root, ['config', 'user.name', 'Epic Test'])
    await git(root, ['config', 'user.email', 'epic-test@example.com'])
    await bootstrapEpicGitignore(root)
    await fs.mkdir(path.join(root, '.pi', 'epics', 'runs', 'run-1'), { recursive: true })
    await fs.writeFile(path.join(root, '.pi', 'epics', 'runs', 'run-1', 'state.json'), '{}\n')
    await git(root, ['add', '.'])
    await git(root, ['commit', '-m', 'initial'])

    await fs.writeFile(path.join(root, '.pi', 'epics', 'runs', 'run-1', 'state.json'), '{"updated":true}\n')
    await assertCleanWorktree(root)

    await fs.writeFile(path.join(root, '.pi', 'epics', 'runs', 'run-1', '.DS_Store'), 'finder metadata\n')
    await assertCleanWorktree(root)

    await fs.writeFile(path.join(root, '.DS_Store'), 'finder metadata\n')
    await assert.rejects(
      () => assertCleanWorktree(root),
      /Epic checkpoints require a clean index and worktree.*\.DS_Store/
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('task delta validates staged, unstaged, and untracked scoped creates', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'epic-git-delta-'))
  try {
    await git(root, ['init'])
    await git(root, ['config', 'user.name', 'Epic Test'])
    await git(root, ['config', 'user.email', 'epic-test@example.com'])
    await fs.writeFile(path.join(root, 'README.md'), 'initial\n')
    await git(root, ['add', 'README.md'])
    await git(root, ['commit', '-m', 'initial'])
    const baseline = await gitOutput(root, ['rev-parse', 'HEAD'])

    await fs.writeFile(path.join(root, 'package.json'), '{}\n')
    await git(root, ['add', 'package.json'])
    await fs.writeFile(path.join(root, 'package-lock.json'), '{}\n')

    assert.deepEqual(
      (await validateTaskDelta(
        root,
        baseline,
        scopedTask({ create: ['package.json', 'package-lock.json'] })
      )).sort(),
      ['package-lock.json', 'package.json']
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('task delta validates nested untracked files against file-level create scope', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'epic-git-delta-'))
  try {
    await git(root, ['init'])
    await git(root, ['config', 'user.name', 'Epic Test'])
    await git(root, ['config', 'user.email', 'epic-test@example.com'])
    await fs.writeFile(path.join(root, 'README.md'), 'initial\n')
    await git(root, ['add', 'README.md'])
    await git(root, ['commit', '-m', 'initial'])
    const baseline = await gitOutput(root, ['rev-parse', 'HEAD'])

    await fs.mkdir(path.join(root, 'src', 'game'), { recursive: true })
    await fs.writeFile(path.join(root, 'src', 'main.js'), 'export {}\n')
    await fs.writeFile(path.join(root, 'src', 'game', 'ArkanoidScene.js'), 'export {}\n')

    assert.deepEqual(
      (await validateTaskDelta(
        root,
        baseline,
        scopedTask({ create: ['src/main.js', 'src/game/ArkanoidScene.js'] })
      )).sort(),
      ['src/game/ArkanoidScene.js', 'src/main.js']
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('task delta rejects a moved HEAD and out-of-scope application paths', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'epic-git-delta-'))
  try {
    await git(root, ['init'])
    await git(root, ['config', 'user.name', 'Epic Test'])
    await git(root, ['config', 'user.email', 'epic-test@example.com'])
    await fs.writeFile(path.join(root, 'README.md'), 'initial\n')
    await git(root, ['add', 'README.md'])
    await git(root, ['commit', '-m', 'initial'])
    const baseline = await gitOutput(root, ['rev-parse', 'HEAD'])

    await fs.writeFile(path.join(root, 'README.md'), 'changed\n')
    await assert.rejects(
      () => validateTaskDelta(root, baseline, scopedTask()),
      /scope\.modify does not allow it/
    )

    await git(root, ['add', 'README.md'])
    await git(root, ['commit', '-m', 'move HEAD'])
    await assert.rejects(
      () => validateTaskDelta(root, baseline, scopedTask({ modify: ['README.md'] })),
      /HEAD moved since task baseline/
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('task delta rejects application paths that escape through symlinks', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'epic-git-delta-'))
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'epic-git-outside-'))
  try {
    await git(root, ['init'])
    await git(root, ['config', 'user.name', 'Epic Test'])
    await git(root, ['config', 'user.email', 'epic-test@example.com'])
    await fs.writeFile(path.join(root, 'README.md'), 'initial\n')
    await git(root, ['add', 'README.md'])
    await git(root, ['commit', '-m', 'initial'])
    const baseline = await gitOutput(root, ['rev-parse', 'HEAD'])
    await fs.symlink(outside, path.join(root, 'link'), 'dir')

    await assert.rejects(
      () => validateTaskDelta(root, baseline, scopedTask({ create: ['link'] })),
      /Task path escapes repository through symlink/
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(outside, { recursive: true, force: true })
  }
})
