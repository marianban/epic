import type { ReviewResult } from './types.ts'
import type { FindingReviewContext, FindingReviewRecord, RegisteredFinding } from './verification-types.ts'
import { validateReviewResult } from './review-validation.ts'

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && !!value.trim()
const localId = (id: string) => /^new:[1-9]\d*$/.test(id)

export function findingReviewContext(findings: RegisteredFinding[], targetId: string | undefined): FindingReviewContext {
  return structuredClone({ findings: findings.filter(f => f.status === 'open'), targetId })
}

export function findingReviewInstructions(context: FindingReviewContext): string {
  return [
    'Reconcile the supplied open findings during this review. Return reconciliation with exactly one entry per supplied ID: {id, disposition: "open" | "resolved" | "superseded" | "not_assessed", reason, evidence?, canonicalId?}.',
    'Keep the same ID when the same defect is reworded; open requires updated feedback in findings. Report each distinct defect once, even if it affects the same file. New findings use response-local IDs new:1, new:2, etc. Superseded requires canonicalId referencing an open finding in this context or response, never another superseded finding. Merge only the same underlying defect, not merely similar text or location.',
    'Resolved requires evidence describing the current code or current verification that establishes resolution. Missing behavioral evidence or historical measurements cannot prove a current defect or resolution. Focused review may mark unrelated findings not_assessed with a reason, but must assess its semantic target. Findings not_assessed must not be emitted again. Suggestions remain non-actionable.',
    `Open findings and provenance: ${JSON.stringify(context)}`,
  ].join('\n\n')
}

/** Pure transition: validate everything before assigning IDs or changing persisted state. */
export function reconcileFindings(
  registry: RegisteredFinding[], context: FindingReviewContext, value: unknown,
  reviewId: string, createFindingId: () => string, allowLocalIds: boolean
): { result: ReviewResult; findings: RegisteredFinding[] } {
  const result = validateReviewResult(value)
  const open = new Map(context.findings.map(f => [f.id, f]))
  if (open.size !== context.findings.length || context.findings.some(f => f.status !== 'open'))
    throw new Error('Invalid finding review context.')
  const active = registry.filter(f => f.status === 'open')
  if (JSON.stringify(active) !== JSON.stringify(context.findings))
    throw new Error('Stale finding review context.')
  const feedback = new Map(result.findings.map(f => [f.id, f]))
  if (feedback.size !== result.findings.length) throw new Error('Repeated finding ID.')
  const dispositions = new Map(result.reconciliation.map(d => [d?.id, d]))
  if (dispositions.size !== result.reconciliation.length || dispositions.size !== open.size)
    throw new Error('Reconciliation requires exactly one disposition for every open finding.')
  for (const [id, d] of dispositions) {
    if (!open.has(id)) throw new Error('Unknown finding disposition.')
    if ((d.disposition === 'open') !== feedback.has(id))
      throw new Error('Only open dispositions may supply existing finding feedback.')
    if (id === context.targetId && d.disposition === 'not_assessed')
      throw new Error('Focused review must assess its semantic target.')
  }
  if (context.targetId && !open.has(context.targetId)) throw new Error('Unknown semantic repair target.')
  for (const id of feedback.keys()) {
    if (!open.has(id) && (registry.some(f => f.id === id) || (allowLocalIds && !localId(id)) || (!allowLocalIds && localId(id))))
      throw new Error('New finding requires a fresh response-local ID.')
  }
  for (const d of dispositions.values()) {
    if (d.disposition !== 'superseded') continue
    const canonical = d.canonicalId as string
    if (canonical === d.id || !(feedback.has(canonical) || dispositions.get(canonical)?.disposition === 'not_assessed'))
      throw new Error('Supersession must reference a canonical open finding, without cycles or chains.')
  }
  const mapping = new Map<string, string>()
  const used = new Set(registry.map(f => f.id))
  for (const id of feedback.keys()) {
    if (open.has(id)) continue
    const assigned = allowLocalIds ? createFindingId() : id
    if (!nonEmpty(assigned) || localId(assigned) || used.has(assigned)) throw new Error('Finding ID generator returned an invalid or repeated ID.')
    used.add(assigned)
    mapping.set(id, assigned)
  }
  const normalized: ReviewResult = {
    ...structuredClone(result),
    findings: result.findings.map(f => ({ ...structuredClone(f), id: mapping.get(f.id) ?? f.id })),
    reconciliation: result.reconciliation.map(d => ({ ...d, ...(d.canonicalId ? { canonicalId: mapping.get(d.canonicalId) ?? d.canonicalId } : {}) })),
  }
  const findings = structuredClone(registry)
  for (const d of normalized.reconciliation) {
    const entry = findings.find(f => f.id === d.id)
    if (!entry) throw new Error('Reconciled finding disappeared.')
    if (d.disposition === 'not_assessed') continue
    entry.latestReviewId = reviewId
    if (d.disposition === 'open') {
      const updated = normalized.findings.find(f => f.id === d.id)
      if (!updated) throw new Error('Open finding feedback disappeared.')
      entry.feedback = updated
    } else {
      entry.status = d.disposition
      if (d.disposition === 'superseded') entry.canonicalId = d.canonicalId
    }
  }
  for (const finding of normalized.findings) {
    if (!open.has(finding.id)) findings.push({ id: finding.id, feedback: finding, status: 'open', originatingReviewId: reviewId, latestReviewId: reviewId })
  }
  // Keep aliases pointing directly to the surviving canonical finding when it is merged later.
  for (const entry of findings) {
    if (entry.status !== 'superseded') continue
    const seen = new Set([entry.id])
    let canonical = findings.find(f => f.id === entry.canonicalId)
    while (canonical?.status === 'superseded') {
      if (seen.has(canonical.id)) throw new Error('Cyclic finding supersession.')
      seen.add(canonical.id)
      const canonicalId = canonical.canonicalId
      canonical = findings.find(f => f.id === canonicalId)
    }
    if (!canonical) throw new Error('Missing canonical finding.')
    entry.canonicalId = canonical.id
  }
  return { result: normalized, findings }
}

export function validateFindingHistory(findings: RegisteredFinding[], reviews: FindingReviewRecord[]): void {
  if (!Array.isArray(findings) || !Array.isArray(reviews)) throw new Error('Invalid persisted finding registry.')
  let replay: RegisteredFinding[] = []
  const ids = new Set<string>()
  for (const review of reviews) {
    if (!review || !nonEmpty(review.id) || ids.has(review.id) || !nonEmpty(review.cycleId) ||
        !['semantic', 'evidence'].includes(review.kind) || !review.context || !Array.isArray(review.context.findings))
      throw new Error('Invalid persisted finding review.')
    ids.add(review.id)
    replay = reconcileFindings(replay, review.context, review.result, review.id, () => { throw new Error('Persisted findings cannot use local IDs.') }, false).findings
  }
  if (JSON.stringify(replay) !== JSON.stringify(findings)) throw new Error('Persisted finding registry does not match review history.')
}
