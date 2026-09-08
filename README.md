# uigrep

> Grep your UI — point at what's wrong, an agent fixes it.

uigrep is a browser extension + local MCP server. Select UI elements on any
page, annotate what's wrong, and send a structured payload — exact element
identity, filtered styles, screenshots, your comments — to any coding agent
harness (Claude Code, Cursor, pi, ...). No more screenshot-and-pray.

## Why

The current flow: you see broken UI, screenshot it, paste into your agent with
a description, and the model sometimes fixes the wrong element. The error comes
from ambiguity — pixels don't identify a node, and prose doesn't pin down
state. uigrep removes ambiguity: the agent gets the selector, the bbox, the
computed styles that matter, the element screenshot, and your intent.

## Status

**Phase 1 — payload contract.** Monorepo scaffold + Zod schema. See
[CONTEXT.md](./CONTEXT.md) for the full decision log and roadmap.

## Layout

- `packages/schema` — the payload contract (Zod). Everything else consumes it.
- `extension/` — Chrome extension (Manifest V3, TypeScript, WXT) — phase 3
- `packages/mcp-server/` — local MCP server — phase 2

## License

MIT (pending — see CONTEXT.md open questions)
