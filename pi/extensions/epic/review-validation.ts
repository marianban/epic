import type { EpicTask, ReviewResult } from './types.ts'

const REVIEW_STATUSES = new Set([
  'met',
  'partially_met',
  'not_met',
  'manual_review_pending',
])

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function validateReviewResult(
  value: unknown,
  task: EpicTask
): ReviewResult {
  const result = record(value)
  if (
    !result ||
    typeof result.passed !== 'boolean' ||
    typeof result.summary !== 'string' ||
    typeof result.requiresPlanRevision !== 'boolean' ||
    !Array.isArray(result.findings) ||
    !Array.isArray(result.acceptanceCriteria)
  ) {
    throw new Error('Reviewer returned invalid repair feedback.')
  }

  for (const value of result.acceptanceCriteria) {
    const criterion = record(value)
    if (
      !criterion ||
      typeof criterion.criterion !== 'string' ||
      typeof criterion.status !== 'string' ||
      !REVIEW_STATUSES.has(criterion.status) ||
      typeof criterion.evidence !== 'string'
    ) {
      throw new Error('Reviewer returned invalid acceptance-criterion feedback.')
    }
  }

  for (const value of result.findings) {
    const finding = record(value)
    if (
      !finding ||
      !Array.isArray(finding.repairPaths) ||
      finding.repairPaths.length === 0 ||
      finding.repairPaths.some(
        (repairPath) =>
          typeof repairPath !== 'string' ||
          !task.scope.modify.includes(repairPath)
      )
    ) {
      throw new Error('Reviewer returned invalid or out-of-scope repair feedback.')
    }
  }

  if (
    result.passed === false &&
    result.findings.length === 0 &&
    result.requiresPlanRevision === false
  ) {
    throw new Error(
      'Reviewer failed semantic review without an actionable repair or plan revision.'
    )
  }

  return value as ReviewResult
}
