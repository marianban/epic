import { randomUUID } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  writeSync,
} from 'node:fs'
import * as path from 'node:path'

const FLUSH_BYTES = 64 * 1024
const FLUSH_INTERVAL_MS = 250

export interface AgentRunStdoutLog {
  readonly filePath: string
  append(chunk: Buffer): void
  close(): void
}

function writeAll(fileDescriptor: number, chunk: Buffer): void {
  let offset = 0
  while (offset < chunk.length) {
    const written = writeSync(fileDescriptor, chunk, offset)
    if (written <= 0) throw new Error('Agent stdout log write made no progress.')
    offset += written
  }
}

/**
 * Create a private, per-invocation stdout log. Chunks are written immediately
 * and periodically synced so a parent-process crash leaves an inspectable log.
 */
export function createAgentRunStdoutLog(
  directory: string,
  role: string
): AgentRunStdoutLog {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const timestamp = new Date().toISOString().replace(/[^0-9A-Za-z_-]/g, '-')
  const filePath = path.join(
    directory,
    `${timestamp}-${role}-${randomUUID()}.stdout.log`
  )
  const fileDescriptor = openSync(filePath, 'wx', 0o600)
  let closed = false
  let bytesSinceSync = 0
  const sync = () => {
    if (!closed) fsyncSync(fileDescriptor)
    bytesSinceSync = 0
  }
  const flushTimer = setInterval(sync, FLUSH_INTERVAL_MS)
  flushTimer.unref()

  return {
    filePath,
    append(chunk) {
      if (closed) throw new Error(`Agent stdout log is closed: ${filePath}`)
      writeAll(fileDescriptor, chunk)
      bytesSinceSync += chunk.length
      if (bytesSinceSync >= FLUSH_BYTES) sync()
    },
    close() {
      if (closed) return
      closed = true
      clearInterval(flushTimer)
      fsyncSync(fileDescriptor)
      closeSync(fileDescriptor)
    },
  }
}
