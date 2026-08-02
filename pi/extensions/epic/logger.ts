import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { EpicRunIdentity } from './types.ts'
import { redactSecrets } from './tools.ts'

export type EpicLogLevel = 'debug' | 'info' | 'warn' | 'error'

function epicLogPath(root: string, epicId: string): string {
  return path.join(root, '.pi', 'epics', 'runs', epicId, 'epic.log')
}

function serialize(fields: Record<string, unknown>): string {
  if (Object.keys(fields).length === 0) return ''
  try {
    const json = JSON.stringify(fields).replace(
      /("(?:api[_-]?key|token|password|secret)"\s*:\s*)"[^"]*"/gi,
      '$1"[REDACTED]"'
    )
    return ` ${redactSecrets(json)}`
  } catch {
    return ' {"fields":"[unserializable]"}'
  }
}

/** Append a human-readable, structured record to the run's diagnostic log. */
export async function logEpic(
  state: EpicRunIdentity,
  timestamp: string,
  level: EpicLogLevel,
  message: string,
  fields: Record<string, unknown> = {}
): Promise<void> {
  const filePath = epicLogPath(state.repositoryRoot, state.epicId)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const line = `${timestamp} ${level.toUpperCase()} ${redactSecrets(message)}${serialize(fields)}\n`
  await fs.appendFile(filePath, line, 'utf8')
}
