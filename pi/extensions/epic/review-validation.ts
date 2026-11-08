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
    !Array.isArray(result.reconciliation) ||
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

  const reconciledIds = new Set<string>()
  for (const value of result.reconciliation) {
    const disposition = record(value)
    if (!disposition || typeof disposition.id !== 'string' || !disposition.id.trim() ||
        reconciledIds.has(disposition.id) ||
        !['open', 'resolved', 'superseded', 'not_assessed'].includes(String(disposition.disposition)) ||
        typeof disposition.reason !== 'string' || !disposition.reason.trim() ||
        (disposition.disposition === 'resolved' && (typeof disposition.evidence !== 'string' || !disposition.evidence.trim())) ||
        (disposition.disposition === 'superseded'
          ? typeof disposition.canonicalId !== 'string' || !disposition.canonicalId.trim()
          : disposition.canonicalId !== undefined))
      throw new Error('Reviewer returned invalid finding reconciliation.')
    reconciledIds.add(disposition.id)
  }

  for (const value of result.findings) {
    const finding = record(value)
    if (
      !finding ||
      typeof finding.id !== 'string' || !finding.id.trim() ||
      !['blocker', 'major', 'minor', 'suggestion'].includes(String(finding.severity)) ||
      !['category', 'message', 'failureScenario', 'requiredFix'].every(k => typeof finding[k] === 'string' && (finding[k] as string).trim()) ||
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
    !result.findings.some(f => (f as { severity: string }).severity !== 'suggestion')
  ) {
    throw new Error(
      'Reviewer failed semantic review without an actionable repair.'
    )
  }

  if (result.passed && result.findings.some(f => (f as { severity: string }).severity !== 'suggestion'))
    throw new Error('Reviewer passed semantic review with actionable findings.')

  return value as ReviewResult
}
