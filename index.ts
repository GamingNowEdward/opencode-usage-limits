import { Plugin } from "@opencode/plugin"

// Server-side entrypoint. This plugin is TUI-only, so the server side is a no-op.
export default Plugin.define({
  id: "usage-limits",
  setup() {},
})