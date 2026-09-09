# uigrep

uigrep is a local-first visual context bridge for coding agents. Start the background app, press a shortcut, annotate one or more UI regions in the browser, and let an MCP-enabled coding harness retrieve only the context it needs.

## Product principles

- The desktop UI is a fixed, non-expandable status pill.
- Capture happens in the user's real browser.
- The harness current working directory is the codebase root.
- Context is stored locally and disclosed progressively.
- No cloud account, telemetry, or hidden model calls.

## Workspace

- `apps/desktop` — Tauri desktop shell, local daemon, and status pill.
- `apps/extension` — WXT browser companion for Chromium and Firefox.
- `apps/test-app` — deterministic UI used by integration tests.
- `packages/schema` — canonical capture contracts and budgets.
- `packages/bridge` — authenticated loopback protocol helpers.
- `packages/mcp` — generic MCP stdio adapter.

## Prerequisites

- Node.js 22+
- pnpm 10+
- Rust stable and the platform prerequisites for Tauri 2

## Development

1. Run `pnpm install`.
2. Run `pnpm check`.
3. Run `pnpm --filter @uigrep/desktop tauri dev` for the desktop app.
4. Run `pnpm --filter @uigrep/extension dev` for Chromium or `pnpm --filter @uigrep/extension dev:firefox` for Firefox.
5. Run `pnpm --filter @uigrep/test-app dev` for the fixture page.

The initial default shortcut is `Alt+Shift+G` (`Option+Shift+G` on macOS), and it will be configurable.
