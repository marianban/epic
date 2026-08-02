import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { getCurrentDiff, summarizeDiff } from '../pi/extensions/epic/diff.ts'

const execFileAsync = promisify(execFile)

async function git(root: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd: root })
}

test('summarizeDiff counts untracked-file style patches', () => {
  const summary = summarizeDiff(
    [
      'diff --git a/new.txt b/new.txt',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1,2 @@',
      '+first',
      '+second',
    ].join('\n')
  )

  assert.deepEqual(summary, {
    filesChanged: 1,
    linesAdded: 2,
    linesDeleted: 0,
  })
})

test('getCurrentDiff includes untracked files alongside tracked changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-epic-diff-'))
  try {
    await git(root, ['init'])
    await git(root, ['config', 'user.email', 'pi-epic@example.test'])
    await git(root, ['config', 'user.name', 'Pi Epic Tests'])
    await writeFile(join(root, 'tracked.txt'), 'before\n')
    await git(root, ['add', 'tracked.txt'])
    await git(root, ['commit', '-m', 'initial'])

    await writeFile(join(root, 'tracked.txt'), 'before\nafter\n')
    await writeFile(join(root, 'untracked.txt'), 'new\nfile\n')
    await writeFile(join(root, 'plan.md'), 'workflow plan\n')
    await mkdir(join(root, '.pi', 'epics'), { recursive: true })
    await writeFile(join(root, '.pi', 'epics', 'state.json'), '{}\n')

    const summary = summarizeDiff(await getCurrentDiff(root))
    assert.deepEqual(summary, {
      filesChanged: 2,
      linesAdded: 3,
      linesDeleted: 0,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
