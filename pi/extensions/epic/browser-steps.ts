import type { Page } from 'playwright-core'
import { executePlaywrightCode } from './browser-playwright.ts'
import { holdBrowserKeys } from './browser-key-hold.ts'
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
  else if (step.action === 'mouse_down') await page.mouse.down({ button: step.button })
  else if (step.action === 'mouse_up') await page.mouse.up({ button: step.button })
  else if (step.action === 'click_at') await page.mouse.click(step.x, step.y, { button: step.button })
  else if (step.action === 'hold') await holdBrowserKeys(page, step, operation)
  else if (step.action === 'resize') {
    // Browser code stays in strings so coverage instrumentation cannot inject Node-only helpers.
    const viewportExpression = '({ width: innerWidth, height: innerHeight })'
    const before = await page.evaluate<{ width: number; height: number }>(viewportExpression)
    await page.setViewportSize({ width: step.width, height: step.height })
    const after = await page.evaluate<{ width: number; height: number }>(viewportExpression)
    if (after.width !== step.width || after.height !== step.height)
      throw new Error(`Viewport resize was not applied: requested ${step.width}×${step.height}, observed ${after.width}×${after.height}.`)
    return { kind: 'observation', value: { before, after } }
  } else if (step.action === 'playwright') {
    return { kind: 'observation', value: await executePlaywrightCode(page, step.code, operation) }
  } else if (step.action === 'wait') {
    if (step.durationMs >= timeout)
      throw new Error('Wait exceeds remaining verification deadline.')
    await page.waitForTimeout(step.durationMs)
  } else if (step.action === 'visible') {
    await page.locator(step.selector).waitFor({ state: 'visible', timeout })
    return { kind: 'assertion', value: true, passed: true }
  } else if (step.action === 'text') {
    await page.waitForFunction(
      '({ selector, value }) => document.querySelector(selector)?.textContent === value',
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
