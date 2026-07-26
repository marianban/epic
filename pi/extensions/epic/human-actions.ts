import { extractReviewInstructions } from './plan-review.ts'

export type HumanContinuation = 'approve' | 'review'

export function humanContinuation(markdown: string): HumanContinuation {
  return extractReviewInstructions(markdown).length > 0
    ? 'review'
    : 'approve'
}
