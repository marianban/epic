import type {
  BrowserSmokeResult,
  CheckResult,
  CheckSuiteResult,
  Finding,
} from './types.ts'
import type { VerificationCycle } from './verification-types.ts'

const DIAGNOSTIC_PREVIEW_CHARS = 1200

function preview(value: string): string {
  return value.length > DIAGNOSTIC_PREVIEW_CHARS
    ? `${value.slice(0, DIAGNOSTIC_PREVIEW_CHARS)}\n[truncated; see evidence artifact]`
    : value
}

function summarizeFinding(finding: Finding) {
  const summary = { ...finding }
  delete summary.raw
  return summary
}

export function summarizeCheck(check: CheckResult) {
  const { stdoutPreview, stderrPreview, findings, ...status } = check
  return {
    ...status,
    findings: findings.map(summarizeFinding),
    ...(!check.passed && {
      stdoutPreview: preview(stdoutPreview),
      stderrPreview: preview(stderrPreview),
    }),
  }
}

export function summarizeCheckSuite(suite: CheckSuiteResult) {
  return {
    suite: suite.suite,
    passed: suite.passed,
    checks: suite.checks.map(summarizeCheck),
    deferredChecks: suite.deferredChecks,
  }
}

export function summarizeSmoke(smoke: BrowserSmokeResult) {
  return {
    passed: smoke.passed,
    url: smoke.url,
    findings: smoke.findings.map(summarizeFinding),
    screenshotPath: smoke.screenshotPath,
  }
}

/** Agent context excludes domain snapshots and duplicated raw check output. */
export function summarizeVerificationCycle(cycle: VerificationCycle) {
  return {
    id: cycle.id,
    identity: cycle.identity,
    attempt: cycle.attempt,
    checks: [cycle.fast, cycle.full]
      .filter((s) => s !== undefined)
      .map(summarizeCheckSuite),
    smoke: cycle.smoke && summarizeSmoke(cycle.smoke),
    evidence: cycle.evidence.map((evidence) => ({
      ...evidence,
      actual:
        evidence.outcome === 'pass' && evidence.artifacts.length && !evidence.conclusion
          ? 'Passed; see evidence artifact.'
          : preview(evidence.actual),
    })),
    probes: cycle.probes,
    review: cycle.review,
    problems: cycle.problems,
    artifacts: cycle.artifacts,
  }
}
