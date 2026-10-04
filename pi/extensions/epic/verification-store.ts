import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { EpicDomainState, EpicClock } from './types.ts'
import type {
  TaskVerificationRecord,
  AllowanceGrant,
} from './verification-types.ts'

export function taskVerificationPath(state: EpicDomainState): string {
  return path.join(
    state.repositoryRoot,
    '.pi',
    'epics',
    'runs',
    state.epicId,
    'tasks',
    `task-${state.currentTaskIndex + 1}-verification.json`
  )
}
export class VerificationStore {
  readonly file: string
  readonly clock: EpicClock
  constructor(file: string, clock: EpicClock) {
    this.file = file
    this.clock = clock
  }
  async read(): Promise<TaskVerificationRecord> {
    const value = JSON.parse(
      await fs.readFile(this.file, 'utf8')
    ) as TaskVerificationRecord
    if (
      !value ||
      typeof value.taskId !== 'string' ||
      !Array.isArray(value.criteria) ||
      !Array.isArray(value.plans) ||
      !Array.isArray(value.invocations) ||
      !Array.isArray(value.cycles) ||
      !Array.isArray(value.grants) ||
      !Array.isArray(value.decisions)
    )
      throw new Error('Invalid task verification ledger.')
    for (const n of [
      value.repairsLimit,
      value.infrastructureLimit,
      value.timeAllowanceMs,
      value.criterionVersion,
    ])
      if (!Number.isSafeInteger(n) || n < 0)
        throw new Error('Invalid task verification allowance.')
    for (const n of [value.startedAt, value.deadline, value.pausedAt])
      if (n !== undefined && (!Number.isFinite(n) || n < 0))
        throw new Error('Invalid persisted verification deadline.')
    if ((value.startedAt === undefined) !== (value.deadline === undefined))
      throw new Error('Incomplete persisted verification deadline.')
    if (value.criterionVersion < 1 || value.timeAllowanceMs <= 0)
      throw new Error('Invalid criterion version or time allowance.')
    const ids = new Set<string>()
    for (const invocation of value.invocations) {
      if (
        !invocation ||
        typeof invocation.id !== 'string' ||
        ids.has(invocation.id) ||
        !['repair', 'infrastructure'].includes(invocation.kind) ||
        typeof invocation.completed !== 'boolean' ||
        !Number.isFinite(invocation.at) ||
        typeof invocation.reason !== 'string'
      )
        throw new Error('Invalid persisted allowance invocation.')
      ids.add(invocation.id)
    }
    if (
      value.invocations.filter((i) => i.kind === 'repair').length >
        value.repairsLimit ||
      value.invocations.filter((i) => i.kind === 'infrastructure').length >
        value.infrastructureLimit
    )
      throw new Error('Persisted usage exceeds granted allowances.')
    return value
  }
  async write(value: TaskVerificationRecord): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(temporary, JSON.stringify(value, null, 2))
      await fs.rename(temporary, this.file)
    } finally {
      await fs.rm(temporary, { force: true })
    }
  }
  async initialize(state: EpicDomainState): Promise<TaskVerificationRecord> {
    try {
      return await this.read()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const task = state.tasks?.[state.currentTaskIndex]
    if (!task) throw new Error('Cannot freeze criteria without a task.')
    const record: TaskVerificationRecord = {
      taskId: task.id,
      criteria: task.acceptanceCriteria.map((text, i) => ({
        id: `${task.id}:AC${i + 1}`,
        text,
      })),
      criterionVersion: 1,
      repairsLimit: state.maxTaskRepairs,
      infrastructureLimit: state.maxTaskInfrastructureRetries,
      timeAllowanceMs: state.taskVerificationTimeoutMs,
      invocations: [],
      grants: [],
      cycles: [],
      decisions: [],
      plans: [],
    }
    await this.write(record)
    return record
  }
  remaining(record: TaskVerificationRecord): number {
    return record.deadline === undefined
      ? record.timeAllowanceMs
      : Math.max(0, record.deadline - (record.pausedAt ?? this.clock.nowMs()))
  }
  async start(record: TaskVerificationRecord): Promise<void> {
    const now = this.clock.nowMs()
    if (record.deadline === undefined) {
      record.startedAt = now
      record.deadline = now + record.timeAllowanceMs
    }
    if (record.pausedAt !== undefined) {
      record.deadline += now - record.pausedAt
      delete record.pausedAt
    }
    await this.write(record)
  }
  async charge(
    record: TaskVerificationRecord,
    kind: 'repair' | 'infrastructure',
    reason: string
  ): Promise<string> {
    const limit =
      kind === 'repair' ? record.repairsLimit : record.infrastructureLimit
    if (record.invocations.filter((i) => i.kind === kind).length >= limit)
      throw new Error(`${kind} allowance exhausted.`)
    if (this.remaining(record) <= 0)
      throw new Error('Verification deadline exhausted.')
    const id = randomUUID()
    record.invocations.push({
      id,
      kind,
      reason,
      at: this.clock.nowMs(),
      completed: false,
    })
    await this.write(record)
    return id
  }
  async pause(record: TaskVerificationRecord): Promise<void> {
    if (record.deadline !== undefined && record.pausedAt === undefined)
      record.pausedAt = this.clock.nowMs()
    await this.write(record)
  }
  async grant(
    record: TaskVerificationRecord,
    grant: AllowanceGrant
  ): Promise<void> {
    if (
      !Number.isSafeInteger(grant.repairs) ||
      grant.repairs < 0 ||
      !Number.isSafeInteger(grant.timeMs) ||
      grant.timeMs <= 0 ||
      !grant.reason.trim()
    )
      throw new Error(
        'A grant requires non-negative repairs, positive time, and a reason.'
      )
    grant.afterInvocationId = record.invocations.at(-1)?.id
    record.grants.push(grant)
    record.repairsLimit += grant.repairs
    record.timeAllowanceMs += grant.timeMs
    if (record.deadline !== undefined)
      record.deadline =
        Math.max(record.deadline, record.pausedAt ?? this.clock.nowMs()) +
        grant.timeMs
    await this.write(record)
  }
}
