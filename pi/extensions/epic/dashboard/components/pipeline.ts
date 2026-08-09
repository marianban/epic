import type { Theme } from '@earendil-works/pi-coding-agent'
import {
  parseKey,
  truncateToWidth,
  visibleWidth,
} from '@earendil-works/pi-tui'
import type { Component } from '@earendil-works/pi-tui'
import { formatDuration, formatTokens } from '../formatting.ts'
import type {
  PipelineAgentDashboardState,
  PipelineAgentStatus,
  PipelineDashboardState,
  PipelineModelDashboardState,
} from '../types.ts'
import {
  framedBottom,
  framedLine,
  framedTop,
  type PanelStyle,
} from './panel.ts'

type Tab = 'agents' | 'models'
type Alignment = 'left' | 'right'

interface Column {
  readonly key: string
  readonly header: string
  readonly align: Alignment
  readonly minWidth: number
  readonly maxWidth?: number
}

const FOCUSED_PIPELINE_STYLE: PanelStyle = { borderColor: 'borderAccent' }

const AGENT_COLUMNS: readonly Column[] = [
  { key: 'role', header: 'Agent', align: 'left', minWidth: 5, maxWidth: 28 },
  { key: 'model', header: 'Model', align: 'left', minWidth: 5, maxWidth: 28 },
  { key: 'thinking', header: 'Thinking', align: 'left', minWidth: 8, maxWidth: 18 },
  { key: 'status', header: 'Status', align: 'left', minWidth: 10, maxWidth: 12 },
  { key: 'runs', header: 'Runs', align: 'right', minWidth: 4 },
  { key: 'time', header: 'Time', align: 'right', minWidth: 5 },
  { key: 'tokens', header: 'Tokens', align: 'right', minWidth: 6 },
]

const MODEL_COLUMNS: readonly Column[] = [
  { key: 'model', header: 'Model', align: 'left', minWidth: 5, maxWidth: 28 },
  { key: 'provider', header: 'Provider', align: 'left', minWidth: 8, maxWidth: 22 },
  { key: 'thinking', header: 'Thinking', align: 'left', minWidth: 8, maxWidth: 18 },
  { key: 'roles', header: 'Roles', align: 'left', minWidth: 5, maxWidth: 30 },
  { key: 'status', header: 'Status', align: 'left', minWidth: 10, maxWidth: 12 },
  { key: 'runs', header: 'Runs', align: 'right', minWidth: 4 },
  { key: 'time', header: 'Time', align: 'right', minWidth: 5 },
  { key: 'tokens', header: 'Tokens', align: 'right', minWidth: 6 },
]

const AGENT_REMOVALS = ['thinking', 'tokens', 'runs', 'time', 'model']
const MODEL_REMOVALS = ['thinking', 'provider', 'tokens', 'runs', 'time', 'roles']

interface StatusPresentation {
  readonly icon: string
  readonly label: string
  readonly color: 'muted' | 'accent' | 'success' | 'error'
}

const STATUS_PRESENTATION: Record<PipelineAgentStatus, StatusPresentation> = {
  idle: { icon: '○', label: 'Idle', color: 'muted' },
  running: { icon: '●', label: 'Running', color: 'accent' },
  failed: { icon: '✕', label: 'Failed', color: 'error' },
}

