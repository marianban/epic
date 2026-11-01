import { Script } from 'node:vm'
import type { Page } from 'playwright-core'
import type { VerificationOperation } from './verification-types.ts'

/** Trusted verifier code, not a security sandbox. The probe owns page cleanup. */
export async function executePlaywrightCode(
  page: Page,
  code: string,
  operation: VerificationOperation
): Promise<unknown> {
  operation.signal.throwIfAborted()
  const timeoutMs = operation.remainingMs()
  page.setDefaultTimeout(timeoutMs)
  page.setDefaultNavigationTimeout(timeoutMs)
  const script = new Script(`(async () => {\n${code}\n})()`, {
    filename: 'verifier-playwright.js',
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  try {
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(operation.signal.reason)
      operation.signal.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => reject(new Error('Playwright step exceeded the remaining verification deadline.')), timeoutMs)
    })
    const result: unknown = await Promise.race([
      script.runInNewContext({ page, timeoutMs }, { timeout: timeoutMs }) as Promise<unknown>,
      cancelled,
    ])
    const json = JSON.stringify(result)
    if (json === undefined)
      throw new Error('Playwright code must return JSON-serializable measurements.')
    return JSON.parse(json) as unknown
  } finally {
    clearTimeout(timer)
    if (abort) operation.signal.removeEventListener('abort', abort)
  }
}
