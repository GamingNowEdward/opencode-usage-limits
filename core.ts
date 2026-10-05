// Shared logic for the usage-limits TUI plugin.
// No JSX here so it can also be imported by the preview script.
import { readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export type WindowKind = "hour5" | "weekly" | "monthly"

export interface UsageWindow {
  kind: WindowKind
  label: string
  percent: number
  /** USD budget for this window; OpenCode Go uses fixed budgets, ClinePass reads them from the plan. */
  limit?: number
  /** Epoch ms when the window resets, or null when unknown. */
  resetsAt: number | null
  /** Provider-reported window status (OpenCode Go only), e.g. "ok". */
  status?: string
}

export interface ProviderConfig {
  id: string
  title: string
  baseUrl: string
  path: string
  /** Endpoint exposing the plan's per-window USD caps, when the provider has one. */
  planPath?: string
  /** Dollar budgets per window (OpenCode Go only). */
  limits?: Record<WindowKind, number>
}

export const PROVIDERS: Record<string, ProviderConfig> = {
  "opencode-go": {
    id: "opencode-go",
    title: "OpenCode Go",
    baseUrl: "https://opencode.ai/zen/go/v1",
    path: "/usage",
    limits: { hour5: 12, weekly: 30, monthly: 60 },
  },
  "cline-pass": {
    id: "cline-pass",
    title: "ClinePass",
    baseUrl: "https://api.cline.bot/api/v1",
    path: "/users/me/plan/usage-limits",
    planPath: "/users/me/plan",
  },
}

const WINDOW_LABEL: Record<WindowKind, string> = {
  hour5: "5 hours",
  weekly: "Weekly",
  monthly: "Monthly",
}

/** Provider configuration with any user-supplied limit overrides applied. */
export function resolveProvider(providerID: string, options?: any): ProviderConfig | undefined {
  const base = PROVIDERS[providerID]
  if (!base) return undefined
  const override = options?.limits?.[providerID]
  if (!override) return base
  return { ...base, limits: { ...(base.limits ?? {}), ...override } as Record<WindowKind, number> }
}

const WINDOW_ORDER: WindowKind[] = ["hour5", "weekly", "monthly"]

/** Number of windows a complete reading contains. */
export const WINDOW_COUNT = WINDOW_ORDER.length

// ---- API key resolution -------------------------------------------------

function authPaths(): string[] {
  const home = homedir()
  const paths = [join(home, ".local", "share", "opencode", "auth.json")]
  if (process.env.XDG_DATA_HOME) paths.push(join(process.env.XDG_DATA_HOME, "opencode", "auth.json"))
  if (process.env.LOCALAPPDATA) paths.push(join(process.env.LOCALAPPDATA, "opencode", "auth.json"))
  if (process.env.APPDATA) paths.push(join(process.env.APPDATA, "opencode", "auth.json"))
  return paths
}

/**
 * Pull an API key out of an auth-store entry. The store may hold a single
 * credential object, or an array of them when several accounts/connections
 * exist for one provider; in that case the first usable key wins.
 */
function extractKey(entry: any): string | undefined {
  if (!entry) return undefined
  if (Array.isArray(entry)) {
    for (const item of entry) {
      const key = extractKey(item)
      if (key) return key
    }
    return undefined
  }
  if (typeof entry !== "object") return undefined
  for (const field of ["key", "apiKey", "access", "token"]) {
    const value = entry[field]
    if (typeof value === "string" && value.length > 0) return value
  }
  return undefined
}

/** Resolve the provider API key from the env or OpenCode's auth store. */
export async function resolveKey(providerID: string): Promise<string | undefined> {
  const envName = `${providerID.toUpperCase().replace(/-/g, "_")}_API_KEY`
  const fromEnv = process.env[envName]
  if (fromEnv) return fromEnv

  for (const path of authPaths()) {
    try {
      if (!existsSync(path)) continue
      const store = JSON.parse(await readFile(path, "utf-8"))
      const key = extractKey(store?.[providerID])
      if (key) return key
    } catch {
      // try the next candidate path
    }
  }
  return undefined
}

// ---- API fetching -------------------------------------------------------

function toMs(value: unknown): number | null {
  if (typeof value !== "string") return null
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? ms : null
}

function buildWindow(
  kind: WindowKind,
  percent: number,
  resetsAt: number | null,
  limits?: Record<WindowKind, number>,
  status?: string,
): UsageWindow {
  return { kind, label: WINDOW_LABEL[kind], percent, limit: limits?.[kind], resetsAt, status }
}

/**
 * ClinePass reports plan caps as fixed-point integers. Calibrated against the
 * live API: the sum of `costUsd` over a rolling window matches
 * `percent x cap` in the same unit, and a single ~144k-token request costs
 * ~82,000 units. 1 unit = 1e-8 USD, i.e. $10 / $25 / $50 for 5h / weekly / monthly.
 */
export const CLINE_CAP_UNIT_USD = 1e-8

const capCache = new Map<string, { at: number; caps: Record<WindowKind, number> }>()
const CAP_TTL_MS = 6 * 60 * 60 * 1000

/**
 * Read the plan's per-window USD caps. Caps change rarely, so they are cached.
 * Caps are a nice-to-have: any failure returns undefined and never fails the
 * usage fetch itself.
 */
async function fetchPlanCaps(
  config: ProviderConfig,
  key: string,
  timeoutMs: number,
): Promise<Record<WindowKind, number> | undefined> {
  if (!config.planPath) return undefined
  const hit = capCache.get(config.id)
  if (hit && Date.now() - hit.at < CAP_TTL_MS) return hit.caps
  try {
    const url = config.baseUrl.replace(/\/$/, "") + config.planPath
    const data = await readJson(url, key, timeoutMs)
    const threshold = data?.data?.plan?.entitlements?.cline_pass?.inferenceCapThreshold
    if (!threshold) return undefined
    const caps: Record<WindowKind, number> = {
      hour5: Number(threshold.last5HoursUsageCostUSDPerUser) * CLINE_CAP_UNIT_USD,
      weekly: Number(threshold.last7daysUsageCostUSDPerUser) * CLINE_CAP_UNIT_USD,
      monthly: Number(threshold.last30daysUsageCostUSDPerUser) * CLINE_CAP_UNIT_USD,
    }
    if (!Object.values(caps).every((n) => Number.isFinite(n) && n > 0)) return undefined
    capCache.set(config.id, { at: Date.now(), caps })
    return caps
  } catch {
    return undefined
  }
}

/** HTTP failure carrying the status code so callers can decide on a backoff. */
function httpError(status: number, message: string): Error {
  const error = new Error(message)
  ;(error as any).status = status
  return error
}

async function readJson(url: string, key: string, timeoutMs: number): Promise<any> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: controller.signal,
    })
    if (res.status === 401 || res.status === 403) throw httpError(res.status, "API key rejected")
    if (res.status === 429) throw httpError(429, "rate limited by the usage API")
    if (!res.ok) throw httpError(res.status, `usage API ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Whether a failure is worth retrying with a growing delay, and how long to
 * wait. Rate limits and server errors back off; auth and shape errors do not.
 */
export function backoffFor(error: unknown, currentMs: number, baseMs: number, maxMs = 5 * 60_000): number {
  const status = Number((error as any)?.status) || 0
  // A 0 status means a network/abort failure, which is also transient.
  const transient = status === 0 || status === 429 || (status >= 500 && status < 600)
  if (!transient) return baseMs
  return Math.min(Math.max(currentMs, baseMs) * 2, maxMs)
}

/** True when the error is transient (used to label the retry countdown). */
export function isTransient(error: unknown): boolean {
  const status = Number((error as any)?.status) || 0
  return status === 0 || status === 429 || (status >= 500 && status < 600)
}

/**
 * Fetch the three usage windows for a provider.
 * OpenCode Go reports percentages and we map them onto its $12/$30/$60 budgets.
 * ClinePass reports percentages only, so no dollar amount is shown.
 */
export async function fetchUsage(config: ProviderConfig, key: string, timeoutMs = 10000): Promise<UsageWindow[]> {
  const url = config.baseUrl.replace(/\/$/, "") + config.path
  const data = await readJson(url, key, timeoutMs)

  if (config.id === "cline-pass") {
    const limits: any[] = Array.isArray(data?.data?.limits) ? data.data.limits : []
    const map: Record<string, WindowKind> = { five_hour: "hour5", weekly: "weekly", monthly: "monthly" }
    const caps = await fetchPlanCaps(config, key, timeoutMs)
    const windows: UsageWindow[] = []
    for (const kind of WINDOW_ORDER) {
      const hit = limits.find((l) => map[l?.type] === kind)
      if (!hit) continue
      windows.push(buildWindow(kind, Number(hit.percentUsed) || 0, toMs(hit.resetsAt), caps ?? config.limits))
    }
    if (windows.length === 0) throw new Error("usage API returned an unexpected shape")
    return windows
  }

  const usage = data?.usage
  const sources: Record<WindowKind, any> = {
    hour5: usage?.rolling,
    weekly: usage?.weekly,
    monthly: usage?.monthly,
  }
  const windows: UsageWindow[] = []
  for (const kind of WINDOW_ORDER) {
    const src = sources[kind]
    if (!src) continue
    const status = typeof src.status === "string" ? src.status : undefined
    windows.push(buildWindow(kind, Number(src.percent) || 0, toMs(src.resetsAt), config.limits, status))
  }
  if (windows.length === 0) throw new Error("usage API returned an unexpected shape")
  return windows
}

// ---- Formatting ---------------------------------------------------------

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)))
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`
}

