function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function addUsage(
  current: Record<string, unknown> | undefined,
  incoming: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (incoming === undefined) return current
  if (current === undefined) return { ...incoming }
  const merged = { ...current }
  for (const [key, value] of Object.entries(incoming)) {
    const existing = merged[key]
    if (typeof existing === 'number' && typeof value === 'number') {
      merged[key] = existing + value
    } else if (!(key in merged)) {
      merged[key] = value
    }
  }
  return merged
}

/** Streaming updates replace the current message snapshot; terminal events replace their duplicates. */
export class AgentUsageCollector {
  private completed: Record<string, unknown> | undefined
  private messages: Record<string, unknown> | undefined
  private pending: Record<string, unknown> | undefined

  observe(event: Record<string, unknown>): void {
    if (event.type === 'message_update' && isRecord(event.usage)) {
      this.pending = event.usage
    } else if (event.type === 'message_end' && isRecord(event.message) && event.message.role === 'assistant') {
      const usage = isRecord(event.message.usage) ? event.message.usage : this.pending
      this.messages = addUsage(this.messages, usage)
      this.pending = undefined
    } else if (event.type === 'agent_end') {
      let terminal: Record<string, unknown> | undefined
      if (isRecord(event.usage)) {
        terminal = event.usage
      } else if (Array.isArray(event.messages)) {
        for (const message of event.messages) {
          if (isRecord(message) && isRecord(message.usage)) {
            terminal = addUsage(terminal, message.usage)
          }
        }
      }
      this.completed = addUsage(this.completed, terminal ?? addUsage(this.messages, this.pending))
      this.messages = undefined
      this.pending = undefined
    }
  }

  snapshot(): Record<string, unknown> | undefined {
    const usage = addUsage(addUsage(this.completed, this.messages), this.pending)
    return usage === undefined ? undefined : {
      ...usage,
      ...(this.pending === undefined ? {} : { incomplete: true }),
    }
  }
}
