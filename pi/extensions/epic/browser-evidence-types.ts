import type { BrowserStep, EvidenceGap, EvidenceOutcome, SuspectedFailure } from './verification-types.ts'

export interface BrowserProbeLimits {
  maxFrames: number
  maxCaptureDurationMs: number
}

export interface ProbeObservation {
  id: string
  stepIndex: number
  timestamp: number
  kind: 'observation' | 'assertion' | 'fixture'
  value: unknown
  passed?: boolean
}

export interface ProbeImage {
  id: string
  stepIndex: number
  timestamp: number
  width: number
  height: number
  selector?: string
  path: string
}

export interface BrowserProbe {
  id: string
  obligationId: string
  criterionId: string
  identity: string
  attempt: number
  invocationId: string
  startedAt: number
  completedAt: number
  steps: BrowserStep[]
  observations: ProbeObservation[]
  images: ProbeImage[]
  runtimeErrors: string[]
  probeErrors: string[]
  artifact: string
  trace: string
}

export interface ConclusionObservation {
  /** Stable subject name shared by observations of the same target. */
  target: string
  /** Distinguishing appearance/location, selector, or state path. */
  targetIdentity: string
  evidenceId: string
  property: string
  /** Observed value, including units/coordinate frame where applicable. */
  value: string
}

export interface ConclusionSelfCheck {
  alternativeExplanation: string
  counterEvidence: string
  wouldPassIfBroken: boolean
  reasoning: string
}

export interface BrowserConclusion {
  obligationId: string
  outcome: EvidenceOutcome
  suspectedFailure?: SuspectedFailure
  gap?: EvidenceGap
  evidenceIds: string[]
  explanation: string
  observations: ConclusionObservation[]
  selfCheck: ConclusionSelfCheck
  limitations: string[]
  basis: 'observations' | 'visual' | 'motion'
  /** Required when citing more than one fresh-page probe. */
  separateExecutions?: string
  /** Required for motion; cite at least two timed observations in one probe. */
  temporalComparison?: string
}

export interface RecordedBrowserConclusion extends BrowserConclusion {
  id: string
  invocationId: string
  timestamp: number
}

export interface BrowserProbeResponse {
  probe: BrowserProbe
  images: { id: string; mimeType: 'image/png'; data: string }[]
}
