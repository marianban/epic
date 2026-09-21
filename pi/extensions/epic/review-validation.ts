import type { ReviewResult } from './types.ts'
import {
  isRepositoryRelativePath,
  isSafeRepairPath,
} from './review-paths.ts'

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

function repositoryPaths(
  value: unknown,
  allowEmpty: boolean
): value is string[] {
  return (
    Array.isArray(value) &&
    (allowEmpty || value.length > 0) &&
    value.every(isRepositoryRelativePath)
  )
}

export function validateReviewResult(value: unknown): ReviewResult {
  const result = record(value)
  if (
    !result ||
    typeof result.passed !== 'boolean' ||
    typeof result.summary !== 'string' ||
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
      throw new Error(
        'Reviewer returned invalid acceptance-criterion feedback.'
      )
    }
  }

  for (const value of result.findings) {
    const finding = record(value)
    if (
      !finding ||
      !repositoryPaths(finding.affectedPaths, false) ||
      !Array.isArray(finding.repairPaths) ||
      finding.repairPaths.length === 0 ||
      !finding.repairPaths.every(isSafeRepairPath) ||
      (finding.file !== undefined &&
        (!isRepositoryRelativePath(finding.file) ||
          !finding.affectedPaths.includes(finding.file)))
    ) {
      throw new Error(
        'Reviewer returned invalid or unsafe repair feedback.'
      )
    }
  }

  if (
    result.passed === false &&
    result.findings.length === 0
  ) {
    throw new Error(
      'Reviewer failed semantic review without an actionable repair.'
    )
  }

  return value as ReviewResult
}
