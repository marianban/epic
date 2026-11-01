/** Preserve protocol metadata and evidence IDs without duplicating bitmap payloads. */
export function stripProtocolImageData(line: string): string {
  if (!line.includes('"image"')) return line
  try {
    let changed = false
    const value: unknown = JSON.parse(line)
    const visit = (item: unknown): unknown => {
      if (Array.isArray(item)) return item.map(visit)
      if (!item || typeof item !== 'object') return item
      const record = item as Record<string, unknown>
      if (record.type === 'image' && typeof record.data === 'string') {
        changed = true
        const { data, ...metadata } = record
        return {
          ...metadata,
          data: `[image payload omitted: ${data.length} base64 characters]`,
        }
      }
      return Object.fromEntries(
        Object.entries(record).map(([key, val]) => [key, visit(val)])
      )
    }
    const clean = visit(value)
    return changed
      ? `${JSON.stringify(clean)}${line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : ''}`
      : line
  } catch {
    return line
  }
}
