# uigrep

> Grep your UI — point at what's wrong, an agent fixes it.

Browser extension for selecting UI elements, annotating them with comments, and
sending structured feedback to any coding harness (Claude Code, Cursor, pi, etc.)
via MCP. Replaces the broken "take screenshot, paste into agent, hope the model
fixes the right thing" workflow.

## Problem

Devs see UI that is wrong, screenshot it, paste it into an agent with some
context, and the model sometimes fixes the wrong element or misses the intent.
Error comes from ambiguity: pixels don't say which node, comment doesn't say
which state. uigrep removes ambiguity by capturing exact element identity plus
human intent.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Personal-first tool, built so strangers can use it. Modest revenue acceptable ($1k/mo), not required. | Scratch own itch first; stranger adoption is signal, not goal. |
| 2 | First non-self user: indie dev using coding agents daily. | Own profile, zero market research, installs without approval, pays for workflow tools. |
| 3 | Harness-agnostic. MCP is the contract. No first-class harness. | Write once, works everywhere MCP works. Payload quality is the product. |
| 4 | Payload = element screenshot + CSS selector + XPath + bbox + comment + filtered computed styles + framework hints. | Model sees what user saw, knows exactly which node, has intent. Rejects: full-page screenshots (bloat), raw computed style dumps (~300 props of noise), authored-CSS-only (loses rendered reality). |
| 5 | Transport: local MCP server, v1. | Cleanest UX ("check my UI feedback" → agent pulls via tool call), true agnostic. Accepted cost: extension↔server plumbing is v1 scope. |
| 6 | Multi-select queue, batch send. | Review a page once, send all findings as one payload — gives agent full intent, prevents fix #2 breaking #3. Inspired by Plannotator-style annotation UX (unverified — search unavailable). |
| 7 | Verification: status-tracked queue + manual "verify" re-capture producing before/after evidence. C-lite. | Closes the loop cheaply (queue already keyed by selector). Auto-verification deferred to v2. |
| 8 | Queue persisted in browser storage, keyed by URL. | Free, no coupling to MCP server, survives restarts. Disk sync rejected (couples capture to server liveness). |
| 9 | No URL→repo config. Agent infers from URL + selector + framework hints; asks user if ambiguous. | Devs run the agent in the right repo anyway. Config burden not justified; revisit if users complain. |
| 10 | Works on any URL. Payload must be self-sufficient (no source maps assumed), selectors must survive SPA navigation. | Requirement from owner. Design/tested on localhost apps; public sites work by mechanics. |
| 11 | Monetization parked. Revisit at ~100 users. Candidates: team tier (cloud sync, shared annotations, designer→dev relay) at $10-12/user/mo, or one-time license. Cheap insurance now: payload carries IDs, timestamps, user. | Money lives in team coordination, not solo speed. Can't price unseen usage. Open-source v1, watch usage, decide later. |
| 12 | Done = demo script + dogfood. (a) Open app in Chrome, select 3 elements, comment, send via MCP, agent fixes all 3, verify with before/after. (b) Use it as daily workflow for 2 weeks, never going back. | A defines *done*, C/dogfood defines *good*. Edge cases (shadow DOM, iframes, canvas) fixed when dogfooding hits them, not before. |

## Stack

- Chrome extension (Manifest V3), TypeScript, WXT (or Vite + crxjs)
- Local MCP server (`@modelcontextprotocol/sdk`)
- Zod schema for the payload contract
- All local. No backend, no auth, no DB for v1.

## v1 scope (explicitly in)

- Element selection overlay (content script), selector + XPath + bbox capture
- Element screenshot via `chrome.tabs.captureVisibleTab`
- Annotate: comment per selection, queue across page, persist in browser storage
- MCP server: agent pulls queued feedback, marks iterations
- Verify button: re-capture same selectors → before/after payload
- Framework hints (React/Vue/Svelte presence)

## Explicitly NOT in v1

- Backend, cloud sync, team features, auth
- Auto-verification / fix detection (v2)
- Clipboard fallback (MCP only)
- Deep integration with any single harness
- Shadow DOM / iframe / canvas edge-case hardening (dogfood first)
- Marketing site / pricing page

## Open questions

- Domain: `uigrep.dev` — check availability and buy (~$12/yr). Not blocking dev.
- Exact MCP tool surface: one tool (`get_feedback`) vs several (`get_feedback`, `mark_verified`)? Decide when wiring server.
- Plannotator interaction model: owner referenced it as annotation UX inspiration — needs a link/demo review when search is available.

## Naming

**uigrep.** Dev-tool metaphor (grep = point at exact thing). Pronounceable,
short, `uigrep.dev` is the domain target.
