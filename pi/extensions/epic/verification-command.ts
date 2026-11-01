import { spawn } from 'node:child_process'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type {
  VerificationObligation,
  VerificationOperation,
  AcceptanceEvidence,
} from './verification-types.ts'
import { redactSecrets } from './tools.ts'
import { wrapSandboxedInvocation } from './execution-sandbox.ts'

export async function verifyCommand(
  obligation: VerificationObligation,
  root: string,
  artifactRoot: string,
  identity: string,
  attempt: number,
  operation: VerificationOperation,
  maxOutputBytes: number
): Promise<AcceptanceEvidence> {
  const command = obligation.command
  if (!command?.trim())
    throw new Error('Acceptance command must be a non-empty string.')
  operation.signal.throwIfAborted()
  const sandboxedInvocation = await wrapSandboxedInvocation(
    root,
    '/bin/sh',
    ['-c', command],
    operation.signal
  )
  operation.signal.throwIfAborted()
  operation.remainingMs()
  const execution = await new Promise<{ code: number; output: string }>(
    (resolve, reject) => {
      const child = spawn('/bin/bash', ['-c', sandboxedInvocation], {
        cwd: root,
        detached: process.platform !== 'win32',
        env: { ...process.env, CI: '1' },
      })
      let output = ''
      const collect = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-maxOutputBytes)
      }
      child.stdout.on('data', collect)
      child.stderr.on('data', collect)
      const terminate = () => {
        try {
          if (process.platform !== 'win32' && child.pid)
            process.kill(-child.pid, 'SIGKILL')
          else child.kill('SIGKILL')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') reject(error)
        }
      }
      const abort = () => {
        terminate()
        reject(operation.signal.reason)
      }
      const timer = setTimeout(() => {
        terminate()
        reject(new Error('Verification command exhausted the remaining time.'))
      }, operation.remainingMs())
      operation.signal.addEventListener('abort', abort, { once: true })
      const cleanup = () => {
        clearTimeout(timer)
        operation.signal.removeEventListener('abort', abort)
      }
      child.on('error', (error) => {
        cleanup()
        reject(error)
      })
      child.on('close', (code) => {
        cleanup()
        resolve({ code: code ?? 1, output: redactSecrets(output) })
      })
    }
  )
  const result: AcceptanceEvidence = {
    obligationId: obligation.id,
    criterionId: obligation.criterionId,
    expected: obligation.expected,
    actual: `Exit ${execution.code}: ${execution.output}`,
    outcome: execution.code === 0 ? 'pass' : 'fail',
    method: obligation.method,
    artifacts: [],
    identity,
    attempt,
    reproduction: command,
  }
  const artifact = path.join(artifactRoot, `${randomUUID()}-command.json`)
  await fs.writeFile(
    artifact,
    JSON.stringify({ ...result, command, exitCode: execution.code }, null, 2),
    { flag: 'wx' }
  )
  result.artifacts.push(artifact)
  return result
}
