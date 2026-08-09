import assert from 'node:assert/strict'
import test from 'node:test'
import type { Theme } from '@earendil-works/pi-coding-agent'
import { visibleWidth } from '@earendil-works/pi-tui'
import { Pipeline } from '../pi/extensions/epic/dashboard/components/pipeline.ts'
import type { PipelineDashboardState } from '../pi/extensions/epic/dashboard/types.ts'

const identityTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  inverse: (text: string) => text,
} as unknown as Theme

function state(): PipelineDashboardState {
  return {
    agents: [
      {
        role: 'implementer',
        provider: 'openai',
        model: 'gpt-long-model-name',
        thinking: 'high',
        status: 'idle',
        runCount: 2,
        agentTimeMs: 65_000,
        tokens: { total: 12_300 },
      },
      {
        role: 'plan-reviewer',
        status: 'idle',
        runCount: 0,
        agentTimeMs: 0,
      },
      {
        role: 'scout',
        status: 'running',
        runCount: 1,
        agentTimeMs: 1_000,
      },
      {
        role: 'reviewer',
        status: 'failed',
        runCount: 1,
        agentTimeMs: 2_000,
        tokens: { total: 4 },
      },
    ],
    models: [
      {
        id: '["openai","gpt-long-model-name"]',
        provider: 'openai',
        model: 'gpt-long-model-name',
        thinkingLevels: ['low', 'high'],
        roles: ['implementer', 'plan-reviewer'],
        status: 'idle',
        runCount: 2,
        agentTimeMs: 65_000,
        tokens: { total: 12_300 },
      },
    ],
  }
}

test('agents is selected initially and both tabs render their headers', () => {
  const component = new Pipeline(state(), identityTheme)
  const agents = component.render(120).join('\n')
  assert.match(agents, /PIPELINE/)
  assert.match(agents, /Agent.*Model.*Thinking.*Status.*Runs.*Time.*Tokens/)
  assert.match(agents, /Implementor/)
  assert.equal(component.getSelectedTab(), 'agents')

  component.handleInput('\t')
  const models = component.render(120).join('\n')
  assert.equal(component.getSelectedTab(), 'models')
  assert.match(models, /Model.*Provider.*Thinking.*Roles.*Status.*Runs.*Time.*Tokens/)
  assert.match(models, /Implementor, Plan Reviewer/)
})

test('numeric columns are right aligned and statuses retain icons and labels', () => {
  const lines = new Pipeline(state(), identityTheme).render(120)
  const row = lines.find((line) => line.includes('Implementor'))
  if (row === undefined) throw new Error('Expected implementer row.')
  assert.match(row, /Implementor.*Idle.*\s+2\s+01:05\s+12\.3k/)
  for (const label of ['○ Idle', '● Running', '✕ Failed']) {
    assert.match(lines.join('\n'), new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
})

test('tab selection wraps in both directions and setState preserves focus and selection', () => {
  const component = new Pipeline(state(), identityTheme)
  component.setFocused(true)
  component.handleInput('\x1b[Z')
  assert.equal(component.getSelectedTab(), 'models')
  component.handleInput('\t')
  assert.equal(component.getSelectedTab(), 'agents')
  component.setState({ agents: [], models: [] })
  assert.equal(component.getSelectedTab(), 'agents')
  assert.equal(component.focused, true)
})

test('missing telemetry, idle rows, and empty state are explicit', () => {
  const output = new Pipeline(state(), identityTheme).render(120).join('\n')
  assert.match(output, /Plan Reviewer\s+--\s+--\s+○ Idle\s+0\s+--\s+--/)
  const empty = new Pipeline({ agents: [], models: [] }, identityTheme).render(80).join('\n')
  assert.match(empty, /No agent pipeline data available\./)
})

test('narrow rendering removes optional columns and never exceeds width', () => {
  const component = new Pipeline(state(), identityTheme)
  const lines = component.render(50)
  assert.ok(lines.every((line) => visibleWidth(line) <= 50))
  const content = lines.join('\n')
  assert.doesNotMatch(content, /Thinking/)
  assert.doesNotMatch(content, /Tokens/)
  assert.doesNotMatch(content, /Runs/)

  component.handleInput('\t')
  const modelLines = component.render(30)
  assert.ok(modelLines.every((line) => visibleWidth(line) <= 30))
  assert.match(modelLines.join('\n'), /Model/)
  assert.match(modelLines.join('\n'), /Status/)
})
