import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Browser, Page } from 'playwright-core'
import type { BrowserExecutionInput } from './browser-execution.ts'
import type {
  BrowserStep,
  VerificationObligation,
} from './verification-types.ts'
import type {
  BrowserProbe,
  BrowserProbeLimits,
} from './browser-evidence-types.ts'
import { validateBrowserStep } from './verification-plan.ts'
import { captureFrames, validateCaptureBudget } from './browser-capture.ts'
import { executeBrowserStep } from './browser-steps.ts'

export async function runBrowserProbe(input: {
  browser: Browser
  execution: BrowserExecutionInput
  obligation: VerificationObligation
  steps: BrowserStep[]
  invocationId: string
  limits: BrowserProbeLimits
  ready(page: Page): Promise<void>
  monitor(page: Page, errors: string[]): void
}): Promise<BrowserProbe> {
  if (
    !Array.isArray(input.steps) ||
    !input.steps.length ||
    input.steps.length > 100
  )
    throw new Error('A browser probe requires 1–100 steps.')
  input.steps.forEach((step, i) => validateBrowserStep(step, `steps[${i}]`))
  validateCaptureBudget(input.steps, input.limits)
  const execution = input.execution
  execution.operation.remainingMs()
  const id = randomUUID()
  const probe: BrowserProbe = {
    id,
    obligationId: input.obligation.id,
    criterionId: input.obligation.criterionId,
    identity: execution.identity,
    attempt: execution.attempt,
    invocationId: input.invocationId,
    startedAt: execution.nowMs(),
    completedAt: execution.nowMs(),
    steps: input.steps,
    observations: [],
    images: [],
    runtimeErrors: [],
    probeErrors: [],
    artifact: path.join(execution.artifactRoot, `${id}-probe.json`),
    trace: path.join(execution.artifactRoot, `${id}-trace.zip`),
  }
  const context = await input.browser.newContext()
  let tracing = false
  let captureDurationMs = 0
  let abortClose: Promise<void> | undefined
  const abort = () => {
    abortClose = context.close().catch((error: unknown) => {
      probe.probeErrors.push(String(error))
    })
  }
  execution.operation.signal.addEventListener('abort', abort, { once: true })
  try {
    execution.operation.remainingMs()
    await context.tracing.start({ screenshots: true, snapshots: true })
    tracing = true
    const page = await context.newPage()
    input.monitor(page, probe.runtimeErrors)
    await input.ready(page)
    for (const [stepIndex, step] of input.steps.entries()) {
      execution.operation.remainingMs()
      if (step.action === 'capture') {
        const start = execution.nowMs()
        await captureFrames({
          page,
          step,
          stepIndex,
          artifactRoot: execution.artifactRoot,
          operation: execution.operation,
          nowMs: execution.nowMs,
          images: probe.images,
          maxDurationMs: input.limits.maxCaptureDurationMs - captureDurationMs,
        })
        captureDurationMs += execution.nowMs() - start
      } else {
        const observation = await executeBrowserStep(
          page,
          step,
          execution.operation
        )
        if (observation)
          probe.observations.push({
            ...observation,
            id: randomUUID(),
            stepIndex,
            timestamp: execution.nowMs(),
          })
      }
      if (probe.runtimeErrors.length) break
    }
  } catch (error) {
    probe.probeErrors.push(
      error instanceof Error ? error.message : String(error)
    )
  } finally {
    execution.operation.signal.removeEventListener('abort', abort)
    try {
      if (tracing) await context.tracing.stop({ path: probe.trace })
      else probe.trace = ''
    } catch (error) {
      probe.probeErrors.push(`Trace cleanup: ${String(error)}`)
      probe.trace = ''
    } finally {
      try {
        if (abortClose) await abortClose
        else await context.close()
      } catch (error) {
        probe.probeErrors.push(`Context cleanup: ${String(error)}`)
      }
    }
    probe.completedAt = execution.nowMs()
    await fs.writeFile(probe.artifact, JSON.stringify(probe, null, 2), {
      flag: 'wx',
    })
  }
  return probe
}
