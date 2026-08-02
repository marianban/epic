import assert from 'node:assert/strict'
import test from 'node:test'
import { formatDuration } from '../pi/extensions/epic/dashboard/formatting.ts'
test('epic stats duration formatter is stable', () => {
  assert.equal(formatDuration(0), '00:00')
})
