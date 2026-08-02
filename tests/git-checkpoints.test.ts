import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import test from 'node:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { assertCleanWorktree } from '../pi/extensions/epic/git-checkpoints.ts'

const exec = promisify(execFile)

async function git(root: string, args: string[]): Promise<void> {
  await exec('git', args, { cwd: root })
}

test('clean-worktree checks ignore persisted epic state but reject application files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'epic-git-checkpoints-'))
  try {
    await git(root, ['init'])
    await git(root, ['config', 'user.name', 'Epic Test'])
    await git(root, ['config', 'user.email', 'epic-test@example.com'])
    await fs.mkdir(path.join(root, '.pi', 'epics', 'runs', 'run-1'), { recursive: true })
    await fs.writeFile(path.join(root, '.pi', 'epics', 'runs', 'run-1', 'state.json'), '{}\n')
    await git(root, ['add', '.'])
    await git(root, ['commit', '-m', 'initial'])

    await fs.writeFile(path.join(root, '.pi', 'epics', 'runs', 'run-1', 'state.json'), '{"updated":true}\n')
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
