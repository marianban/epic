function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasDiagnosticError(event: Record<string, unknown>): boolean {
  if (typeof event.errorMessage === 'string' && event.errorMessage.trim())
    return true
  if (event.isError === true) return true

  const message = event.message
  if (
    isRecord(message) &&
    ((typeof message.errorMessage === 'string' && message.errorMessage.trim()) ||
      message.stopReason === 'error')
  )
    return true

  return isRecord(event.result) && event.result.isError === true
}

function shouldPersistEvent(event: Record<string, unknown>): boolean {
  if (hasDiagnosticError(event)) return true

  switch (event.type) {
    case 'message_update':
    case 'tool_execution_update':
    case 'turn_end':
    case 'agent_end':
      return false
    case 'message_start':
      return (
        !isRecord(event.message) ||
        (event.message.role !== 'system' && event.message.role !== 'toolResult')
      )
    case 'message_end':
      return !isRecord(event.message) || event.message.role !== 'toolResult'
    default:
      return true
  }
}

export function shouldPersistAgentRunLogLine(line: string): boolean {
  const json = line.replace(/\r?\n$/, '')
  if (!json.trim()) return true
  try {
    const event: unknown = JSON.parse(json)
    return !isRecord(event) || shouldPersistEvent(event)
  } catch {
    // Unexpected stdout is more valuable for diagnosis than protocol noise.
    return true
  }
}
