# Changelog

All notable changes to `usage-limits` are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/).

[简体中文](./CHANGELOG.md) · [English](./CHANGELOG.en.md)

## 0.2.0 - 2026-10-06

### Added

- Added the [MIT](./LICENSE) license file.
- **ClinePass spend display**: reads `inferenceCapThreshold` from `GET /users/me/plan` and shows
  `used / limit` like OpenCode Go. The unit was calibrated against live data: caps and `costUsd`
  share a unit, **1 unit = 1e-8 USD** ($10 / $25 / $50). Caps are cached for 6 hours and a failed
  read never affects the usage reading itself.
- **Partial-data notice**: shows `partial data · N/3 windows` when fewer windows are returned.
- **Rate-limit backoff**: 429 / 5xx / network failures back off exponentially (capped at 5 minutes) and
  the error line shows `retry in Ns`; auth and shape errors are not retried. Polling moved from a fixed
  `setInterval` to result-driven `setTimeout` scheduling.
- **Configurable budgets**: a new `limits` option overrides the built-in budgets
  (e.g. `{ "opencode-go": { "monthly": 100 } }`); it is also the fallback when a ClinePass plan read fails.
- **Minimal re-render**: the window list moved from `<For>` to `<Index>`, so a usage refresh no longer
  destroys and rebuilds the three rows; the tick moved from every second to **minute boundaries**
  (second-precision only while a retry countdown is on screen); countdown and age text are wrapped in
  `createMemo` so unchanged text is never written to the DOM; the title row's right side is now a
  **fixed-width cell**, removing the layout jitter on each refresh. Update frequency drops from 4 spots
  per second to once a minute.
- **Freshness only shown when stale**: the title row's right cell stays blank while data is fresh; the
  age (`2m` / `5m`) appears only once the reading is older than 2.5 polling intervals (~75s), in the
  warning colour. The previously always-on `now` label is gone.

### Fixed

- **Usage request dropped when switching models**: the in-flight guard is now tracked
  **per provider** instead of a single global boolean. Previously, if a request was still in
  flight, the request for the newly selected provider was skipped and the panel only refreshed on
  the next poll (up to 30 seconds later). It now fires immediately, and the stale response is
  dropped by the provider check so it cannot pollute the panel.
- **Window status ignored**: each OpenCode Go window carries a `status` field that was previously
  read as a percentage only. A non-`ok` status now forces the danger colour and prints the status
  word, instead of showing a disabled window as healthy.
- **Missing windows silently dropped**: if one of the three windows was absent the row simply
  disappeared with no warning; incomplete readings are now called out explicitly.
- **Multiple credentials**: `extractKey` only handled a single credential object, so an `auth.json`
  holding an array (several accounts/connections) resolved to no key at all; it now takes the first
  usable one.

## 0.1.0 - 2026-10-06

Initial release.

### Added

- Sidebar usage block supporting **OpenCode Go** (`opencode-go`) and **ClinePass** (`cline-pass`).
- Three rolling windows: **5 hours / weekly / monthly**, with percentage, progress bar and reset countdown.
- OpenCode Go additionally shows the `used / limit` amount ($12 / $30 / $60).
- Green / yellow / red usage indication: < 50% green, 50–79% yellow, ≥ 80% red.
- Collapsible panel: click the title row to collapse to one line, toggle via the command palette
  command **Toggle usage panel**; the state is persisted.
- The API key is read live from OpenCode's `auth.json`; the plugin stores no credentials.
- `refreshMs` option (default 30000 ms).
- Nothing is rendered for other providers, so the sidebar is never taken up needlessly.
- Offline preview script [`preview.mjs`](./preview.mjs).

### Changed

- The sidebar claim now uses `prepend`, placing the block between the cache stats, Context and MCP.
- The normal state colour moved from the theme's primary colour to the theme's `success` (green),
  giving a consistent semantic green / yellow / red set.
- The unfilled progress track moved from `background.raised.base` to `border.base`, so it no longer
  blends into the panel background.
- The reset countdown label is uniformly `↻ ` (a single space after the glyph).
- Thresholds changed from 70 / 90 to **50 / 80**.

### Notes

- The usage endpoints are provider **undocumented** APIs and their fields may change at any time;
  on error the block shows an error line and keeps the last data.
- The ClinePass endpoint returns percentages only, so no dollar amount is shown.