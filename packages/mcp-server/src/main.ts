/**
 * Entry point: stdio MCP server + localhost bridge (phase 5).
 *
 * Harness config (e.g. Claude Code / Cursor / pi):
 *   { "mcpServers": { "uigrep": { "command": "node", "args": ["/path/to/uigrep/packages/mcp-server/src/main.ts"] } } }
 *
 * NOTE: stdout carries MCP protocol — log via console.error only.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createUigrepServer } from "./server.ts";
import { createBridgeServer, DEFAULT_BRIDGE_PORT } from "./bridge.ts";
import { FileFeedbackStore } from "./file-store.ts";

const store = new FileFeedbackStore();
await store.load();

const server = createUigrepServer(store);
await server.connect(new StdioServerTransport());

const port = Number(process.env.UIGREP_PORT ?? DEFAULT_BRIDGE_PORT);
createBridgeServer(store, port);
console.error(`[uigrep] MCP stdio ready · bridge on http://127.0.0.1:${port}`);
