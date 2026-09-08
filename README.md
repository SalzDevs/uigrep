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

**Phases 1–6 built. Phase 7 (E2E demo) in progress.**

- Payload contract (`packages/schema`) — Zod, 11 tests
- MCP server (`packages/mcp-server`) — `get_feedback` / `mark_fixed`, localhost bridge, file persistence, 22 tests incl. real stdio E2E
- Extension (`extension/`) — pick mode, annotate popup, review queue, send, verify loop, 20 tests
- Full loop verified: annotate → send → agent pulls → fixes → human verifies/reopens

See [DEMO.md](./DEMO.md) to run it end to end, and [CONTEXT.md](./CONTEXT.md) for the decision log.

## Layout

- `packages/schema` — the payload contract (Zod). Everything else consumes it.
- `packages/mcp-server/` — local MCP server + HTTP bridge
- `extension/` — Chrome extension (Manifest V3, TypeScript, WXT)
- `demo/` — static pricing page with 3 planted UI bugs for the demo

## License

MIT (pending — see CONTEXT.md open questions)
