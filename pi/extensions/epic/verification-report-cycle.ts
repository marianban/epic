import type {
  TaskVerificationRecord,
  VerificationCycle,
} from './verification-types.ts'
import { currentVerificationProblems } from './verification-problems.ts'

/** Compose evidence-only retries on unchanged code, retaining each observation's original provenance. */
export function reportVerificationCycle(
  record: TaskVerificationRecord,
  identity: string
): VerificationCycle | undefined {
  const latest = [...record.cycles]
    .reverse()
    .find((c) => c.identity === identity && !c.invalidated)
  if (!latest || latest.kind !== 'targeted' || !latest.completed) return latest
  const index = record.cycles.indexOf(latest)
  const baseline = record.cycles
    .slice(0, index)
    .reverse()
    .find(
      (c) =>
        c.kind !== 'targeted' &&
        c.completed &&
        !c.invalidated &&
        c.candidateRevision === latest.candidateRevision &&
        c.plan?.criterionVersion === latest.plan?.criterionVersion &&
        c.plan?.version === latest.plan?.version
    )
  if (!baseline) return latest
  const updates = record.cycles.slice(
    record.cycles.indexOf(baseline) + 1,
    index + 1
  )
  if (
    updates.some(
      (c) => c.candidateRevision !== baseline.candidateRevision || c.invalidated
    )
  )
    return latest
  const evidence = new Map(baseline.evidence.map((e) => [e.obligationId, e]))
  for (const cycle of updates.filter((c) => c.completed))
    for (const entry of cycle.evidence) evidence.set(entry.obligationId, entry)
  return {
    ...latest,
    plan: baseline.plan,
    review: baseline.review,
    evidenceReviews: [baseline, ...updates].flatMap((c) => c.evidenceReviews),
    probes: [baseline, ...updates].flatMap((c) => c.probes ?? []),
    smoke: [...updates].reverse().find((c) => c.smoke)?.smoke ?? baseline.smoke,
    evidence: [...evidence.values()],
    problems: currentVerificationProblems([baseline, ...updates]),
    artifacts: [...new Set([baseline, ...updates].flatMap((c) => c.artifacts))],
  }
}
