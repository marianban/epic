import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from '@earendil-works/pi-coding-agent'
import type { Component, TUI } from '@earendil-works/pi-tui'
import { isKeyRelease, parseKey, truncateToWidth } from '@earendil-works/pi-tui'
import { ActionRequired } from './components/action-required.ts'
import { CurrentTask } from './components/current-task.ts'
import { EpicStats } from './components/epic-stats.ts'
import { Pipeline } from './components/pipeline.ts'
import { loadActiveDashboardState } from './data.ts'
import type { DashboardState } from './state.ts'
import type { DashboardAction } from './types.ts'

const EPIC_STATUS_WIDGET_KEY = 'epicstatus'
export const EPIC_STATUS_REFRESH_INTERVAL_MS = 1_000

export type DashboardLoader = (
  repositoryRoot: string,
  now: string
) => Promise<DashboardState | undefined>

type TerminalInputListener = (
  data: string
) => { consume?: boolean; data?: string } | undefined

export type RegisterTerminalInput = (handler: TerminalInputListener) => () => void

export type EpicStatusActionExecutor = (
  action: DashboardAction,
  ctx: ExtensionContext
) => Promise<void>

export interface EpicStatusWidgetLifecycle {
  show(ctx: ExtensionContext): void
  hide(ctx: ExtensionContext): void
}