export function usedUsd(window: UsageWindow): number | undefined {
  if (window.limit == null) return undefined
  return (window.percent / 100) * window.limit
}

export function rightAlign(value: string, width: number): string {
  return value.padStart(width)
}

/** Compact countdown such as `1h12m`, `5d 4h`, `now`. */
export function resetText(resetsAt: number | null, now: number): string {
  if (resetsAt == null) return "--"
  const remaining = resetsAt - now
  if (remaining <= 0) return "now"
  if (remaining < HOUR) return `${Math.max(1, Math.floor(remaining / MINUTE))}m`
  if (remaining < DAY) {
    const h = Math.floor(remaining / HOUR)
    const m = Math.floor((remaining % HOUR) / MINUTE)
    return m > 0 && h < 10 ? `${h}h${m}m` : `${h}h`
  }
  const d = Math.floor(remaining / DAY)
  const h = Math.floor((remaining % DAY) / HOUR)
  return h > 0 ? `${d}d ${h}h` : `${d}d`
}

export type Severity = "ok" | "warn" | "danger"

/** Percentage thresholds for the green/yellow/red usage colour. */
export const WARN_AT = 50
export const DANGER_AT = 80

export function severity(percent: number): Severity {
  if (percent >= DANGER_AT) return "danger"
  if (percent >= WARN_AT) return "warn"
  return "ok"
}

/** True when the provider itself reports the window as not usable. */
export function isWindowLimited(window: UsageWindow): boolean {
  return Boolean(window.status && window.status !== "ok")
}

/** Severity for a window, taking the provider-reported status into account. */
export function windowSeverity(window: UsageWindow): Severity {
  if (isWindowLimited(window)) return "danger"
  return severity(window.percent)
}