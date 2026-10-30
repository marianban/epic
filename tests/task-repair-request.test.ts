import assert from 'node:assert/strict'
import test from 'node:test'
import { latestTaskRepairRequest } from '../pi/extensions/epic/task-repair-request.ts'

test('repair shortcut binds the grant to the latest unresolved report and explicit allowance', () => {
  assert.deepEqual(latestTaskRepairRequest(
    { identity: 'latest-attempt', id: 'latest-report', readiness: 'issues_remaining' },
    { repairs: 1, timeMs: 300_000 }, false
  ), {
    kind: 'grant',
    identity: 'latest-attempt',
    reportId: 'latest-report',
    repairs: 1,
    timeMs: 300_000,
    reason: 'Repair unresolved issues in the latest task report.',
  })
})

test('repair shortcut rejects missing and already verified reports', () => {
  const allowance = { repairs: 1, timeMs: 300_000 }
  assert.throws(() => latestTaskRepairRequest(undefined, allowance, false), /No human-review report/)
  assert.throws(() => latestTaskRepairRequest(
    { identity: 'attempt', id: 'report', readiness: 'verified' }, allowance, false
  ), /already verified/)
})

test('repair shortcut rejects evidence gaps but permits recorded manual failures', () => {
  const report = { identity: 'attempt', id: 'report', readiness: 'needs_manual_confirmation' as const }
  const allowance = { repairs: 1, timeMs: 300_000 }
  assert.throws(() => latestTaskRepairRequest(report, allowance, false), /No actionable failure.*Review the unresolved evidence/)
  for (const readiness of ['verified', 'needs_manual_confirmation', 'issues_remaining'] as const) {
    assert.equal(latestTaskRepairRequest({ ...report, readiness }, allowance, true).kind, 'grant')
  }
})
