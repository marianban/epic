import type { EpicEvent } from '../types.ts'
import type { TokenUsage } from './types.ts'

function usageValue(
  event: EpicEvent,
  usage: Record<string, unknown>,
  keys: readonly string[]
): number | undefined {
  const key = keys.find((candidate) => candidate in usage)
  if (key === undefined) return undefined
  const value = usage[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`Event ${event.id} has an invalid ${key} token count.`)
  }
  return value
}

export function normalizeTokenUsage(event: EpicEvent): TokenUsage | undefined {
  const raw = event.payload.usage
  if (raw === undefined) return undefined
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`Event ${event.id} has invalid token usage.`)
  }
  const usage = raw as Record<string, unknown>
  if (usage.incomplete !== undefined && typeof usage.incomplete !== 'boolean') {
    throw new Error(`Event ${event.id} has invalid usage completeness.`)
  }
  const input = usageValue(event, usage, [
    'input',
    'inputTokens',
    'promptTokens',
  ])
  const output = usageValue(event, usage, [
    'output',
    'outputTokens',
    'completionTokens',
  ])
  const directCached = usageValue(event, usage, ['cached', 'cachedTokens'])
  const cacheRead = usageValue(event, usage, ['cacheRead', 'cacheReadTokens'])
  const cacheWrite = usageValue(event, usage, [
    'cacheWrite',
    'cacheWriteTokens',
  ])
  const cached =
    directCached ??
    (cacheRead === undefined && cacheWrite === undefined
      ? undefined
      : (cacheRead ?? 0) + (cacheWrite ?? 0))
  const reasoning = usageValue(event, usage, ['reasoning', 'reasoningTokens'])
  const explicitTotal = usageValue(event, usage, [
    'total',
    'totalTokens',
    'tokens',
  ])
  const hasKnownCounter =
    explicitTotal !== undefined ||
    input !== undefined ||
    output !== undefined ||
    cached !== undefined
  if (!hasKnownCounter) return undefined
  return {
    ...(usage.incomplete === true ? { incomplete: true as const } : {}),
    total:
      explicitTotal ??
      (input ?? 0) + (output ?? 0) + (cached ?? 0),
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(cached === undefined ? {} : { cached }),
    ...(reasoning === undefined ? {} : { reasoning }),
  }
}

export function aggregateTokenUsage(
  usages: readonly (TokenUsage | undefined)[]
): TokenUsage | undefined {
  const measured = usages.filter((usage): usage is TokenUsage => usage !== undefined)
  if (measured.length === 0) return undefined
  let total = 0
  let input: number | undefined
  let output: number | undefined
  let cached: number | undefined
  let reasoning: number | undefined
  for (const usage of measured) {
    total += usage.total
    input = usage.input === undefined ? input : (input ?? 0) + usage.input
    output = usage.output === undefined ? output : (output ?? 0) + usage.output
    cached = usage.cached === undefined ? cached : (cached ?? 0) + usage.cached
    reasoning = usage.reasoning === undefined ? reasoning : (reasoning ?? 0) + usage.reasoning
  }
  return {
    total,
    ...(measured.length === usages.length && !measured.some((usage) => usage.incomplete) ? {} : { incomplete: true as const }),
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(cached === undefined ? {} : { cached }),
    ...(reasoning === undefined ? {} : { reasoning }),
  }
}
