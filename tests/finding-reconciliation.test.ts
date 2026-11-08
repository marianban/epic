import assert from 'node:assert/strict'
import test from 'node:test'
import { findingReviewContext, findingReviewInstructions, reconcileFindings, validateFindingHistory } from '../pi/extensions/epic/finding-reconciliation.ts'
import type { FindingDisposition, ReviewResult } from '../pi/extensions/epic/types.ts'
import type { FindingReviewRecord, RegisteredFinding } from '../pi/extensions/epic/verification-types.ts'

const finding = (id: string, message = 'Canvas sizing overrides Phaser FIT'): ReviewResult['findings'][number] => ({
  id, severity: 'major', category: 'layout', file: 'src/styles.css', message,
  failureScenario: 'Canvas overflows after resize', requiredFix: 'Let Phaser control sizing',
  affectedPaths: ['src/styles.css'], repairPaths: ['src/styles.css'],
})
const result = (findings: ReviewResult['findings'], reconciliation: FindingDisposition[]): ReviewResult => ({
  passed: !findings.some(f => f.severity !== 'suggestion'), summary: 'Current review', acceptanceCriteria: [], findings, reconciliation,
})
const disposition = (id: string, value: FindingDisposition['disposition'], extra: Partial<FindingDisposition> = {}): FindingDisposition => ({
  id, disposition: value, reason: 'Inspected current implementation', ...extra,
})
function initial() {
  let id = 0
  const context = findingReviewContext([], undefined)
  const accepted = reconcileFindings([], context, result([finding('new:1'), finding('new:2'), finding('new:3', 'Independent defect')], []), 'r1', () => `f${++id}`, true)
  const review: FindingReviewRecord = { id: 'r1', cycleId: 'c1', kind: 'semantic', context, result: accepted.result }
  return { ...accepted, review }
}
const noIds = () => { throw Error('Existing IDs must be reused') }

test('reworded findings retain stable IDs and updated feedback without mutating history', () => {
  const f = initial()
  const before = structuredClone(f)
  const accepted = reconcileFindings(f.findings, findingReviewContext(f.findings, 'f1'), result([
    finding('f1', 'Different wording for the same sizing defect'),
  ], [disposition('f1', 'open'), disposition('f2', 'not_assessed'), disposition('f3', 'not_assessed')]), 'r2', noIds, true)
  assert.equal(accepted.findings.length, 3)
  assert.equal(accepted.findings[0].feedback.message, 'Different wording for the same sizing defect')
  assert.equal(accepted.findings[0].originatingReviewId, 'r1')
  assert.equal(accepted.findings[0].latestReviewId, 'r2')
  assert.deepEqual(f, before)
})

test('duplicates merge while unrelated findings in the same file stay open', () => {
  const f = initial()
  const accepted = reconcileFindings(f.findings, findingReviewContext(f.findings, 'f1'), result([finding('f1')], [
    disposition('f1', 'open'), disposition('f2', 'superseded', { canonicalId: 'f1' }), disposition('f3', 'not_assessed'),
  ]), 'r2', noIds, true)
  assert.deepEqual(accepted.findings.map(f => [f.id, f.status, f.canonicalId]), [
    ['f1', 'open', undefined], ['f2', 'superseded', 'f1'], ['f3', 'open', undefined],
  ])
})

test('one repair can resolve multiple findings with current evidence and preserve unassessed findings', () => {
  const f = initial()
  const accepted = reconcileFindings(f.findings, findingReviewContext(f.findings, 'f1'), result([], [
    disposition('f1', 'resolved', { evidence: 'Current stylesheet removes both overrides' }),
    disposition('f2', 'resolved', { evidence: 'Current browser probe confirms centered 4:3 canvas' }),
    disposition('f3', 'not_assessed'),
  ]), 'r2', noIds, true)
  assert.deepEqual(accepted.findings.map(f => f.status), ['resolved', 'resolved', 'open'])
  assert.deepEqual(accepted.findings[2], f.findings[2])
})

