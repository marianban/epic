import { setTimeout as delay } from 'node:timers/promises'
import type { Page } from 'playwright-core'
import type { BrowserStep, VerificationOperation } from './verification-types.ts'

export async function holdBrowserKeys(
  page: Page,
  step: Extract<BrowserStep, { action: 'hold' }>,
  operation: VerificationOperation
): Promise<void> {
  operation.signal.throwIfAborted()
  if (step.durationMs >= operation.remainingMs())
    throw new Error('Hold exceeds remaining verification deadline.')
  const attemptedKeys: string[] = []
  const errors: unknown[] = []
  try {
    for (const key of step.keys) {
      operation.signal.throwIfAborted()
      attemptedKeys.push(key)
      await page.keyboard.down(key)
    }
    if (step.durationMs >= operation.remainingMs())
      throw new Error('Hold exceeds remaining verification deadline.')
    await delay(step.durationMs, undefined, { signal: operation.signal })
    operation.remainingMs()
  } catch (error) {
    errors.push(error)
  } finally {
    // Release sequentially in reverse order so modifiers outlive their keys.
    for (const key of attemptedKeys.reverse()) {
      try {
        await page.keyboard.up(key)
      } catch (error) {
        errors.push(error)
      }
    }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1)
    throw new AggregateError(errors, 'Key hold failed; key release errors are included.', { cause: errors[0] })
}
