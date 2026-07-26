import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from '@earendil-works/pi-coding-agent'
import type { Component, TUI } from '@earendil-works/pi-tui'
import { isKeyRelease, truncateToWidth } from '@earendil-works/pi-tui'
import { ActionRequired } from './components/action-required.ts'
import { EpicStats } from './components/epic-stats.ts'
import { loadActiveDashboardState } from './data.ts'
import type { DashboardState } from './state.ts'
import type { DashboardAction } from './types.ts'

export const EPIC_STATUS_WIDGET_KEY = 'epicstatus'
export const EPIC_STATUS_REFRESH_INTERVAL_MS = 1_000

type DashboardLoader = (
  repositoryRoot: string,
  now: string
) => Promise<DashboardState | undefined>

type TerminalInputListener = (data: string) =>
  | { consume?: boolean; data?: string }
  | undefined

type RegisterTerminalInput = (
  handler: TerminalInputListener
) => () => void

export type EpicStatusActionExecutor = (
  action: DashboardAction,
  ctx: ExtensionContext
) => Promise<void>

export class EpicStatusWidget implements Component {
  private readonly repositoryRoot: string
  private readonly tui: TUI
  private readonly theme: Theme
  private readonly load: DashboardLoader
  private readonly notify: (message: string) => void
  private readonly executeAction: (action: DashboardAction) => void
  private readonly unregisterTerminalInput: () => void
  private stats: EpicStats | undefined
  private actionRequired: ActionRequired | undefined
  private errorMessage: string | undefined
  private notifiedError: string | undefined
  private refreshInFlight = false
  private disposed = false
  private readonly timer: ReturnType<typeof setInterval>

  constructor(
    repositoryRoot: string,
    tui: TUI,
    theme: Theme,
    load: DashboardLoader,
    notify: (message: string) => void,
    executeAction: (action: DashboardAction) => void,
    registerTerminalInput: RegisterTerminalInput,
    refreshIntervalMs: number
  ) {
    this.repositoryRoot = repositoryRoot
    this.tui = tui
    this.theme = theme
    this.load = load
    this.notify = notify
    this.executeAction = executeAction
    this.unregisterTerminalInput = registerTerminalInput((data) => {
      if (this.actionRequired?.focused !== true) return undefined
      if (isKeyRelease(data)) return { consume: true }
      return this.actionRequired.handleInput(data)
        ? { consume: true }
        : undefined
    })
    if (!Number.isInteger(refreshIntervalMs) || refreshIntervalMs <= 0) {
      throw new Error(
        `Epic status refresh interval must be a positive integer: ${refreshIntervalMs}`
      )
    }
    this.timer = setInterval(() => {
      void this.refresh()
    }, refreshIntervalMs)
    void this.refresh()
  }

  render(width: number): string[] {
    const stats = this.stats?.render(width)
    const actions = this.actionRequired?.render(width) ?? []
    if (stats !== undefined) {
      return actions.length === 0 ? stats : [...stats, '', ...actions]
    }
    if (actions.length > 0) return actions
    if (width <= 0) return []

    const message =
      this.errorMessage === undefined
        ? this.theme.fg('muted', 'No active epic.')
        : this.theme.fg('error', `Epic status unavailable: ${this.errorMessage}`)
    return [truncateToWidth(message, width, '…', true)]
  }

  invalidate(): void {
    this.stats?.invalidate()
    this.actionRequired?.invalidate()
  }

  dispose(): void {
    this.disposed = true
    clearInterval(this.timer)
    this.unregisterTerminalInput()
    this.actionRequired?.setFocused(false)
  }

  async refresh(): Promise<void> {
    if (this.disposed || this.refreshInFlight) return
    this.refreshInFlight = true
    try {
      const next = await this.load(
        this.repositoryRoot,
        new Date().toISOString()
      )
      if (this.disposed) return

      this.errorMessage = undefined
      this.notifiedError = undefined
      if (next === undefined) {
        this.stats = undefined
        this.actionRequired?.setState(undefined)
        this.actionRequired?.setFocused(false)
      } else if (this.stats === undefined) {
        this.stats = new EpicStats(next, this.theme)
        this.actionRequired = new ActionRequired(
          next.actionRequired,
          this.theme,
          this.executeAction
        )
        this.actionRequired.setFocused(next.actionRequired !== undefined)
      } else {
        this.stats.setState(next)
        if (this.actionRequired === undefined) {
          this.actionRequired = new ActionRequired(
            next.actionRequired,
            this.theme,
            this.executeAction
          )
        } else {
          this.actionRequired.setState(next.actionRequired)
        }
        this.actionRequired.setFocused(next.actionRequired !== undefined)
      }
      this.invalidate()
      this.tui.requestRender()
    } catch (error) {
      if (this.disposed) return
      this.stats = undefined
      this.actionRequired?.setState(undefined)
      this.actionRequired?.setFocused(false)
      this.errorMessage = error instanceof Error ? error.message : String(error)
      if (this.notifiedError !== this.errorMessage) {
        this.notifiedError = this.errorMessage
        this.notify(`Epic status unavailable: ${this.errorMessage}`)
      }
      this.invalidate()
      this.tui.requestRender()
    } finally {
      this.refreshInFlight = false
    }
  }
}

export function registerEpicStatusWidget(
  pi: ExtensionAPI,
  refreshIntervalMs: number,
  executeAction: EpicStatusActionExecutor
): void {
  let installed = false

  pi.on('session_start', (_event, ctx) => {
    if (ctx.mode !== 'tui') return
    installed = true
    ctx.ui.setWidget(EPIC_STATUS_WIDGET_KEY, (tui, theme) =>
      new EpicStatusWidget(
        ctx.cwd,
        tui,
        theme,
        loadActiveDashboardState,
        (message) => ctx.ui.notify(message, 'error'),
        (action) => {
          void executeAction(action, ctx).catch((error: unknown) => {
            ctx.ui.notify(
              `Epic action ${action.id} failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
              'error'
            )
          })
        },
        (handler) => ctx.ui.onTerminalInput(handler),
        refreshIntervalMs
      )
    )
  })

  pi.on('session_shutdown', (_event, ctx) => {
    if (!installed || ctx.mode !== 'tui') return
    installed = false
    ctx.ui.setWidget(EPIC_STATUS_WIDGET_KEY, undefined)
  })
}
