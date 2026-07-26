import * as path from 'node:path'
import type { EpicState } from './types.ts'

export function currentTaskArtifactPath(state: EpicState): string {
  return path.join(
    state.repositoryRoot,
    '.pi',
    'epics',
    'runs',
    state.epicId,
    'tasks',
    `task-${String(state.currentTaskIndex + 1).padStart(3, '0')}.md`
  )
}
