import { checklistLines, nextReviewStatus } from './manual-checklist.ts'
import type { Theme } from '@earendil-works/pi-coding-agent'
import {
  parseKey,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui'
import type { Component } from '@earendil-works/pi-tui'
import type { DashboardAction, DashboardActionRequest } from '../types.ts'
import {
  framedBottom,
  framedLine,
  framedTop,
  type PanelStyle,
} from './panel.ts'

const ACTION_GAP = 3
const CHECKPOINT_PANEL_STYLE: PanelStyle = {
  borderColor: 'borderAccent',
  backgroundColor: 'customMessageBg',
}

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
  private readonly executeAction: (
    action: DashboardAction
  ) => void | Promise<void>
  private pending = false
  private selectedItem = 0
  private checklistFocused = true
  private focusedActionId: string | undefined
  private cachedWidth: number | undefined
  private cachedLines: string[] | undefined

  constructor(
    state: DashboardActionRequest | undefined,
    theme: Theme,
    executeAction: (action: DashboardAction) => void | Promise<void>
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
    if (this.state?.manualReview?.reportId !== state?.manualReview?.reportId) {
      this.selectedItem = 0
      this.checklistFocused = true
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
    if (this.state === undefined || this.pending) return false

    const review = this.state.manualReview
    const key = parseKey(data)
    if (review?.items.length) {
      if (key === 'tab' || key === 'shift+tab') {
        if (this.checklistFocused) {
          this.checklistFocused = false
          this.focusedActionId =
            key === 'tab'
              ? this.state.actions[0]?.id
              : this.state.actions.at(-1)?.id
          this.invalidate()
          return true
        }
        const actions = this.state.actions
        const index = actions.findIndex((a) => a.id === this.focusedActionId)
        if (
          (key === 'tab' && index === actions.length - 1) ||
          (key === 'shift+tab' && index === 0)
        ) {
          this.checklistFocused = true
          this.invalidate()
          return true
        }
      }
      if (this.checklistFocused) {
        if (key === 'up' || key === 'down') {
          this.selectedItem =
            (this.selectedItem +
              (key === 'up' ? -1 : 1) +
              review.items.length) %
            review.items.length
          this.invalidate()
          return true
        }
        if (key === 'space' || key === 'enter') {
          const item = review.items[this.selectedItem]
          if (item)
            this.runAction({
              id: 'manual-review-update',
              label: 'Update review item',
              manualReview: review,
              itemId: item.id,
              ...(key === 'space'
                ? { status: nextReviewStatus(item.status) }
                : {}),
            })
          return true
        }
        return false
      }
    }
    switch (key) {
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
        if (action !== undefined && !action.disabled) {
          if (!action.manualReview) {
            this.state = undefined
            this.setFocused(false)
          }
          this.invalidate()
          this.runAction(action)
        }
        return true
      }
      default:
        return false
    }
  }

  private runAction(action: DashboardAction): void {
    if (!action.manualReview) {
      void this.executeAction(action)
      return
    }
    this.pending = true
    void Promise.resolve()
      .then(() => this.executeAction(action))
      .finally(() => {
        this.pending = false
        this.invalidate()
      })
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
    const manualReviewLines = state.manualReview
      ? checklistLines(
          state.manualReview,
          this.checklistFocused ? this.selectedItem : undefined
        ).flatMap((line) => wrapTextWithAnsi(line, Math.max(1, innerWidth)))
      : this.renderManualReviewSteps(state.manualReviewSteps, innerWidth)
    const actionLines = this.renderActions(state.actions, innerWidth)
    const reportLines =
      state.verificationReportLink === undefined
        ? []
        : wrapTextWithAnsi(
            state.verificationReportLink,
            Math.max(1, innerWidth)
          )
    const content = [
      ...titleLines,
      ...(messageLines.length > 0 ? ['', ...messageLines] : []),
      ...(manualReviewLines.length > 0 ? ['', ...manualReviewLines] : []),
      ...(reportLines.length > 0 ? ['', ...reportLines] : []),
      ...(actionLines.length > 0 ? ['', ...actionLines] : []),
    ]
    const lines = [
      framedTop(width, 'CHECKPOINT', this.theme, CHECKPOINT_PANEL_STYLE),
      ...content.map((line) =>
        framedLine(line, width, this.theme, CHECKPOINT_PANEL_STYLE)
      ),
      framedBottom(width, this.theme, CHECKPOINT_PANEL_STYLE),
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

  private renderManualReviewSteps(
    steps: readonly string[] | undefined,
    innerWidth: number
  ): string[] {
    if (steps === undefined || steps.length === 0 || innerWidth <= 0) {
      return []
    }

    return [
      this.theme.bold(this.theme.fg('text', 'Manual Review Steps')),
      ...steps.flatMap((step, index) =>
        wrapTextWithAnsi(`${index + 1}. ${step}`, Math.max(1, innerWidth))
      ),
    ]
  }

  private renderButton(action: DashboardAction, label: string): string {
    const focused =
      action.id === this.focusedActionId &&
      !(this.state?.manualReview?.items.length && this.checklistFocused)
    const button = `${focused ? '▸' : ' '}[ ${label} ]`
    const colored = this.theme.fg(
      action.disabled ? 'dim' : actionColor(action),
      button
    )
    return focused ? this.theme.inverse(colored) : colored
  }
}
