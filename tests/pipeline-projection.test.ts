import assert from 'node:assert/strict'
import test from 'node:test'
import { projectPipelineState } from '../pi/extensions/epic/dashboard/pipeline-projection.ts'
import type { ActiveAgentRun } from '../pi/extensions/epic/dashboard/types.ts'
import type { AgentProfile, EpicEvent } from '../pi/extensions/epic/types.ts'

const baseMs = Date.parse('2026-01-01T00:00:00.000Z')

function profile(
  role: AgentProfile['role'],
  provider = 'openai',
  model = 'model-a',
  thinking: AgentProfile['thinking'] = 'low'
): AgentProfile {
  return {
    role,
    provider,
    model,
    thinking,
    systemPromptPath: `${role}.md`,
    tools: [],
    readOnly: true,
  }
}

function event(
  id: string,
  type: 'agent_started' | 'agent_finished',
  offsetMs: number,
  payload: Record<string, unknown>
): EpicEvent {
  return {
    id,
    epicId: 'run',
    timestamp: new Date(baseMs + offsetMs).toISOString(),
    type,
    stage: 'implementing',
    payload,
  }
}

function lifecycle(
  id: string,
  role: string,
  action: string,
  startOffset: number,
  finishOffset: number,
  finish: Record<string, unknown> = {}
): EpicEvent[] {
  return [
    event(`${id}-start`, 'agent_started', startOffset, {
      invocationId: id,
      role,
      action,
      provider: 'openai',
      model: 'model-a',
      thinking: 'low',
    }),
    event(`${id}-finish`, 'agent_finished', finishOffset, {
      invocationId: id,
      role,
      action,
      exitCode: 0,
      ...finish,
    }),
  ]
}

test('configured zero-run roles are idle with unavailable metrics', () => {
  const state = projectPipelineState(
    [],
    [],
    [profile('scout'), profile('implementer')],
    baseMs
  )
  assert.deepEqual(state.agents.map((agent) => [agent.role, agent.status, agent.runCount, agent.tokens]), [
    ['scout', 'idle', 0, undefined],
    ['implementer', 'idle', 0, undefined],
  ])
  assert.deepEqual(state.models[0]?.roles, ['scout', 'implementer'])
})

test('active duration and status use the injected clock', () => {
  const started = lifecycle('active-1', 'scout', 'discovery', 1_000, 2_000).at(0)
  if (started === undefined) throw new Error('Expected a start event.')
  const active: ActiveAgentRun = {
    invocationId: 'active-1',
    startedAtMs: baseMs + 1_250,
    role: 'scout',
    action: 'discovery',
  }
  const state = projectPipelineState(
    [started],
    [active],
    [profile('scout')],
    baseMs + 5_250
  )
  assert.equal(state.agents[0]?.status, 'running')
  assert.equal(state.agents[0]?.runCount, 1)
  assert.equal(state.agents[0]?.agentTimeMs, 4_000)
})

test('successful latest runs are idle while preserving run history', () => {
  const state = projectPipelineState(
    lifecycle('success', 'scout', 'discovery', 1_000, 2_000),
    [],
    [profile('scout')],
    baseMs + 10_000
  )
  assert.equal(state.agents[0]?.status, 'idle')
  assert.equal(state.agents[0]?.runCount, 1)
})

test('an active run does not invalidate tokens from finished runs', () => {
  const activeStart = event('active-start', 'agent_started', 3_000, {
    invocationId: 'active-2',
    role: 'scout',
    action: 'discovery',
  })
  const state = projectPipelineState(
    [
      ...lifecycle('finished', 'scout', 'discovery', 1_000, 2_000, {
        usage: { total: 9 },
      }),
      activeStart,
    ],
    [{
      invocationId: 'active-2',
      startedAtMs: baseMs + 3_000,
      role: 'scout',
      action: 'discovery',
    }],
    [profile('scout')],
    baseMs + 5_000
  )
  assert.deepEqual(state.agents[0]?.tokens, { total: 9 })
})

test('completed runs aggregate time and normalized tokens while failure derives from outcome', () => {
  const events = [
    ...lifecycle('success', 'scout', 'discovery', 1_000, 2_000, {
      durationMs: 900,
      usage: {
        input: 2,
        output: 3,
        cacheRead: 4,
        cacheWrite: 5,
        reasoning: 6,
      },
    }),
    ...lifecycle('failure', 'scout', 'discovery', 3_000, 4_000, {
      exitCode: 2,
      failureReason: 'failed',
      usage: { totalTokens: 7 },
    }),
  ]
  const state = projectPipelineState(events, [], [profile('scout')], baseMs + 10_000)
  const agent = state.agents[0]
  assert.equal(agent?.status, 'failed')
  assert.equal(agent?.runCount, 2)
  assert.equal(agent?.agentTimeMs, 1_900)
  assert.deepEqual(agent?.tokens, {
    total: 21,
    input: 2,
    output: 3,
    cached: 9,
    reasoning: 6,
  })
})

test('missing usage makes an aggregate unavailable but does not erase known duration', () => {
  const state = projectPipelineState(
    lifecycle('missing', 'scout', 'discovery', 1_000, 2_000),
    [],
    [profile('scout')],
    baseMs + 10_000
  )
  assert.equal(state.agents[0]?.tokens, undefined)
  assert.equal(state.agents[0]?.agentTimeMs, 1_000)
})

test('model identity is collision-safe and historical attribution survives profile changes', () => {
  const events = [
    ...lifecycle('old', 'scout', 'discovery', 1_000, 2_000, {
      provider: 'old-provider',
      model: 'same-name',
    }),
    ...lifecycle('new', 'implementer', 'implementation', 3_000, 4_000, {
      provider: 'other-provider',
      model: 'same-name',
    }),
  ]
  const state = projectPipelineState(
    events,
    [],
    [profile('scout', 'current-provider', 'current-model'), profile('implementer', 'other-provider', 'same-name')],
    baseMs + 10_000
  )
  const observed = state.models.filter((model) => model.model === 'same-name')
  assert.equal(observed.length, 2)
  assert.equal(state.agents.find((agent) => agent.role === 'scout')?.provider, 'old-provider')
  assert.equal(state.agents.find((agent) => agent.role === 'scout')?.model, 'same-name')
})

test('thinking levels are unique and ordered', () => {
  const state = projectPipelineState(
    [
      ...lifecycle('low', 'scout', 'one', 1_000, 2_000, { thinking: 'low' }),
      ...lifecycle('high', 'scout', 'two', 3_000, 4_000, { thinking: 'high' }),
    ],
    [],
    [profile('scout', 'openai', 'model-a', 'medium')],
    baseMs + 10_000
  )
  assert.deepEqual(state.models.find((model) => model.model === 'model-a')?.thinkingLevels, ['low', 'medium', 'high'])
})

test('malformed lifecycle telemetry fails with event context', () => {
  assert.throws(
    () => projectPipelineState([
      event('orphan', 'agent_finished', 1_000, {
        invocationId: 'missing',
        role: 'scout',
        action: 'discovery',
      }),
    ], [], [profile('scout')], baseMs + 10_000),
    /event orphan.*matching start/
  )
  assert.throws(
    () => projectPipelineState([
      event('stale', 'agent_started', 1_000, {
        invocationId: 'stale',
        role: 'scout',
        action: 'discovery',
      }),
    ], [], [profile('scout')], baseMs + 10_000),
    /stale unmatched start/
  )
})
