import assert from 'node:assert/strict'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { canonicalTemporaryPaths } from '../pi/extensions/epic/implementer-sandbox.ts'

test('implementer sandbox allows canonical temporary directory aliases', () => {
  const paths = canonicalTemporaryPaths()

  assert.ok(paths.includes(path.resolve(os.tmpdir())))
  assert.ok(paths.includes('/tmp'))
  assert.ok(paths.includes('/var/tmp'))

  if (process.platform === 'darwin') {
    assert.ok(paths.includes('/private/tmp'))
    assert.ok(paths.includes('/private/var/tmp'))
  }
})
