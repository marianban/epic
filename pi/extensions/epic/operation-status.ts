const activeEpicOperations = new Set<string>()

export function isEpicOperationActive(epicId: string): boolean {
  return activeEpicOperations.has(epicId)
}

export async function withActiveEpicOperation<T>(
  epicId: string,
  operation: () => Promise<T>
): Promise<T> {
  if (activeEpicOperations.has(epicId)) {
    throw new Error(`Epic operation is already active: ${epicId}`)
  }

  activeEpicOperations.add(epicId)
  try {
    return await operation()
  } finally {
    activeEpicOperations.delete(epicId)
  }
}
