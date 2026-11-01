import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  AcceptanceEvidence,
  VerificationObligation,
} from './verification-types.ts'
import type {
  BrowserConclusion,
  BrowserProbe,
} from './browser-evidence-types.ts'

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export async function concludeBrowserProbe(input: {
  conclusion: BrowserConclusion
  obligation: VerificationObligation
  probes: BrowserProbe[]
  invocationId: string
  identity: string
  attempt: number
  artifactRoot: string
  nowMs(): number
}): Promise<AcceptanceEvidence> {
  const c = input.conclusion
  if (c.obligationId !== input.obligation.id)
    throw new Error('Conclusion identifies a different obligation.')
  if (
    !['pass', 'fail', 'unverified'].includes(c.outcome) ||
    !nonEmpty(c.explanation) ||
    !Array.isArray(c.limitations) ||
    c.limitations.some((v) => !nonEmpty(v)) ||
    !Array.isArray(c.evidenceIds) ||
    c.evidenceIds.some((v) => !nonEmpty(v)) ||
    new Set(c.evidenceIds).size !== c.evidenceIds.length ||
    !['observations', 'visual', 'motion'].includes(c.basis)
  )
    throw new Error(
      'Conclusion requires an outcome, explanation, limitations array, unique evidenceIds, and observations/visual/motion basis.'
    )
  if (
    c.outcome === 'unverified'
      ? !['blocked', 'not_attempted', 'inconclusive'].includes(String(c.gap))
      : c.gap !== undefined
  )
    throw new Error(
      'Only unverified conclusions require a blocked/not_attempted/inconclusive gap.'
    )
  const current = input.probes.filter(
    (p) =>
      p.obligationId === input.obligation.id &&
      p.invocationId === input.invocationId &&
      p.identity === input.identity &&
      p.attempt === input.attempt
  )
  const ids = new Set(c.evidenceIds)
  const available = new Set(
    current.flatMap((p) => [
      p.id,
      ...p.observations.map((o) => o.id),
      ...p.images.map((i) => i.id),
    ])
  )
  if (c.evidenceIds.some((id) => !available.has(id)))
    throw new Error(
      'Evidence reference is unknown, foreign, or stale; cite this obligation and invocation only.'
    )
  const cited = current.filter(
    (p) =>
      ids.has(p.id) ||
      p.observations.some((o) => ids.has(o.id)) ||
      p.images.some((i) => ids.has(i.id))
  )
  if (cited.length > 1 && !nonEmpty(c.separateExecutions))
    throw new Error(
      'Explain separateExecutions: these probes ran on independent fresh pages.'
    )
  if (c.outcome !== 'unverified' && !c.evidenceIds.length)
    throw new Error('Pass/fail conclusions require recorded evidence.')
  if (c.outcome === 'pass') {
    if (
      input.probes.some(
        (p) =>
          p.obligationId === input.obligation.id &&
          p.identity === input.identity &&
          p.runtimeErrors.length
      )
    )
      throw new Error(
        'Application/runtime errors prevent a pass in this verification cycle; report the defect.'
      )
    if (
      cited.some(
        (p) =>
          p.probeErrors.length || p.observations.some((o) => o.passed === false)
      )
    )
      throw new Error(
        'Cited probe has errors or failed assertions; correct the probe or report fail/unverified.'
      )
    const meaningful = cited.some(
      (p) =>
        p.images.some((i) => ids.has(i.id)) ||
        p.observations.some((o) => {
          if (!ids.has(o.id) || o.kind === 'fixture') return false
          const step = p.steps[o.stepIndex]
          if (step?.action === 'visible') return false
          if (
            step?.action === 'inspect' &&
            /^\s*(?:true|\(true\))\s*;?\s*$/.test(step.expression)
          )
            return false
          return true
        })
    )
    if (!meaningful)
      throw new Error(
        'A pass must cite measured observations or images; probe completion, fixtures, visibility, and inspect:true alone do not establish behavior.'
      )
  }
  if (
    c.outcome !== 'unverified' &&
    c.basis === 'visual' &&
    !cited.some((p) => p.images.some((i) => ids.has(i.id)))
  )
    throw new Error('Visual conclusions must cite captured image IDs.')
  if (c.outcome !== 'unverified' && c.basis === 'motion') {
    const temporal = cited.some((p) => {
      const times = [
        ...p.images.filter((i) => ids.has(i.id)),
        ...p.observations.filter((o) => ids.has(o.id) && o.kind !== 'fixture'),
      ].map((v) => v.timestamp)
      return times.length >= 2 && Math.max(...times) > Math.min(...times)
    })
    if (!nonEmpty(c.temporalComparison) || !temporal)
      throw new Error(
        'Motion conclusions require temporalComparison and at least two timed observations/images from the same probe.'
      )
  }
  const conclusion = {
    ...c,
    id: randomUUID(),
    invocationId: input.invocationId,
    timestamp: input.nowMs(),
  }
  const artifact = path.join(
    input.artifactRoot,
    `${conclusion.id}-conclusion.json`
  )
  const result: AcceptanceEvidence = {
    obligationId: input.obligation.id,
    criterionId: input.obligation.criterionId,
    expected: input.obligation.expected,
    actual: c.explanation,
    outcome: c.outcome,
    ...(c.gap ? { gap: c.gap } : {}),
    method: 'agent_browser',
    artifacts: [artifact],
    attachments: cited.flatMap((p) => [
      p.artifact,
      ...p.images.map((i) => i.path),
      ...(p.trace ? [p.trace] : []),
    ]),
    identity: input.identity,
    attempt: input.attempt,
    conclusion,
    reproduction: JSON.stringify(
      cited.map((p) => ({ probeId: p.id, steps: p.steps }))
    ),
  }
  // The conclusion and all referenced runtime records remain immutable on disk.
  await fs.writeFile(artifact, JSON.stringify(result, null, 2), { flag: 'wx' })
  return result
}
