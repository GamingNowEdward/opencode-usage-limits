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
    // No dollar budgets: the usage API only reports percentages, and the
    // per-model allowances on the pricing page are reference information shown
    // separately (see GO_MODEL_ALLOWANCE).
  },
  "cline-pass": {
    id: "cline-pass",
    title: "ClinePass",
    baseUrl: "https://api.cline.bot/api/v1",
    path: "/users/me/plan/usage-limits",
    planPath: "/users/me/plan",
  },
}

export type PlanTier = "go" | "plus"

/**
 * Monthly allowance per OpenCode Go model, by plan tier, taken from the
 * official usage table at https://opencode.ai/zh/go.
 *
 * Reference only: it is displayed as "how expensive is this model", never used
 * to derive spend. The usage API reports percentages and says nothing about
 * which model an allowance belongs to, so converting a percentage into dollars
 * would be guesswork.
 */
export const GO_MODEL_ALLOWANCE: Record<string, Record<PlanTier, number> | "free"> = {
  "kimi-k3": { go: 15, plus: 60 },
  "qwen3.8-max": { go: 15, plus: 60 },
  "grok-4.7": { go: 15, plus: 60 },
  "grok-4.6": { go: 15, plus: 60 },
  "glm-5.3": { go: 15, plus: 120 },
  "glm-5.2": { go: 60, plus: 180 },
  "deepseek-v4-pro": { go: 15, plus: 60 },
  "kimi-k2.7-code": { go: 60, plus: 180 },
  "hy4-preview": { go: 30, plus: 120 },
  "gpt-5.6-luna": { go: 15, plus: 60 },
  "space-bunny": { go: 30, plus: 120 },
  "minimax-m3": { go: 60, plus: 180 },
  "mimo-v2.6-pro": { go: 15, plus: 60 },
  "mimo-v2.5-pro": { go: 15, plus: 60 },
  "minimax-m2.7": { go: 60, plus: 240 },
  "claude-haiku-5-5": { go: 15, plus: 60 },
  "gpt-6-luna": { go: 15, plus: 60 },
  "qwen3.7-plus": { go: 60, plus: 180 },
  hy3: { go: 60, plus: 240 },
  "qwen3.8-flash": { go: 30, plus: 90 },
  "glm-5.3-flash": { go: 60, plus: 180 },
  "deepseek-v4-flash-vision-exp": { go: 15, plus: 60 },
  "longcat-2.0": { go: 60, plus: 240 },
  "deepseek-v4-flash": { go: 30, plus: 120 },
  "mimo-v2.6-flash": { go: 60, plus: 120 },
  "mimo-v2.5": { go: 60, plus: 120 },
  "deepseek-v4.1-flash": { go: 80, plus: 160 },
  "muse-spark-1.3-contributor": { go: 60, plus: 120 },
  "muse-spark-1.2-contributor": { go: 60, plus: 120 },
  "longcat-2.5-preview-free": "free",
  "step-5-preview-free": "free",
}

/** Allowance of an OpenCode Go model, or undefined when it is not in the table. */
export function modelAllowance(modelID: string | undefined): Record<PlanTier, number> | "free" | undefined {
  if (!modelID) return undefined
  return GO_MODEL_ALLOWANCE[modelID]
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
 * Pull an API key out of a credential entry. An entry may hold a single
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

/**
 * Pick the credential belonging to `providerID` out of the list returned by
 * OpenCode's `credential.list()` API. OpenCode v2 stores credentials in its
 * database rather than in `auth.json`, so this is the authoritative source.
 * The active credential wins; otherwise the first match is used.
 */
export function keyFromCredentials(entries: unknown, providerID: string): string | undefined {
  const list = Array.isArray(entries)
    ? entries
    : Array.isArray((entries as any)?.data)
      ? (entries as any).data
      : []
  const matches = list.filter((entry: any) => entry?.integrationID === providerID)
  const preferred = matches.find((entry: any) => entry?.active === true) ?? matches[0]
  return extractKey(preferred?.value)
}

/** Reads a provider key through the host's OpenCode client. */
export type KeyResolver = (providerID: string) => Promise<string | undefined>

/**
 * Resolve the provider API key from the env, the host credential store, or
 * `auth.json`. The host store comes first because OpenCode v2 keeps credentials
 * in its database; `auth.json` remains as a fallback for older installs and for
 * the offline preview script.
 */
export async function resolveKey(providerID: string, fromHost?: KeyResolver): Promise<string | undefined> {
  const envName = `${providerID.toUpperCase().replace(/-/g, "_")}_API_KEY`
  const fromEnv = process.env[envName]
  if (fromEnv) return fromEnv

  if (fromHost) {
    try {
      const key = await fromHost(providerID)
      if (key) return key
    } catch {
      // Host credential API unavailable (older OpenCode, remote server): fall
      // through to the legacy auth store.
    }
  }

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
  // Provider endpoints return ISO strings; OpenCode's own usage API returns
  // epoch milliseconds.
  if (typeof value === "number") return Number.isFinite(value) ? value : null
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
 *
 * OpenCode Go reports percentages only; the per-model dollar allowances on the
 * pricing page are reference information and are never converted into "spend".
 * ClinePass reports percentages plus a plan document whose caps ARE real
 * dollars, so its windows carry a limit and the panel can show used / limit.
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
    windows.push(buildWindow(kind, Number(src.percent) || 0, toMs(src.resetsAt), undefined, status))
  }
  if (windows.length === 0) throw new Error("usage API returned an unexpected shape")
  return windows
}

/**
 * Map the OpenCode host's own usage payload (`GET /api/experimental/usage/limits`)
 * onto the panel's windows. Newer OpenCode releases expose the Go meters there,
 * which removes the need for a key entirely; older ones do not, so the caller
 * falls back to the provider endpoint above.
 */
export function goWindowsFromLimits(info: any): UsageWindow[] | undefined {
  const go = info?.go ?? info?.data?.go
  if (!go) return undefined
  const meters: Record<WindowKind, any> = {
    hour5: go.rolling,
    weekly: go.weekly,
    monthly: go.monthly,
  }
  const windows: UsageWindow[] = []
  for (const kind of WINDOW_ORDER) {
    const meter = meters[kind]
    if (!meter) continue
    windows.push(
      buildWindow(
        kind,
        Number(meter.percent) || 0,
        toMs(meter.resetsAt),
        undefined,
        meter.limited === true ? "limited" : "ok",
      ),
    )
  }
  return windows.length > 0 ? windows : undefined
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