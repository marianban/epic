import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from 'node:fs'
import * as path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { shouldPersistAgentRunLogLine } from './agent-run-log-records.ts'
import { stripProtocolImageData } from './agent-image-log.ts'

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
    if (written <= 0)
      throw new Error('Agent stdout log write made no progress.')
    offset += written
  }
}

/**
 * Create a private, per-invocation diagnostic log. Complete JSONL records that
 * duplicate terminal protocol events are discarded; retained records are
 * written with image payloads omitted and periodically synced so a parent-process crash leaves
 * an inspectable log.
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
  const decoder = new StringDecoder('utf8')
  let closed = false
  let bytesSinceSync = 0
  let pendingLine = ''
  const persist = (line: string) => {
    if (!shouldPersistAgentRunLogLine(line)) return
    const chunk = Buffer.from(stripProtocolImageData(line), 'utf8')
    writeAll(fileDescriptor, chunk)
    bytesSinceSync += chunk.length
    if (bytesSinceSync >= FLUSH_BYTES) sync()
  }
  const consume = (text: string) => {
    let offset = 0
    while (offset < text.length) {
      const newline = text.indexOf('\n', offset)
      if (newline === -1) {
        pendingLine += text.slice(offset)
        return
      }
      const line = `${pendingLine}${text.slice(offset, newline + 1)}`
      pendingLine = ''
      persist(line)
      offset = newline + 1
    }
  }
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
      consume(decoder.write(chunk))
    },
    close() {
      if (closed) return
      consume(decoder.end())
      if (pendingLine) {
        persist(pendingLine)
        pendingLine = ''
      }
      closed = true
      clearInterval(flushTimer)
      fsyncSync(fileDescriptor)
      closeSync(fileDescriptor)
    },
  }
}
