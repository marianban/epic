import { validateReviewResult } from './review-validation.ts'
import type { ReviewResult } from './types.ts'
import type { VerificationCycle } from './verification-types.ts'

export interface BrowserEvidenceAssessment {
  result: ReviewResult
  inspectedObligationIds: string[]
  limitations: string[]
}

export function browserEvidenceReviewInstructions(
  cycle: VerificationCycle
): string {
  return [
    'This is focused independent review of replacement browser evidence, not another full code review. Inspect the supplied criterion, raw probes and cited images against every new browser conclusion, using the evidence inspection instructions above. Report only related independently established code/configuration defects as repair findings. Unsupported claims or inability to inspect evidence must be recorded as limitations, not invented code defects.',
    `Review these obligations: ${cycle.evidence
      .filter((e) => e.method === 'agent_browser' && e.conclusion)
      .map((e) => e.obligationId)
      .join(', ')}.`,
    'Return JSON { result: ReviewResult, inspectedObligationIds: string[], limitations: string[] }. List an obligation as inspected only after opening its cited evidence and independently checking its claims. Every unsupported conclusion, missing image, or incomplete inspection must appear in limitations. Do not modify files.',
  ].join('\n\n')
}

export function validateBrowserEvidenceAssessment(
  value: unknown,
  cycle: VerificationCycle
): BrowserEvidenceAssessment {
  if (!value || typeof value !== 'object')
    throw new Error('Invalid browser evidence assessment.')
  const assessment = value as BrowserEvidenceAssessment
  const ids = cycle.evidence
    .filter((e) => e.method === 'agent_browser' && e.conclusion)
    .map((e) => e.obligationId)
  if (
    !Array.isArray(assessment.inspectedObligationIds) ||
    assessment.inspectedObligationIds.some((id) => !ids.includes(id)) ||
    new Set(assessment.inspectedObligationIds).size !==
      assessment.inspectedObligationIds.length ||
    !Array.isArray(assessment.limitations) ||
    assessment.limitations.some((s) => typeof s !== 'string' || !s.trim())
  )
    throw new Error(
      'Invalid browser evidence inspection coverage or limitations.'
    )
  validateReviewResult(assessment.result)
  return assessment
}