test('a duplicate may supersede a new canonical issue and local references normalize together', () => {
  const f = initial()
  const accepted = reconcileFindings(f.findings, findingReviewContext(f.findings, 'f1'), result([finding('new:1')], [
    disposition('f1', 'superseded', { canonicalId: 'new:1' }), disposition('f2', 'superseded', { canonicalId: 'new:1' }), disposition('f3', 'not_assessed'),
  ]), 'r2', () => 'canonical', true)
  assert.equal(accepted.result.findings[0].id, 'canonical')
  assert.equal(accepted.result.reconciliation[0].canonicalId, 'canonical')
  assert.equal(accepted.findings[0].canonicalId, 'canonical')
})

test('review history replays exactly, rejecting changed registry or reused review identity', () => {
  const f = initial()
  validateFindingHistory(f.findings, [f.review])
  assert.throws(() => validateFindingHistory(f.findings, [f.review, f.review]), /persisted finding review/)
  const changed = structuredClone(f.findings)
  changed[0].status = 'resolved'
  assert.throws(() => validateFindingHistory(changed, [f.review]), /does not match/)
})

const invalidCases: [string, (registry: RegisteredFinding[]) => ReviewResult][] = [
  ['missing disposition', () => result([], [])],
  ['unknown ID', () => result([], [disposition('unknown', 'not_assessed'), disposition('f2', 'not_assessed'), disposition('f3', 'not_assessed')])],
  ['repeated disposition', () => result([], [disposition('f1', 'not_assessed'), disposition('f1', 'not_assessed'), disposition('f3', 'not_assessed')])],
  ['unassessed target', () => result([], ['f1', 'f2', 'f3'].map(id => disposition(id, 'not_assessed')))],
  ['resolution without evidence', () => result([], [disposition('f1', 'resolved'), disposition('f2', 'not_assessed'), disposition('f3', 'not_assessed')])],
  ['open without feedback', () => result([], [disposition('f1', 'open'), disposition('f2', 'not_assessed'), disposition('f3', 'not_assessed')])],
  ['closed feedback', () => result([finding('f1')], [disposition('f1', 'resolved', { evidence: 'Inspected' }), disposition('f2', 'not_assessed'), disposition('f3', 'not_assessed')])],
  ['repeated feedback', () => result([finding('f1'), finding('f1')], [disposition('f1', 'open'), disposition('f2', 'not_assessed'), disposition('f3', 'not_assessed')])],
  ['cycle', () => result([], [disposition('f1', 'superseded', { canonicalId: 'f2' }), disposition('f2', 'superseded', { canonicalId: 'f1' }), disposition('f3', 'not_assessed')])],
  ['closed canonical', () => result([], [disposition('f1', 'superseded', { canonicalId: 'f2' }), disposition('f2', 'resolved', { evidence: 'Inspected' }), disposition('f3', 'not_assessed')])],
  ['unsafe path', () => result([{ ...finding('f1'), repairPaths: ['../escape'] }], [disposition('f1', 'open'), disposition('f2', 'not_assessed'), disposition('f3', 'not_assessed')])],
  ['invalid new ID', () => result([finding('unexpected')], [disposition('f1', 'resolved', { evidence: 'Inspected' }), disposition('f2', 'not_assessed'), disposition('f3', 'not_assessed')])],
]
for (const [name, invalid] of invalidCases) {
  test(`invalid reconciliation (${name}) leaves input unchanged and allocates no IDs`, () => {
    const f = initial()
    const before = structuredClone(f.findings)
    let allocations = 0
    assert.throws(() => reconcileFindings(f.findings, findingReviewContext(f.findings, 'f1'), invalid(f.findings), 'r2', () => { allocations++; return 'unexpected-allocation' }, true))
    assert.equal(allocations, 0)
    assert.deepEqual(f.findings, before)
  })
}

test('review context carries provenance and instructions preserve focused scope', () => {
  const f = initial()
  const context = findingReviewContext(f.findings, 'f1')
  const prompt = findingReviewInstructions(context)
  assert.match(prompt, /not_assessed/)
  assert.match(prompt, /originatingReviewId/)
  assert.match(prompt, /new:1/)
  assert.match(prompt, /must assess its semantic target/)
  context.findings[0].feedback.message = 'Changed copy'
  assert.notEqual(context.findings[0].feedback.message, f.findings[0].feedback.message)
})
