import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Page } from 'playwright-core'
import type {
  BrowserStep,
  VerificationOperation,
} from './verification-types.ts'
import type {
  BrowserProbeLimits,
  ProbeImage,
} from './browser-evidence-types.ts'

export function validateCaptureBudget(
  steps: BrowserStep[],
  limits: BrowserProbeLimits
): void {
  let frames = 0
  let durationMs = 0
  for (const step of steps) {
    if (step.action === 'capture') {
      frames += step.count
      durationMs += (step.count - 1) * step.intervalMs
    }
    if ((step.action === 'wait' || step.action === 'hold') && step.durationMs > limits.maxCaptureDurationMs)
      throw new Error(`A ${step.action} may not exceed ${limits.maxCaptureDurationMs}ms.`)
  }
  if (frames > limits.maxFrames || durationMs > limits.maxCaptureDurationMs)
    throw new Error(
      `Capture budget exceeded: at most ${limits.maxFrames} frames over ${limits.maxCaptureDurationMs}ms per probe.`
    )
}

export async function captureFrames(input: {
  page: Page
  step: Extract<BrowserStep, { action: 'capture' }>
  stepIndex: number
  artifactRoot: string
  operation: VerificationOperation
  nowMs(): number
  images: ProbeImage[]
  maxDurationMs: number
}): Promise<void> {
  const deadline = input.nowMs() + input.maxDurationMs
  const remaining = () => {
    const ms = Math.min(input.operation.remainingMs(), deadline - input.nowMs())
    if (ms <= 0) throw new Error('Capture duration budget exhausted.')
    return ms
  }
  for (let i = 0; i < input.step.count; i++) {
    remaining()
    if (i > 0) {
      if (input.step.intervalMs >= remaining())
        throw new Error(
          'Frame interval exceeds remaining capture or verification deadline.'
        )
      await input.page.waitForTimeout(input.step.intervalMs)
    }
    const id = randomUUID()
    const target = input.step.selector
      ? input.page.locator(input.step.selector)
      : input.page
    const timestamp = input.nowMs()
    const data = await target.screenshot({ type: 'png', timeout: remaining() })
    const file = path.join(input.artifactRoot, `${id}-frame.png`)
    await fs.writeFile(file, data, { flag: 'wx' })
    // PNG IHDR stores the actual pixel dimensions, including selector crops.
    input.images.push({
      id,
      stepIndex: input.stepIndex,
      timestamp,
      width: data.readUInt32BE(16),
      height: data.readUInt32BE(20),
      ...(input.step.selector ? { selector: input.step.selector } : {}),
      path: file,
    })
  }
}
