# uigrep demo — 3 bugs, end to end

Run the full loop in ~5 minutes.

## 0. Prerequisites

- Node 26+ (native TypeScript execution)
- Chrome (or any Chromium)
- A coding agent that speaks MCP: Claude Code, Cursor, pi, ...

## 1. Start the three pieces

```bash
# terminal 1 — demo page with 3 planted UI bugs
pnpm demo                      # http://localhost:5173

# terminal 2 — MCP server + bridge (this is also the process to register in your harness)
pnpm agent                     # stdio MCP + bridge on http://127.0.0.1:8742
```

## 2. Load the extension

- `cd extension && pnpm dev` (or `pnpm build`)
- Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → select `extension/.output/chrome-mv3`
- Optional: pin it. Hotkeys: `Alt+Shift+U` pick, `Alt+Shift+P` review panel.

## 3. Register the MCP server in your harness

Example for Claude Code (`.mcp.json`):

```json
{
  "mcpServers": {
    "uigrep": {
      "command": "node",
      "args": ["<absolute-path>/uigrep/packages/mcp-server/src/main.ts"]
    }
  }
}
```

Cursor: Settings → MCP → New MCP server, same JSON shape.

## 4. Annotate the 3 bugs

Open `http://localhost:5173`:

1. `Alt+Shift+U` → click the **Pro plan** heading → comment: "contrast fails, barely readable" → Save
2. Click the **Start free trial** button → comment: "overlaps the pricing card" → Save
3. Click the **footer text** → comment: "line-height is crushed" → Save
4. `Alt+Shift+P` → check the queue → **Send to agent**

## 5. Let the agent work

In your harness:

> Get my uigrep feedback and fix every annotation in demo/index.html.

The agent pulls both-and-all annotations with exact selectors, bbox, filtered
computed styles, screenshots, and your comments — then edits the code and calls
`mark_fixed` per annotation.

## 6. Verify

Back in the browser: `Alt+Shift+P` → annotations show **fixed** →
**✓ Fixed** (if actually fixed) or **Still broken** (agent gets it again,
iteration++, with a fresh screenshot of the current state).

## Planted bugs (spoilers)

1. `.plan-name` — `color: #c8c8c8` on white = contrast fail
2. `.cta-primary` — `position: absolute; top: 140px; left: 48%` overlaps card
3. `footer` — `line-height: 0.6` crushes the text
