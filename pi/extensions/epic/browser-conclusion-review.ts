import type { BrowserConclusion, BrowserProbe } from './browser-evidence-types.ts'

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** Validate the recorded interpretation separately from runtime probe provenance. */
export function assertConclusionReview(c: BrowserConclusion): void {
  if (!Array.isArray(c.observations) || !c.selfCheck)
    throw new Error('Incompatible browser conclusion: structured observations and selfCheck are required; no migration was applied.')
  if (c.observations.some(o => !o ||
    ![o.target, o.targetIdentity, o.evidenceId, o.property, o.value].every(nonEmpty)))
    throw new Error('Structured observations require target, targetIdentity, evidenceId, property, and observed value.')
  if (![c.selfCheck.alternativeExplanation, c.selfCheck.counterEvidence, c.selfCheck.reasoning].every(nonEmpty) ||
    typeof c.selfCheck.wouldPassIfBroken !== 'boolean')
    throw new Error('Self-check requires alternativeExplanation, counterEvidence, wouldPassIfBroken, and reasoning.')
  if (c.outcome !== 'inconclusive' && !c.observations.length)
    throw new Error('Pass/fail/likely-fail requires structured observations of the target.')
  if (c.outcome === 'pass' && c.selfCheck.wouldPassIfBroken)
    throw new Error('A probe that would pass if the expected behavior were broken cannot establish a pass; strengthen the probe or report likely-fail/inconclusive.')
  if (c.observations.some(o => !c.evidenceIds.includes(o.evidenceId)))
    throw new Error('Structured observations must reference cited evidence IDs.')
}

export function assertConclusionObservations(c: BrowserConclusion, probes: BrowserProbe[]): void {
  const records = probes.flatMap(p => [
    ...p.images.map(i => ({ ...i, probeId: p.id })),
    ...p.observations.filter(o => o.kind !== 'fixture').map(o => ({ ...o, probeId: p.id })),
  ])
  if (c.observations.some(o => !records.some(r => r.id === o.evidenceId)))
    throw new Error('Structured observations require image or non-fixture observation IDs, not probe IDs.')
  if (records.some(r => c.evidenceIds.includes(r.id) && !c.observations.some(o => o.evidenceId === r.id)))
    throw new Error('Describe the target and observed property for every cited measurement/image.')
  if (c.outcome !== 'inconclusive' && c.basis === 'motion') {
    const temporalTarget = c.observations.some(before => c.observations.some(after => {
      if (before.target !== after.target || before.targetIdentity !== after.targetIdentity || before.property !== after.property) return false
      const a = records.find(r => r.id === before.evidenceId)
      const b = records.find(r => r.id === after.evidenceId)
      return a && b && a.probeId === b.probeId && a.timestamp < b.timestamp
    }))
    if (!temporalTarget)
      throw new Error('Motion requires observations of the same target identity and property at different times in the same probe.')
  }
}
