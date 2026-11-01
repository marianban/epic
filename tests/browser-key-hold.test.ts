import assert from 'node:assert/strict'
import test from 'node:test'
import type { Page } from 'playwright-core'
import { executeBrowserStep } from '../pi/extensions/epic/browser-steps.ts'

function keyboardPage(keyboard: Pick<Page['keyboard'], 'down' | 'up'>): Page {
  return { keyboard } as Page
}

test('hold releases every attempted key after a partial key-down failure', async () => {
  const events: string[] = []
  const failure = new Error('key-down failed')
  const page = keyboardPage({
    down: async key => {
      events.push(`down:${key}`)
      if (key === 'Space') throw failure
    },
    up: async key => { events.push(`up:${key}`) },
  })
  await assert.rejects(executeBrowserStep(page,
    { action: 'hold', keys: ['ArrowRight', 'Space'], durationMs: 100 },
    { signal: new AbortController().signal, remainingMs: () => 1000 }
  ), error => error === failure)
  assert.deepEqual(events, ['down:ArrowRight', 'down:Space', 'up:Space', 'up:ArrowRight'])
})

test('hold releases keys promptly on cancellation and surfaces all release failures', async () => {
  const controller = new AbortController()
  const events: string[] = []
  const releaseFailure = new Error('release failed')
  const page = keyboardPage({
    down: async key => {
      events.push(`down:${key}`)
      if (key === 'Space') setImmediate(() => controller.abort(new Error('cancel hold')))
    },
    up: async key => {
      events.push(`up:${key}`)
      if (key === 'Space') throw releaseFailure
    },
  })
  await assert.rejects(executeBrowserStep(page,
    { action: 'hold', keys: ['ArrowRight', 'Space'], durationMs: 10000 },
    { signal: controller.signal, remainingMs: () => 20000 }
  ), error => error instanceof AggregateError &&
    error.errors[0].name === 'AbortError' && error.errors[1] === releaseFailure)
  assert.deepEqual(events, ['down:ArrowRight', 'down:Space', 'up:Space', 'up:ArrowRight'])
})

test('hold checks its deadline before input and again after pressing keys', async () => {
  const events: string[] = []
  let remainingMs = 100
  const page = keyboardPage({
    down: async key => { events.push(`down:${key}`); remainingMs = 10 },
    up: async key => { events.push(`up:${key}`) },
  })
  const operation = { signal: new AbortController().signal, remainingMs: () => remainingMs }
  await assert.rejects(executeBrowserStep(page,
    { action: 'hold', keys: ['Space'], durationMs: 100 }, operation
  ), /deadline/)
  assert.deepEqual(events, [])
  await assert.rejects(executeBrowserStep(page,
    { action: 'hold', keys: ['Space'], durationMs: 50 }, operation
  ), /deadline/)
  assert.deepEqual(events, ['down:Space', 'up:Space'])
})
