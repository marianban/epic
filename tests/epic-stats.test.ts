import assert from 'node:assert/strict'
import test from 'node:test'
import type { Theme } from '@earendil-works/pi-coding-agent'
import { EpicStats } from '../pi/extensions/epic/dashboard/components/epic-stats.ts'
import type { DashboardState } from '../pi/extensions/epic/dashboard/state.ts'
import { formatDuration } from '../pi/extensions/epic/dashboard/formatting.ts'

const identityTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme
test('epic stats duration formatter is stable', () => {
  assert.equal(formatDuration(0), '00:00')
})

test('epic stats uses the concise Time label', () => {
  const dashboard = {
    epic: {
      id: 'run',
      runDirectory: '/repo/.epic/run',
      name: 'Ship it',
      status: 'in-progress',
      agentTimeMs: 65_000,
      tasks: { completed: 1, total: 2, percent: 50 },
      criteria: { completed: 1, total: 2, percent: 50 },
      tokens: { total: 100 },
    },
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as DashboardState

  const output = new EpicStats(dashboard, identityTheme).render(100).join('\n')
  assert.match(output, /Time/)
  assert.doesNotMatch(output, /Agent time/)
  const incomplete: DashboardState = { ...dashboard, epic: { ...dashboard.epic, tokens: { total: 1_000, incomplete: true } } }
  for (const width of [60, 100]) {
    assert.match(new EpicStats(incomplete, identityTheme).render(width).join('\n'), /Tokens\s+≥1k/)
  }
  const unavailable = { ...dashboard, epic: { ...dashboard.epic, tokens: undefined } }
  assert.match(new EpicStats(unavailable, identityTheme).render(100).join('\n'), /Tokens\s+--/)
})
