import assert from 'node:assert/strict'
import test from 'node:test'
import { formatDuration } from '../pi/extensions/epic/dashboard/formatting.ts'
test('current task duration formatter is stable', () => {
  assert.equal(formatDuration(65_000), '01:05')
})