function roleLabel(role: string): string {
  if (role === 'implementer') return 'Implementor'
  return role
    .split('-')
    .map((part) => part.length === 0 ? part : `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ')
}

function statusLabel(status: PipelineAgentStatus): string {
  const presentation = STATUS_PRESENTATION[status]
  return `${presentation.icon} ${presentation.label}`
}

function thinkingLabel(
  values: readonly string[] | undefined
): string {
  return values === undefined || values.length === 0 ? '--' : values.join(', ')
}

function metricTime(runCount: number, durationMs: number): string {
  return runCount === 0 ? '--' : formatDuration(durationMs)
}

function metricTokens(
  runCount: number,
  tokens: { readonly total: number } | undefined
): string {
  return runCount === 0 || tokens === undefined ? '--' : formatTokens(tokens.total)
}

function agentCells(state: PipelineAgentDashboardState): Record<string, string> {
  return {
    role: roleLabel(state.role),
    model: state.model ?? '--',
    thinking: thinkingLabel(state.thinking === undefined ? undefined : [state.thinking]),
    status: statusLabel(state.status),
    runs: String(state.runCount),
    time: metricTime(state.runCount, state.agentTimeMs),
    tokens: metricTokens(state.runCount, state.tokens),
  }
}

function modelCells(state: PipelineModelDashboardState): Record<string, string> {
  return {
    model: state.model ?? '--',
    provider: state.provider ?? '--',
    thinking: thinkingLabel(state.thinkingLevels),
    roles: state.roles.map(roleLabel).join(', ') || '--',
    status: statusLabel(state.status),
    runs: String(state.runCount),
    time: metricTime(state.runCount, state.agentTimeMs),
    tokens: metricTokens(state.runCount, state.tokens),
  }
}

function naturalWidth(column: Column, rows: readonly Record<string, string>[]): number {
  const valueWidth = Math.max(
    visibleWidth(column.header),
    ...rows.map((row) => visibleWidth(row[column.key] ?? ''))
  )
  return Math.min(column.maxWidth ?? valueWidth, Math.max(column.minWidth, valueWidth))
}

function totalWidth(widths: readonly number[]): number {
  return widths.reduce((total, value) => total + value, 0) + Math.max(0, widths.length - 1) * 2
}

function fits(columns: readonly Column[], rows: readonly Record<string, string>[], width: number): boolean {
  return totalWidth(columns.map((column) => naturalWidth(column, rows))) <= width
}

function visibleColumns(
  columns: readonly Column[],
  removals: readonly string[],
  rows: readonly Record<string, string>[],
  width: number
): readonly Column[] {
  const result = [...columns]
  for (const key of removals) {
    if (fits(result, rows, width)) break
    if (result.length <= 2) break
    const index = result.findIndex((column) => column.key === key)
    if (index >= 0) result.splice(index, 1)
  }
  return result
}

function columnWidths(
  columns: readonly Column[],
  rows: readonly Record<string, string>[],
  width: number
): readonly number[] {
  const widths = columns.map((column) => naturalWidth(column, rows))
  let excess = totalWidth(widths) - width
  if (excess <= 0) return widths

  const shrinkOrder = [...columns]
    .sort((left, right) => {
      const leftSecondary = left.key === 'model' || left.key === 'roles' ? 0 : 1
      const rightSecondary = right.key === 'model' || right.key === 'roles' ? 0 : 1
      return leftSecondary - rightSecondary
    })
  while (excess > 0) {
    const target = shrinkOrder.findIndex((column) => {
      const index = columns.indexOf(column)
      const currentWidth = widths[index]
      return currentWidth !== undefined && currentWidth > Math.min(column.minWidth, 3)
    })
    if (target < 0) break
    const column = shrinkOrder[target]
    if (column === undefined) break
    const index = columns.indexOf(column)
    widths[index] = (widths[index] ?? 0) - 1
    excess--
  }
  return widths
}

function alignedCell(value: string, width: number, alignment: Alignment): string {
  const truncated = truncateToWidth(value, width, '…', true)
  const padding = Math.max(0, width - visibleWidth(truncated))
  return alignment === 'right'
    ? `${' '.repeat(padding)}${truncated}`
    : `${truncated}${' '.repeat(padding)}`
}

function styledCell(
  column: Column,
  value: string,
  width: number,
  theme: Theme,
  header: boolean
): string {
  const aligned = alignedCell(value, width, column.align)
  if (header) return theme.bold(theme.fg('muted', aligned))
  if (column.key === 'status') {
    const status = Object.values(STATUS_PRESENTATION).find(
      (candidate) => `${candidate.icon} ${candidate.label}` === value
    )
    return theme.fg(status?.color ?? 'text', aligned)
  }
  return theme.fg('text', aligned)
}

function tableLines(
  columns: readonly Column[],
  rows: readonly Record<string, string>[],
  width: number,
  theme: Theme
): string[] {
  const widths = columnWidths(columns, rows, width)
  const renderRow = (row: Record<string, string>, header: boolean): string =>
    columns
      .map((column, index) => styledCell(column, row[column.key] ?? '', widths[index] ?? 0, theme, header))
      .join('  ')
  return [
    renderRow(Object.fromEntries(columns.map((column) => [column.key, column.header])), true),
    ...rows.map((row) => renderRow(row, false)),
  ]
}

/** Renders the agent/model pipeline overview and owns its two-tab selection. */
export class Pipeline implements Component {
  focused = false

  private state: PipelineDashboardState
  private readonly theme: Theme
  private selectedTab: Tab = 'agents'
  private cachedWidth: number | undefined
  private cachedLines: string[] | undefined

  constructor(state: PipelineDashboardState, theme: Theme) {
    this.state = state
    this.theme = theme
  }

  getSelectedTab(): Tab {
    return this.selectedTab
  }

  selectTab(tab: Tab): void {
    if (this.selectedTab === tab) return
    this.selectedTab = tab
    this.invalidate()
  }

  setFocused(focused: boolean): void {
    if (this.focused === focused) return
    this.focused = focused
    this.invalidate()
  }

  setState(state: PipelineDashboardState): void {
    this.state = state
    this.invalidate()
  }

  invalidate(): void {
    this.cachedWidth = undefined
    this.cachedLines = undefined
  }

  handleInput(data: string): boolean {
    switch (parseKey(data)) {
      case 'tab':
        this.selectTab(this.selectedTab === 'agents' ? 'models' : 'agents')
        return true
      case 'shift+tab':
        this.selectTab(this.selectedTab === 'models' ? 'agents' : 'models')
        return true
      default:
        return false
    }
  }

  render(width: number): string[] {
    if (width <= 0) return []
    if (this.cachedWidth === width && this.cachedLines !== undefined) return this.cachedLines
    const innerWidth = Math.max(0, width - 4)
    const selectedRows = this.selectedTab === 'agents'
      ? this.state.agents.map(agentCells)
      : this.state.models.map(modelCells)
    const columns = this.selectedTab === 'agents' ? AGENT_COLUMNS : MODEL_COLUMNS
    const removals = this.selectedTab === 'agents' ? AGENT_REMOVALS : MODEL_REMOVALS
    const visible = visibleColumns(columns, removals, selectedRows, innerWidth)
    const tabs = [
      this.theme.fg(this.selectedTab === 'agents' ? 'accent' : 'muted', this.selectedTab === 'agents' ? '▸ Agents' : '  Agents'),
      this.theme.fg(this.selectedTab === 'models' ? 'accent' : 'muted', this.selectedTab === 'models' ? '▸ Models' : '  Models'),
    ].join('   ')
    const content = selectedRows.length === 0
      ? ['No agent pipeline data available.']
      : tableLines(visible, selectedRows, innerWidth, this.theme)
    const style = this.focused ? FOCUSED_PIPELINE_STYLE : {}
    const lines = [
      framedTop(width, 'PIPELINE', this.theme, style),
      framedLine(tabs, width, this.theme, style),
      ...content.map((line) => framedLine(line, width, this.theme, style)),
      framedBottom(width, this.theme, style),
    ]
    this.cachedWidth = width
    this.cachedLines = lines
    return lines
  }
}
