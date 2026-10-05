/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { Index, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import {
  WINDOW_COUNT,
  backoffFor,
  clampPercent,
  fetchUsage,
  formatUsd,
  isTransient,
  isWindowLimited,
  resetText,
  resolveKey,
  resolveProvider,
  rightAlign,
  usedUsd,
  windowSeverity,
  type UsageWindow,
} from "./core.ts"

const REFRESH_MS = 30_000
const MAX_BACKOFF_MS = 5 * 60_000
/** Fixed width of the title row's right-hand status cell (spinner or age). */
const STATUS_WIDTH = 4

type Palette = {
  text: any
  muted: any
  accent: any
  green: any
  warn: any
  danger: any
  track: any
}

function readPalette(theme: any): Palette {
  const action = theme?.text?.action?.primary
  const base = theme?.text?.base
  return {
    text: base,
    muted: theme?.text?.muted,
    accent: action?.base ?? base,
    // Green / yellow / red usage states come from the theme's semantic feedback
    // colours so they stay consistent with the active theme.
    green: theme?.text?.feedback?.success?.base ?? "#3FB950",
    warn: theme?.text?.feedback?.warning?.base ?? base,
    danger: theme?.text?.feedback?.error?.base ?? base,
    // Use the theme's border colour for the unfilled track: it is guaranteed to
    // contrast with the sidebar panel background (raised.base is the panel
    // colour itself, which made the track invisible).
    track: theme?.border?.base ?? theme?.background?.raised?.base,
  }
}

function severityColor(palette: Palette, window: UsageWindow) {
  const level = windowSeverity(window)
  if (level === "danger") return palette.danger
  if (level === "warn") return palette.warn
  return palette.green
}

function ProgressBar(props: { percent: number; color: any; track: any }) {
  const pct = () => Math.max(0, Math.min(100, props.percent))
  return (
    <box width="100%" height={1} flexDirection="row">
      <box flexGrow={Math.max(pct(), 0.01)} backgroundColor={props.color} />
      <box flexGrow={Math.max(100 - pct(), 0.01)} backgroundColor={props.track} />
    </box>
  )
}

function WindowRow(props: { window: UsageWindow; palette: Palette; now: number }) {
  const pct = () => clampPercent(props.window.percent)
  const color = () => severityColor(props.palette, props.window)
  const used = () => usedUsd(props.window)
  const hasAmount = () => used() != null && props.window.limit != null
  const limited = () => isWindowLimited(props.window)
  // Memoised so the ticking clock only writes to the DOM when the rendered text
  // actually changes (Solid memos compare with ===).
  const resetLabel = createMemo(() => `↻ ${resetText(props.window.resetsAt, props.now)}`)

  return (
    <box flexDirection="column" width="100%" marginTop={1}>
      <box flexDirection="row" width="100%">
        <box flexGrow={1} flexDirection="row">
          <text fg={color()}>{props.window.label}</text>
          <Show when={limited()}>
            <text fg={color()}>{`  ${props.window.status}`}</text>
          </Show>
        </box>
        <text fg={color()}>{rightAlign(`${pct()}%`, 5)}</text>
      </box>
      <ProgressBar percent={props.window.percent} color={color()} track={props.palette.track} />
      <box flexDirection="row" width="100%">
        <text fg={props.palette.muted}>{resetLabel()}</text>
        <box flexGrow={1} />
        <Show when={hasAmount()}>
          <text fg={props.palette.muted}>{`${formatUsd(used() as number)} / ${formatUsd(props.window.limit as number)}`}</text>
        </Show>
      </box>
    </box>
  )
}

function UsagePanel(props: { context: any; panel: any; toggle: () => void }) {
  const ctx = props.context
  const palette = createMemo<Palette>(() => readPalette(ctx.theme))
  const providerID = createMemo<string | undefined>(() => ctx.ui.model.current()?.providerID)
  const config = createMemo(() => {
    const id = providerID()
    return id ? resolveProvider(id, ctx.options) : undefined
  })

  const [windows, setWindows] = createSignal<UsageWindow[]>([])
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal("")
  const [now, setNow] = createSignal(Date.now())
  const [lastOkAt, setLastOkAt] = createSignal<number | undefined>(undefined)
  const [nextRetryAt, setNextRetryAt] = createSignal<number | undefined>(undefined)

  const baseMs = Number(props.context?.options?.refreshMs) || REFRESH_MS
  let pollMs = baseMs

  // Guard per provider: if the user switches providers while a request is
  // still in flight, the new provider's request must fire immediately instead
  // of waiting for the next poll. Stale responses are dropped by the
  // `config()?.id === cfg.id` check below, so they cannot pollute the panel.
  const inflight = new Set<string>()
  const refresh = async () => {
    const cfg = config()
    if (!cfg || inflight.has(cfg.id)) return
    inflight.add(cfg.id)
    setLoading(true)
    try {
      const key = await resolveKey(cfg.id)
      if (!key) {
        setWindows([])
        setError("API key not found")
        setNextRetryAt(undefined)
        return
      }
      const next = await fetchUsage(cfg, key)
      if (config()?.id === cfg.id) {
        setWindows(next)
        setError("")
        setLastOkAt(Date.now())
        setNextRetryAt(undefined)
      }
      pollMs = baseMs
    } catch (err: any) {
      const message = err?.message ?? "usage API unavailable"
      if (isTransient(err)) {
        // Rate limits and network/server failures back off instead of hammering
        // the endpoint on every tick.
        pollMs = backoffFor(err, pollMs, baseMs, MAX_BACKOFF_MS)
        setNextRetryAt(Date.now() + pollMs)
      } else {
        pollMs = baseMs
        setNextRetryAt(undefined)
      }
      setError(message)
    } finally {
      inflight.delete(cfg.id)
      setLoading(inflight.size > 0)
    }
  }

  let pollTimer: any
  let tickTimer: any
  onMount(() => {
    let cancelled = false
    const loop = async () => {
      if (cancelled) return
      await refresh()
      if (cancelled) return
      pollTimer = setTimeout(loop, pollMs)
    }
    pollTimer = setTimeout(loop, baseMs)

    // The countdown only ever shows minute precision, so tick on minute
    // boundaries instead of every second. While a retry countdown is on screen
    // tick every second so the remaining seconds stay live.
    const scheduleTick = () => {
      const delay = nextRetryAt() !== undefined ? 1000 : 60_000 - (Date.now() % 60_000)
      tickTimer = setTimeout(() => {
        if (cancelled) return
        setNow(Date.now())
        scheduleTick()
      }, delay)
    }
    scheduleTick()

    onCleanup(() => {
      cancelled = true
      clearTimeout(pollTimer)
      clearTimeout(tickTimer)
    })
  })

  createEffect(() => {
    const cfg = config()
    setWindows([])
    setError("")
    setNextRetryAt(undefined)
    pollMs = baseMs
    if (cfg) {
      setLastOkAt(undefined)
      void refresh()
    }
  })

  // Age of the reading currently on screen, and whether it is older than two
  // polling intervals (i.e. the panel is showing stale data after a failure).
  const ageSeconds = () => {
    const at = lastOkAt()
    if (!at) return undefined
    return Math.max(0, Math.floor((now() - at) / 1000))
  }
  const isStale = createMemo(() => {
    const s = ageSeconds()
    return s !== undefined && s * 1000 > baseMs * 2.5
  })
  // Minute precision: the label stays identical between ticks, and the memo
  // stops Solid from rewriting the text node every time the clock advances.
  const ageText = createMemo(() => {
    const s = ageSeconds()
    if (s === undefined) return ""
    if (s < 60) return "now"
    if (s < 3600) return `${Math.floor(s / 60)}m`
    return `${Math.floor(s / 3600)}h`
  })
  // Only surface the age once the reading is actually stale: while the data is
  // fresh the cell stays blank so the title row carries no noise. The spinner
  // keeps using the same fixed-width cell, so it never shifts the layout.
  const statusText = createMemo(() => rightAlign(loading() ? "⋯" : isStale() ? ageText() : "", STATUS_WIDTH))
  const retryText = createMemo(() => {
    const at = nextRetryAt()
    if (at === undefined) return ""
    return ` · retry in ${Math.max(0, Math.ceil((at - now()) / 1000))}s`
  })

  return (
    <Show when={config()}>
      {(cfg) => (
        <box flexDirection="column" width="100%" marginTop={1}>
          <box flexDirection="row" width="100%" onMouseUp={() => props.toggle()}>
            <box flexGrow={1}>
              <text fg={palette().text}>{`${props.panel.collapsed ? "▸" : "▾"} USAGE · ${cfg().title}`}</text>
            </box>
            <text fg={isStale() && !loading() ? palette().warn : palette().muted}>{statusText()}</text>
          </box>
          <Show when={!props.panel.collapsed}>
            <Show when={error()}>
              <text fg={palette().danger}>{`${error()}${retryText()}`}</text>
            </Show>
            <Show when={windows().length > 0 && windows().length < WINDOW_COUNT}>
              <text fg={palette().warn}>{`partial data · ${windows().length}/${WINDOW_COUNT} windows`}</text>
            </Show>
            <Index each={windows()}>{(w) => <WindowRow window={w()} palette={palette()} now={now()} />}</Index>
          </Show>
        </box>
      )}
    </Show>
  )
}

export default Plugin.define({
  id: "usage-limits",
  setup(context) {
    const [panel, updatePanel] = context.storage.store("usage-limits.panel", {
      initial: { collapsed: false },
    })
    const toggle = () => void updatePanel((draft: any) => { draft.collapsed = !draft.collapsed })

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "usage-limits.toggle",
          title: "Toggle usage panel",
          group: "Usage Limits",
          palette: true,
          run: toggle,
        },
      ],
    }))

    return context.ui.slot({
      prepend: "sidebar.content",
      render: () => <UsagePanel context={context} panel={panel} toggle={toggle} />,
    })
  },
})