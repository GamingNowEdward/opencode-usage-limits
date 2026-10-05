# AGENTS.md

Development conventions for the `usage-limits` plugin, shared by humans and AI agents.

## Overview

An **OpenCode V2 TUI plugin** that shows the usage limits of the subscription behind the currently
selected model (5-hour / weekly / monthly) in the right sidebar, using each provider's official
usage endpoint.

- Supported providers: `opencode-go`, `cline-pass`
- Shape: CLI/TUI plugin (`@opencode/plugin/tui`), Solid JSX
- No build step: OpenCode's runtime (Bun) transpiles `.ts` / `.tsx` directly

## Layout

```
usage-limits/
├─ tui.tsx        TUI plugin: slot registration, collapse, rendering, polling
├─ tui.ts         Discovery entrypoint, re-exports tui.tsx (for the tui.ts name)
├─ index.ts       Server entrypoint (no-op) so either discovery path resolves
├─ core.ts        Pure logic: auth, API client, formatting, thresholds (no JSX)
├─ preview.mjs    Offline preview: real key, real API, ANSI output
├─ package.json   exports map
├─ AGENTS.md      This file
├─ README.md      Simplified Chinese README (default)
├─ README.en.md   English README
├─ CHANGELOG.md   Changelog (Simplified Chinese)
├─ CHANGELOG.en.md Changelog (English)
└─ LICENSE        MIT
```

## Technical constraints

- **Do not introduce a build tool.** Files are loaded as source by OpenCode; confirm the runtime
  already provides anything you add.
- **Do not use `@opencode-ai/plugin` (V1).** V2 uses `@opencode/plugin`.
- Stick to conservative `<box>` / `<text>` in the render layer. `<box>` supports `backgroundColor`,
  `flexGrow`, `onMouseUp`, and more; colours come from `context.theme` (`ResolvedTheme`).
- `core.ts` **must not** import JSX or Solid, so the preview script keeps running under plain Node.

## Implementation notes

| Concern | Convention |
| --- | --- |
| Ordering | `context.ui.slot({ prepend: "sidebar.content" })`; same-anchor claims coexist in plugin enable order |
| Colours | Green/yellow/red from the theme's semantic colours `text.feedback.{success,warning,error}.base` |
| Thresholds | `WARN_AT = 50`, `DANGER_AT = 80`, defined in `core.ts` |
| Window status | A provider status other than `ok` forces the danger colour and prints the status word next to the label |
| Partial readings | Fewer than `WINDOW_COUNT` windows renders `partial data · N/3` instead of silently dropping rows |
| ClinePass caps | Read live from `/users/me/plan` (`inferenceCapThreshold`); cached for 6h; never fails the usage fetch |
| Cap unit | Caps and `costUsd` share a unit: **1 unit = 1e-8 USD** (`CLINE_CAP_UNIT_USD`), calibrated against live data |
| Limit overrides | `options.limits.<providerID>` overrides built-in budgets (OpenCode Go) and is the fallback when a ClinePass plan read fails |
| Credentials | `extractKey` accepts one credential object or an array (multiple accounts); the first usable key wins |
| Transient failures | 429 / 5xx / network failures back off (double, capped at 5 min) and show `retry in Ns`; auth and shape errors do not |
| Freshness | The title row's right cell stays blank while data is fresh; the age (`2m`) appears in the warning colour only once the reading is older than 2.5 polling intervals (it shares the fixed-width cell with the spinner) |
| Progress track | The unfilled colour uses `theme.border.base` (`background.raised.base` matches the panel and disappears) |
| Collapse | Persisted via `context.storage.store("usage-limits.panel")`; title row `onMouseUp` + a command-palette command |
| Countdown | `↻ ` followed by the time, with a single space after the glyph |
| API key | Read live from `auth.json`; **never** write it to the repo or logs |

## Commands

```powershell
# Offline preview (real key, real endpoint, coloured output)
node preview.mjs
node preview.mjs cline-pass

# Transpile / syntax check
npx --yes esbuild tui.tsx --bundle --platform=node --format=esm --jsx=automatic `
  --external:@opencode/plugin/tui --external:solid-js --external:@opentui/solid `
  --outfile=$env:TEMP\ul-check.js

# Config hot reload (local plugin edits may need a TUI restart)
opencode service restart
```

Log: `~/.local/share/opencode/log/opencode.log`, filter by `role=cli` and `plugin`.

## Release

Published to npm as `opencode-usage-limits` via **trusted publishing (OIDC)** — no npm token is stored
in the repository.

1. Bump `version` in `package.json` and turn the CHANGELOG's current section into a new dated one
   (`CHANGELOG.md` **and** `CHANGELOG.en.md`).
2. Commit, then tag and push:

   ```sh
   git tag vX.Y.Z
   git push origin main --tags
   ```

3. `.github/workflows/publish.yml` checks the tag against `package.json`, then runs `npm publish`
   over OIDC. Provenance is generated automatically.

Manual publishing still works (`npm publish --otp=…`), but **granular access tokens with bypass-2FA
no longer publish**; npm is retiring that path (target January 2027) in favour of trusted publishing.

## Change notes

- **Saving a plugin file hot reloads it.** OpenCode watches the local plugin path configured in
  `cli.json`: saving `tui.tsx` / `core.ts` triggers a `plugin reconciliation` and reloads the module,
  so **no TUI restart is needed**. Verified against `~/.local/share/opencode/log/opencode.log`
  (file mtime matches the reconciliation timestamp to the second).
- Touching `cli.json` is *not* what triggers a reload; the plugin file save itself does.
- A TUI restart is only needed when the **module graph** changes (adding or removing an imported
  file) or when a host API changes.
- Reloading re-runs `setup()`, so it also refetches usage on every save; module-level caches (e.g.
  the ClinePass cap cache) are cleared by a reload.
- When changing an API field or the provider list, update `PROVIDERS` in `core.ts` and both READMEs.
- Every behaviour change must be recorded in **both** `CHANGELOG.md` and `CHANGELOG.en.md`.

## Documentation

- Keep all documents **bilingual**: `X.md` (Simplified Chinese, default) + `X.en.md` (English).
- Link the two files to each other at the top and keep the content aligned.
- Link external references and keep original identifiers (provider IDs, endpoint paths) untranslated.

## Links

- [OpenCode V2 docs](https://opencode.ai/v2/docs/)
- [Build plugins](https://opencode.ai/v2/docs/build/plugins)
- [CLI plugins](https://opencode.ai/v2/docs/build/plugins/cli)
- [Configure plugins](https://opencode.ai/v2/docs/plugins)