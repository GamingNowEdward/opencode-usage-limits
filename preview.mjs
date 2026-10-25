// Standalone preview: reads the real API keys, queries the live usage APIs and
// prints the sidebar block with ANSI colours, mirroring the TUI layout.
//   node preview.mjs                                  -> both providers
//   node preview.mjs cline-pass                       -> one provider
//   node preview.mjs opencode-go kimi-k3              -> pick the model shown
import { homedir } from "node:os"
import { join } from "node:path"
import {
  PROVIDERS,
  clampPercent,
  fetchUsage,
  formatUsd,
  isWindowLimited,
  keyFromCredentials,
  modelAllowance,
  resetText,
  resolveKey,
  usedUsd,
  windowSeverity,
} from "./core.ts"

/**
 * Mirror the TUI: OpenCode v2 keeps credentials in its database, so read them
 * from there before falling back to auth.json. `node:sqlite` is optional and
 * failures silently fall through to the legacy store.
 */
async function keyFromDatabase(providerID) {
  try {
    const { DatabaseSync } = await import("node:sqlite")
    const file = join(homedir(), ".local", "share", "opencode", "opencode.db")
    const db = new DatabaseSync(file, { readOnly: true })
    const rows = db.prepare("select integration_id, value, active from credential").all()
    const entries = rows.map((row) => ({
      integrationID: row.integration_id,
      active: row.active === 1,
      value: JSON.parse(row.value),
    }))
    return keyFromCredentials(entries, providerID)
  } catch {
    return undefined
  }
}

const OUTER = 4 // leading indent inside the sidebar
const CONTENT = 36 // usable content width (sidebar is ~40 cols)
const DEFAULT_GO_MODEL = "deepseek-v4.1-flash"

const RESET = "\x1b[0m"
const DIM = "\x1b[2m"
const BOLD = "\x1b[1m"

function colorFor(window) {
  const level = windowSeverity(window)
  if (level === "danger") return "\x1b[31m" // red
  if (level === "warn") return "\x1b[33m" // yellow
  return "\x1b[32m" // green
}

function renderWindow(window, now) {
  const pct = clampPercent(window.percent)
  const color = colorFor(window)

  const labelWidth = CONTENT - 6
  const status = isWindowLimited(window) ? `  ${window.status}` : ""
  const head = `${window.label}${status}`.padEnd(labelWidth) + String(`${pct}%`).padStart(5)

  const barWidth = CONTENT - 4
  const filled = Math.round((pct / 100) * barWidth)
  const bar = `${color}${"█".repeat(filled)}${RESET}${DIM}${"░".repeat(barWidth - filled)}${RESET}`

  // Only providers with a real dollar cap (ClinePass) show used / limit.
  const used = usedUsd(window)
  const left = `↻ ${resetText(window.resetsAt, now)}`
  const right = used != null && window.limit != null ? `${formatUsd(used)} / ${formatUsd(window.limit)}` : ""
  const foot = right ? left.padEnd(CONTENT - right.length) + right : left

  const pad = " ".repeat(OUTER)
  return [`${pad}${color}${head}${RESET}`, `${pad}${bar}`, `${pad}${DIM}${foot}${RESET}`]
}

/** Reference line: how expensive the selected OpenCode Go model is. */
function renderAllowance(modelID) {
  const allowance = modelAllowance(modelID)
  const text = allowance === "free" ? "∞" : allowance ? `$${allowance.go}/$${allowance.plus}` : "—"
  const label = modelID ?? ""
  const width = Math.max(1, CONTENT - text.length)
  const line = label.length > width ? label.slice(0, width) : label.padEnd(width) + text
  // Full-intensity text, not DIM: this line is a deliberate signal, not a footnote.
  return `${" ".repeat(OUTER)}${line}`
}

async function show(providerID, modelID) {
  const config = PROVIDERS[providerID]
  const key = await resolveKey(providerID, keyFromDatabase)
  if (!key) {
    console.log(`\n${" ".repeat(OUTER)}${BOLD}USAGE · ${config.title}${RESET}`)
    console.log(`${" ".repeat(OUTER + 2)}${"\x1b[31m"}API key not found${RESET}`)
    return
  }
  const windows = await fetchUsage(config, key)
  const now = Date.now()
  console.log()
  console.log(`${" ".repeat(OUTER)}${BOLD}USAGE · ${config.title}${RESET}`)
  for (const window of windows) {
    for (const line of renderWindow(window, now)) console.log(line)
    console.log()
  }
  if (providerID === "opencode-go") {
    console.log(renderAllowance(modelID))
    console.log()
  }
}

const target = process.argv[2]
const modelArg = process.argv[3]
if (target) {
  await show(target, modelArg ?? (target === "opencode-go" ? DEFAULT_GO_MODEL : undefined))
} else {
  await show("opencode-go", modelArg ?? DEFAULT_GO_MODEL)
  await show("cline-pass")
}
