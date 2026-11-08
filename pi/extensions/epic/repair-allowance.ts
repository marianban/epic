import type { TaskVerificationRecord } from './verification-types.ts'

/** Stable work-item IDs keep retries charged across cycles and resume. */
function repairUsage(record: TaskVerificationRecord, itemId: string): number {
  return record.invocations.filter(i => i.kind === 'repair' && i.repairItemId === itemId).length
}

export function canRepairItem(record: TaskVerificationRecord, itemId: string): boolean {
  return repairUsage(record, itemId) < record.repairsPerItemLimit
}

export function repairItemUsage(record: TaskVerificationRecord): { id: string; used: number; limit: number }[] {
  const ids = new Set([
    ...record.criteria.map(c => c.id),
    ...record.invocations.flatMap(i => i.repairItemId ? [i.repairItemId] : []),
    ...[...record.schedule.queue, ...record.schedule.deferred].filter(i => i.action === 'repair').map(i => i.id),
  ])
  return [...ids].map(id => ({ id, used: repairUsage(record, id), limit: record.repairsPerItemLimit }))
}
