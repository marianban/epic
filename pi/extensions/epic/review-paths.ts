export function isRepositoryRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false
  const normalized = value.replaceAll('\\', '/')
  const segments = normalized.split('/')
  return (
    normalized === value &&
    !normalized.includes('\0') &&
    !normalized.startsWith('/') &&
    !/^[A-Za-z]:\//.test(normalized) &&
    segments.every(
      (segment) => segment !== '' && segment !== '.' && segment !== '..'
    ) &&
    normalized !== '.git' &&
    !normalized.startsWith('.git/')
  )
}

export function isSafeRepairPath(value: unknown): value is string {
  if (!isRepositoryRelativePath(value)) return false
  if (value === '.pi/epics' || value.startsWith('.pi/epics/')) return false
  const name = value.split('/').at(-1)?.toLowerCase() ?? ''
  return (
    name !== '.env' &&
    !name.startsWith('.env.') &&
    !name.endsWith('.pem') &&
    !name.endsWith('.key')
  )
}
