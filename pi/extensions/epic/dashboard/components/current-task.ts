import type { Theme } from '@earendil-works/pi-coding-agent'
import type { Component } from '@earendil-works/pi-tui'
import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui'
import { formatDuration } from '../formatting.ts'
import type {
  CurrentTaskDashboardState,
  TaskDashboardStatus,
} from '../types.ts'
import { framedBottom, framedLine, framedTop } from './panel.ts'

interface DetailRow {
  readonly label: string
  readonly value: string
  readonly warning?: boolean
}

interface StatusPresentation {
  readonly icon: string
  readonly label: string
  readonly color: 'accent' | 'muted' | 'warning' | 'success' | 'error'
}

const STATUS_PRESENTATION: Record<TaskDashboardStatus, StatusPresentation> = {
  'initial-review': { icon: '◐', label: 'INITIAL REVIEW', color: 'accent' },
  refinement: { icon: '◆', label: 'REFINEMENT', color: 'warning' },
  pending: { icon: '○', label: 'PENDING', color: 'muted' },
  'in-progress': { icon: '●', label: 'IN PROGRESS', color: 'accent' },
  completed: { icon: '✓', label: 'COMPLETED', color: 'success' },
  failed: { icon: '✕', label: 'FAILED', color: 'error' },
}

const LEFT_LABEL_WIDTH = Math.max(
  ...['Time', 'Attempt', 'Criteria'].map((label) => visibleWidth(label))
)
const RIGHT_LABEL_WIDTH = Math.max(
  ...['Agent', 'Files', 'Diff'].map((label) => visibleWidth(label))
)
const COLUMN_GAP = 3
const MIN_VALUE_WIDTH = 2

function detailRows(state: CurrentTaskDashboardState): {
  left: readonly DetailRow[]
  right: readonly DetailRow[]
} {
  const diff = state.diff
  const files = diff === undefined ? undefined : `${diff.filesChanged} changed`
  const changes =
    diff === undefined
      ? undefined
      : `+${diff.linesAdded} / -${diff.linesDeleted}`
  return {
    left: [
      { label: 'Time', value: formatDuration(state.agentTimeMs) },
      {
        label: 'Attempt',
        value:
          state.attempt.max === undefined
            ? String(state.attempt.current)
            : `${state.attempt.current} / ${state.attempt.max}`,
      },
      {
        label: 'Criteria',
        value: `${state.criteria.completed} / ${state.criteria.total}`,
      },
    ],
    right: [
      { label: 'Agent', value: state.agent ?? '--' },
      {
        label: 'Files',
        value: files === undefined ? '--' : files,
        warning: diff?.hasWarning,
      },
      {
        label: 'Diff',
        value: changes === undefined ? '--' : changes,
        warning: diff?.hasWarning,
      },
    ],
  }
}

function renderRow(row: DetailRow, width: number, theme: Theme): string {
  const labelWidth =
    row.label === 'Agent' || row.label === 'Files' || row.label === 'Diff'
      ? RIGHT_LABEL_WIDTH
      : LEFT_LABEL_WIDTH
  const valueWidth = Math.max(0, width - labelWidth - 1)
  const suffix = row.warning === true ? ' ⚠' : ''
  const value = truncateToWidth(`${row.value}${suffix}`, valueWidth, '…', true)
  return `${theme.fg('muted', row.label.padEnd(labelWidth))} ${theme.fg(
    row.warning === true ? 'warning' : 'text',
    value
  )}`
}

function renderGrid(
  rows: readonly DetailRow[],
  width: number,
  theme: Theme
): string[] {
  return rows.map((row) => renderRow(row, width, theme))
}

/** Renders the task operation currently owned by the epic workflow. */
export class CurrentTask implements Component {
  private state: CurrentTaskDashboardState | undefined
  private readonly theme: Theme
  private cachedWidth: number | undefined
  private cachedLines: string[] | undefined

  constructor(state: CurrentTaskDashboardState | undefined, theme: Theme) {
    this.state = state
    this.theme = theme
  }

  setState(state: CurrentTaskDashboardState | undefined): void {
    this.state = state
    this.invalidate()
  }

  invalidate(): void {
    this.cachedWidth = undefined
    this.cachedLines = undefined
  }

  render(width: number): string[] {
    if (this.state === undefined || width <= 0) return []
    if (this.cachedWidth === width && this.cachedLines !== undefined) {
      return this.cachedLines
    }

    const innerWidth = Math.max(0, width - 4)
    const state = this.state
    const status = STATUS_PRESENTATION[state.status]
    const title = wrapTextWithAnsi(
      this.theme.fg('text', `#${state.index}  ${state.name}`),
      Math.max(1, innerWidth)
    )
    const statusLine = this.theme.fg(
      status.color,
      `${status.icon} ${status.label}`
    )
    const rows = detailRows(state)
    const minimumLeftWidth =
      LEFT_LABEL_WIDTH +
      1 +
      Math.max(
        MIN_VALUE_WIDTH,
        ...rows.left.map((row) => visibleWidth(row.value))
      )
    const minimumRightWidth =
      RIGHT_LABEL_WIDTH +
      1 +
      Math.max(
        MIN_VALUE_WIDTH,
        ...rows.right.map((row) =>
          visibleWidth(`${row.value}${row.warning === true ? ' ⚠' : ''}`)
        )
      )
    const twoColumnWidth = Math.floor((innerWidth - COLUMN_GAP) / 2)
    const useTwoColumns =
      twoColumnWidth >= minimumLeftWidth &&
      innerWidth - COLUMN_GAP - twoColumnWidth >= minimumRightWidth

    const details = useTwoColumns
      ? this.renderTwoColumns(rows, twoColumnWidth, innerWidth)
      : [
          ...renderGrid(rows.left, innerWidth, this.theme),
          ...renderGrid(rows.right, innerWidth, this.theme),
        ]
    const lines = [
      framedTop(width, 'CURRENT TASK', this.theme),
      ...title.map((line) => framedLine(line, width, this.theme)),
      framedLine(statusLine, width, this.theme),
      framedLine('', width, this.theme),
      ...details.map((line) => framedLine(line, width, this.theme)),
      framedBottom(width, this.theme),
    ]
    this.cachedWidth = width
    this.cachedLines = lines
    return lines
  }

  private renderTwoColumns(
    rows: { left: readonly DetailRow[]; right: readonly DetailRow[] },
    columnWidth: number,
    innerWidth: number
  ): string[] {
    const left = renderGrid(rows.left, columnWidth, this.theme)
    const right = renderGrid(
      rows.right,
      innerWidth - COLUMN_GAP - columnWidth,
      this.theme
    )
    return left.map(
      (line, index) =>
        `${line}${' '.repeat(Math.max(0, columnWidth - visibleWidth(line)) + COLUMN_GAP)}${right[index] ?? ''}`
    )
  }
}