export class EpicStatusWidget implements Component {
  private readonly repositoryRoot: string
  private readonly tui: TUI
  private readonly theme: Theme
  private readonly load: DashboardLoader
  private readonly notify: (message: string) => void
  private readonly executeAction: (action: DashboardAction) => void | Promise<void>
  private readonly unregisterTerminalInput: () => void
  private stats: EpicStats | undefined
  private actionRequired: ActionRequired | undefined
  private currentTask: CurrentTask | undefined
  private pipeline: Pipeline | undefined
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
    executeAction: (action: DashboardAction) => void | Promise<void>,
    registerTerminalInput: RegisterTerminalInput,
    refreshIntervalMs: number
  ) {
    this.repositoryRoot = repositoryRoot
    this.tui = tui
    this.theme = theme
    this.load = load
    this.notify = notify
    this.executeAction = async (action) => {
      try { await executeAction(action) }
      finally { await this.refresh() }
    }
    this.unregisterTerminalInput = registerTerminalInput((data) => {
      if (this.actionRequired?.focused === true) {
        if (isKeyRelease(data)) return { consume: true }
        const handled = this.actionRequired.handleInput(data)
        if (handled) this.tui.requestRender()
        return handled ? { consume: true } : undefined
      }
      if (isKeyRelease(data)) return undefined
      const key = parseKey(data)
      if (key !== 'tab' && key !== 'shift+tab') return undefined
      if (this.currentTask === undefined && this.pipeline === undefined) {
        return undefined
      }
      if (this.currentTask?.focused === true) {
        this.currentTask.setFocused(false)
        this.pipeline?.setFocused(true)
        this.pipeline?.selectTab(key === 'tab' ? 'agents' : 'models')
        this.tui.requestRender()
        return { consume: true }
      }
      if (this.pipeline?.focused === true) {
        const selected = this.pipeline.getSelectedTab()
        if (
          (key === 'tab' && selected === 'agents') ||
          (key === 'shift+tab' && selected === 'models')
        ) {
          this.pipeline.handleInput(data)
        } else if (this.currentTask !== undefined) {
          this.pipeline.setFocused(false)
          this.currentTask.setFocused(true)
        } else {
          this.pipeline.handleInput(data)
        }
        this.tui.requestRender()
        return { consume: true }
      }
      if (this.currentTask !== undefined) {
        this.currentTask.setFocused(true)
        this.tui.requestRender()
        return { consume: true }
      }
      this.pipeline?.setFocused(true)
      this.pipeline?.selectTab(key === 'tab' ? 'agents' : 'models')
      this.tui.requestRender()
      return { consume: true }
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
    const currentTask = this.currentTask?.render(width) ?? []
    const pipeline = this.pipeline?.render(width) ?? []
    const panels = [stats ?? [], currentTask, pipeline, actions].filter(
      (panel) => panel.length > 0
    )
    if (panels.length > 0) {
      return panels.flatMap((panel, index) =>
        index === 0 ? panel : ['', ...panel]
      )
    }
    if (width <= 0) return []

    const message =
      this.errorMessage === undefined
        ? this.theme.fg('muted', 'No active epic.')
        : this.theme.fg(
            'error',
            `Epic status unavailable: ${this.errorMessage}`
          )
    return [truncateToWidth(message, width, '…', true)]
  }

  invalidate(): void {
    this.stats?.invalidate()
    this.actionRequired?.invalidate()
    this.currentTask?.invalidate()
    this.pipeline?.invalidate()
  }

  dispose(): void {
    this.disposed = true
    clearInterval(this.timer)
    this.unregisterTerminalInput()
    this.actionRequired?.setFocused(false)
    this.currentTask?.setFocused(false)
    this.pipeline?.setFocused(false)
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
        this.actionRequired?.setFocused(false)
        this.actionRequired = undefined
        this.currentTask?.setFocused(false)
        this.currentTask = undefined
        this.pipeline = undefined
      } else if (this.stats === undefined) {
        this.stats = new EpicStats(next, this.theme)
        this.actionRequired = new ActionRequired(
          next.actionRequired,
          this.theme,
          this.executeAction
        )
        this.actionRequired.setFocused(next.actionRequired !== undefined)
        this.currentTask = new CurrentTask(next.currentTask, this.theme)
        this.pipeline = new Pipeline(next.pipeline, this.theme)
        this.currentTask.setFocused(
          next.actionRequired === undefined && next.currentTask !== undefined
        )
      } else {
        const hadCheckpoint = this.actionRequired?.focused === true
        const hadCurrentFocus = this.currentTask?.focused === true
        const hadPipelineFocus = this.pipeline?.focused === true
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
        if (this.currentTask === undefined) {
          this.currentTask = new CurrentTask(next.currentTask, this.theme)
        } else {
          this.currentTask.setState(next.currentTask)
        }
        if (this.pipeline === undefined) {
          this.pipeline = new Pipeline(next.pipeline, this.theme)
        } else {
          this.pipeline.setState(next.pipeline)
        }
        if (next.actionRequired !== undefined) {
          this.currentTask.setFocused(false)
          this.pipeline.setFocused(false)
        } else if (hadCheckpoint) {
          this.currentTask.setFocused(next.currentTask !== undefined)
          this.pipeline.setFocused(false)
        } else if (hadCurrentFocus) {
          this.currentTask.setFocused(next.currentTask !== undefined)
          this.pipeline.setFocused(false)
        } else if (hadPipelineFocus) {
          this.currentTask.setFocused(false)
          this.pipeline.setFocused(true)
        } else {
          this.currentTask.setFocused(next.currentTask !== undefined)
          this.pipeline.setFocused(false)
        }
      }
      this.invalidate()
      this.tui.requestRender()
    } catch (error) {
      if (this.disposed) return
      this.stats = undefined
      this.actionRequired?.setFocused(false)
      this.actionRequired = undefined
      this.currentTask?.setFocused(false)
      this.currentTask = undefined
      this.pipeline = undefined
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
): EpicStatusWidgetLifecycle {
  let installed = false

  const show = (ctx: ExtensionContext): void => {
    if (ctx.mode !== 'tui') return
    installed = true
    ctx.ui.setWidget(
      EPIC_STATUS_WIDGET_KEY,
      (tui, theme) =>
        new EpicStatusWidget(
          ctx.cwd,
          tui,
          theme,
          loadActiveDashboardState,
          (message) => ctx.ui.notify(message, 'error'),
          (action) => {
            return executeAction(action, ctx).catch((error: unknown) => {
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
  }

  const hide = (ctx: ExtensionContext): void => {
    if (!installed || ctx.mode !== 'tui') return
    installed = false
    ctx.ui.setWidget(EPIC_STATUS_WIDGET_KEY, undefined)
  }

  pi.on('session_start', (_event, ctx) => {
    show(ctx)
  })

  pi.on('session_shutdown', (_event, ctx) => {
    hide(ctx)
  })

  return { show, hide }
}
