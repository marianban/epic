import type { Theme } from '@earendil-works/pi-coding-agent'
import {
  parseKey,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui'
import type { Component } from '@earendil-works/pi-tui'
import type { DashboardAction, DashboardActionRequest } from '../types.ts'
import { framedBottom, framedLine, framedTop } from './panel.ts'

const ACTION_GAP = 3

function severityIcon(severity: DashboardActionRequest['severity']): string {
  switch (severity) {
    case 'info':
      return '●'
    case 'warning':
      return '⚠'
    case 'critical':
      return '✕'
  }
}

function severityColor(
  severity: DashboardActionRequest['severity']
): 'accent' | 'warning' | 'error' {
  switch (severity) {
    case 'info':
      return 'accent'
    case 'warning':
      return 'warning'
    case 'critical':
      return 'error'
  }
}

function actionColor(action: DashboardAction): 'accent' | 'text' | 'error' {
  switch (action.kind) {
    case 'primary':
      return 'accent'
    case 'danger':
      return 'error'
    case 'secondary':
    case undefined:
      return 'text'
  }
}

function actionIds(state: DashboardActionRequest | undefined): Set<string> {
  return new Set(state?.actions.map((action) => action.id) ?? [])
}

/** Renders a keyboard-driven action panel for a dashboard action request. */
export class ActionRequired implements Component {
  focused = false

  private state: DashboardActionRequest | undefined
  private readonly theme: Theme
  private readonly executeAction: (action: DashboardAction) => void
  private focusedActionId: string | undefined
  private cachedWidth: number | undefined
  private cachedLines: string[] | undefined

  constructor(
    state: DashboardActionRequest | undefined,
    theme: Theme,
    executeAction: (action: DashboardAction) => void
  ) {
    this.state = state
    this.theme = theme
    this.executeAction = executeAction
    this.focusedActionId = state?.actions[0]?.id
  }

  getFocusedActionId(): string | undefined {
    return this.focusedActionId
  }

  setFocused(focused: boolean): void {
    if (this.focused === focused) return
    this.focused = focused
    this.invalidate()
  }

  setState(state: DashboardActionRequest | undefined): void {
    const ids = actionIds(state)
    if (this.focusedActionId === undefined || !ids.has(this.focusedActionId)) {
      this.focusedActionId = state?.actions[0]?.id
    }
    this.state = state
    this.invalidate()
  }

  invalidate(): void {
    this.cachedWidth = undefined
    this.cachedLines = undefined
  }

  /** Returns true when the input was an action-panel key. */
  handleInput(data: string): boolean {
    if (this.state === undefined) return false

    switch (parseKey(data)) {
      case 'shift+tab':
        this.moveFocus(-1)
        return true
      case 'tab':
      case 'right':
        this.moveFocus(1)
        return true
      case 'left':
        this.moveFocus(-1)
        return true
      case 'enter': {
        const action = this.state.actions.find(
          (candidate) => candidate.id === this.focusedActionId
        )
        if (action !== undefined) this.executeAction(action)
        return true
      }
      default:
        return false
    }
  }

  render(width: number): string[] {
    if (this.state === undefined || width <= 0) return []
    if (this.cachedWidth === width && this.cachedLines !== undefined) {
      return this.cachedLines
    }

    const innerWidth = Math.max(0, width - 4)
    const state = this.state
    const title = `${this.theme.fg(
      severityColor(state.severity),
      severityIcon(state.severity)
    )} ${this.theme.bold(this.theme.fg('text', state.title))}`
    const titleLines = wrapTextWithAnsi(title, Math.max(1, innerWidth))
    const messageLines =
      state.message === undefined
        ? []
        : wrapTextWithAnsi(
            this.theme.fg('text', state.message),
            Math.max(1, innerWidth)
          )
    const actionLines = this.renderActions(state.actions, innerWidth)
    const content = [
      ...titleLines,
      ...(messageLines.length > 0 ? ['', ...messageLines] : []),
      ...(actionLines.length > 0 ? ['', ...actionLines] : []),
    ]
    const lines = [
      framedTop(width, 'ACTION REQUIRED', this.theme),
      ...content.map((line) => framedLine(line, width, this.theme)),
      framedBottom(width, this.theme),
    ]
    this.cachedWidth = width
    this.cachedLines = lines
    return lines
  }

  private moveFocus(direction: -1 | 1): void {
    const actions = this.state?.actions ?? []
    if (actions.length === 0) return
    const currentIndex = actions.findIndex(
      (action) => action.id === this.focusedActionId
    )
    const index = currentIndex < 0 ? 0 : currentIndex
    const nextIndex = (index + direction + actions.length) % actions.length
    this.focusedActionId = actions[nextIndex]?.id
    this.invalidate()
  }

  private renderActions(
    actions: readonly DashboardAction[],
    innerWidth: number
  ): string[] {
    if (actions.length === 0 || innerWidth <= 0) return []

    const rows: string[] = []
    const inline: string[] = []
    let inlineWidth = 0
    const flushInline = (): void => {
      if (inline.length === 0) return
      rows.push(inline.join(' '.repeat(ACTION_GAP)))
      inline.length = 0
      inlineWidth = 0
    }

    for (const action of actions) {
      const chunks = wrapTextWithAnsi(action.label, Math.max(1, innerWidth - 4))
      const buttonWidth = visibleWidth(`[ ${action.label} ]`) + 1
      if (chunks.length > 1 || buttonWidth > innerWidth) {
        flushInline()
        for (const chunk of chunks) {
          rows.push(this.renderButton(action, chunk))
        }
        continue
      }

      const button = this.renderButton(action, action.label)
      const nextWidth =
        inline.length === 0
          ? visibleWidth(button)
          : inlineWidth + ACTION_GAP + visibleWidth(button)
      if (nextWidth > innerWidth) flushInline()
      inline.push(button)
      inlineWidth =
        inline.length === 1
          ? visibleWidth(button)
          : inlineWidth + ACTION_GAP + visibleWidth(button)
    }
    flushInline()
    return rows
  }

  private renderButton(action: DashboardAction, label: string): string {
    const focused = action.id === this.focusedActionId
    const button = `${focused ? '▸' : ' '}[ ${label} ]`
    const colored = this.theme.fg(actionColor(action), button)
    return focused ? this.theme.inverse(colored) : colored
  }
}
