import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { assertSuspectedFailure } from './evidence-outcome.ts'
import type {
  AcceptanceEvidence,
  VerificationPlan,
} from './verification-types.ts'

export async function validateAcceptanceEvidence(
  value: unknown,
  plan: VerificationPlan,
  identity: string,
  attempt: number,
  artifactRoot: string
): Promise<{ evidence: AcceptanceEvidence[]; problems: string[] }> {
  const evidence: AcceptanceEvidence[] = []
  const problems: string[] = []
  if (!Array.isArray(value))
    return { evidence, problems: ['Verifier returned no evidence array.'] }
  const duplicates = new Set(
    value.flatMap((v) =>
      v &&
      typeof v === 'object' &&
      typeof v.obligationId === 'string' &&
      value.filter((x) => x?.obligationId === v.obligationId).length > 1
        ? [v.obligationId as string]
        : []
    )
  )
  for (const item of value) {
    const result = item as AcceptanceEvidence | undefined
    const obligation = plan.obligations.find(
      (o) => o.id === result?.obligationId
    )
    try {
      if (
        !result ||
        !obligation ||
        duplicates.has(result.obligationId) ||
        result.criterionId !== obligation.criterionId ||
        result.expected !== obligation.expected ||
        result.method !== obligation.method ||
        result.identity !== identity ||
        result.attempt !== attempt ||
        typeof result.actual !== 'string' ||
        !result.actual.trim() ||
        !['pass', 'fail', 'likely-fail', 'inconclusive'].includes(result.outcome) ||
        !Array.isArray(result.artifacts)
      )
        throw new Error('Invalid, duplicate, or stale result.')
      if (
        result.outcome === 'inconclusive' &&
        !['human_only', 'blocked', 'not_attempted', 'inconclusive'].includes(
          String(result.gap)
        )
      )
        throw new Error('Missing evidence classification.')
      if (
        result.outcome !== 'inconclusive' &&
        (result.gap !== undefined || !result.artifacts.length)
      )
        throw new Error('Unsupported success/failure claim.')
      if (result.method === 'human_only' && result.outcome !== 'inconclusive')
        throw new Error('Human confirmation must be a recorded user decision.')
      assertSuspectedFailure(result.outcome, result.suspectedFailure)
      if (result.method === 'agent_browser' && !result.conclusion)
        throw new Error('Browser acceptance requires an explicit recorded conclusion.')
      for (const artifact of result.artifacts) {
        if (typeof artifact !== 'string')
          throw new Error('Invalid artifact reference.')
        const relative = path.relative(artifactRoot, artifact)
        if (relative.startsWith('..') || path.isAbsolute(relative))
          throw new Error('Artifact is outside this verification run.')
        const data = JSON.parse(await fs.readFile(artifact, 'utf8')) as {
          identity?: string
          attempt?: number
          obligationId?: string
          outcome?: string
          attachments?: string[]
          conclusion?: AcceptanceEvidence['conclusion']
          suspectedFailure?: AcceptanceEvidence['suspectedFailure']
        }
        if (
          data.identity !== identity ||
          data.attempt !== attempt ||
          data.obligationId !== result.obligationId ||
          data.outcome !== result.outcome ||
          JSON.stringify(data.suspectedFailure) !== JSON.stringify(result.suspectedFailure)
        )
          throw new Error(
            'Artifact does not establish the claimed observation.'
          )
        if (result.method === 'agent_browser' && JSON.stringify(data.conclusion) !== JSON.stringify(result.conclusion))
          throw new Error('Conclusion differs from its immutable artifact.')
        if (
          JSON.stringify(data.attachments) !==
          JSON.stringify(result.attachments)
        )
          throw new Error('Attachment provenance differs from the observation.')
      }
      for (const attachment of result.attachments ?? []) {
        const relative = path.relative(artifactRoot, attachment)
        if (
          relative.startsWith('..') ||
          path.isAbsolute(relative) ||
          !(await fs.stat(attachment)).isFile()
        )
          throw new Error('Missing or escaping evidence attachment.')
      }
      evidence.push(result)
    } catch (error) {
      problems.push(
        `${result?.obligationId ?? 'unknown'}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  for (const obligation of plan.obligations)
    if (!evidence.some((e) => e.obligationId === obligation.id))
      problems.push(`${obligation.id}: missing valid evidence.`)
  return { evidence, problems }
}
