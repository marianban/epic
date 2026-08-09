import type { Component } from '@earendil-works/pi-tui'
import {
  hyperlink,
  truncateToWidth,
  visibleWidth,
} from '@earendil-works/pi-tui'
import type { Theme } from '@earendil-works/pi-coding-agent'
import { pathToFileURL } from 'node:url'
import { DashboardState } from '../state.ts'
import type { EpicDashboardState, ProgressMetric } from '../types.ts'
import { formatDuration, formatTokens } from '../formatting.ts'
import { framedBottom, framedLine, framedTop } from './panel.ts'

const COMPACT_BREAKPOINT = 80
const WIDE_BAR_WIDTH = 20
const COMPACT_BAR_WIDTH = 10
const RIGHT_COLUMN_GAP = 2

interface RightColumnRow {
  readonly label: string
  readonly value: string
}

function progressBar(
  metric: ProgressMetric,
  length: number,
  theme: Theme
): string {
  if (length === 0) return ''
  const filled = Math.round((metric.percent / 100) * length)
  const completed = theme.fg('success', '█'.repeat(filled))
  const remaining = theme.fg('dim', '░'.repeat(length - filled))
  return completed + remaining
}

function progressGrid(
  rows: readonly { label: string; metric: ProgressMetric }[],
  width: number,
  preferredBarWidth: number,
  theme: Theme,
  rightColumn: readonly RightColumnRow[] = []
): string[] {
  const labelWidth = Math.max(...rows.map(({ label }) => visibleWidth(label)))
  const countWidth = Math.max(
    ...rows.map(({ metric }) =>
      visibleWidth(`${metric.completed} / ${metric.total}`)
    )
  )
  const percentWidth = Math.max(
    ...rows.map(({ metric }) => visibleWidth(`${Math.round(metric.percent)}%`))
  )
  const rightColumnWidth = Math.max(
    0,
    ...rightColumn.map(
      ({ label, value }) => visibleWidth(label) + 1 + visibleWidth(value)
    )
  )
  const fixedWidth = labelWidth + countWidth + percentWidth + 3
  const reservedRightColumnWidth =
    rightColumn.length === 0 ? 0 : rightColumnWidth + RIGHT_COLUMN_GAP
  const barWidth = Math.min(
    preferredBarWidth,
    Math.max(0, width - fixedWidth - reservedRightColumnWidth)
  )

  return rows.map(({ label, metric }, index) => {
    const count = `${metric.completed} / ${metric.total}`
    const percent = `${Math.round(metric.percent)}%`
    const row = [
      theme.fg('muted', label.padEnd(labelWidth)),
      theme.fg('muted', count.padStart(countWidth)),
      progressBar(metric, barWidth, theme),
      theme.fg('text', percent.padStart(percentWidth)),
    ].join(' ')

    const rightColumnRow = rightColumn[index]
    if (rightColumnRow === undefined) return row

    const rightLabelWidth = Math.max(
      ...rightColumn.map(({ label }) => visibleWidth(label))
    )
    const rightColumnValue = [
      rightColumnRow.label.padEnd(rightLabelWidth),
      rightColumnRow.value,
    ].join(' ')
    return `${row}${' '.repeat(RIGHT_COLUMN_GAP)}${theme.fg(
      'muted',
      rightColumnValue
    )}`
  })
}

function titleLine(
  epic: EpicDashboardState,
  width: number,
  theme: Theme
): string {
  const prefix = 'Prompt: '
  const name = truncateToWidth(
    epic.name,
    Math.max(0, width - prefix.length),
    '…'
  )
  return theme.bold(theme.fg('text', `${prefix}${name}`))
}

function runIdLine(
  epic: EpicDashboardState,
  width: number,
  theme: Theme
): string {
  const runId = hyperlink(epic.id, pathToFileURL(epic.runDirectory).toString())
  return truncateToWidth(
    `${theme.fg('muted', 'Run ID:')} ${theme.fg('dim', runId)}`,
    width,
    '…'
  )
}

/** Renders the epic summary shown above or below a Pi TUI view. */
export class EpicStats implements Component {
  private state: DashboardState
  private readonly theme: Theme
  private cachedWidth: number | undefined
  private cachedLines: string[] | undefined

  constructor(state: DashboardState, theme: Theme) {
    this.state = state
    this.theme = theme
  }

  setState(state: DashboardState): void {
    this.state = state
    this.invalidate()
  }

  invalidate(): void {
    this.cachedWidth = undefined
    this.cachedLines = undefined
  }

  render(width: number): string[] {
    if (width <= 0) return []
    if (this.cachedWidth === width && this.cachedLines !== undefined) {
      return this.cachedLines
    }

    const epic = this.state.epic
    const innerWidth = Math.max(0, width - 4)
    const compact = width < COMPACT_BREAKPOINT
    const lines = compact
      ? this.renderCompact(epic, innerWidth, width)
      : this.renderWide(epic, innerWidth, width)
    this.cachedWidth = width
    this.cachedLines = lines
    return lines
  }

  private renderWide(
    epic: EpicDashboardState,
    innerWidth: number,
    width: number
  ): string[] {
    const theme = this.theme
    const progressRows = progressGrid(
      [
        { label: 'Tasks', metric: epic.tasks },
        { label: 'Criteria', metric: epic.criteria },
      ],
      innerWidth,
      WIDE_BAR_WIDTH,
      theme,
      [
        {
          label: 'Time',
          value: formatDuration(epic.agentTimeMs),
        },
        { label: 'Tokens', value: formatTokens(epic.tokens.total) },
      ]
    )
    return [
      framedTop(width, 'EPIC', theme),
      framedLine(titleLine(epic, innerWidth, theme), width, theme),
      framedLine(runIdLine(epic, innerWidth, theme), width, theme),
      framedLine('', width, theme),
      ...progressRows.map((row) => framedLine(row, width, theme)),
      framedBottom(width, theme),
    ]
  }

  private renderCompact(
    epic: EpicDashboardState,
    innerWidth: number,
    width: number
  ): string[] {
    const theme = this.theme
    const progressRows = progressGrid(
      [
        { label: 'Tasks', metric: epic.tasks },
        { label: 'Criteria', metric: epic.criteria },
      ],
      innerWidth,
      COMPACT_BAR_WIDTH,
      theme,
      [
        {
          label: 'Time',
          value: formatDuration(epic.agentTimeMs),
        },
        { label: 'Tokens', value: formatTokens(epic.tokens.total) },
      ]
    )
    return [
      framedTop(width, 'EPIC', theme),
      framedLine(titleLine(epic, innerWidth, theme), width, theme),
      framedLine(runIdLine(epic, innerWidth, theme), width, theme),
      framedLine('', width, theme),
      ...progressRows.map((row) => framedLine(row, width, theme)),
      framedBottom(width, theme),
    ]
  }
}
