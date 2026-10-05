// Standalone preview: reads the real API keys, queries the live usage APIs and
// prints the sidebar block with ANSI colours, mirroring the TUI layout.
//   node preview.mjs            -> both providers
//   node preview.mjs cline-pass -> one provider
import {
  PROVIDERS,
  clampPercent,
  fetchUsage,
  formatUsd,
  isWindowLimited,
  resetText,
  resolveKey,
  usedUsd,
  windowSeverity,
} from "./core.ts"

const OUTER = 4 // leading indent inside the sidebar
const CONTENT = 36 // usable content width (sidebar is ~40 cols)

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

  const used = usedUsd(window)
  const left = `↻ ${resetText(window.resetsAt, now)}`
  const right = used != null && window.limit != null ? `${formatUsd(used)} / ${formatUsd(window.limit)}` : ""
  const foot = right ? left.padEnd(CONTENT - right.length) + right : left

  const pad = " ".repeat(OUTER)
  return [
    `${pad}${color}${head}${RESET}`,
    `${pad}${bar}`,
    `${pad}${DIM}${foot}${RESET}`,
  ]
}

async function show(providerID) {
  const config = PROVIDERS[providerID]
  const key = await resolveKey(providerID)
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
}

const target = process.argv[2]
if (target) {
  await show(target)
} else {
  await show("opencode-go")
  await show("cline-pass")
}