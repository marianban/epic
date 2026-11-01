import type { Page } from 'playwright-core'
import type {
  BrowserStep,
  VerificationOperation,
} from './verification-types.ts'

/** Expressions and selectors remain model-chosen; the runtime records their results. */
export async function executeBrowserStep(
  page: Page,
  step: Exclude<BrowserStep, { action: 'capture' }>,
  operation: VerificationOperation
): Promise<
  | {
      kind: 'observation' | 'assertion' | 'fixture'
      value: unknown
      passed?: boolean
    }
  | undefined
> {
  const timeout = operation.remainingMs()
  if (step.action === 'click')
    await page.locator(step.selector).click({ timeout })
  else if (step.action === 'press')
    await page.locator(step.selector).press(step.value, { timeout })
  else if (step.action === 'key_down') await page.keyboard.down(step.key)
  else if (step.action === 'key_up') await page.keyboard.up(step.key)
  else if (step.action === 'pointer') await page.mouse.move(step.x, step.y)
  else if (step.action === 'wait') {
    if (step.durationMs >= timeout)
      throw new Error('Wait exceeds remaining verification deadline.')
    await page.waitForTimeout(step.durationMs)
  } else if (step.action === 'visible') {
    await page.locator(step.selector).waitFor({ state: 'visible', timeout })
    return { kind: 'assertion', value: true, passed: true }
  } else if (step.action === 'text') {
    await page.waitForFunction(
      ({ selector, value }) =>
        document.querySelector(selector)?.textContent === value,
      step,
      { timeout }
    )
    return {
      kind: 'assertion',
      value: await page.locator(step.selector).textContent(),
      passed: true,
    }
  } else if (
    step.action === 'inspect' ||
    step.action === 'observe' ||
    step.action === 'fixture'
  ) {
    const value: unknown = await page.evaluate(step.expression)
    return {
      kind:
        step.action === 'fixture'
          ? 'fixture'
          : step.action === 'inspect'
            ? 'assertion'
            : 'observation',
      value,
      ...(step.action === 'inspect' ? { passed: value === true } : {}),
    }
  }
}
