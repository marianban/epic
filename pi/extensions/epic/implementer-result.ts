import { validateDevServerLaunchSpec } from './dev-server.ts'
import type { ImplementerResult } from './types.ts'

export function validateImplementerResult(
  value: unknown,
  browserSmokeRequired: boolean
): ImplementerResult {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Implementer response must be a JSON object.')
  const item = value as Record<string, unknown>
  if (typeof item.summary !== 'string' || !item.summary.trim())
    throw new Error('Implementer response summary must be non-empty.')
  if (
    !Array.isArray(item.checks) ||
    item.checks.some((check) => typeof check !== 'string' || !check.trim())
  )
    throw new Error(
      'Implementer response checks must contain non-empty strings.'
    )
  const devServer = validateDevServerLaunchSpec(
    item.devServer,
    browserSmokeRequired
  )
  return {
    summary: item.summary,
    checks: item.checks as string[],
    ...(devServer ? { devServer } : {}),
  }
}
