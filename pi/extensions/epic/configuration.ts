import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { EpicConfig, ResolvedEpicConfiguration } from './types.ts'

function positiveInteger(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || (value as number) <= 0) throw new Error(`Invalid epic configuration ${field}: expected a positive integer.`)
  return value as number
}
function optionalBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new Error(`Invalid epic configuration ${field}: expected a boolean.`)
  return value
}
function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid epic configuration ${field}: expected an object.`)
  return value as Record<string, unknown>
}
function checks(value: EpicConfig['checks']): NonNullable<EpicConfig['checks']> {
  if (value === undefined) return {}
  const result = object(value, 'checks')
  for (const key of ['fast', 'full', 'final']) {
    const commands = result[key]
    if (commands !== undefined && (!Array.isArray(commands) || commands.some((command) => typeof command !== 'string' || !command.trim())))
      throw new Error(`Invalid epic configuration checks.${key}: expected non-empty command strings.`)
  }
  for (const key of ['focusedTests', 'fallow', 'fallowBaseline'])
    if (result[key] !== undefined && typeof result[key] !== 'string') throw new Error(`Invalid epic configuration checks.${key}: expected a string.`)
  return value
}

function browserSmoke(
  value: NonNullable<EpicConfig['checks']>['browserSmoke']
): ResolvedEpicConfiguration['checks']['browserSmoke'] {
  if (value === undefined)
    return {
      startupTimeoutMs: 30_000,
      navigationTimeoutMs: 15_000,
      selectorTimeoutMs: 10_000,
      settleTimeoutMs: 500,
    }
  const result = object(value, 'checks.browserSmoke')
  const executablePath = result.executablePath
  if (
    executablePath !== undefined &&
    (typeof executablePath !== 'string' || !executablePath.trim())
  )
    throw new Error(
      'Invalid epic configuration checks.browserSmoke.executablePath: expected a non-empty string.'
    )
  return {
    ...(typeof executablePath === 'string' ? { executablePath } : {}),
    startupTimeoutMs: positiveInteger(
      result.startupTimeoutMs,
      'checks.browserSmoke.startupTimeoutMs',
      30_000
    ),
    navigationTimeoutMs: positiveInteger(
      result.navigationTimeoutMs,
      'checks.browserSmoke.navigationTimeoutMs',
      15_000
    ),
    selectorTimeoutMs: positiveInteger(
      result.selectorTimeoutMs,
      'checks.browserSmoke.selectorTimeoutMs',
      10_000
    ),
    settleTimeoutMs: positiveInteger(
      result.settleTimeoutMs,
      'checks.browserSmoke.settleTimeoutMs',
      500
    ),
  }
}
function agents(value: EpicConfig['agents']): NonNullable<EpicConfig['agents']> {
  if (value === undefined) return {}
  const result = object(value, 'agents')
  for (const [role, profile] of Object.entries(result)) {
    const override = object(profile, `agents.${role}`)
    if (override.timeoutMs !== undefined) positiveInteger(override.timeoutMs, `agents.${role}.timeoutMs`, 1)
  }
  return value
}
export async function resolveEpicConfiguration(root: string): Promise<ResolvedEpicConfiguration> {
  const candidates = [path.join(root, '.pi', 'epic.config.json'), path.join(root, '.pi', 'epic.config.local.json')]
  let config: EpicConfig = {}
  for (const file of candidates) {
    try { config = JSON.parse(await fs.readFile(file, 'utf8')) as EpicConfig; break } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw new Error(`Invalid epic configuration at ${file}.`, { cause: error })
    }
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid epic configuration: expected an object.')
  const inspector = config.inspector === undefined ? {} : object(config.inspector, 'inspector')
  const inspectorPort = positiveInteger(inspector.port, 'inspector.port', 8080)
  if (inspectorPort > 65535) throw new Error('Invalid epic configuration inspector.port: expected a TCP port.')
  return {
    inspector: { enabled: optionalBoolean(inspector.enabled, 'inspector.enabled', false), port: inspectorPort, autoOpen: optionalBoolean(inspector.autoOpen, 'inspector.autoOpen', true) },
    agentTimeoutMs: positiveInteger(config.agentTimeoutMs, 'agentTimeoutMs', 300_000), commandTimeoutMs: positiveInteger(config.commandTimeoutMs, 'commandTimeoutMs', 120_000), maxOutputBytes: positiveInteger(config.maxOutputBytes, 'maxOutputBytes', 20_000), maxScoutRounds: positiveInteger(config.maxScoutRounds, 'maxScoutRounds', 3), maxFastRepairs: positiveInteger(config.maxFastRepairs, 'maxFastRepairs', 2), maxFullRepairs: positiveInteger(config.maxFullRepairs, 'maxFullRepairs', 1), maxSemanticRepairs: positiveInteger(config.maxSemanticRepairs, 'maxSemanticRepairs', 2), maxTaskPlanRepairs: positiveInteger(config.maxTaskPlanRepairs, 'maxTaskPlanRepairs', 2), checks: { ...checks(config.checks), browserSmoke: browserSmoke(config.checks?.browserSmoke) }, agents: agents(config.agents),
  }
}
