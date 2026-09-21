import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { getCurrentDiff, getTaskDiff, hashTaskDiff, summarizeDiff } from '../pi/extensions/epic/diff.ts'

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

test('task diff includes committed and working-tree changes while excluding epic state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-epic-task-diff-'))
  try {
    await git(root, ['init'])
    await git(root, ['config', 'user.email', 'pi-epic@example.test'])
    await git(root, ['config', 'user.name', 'Pi Epic Tests'])
    await writeFile(join(root, 'theme.css'), 'black\n')
    await mkdir(join(root, '.pi', 'epics'), { recursive: true })
    await writeFile(join(root, '.pi', 'epics', 'state.json'), '{}\n')
    await git(root, ['add', '.'])
    await git(root, ['commit', '-m', 'baseline'])
    const baseline = String((await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout).trim()

    await writeFile(join(root, 'theme.css'), 'blue\n')
    await git(root, ['add', 'theme.css'])
    await git(root, ['commit', '-m', 'user color'])
    await writeFile(join(root, 'game.js'), 'export {}\n')
    await writeFile(join(root, '.pi', 'epics', 'state.json'), '{"updated":true}\n')

    const diff = await getTaskDiff(root, baseline)
    assert.match(diff, /theme\.css/)
    assert.match(diff, /game\.js/)
    assert.doesNotMatch(diff, /\.pi\/epics\/state\.json/)
    assert.equal(hashTaskDiff(diff), hashTaskDiff(diff))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
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
    await mkdir(join(root, '.pi', 'epics', 'runs', 'run-1'), { recursive: true })
    await writeFile(
      join(root, '.pi', 'epics', 'runs', 'run-1', 'plan.md'),
      'workflow plan\n'
    )
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
