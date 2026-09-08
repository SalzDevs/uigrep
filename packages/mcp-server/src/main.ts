/**
 * Entry point: stdio MCP server. Coding harnesses spawn this process and
 * talk MCP over stdio — the agnostic path (decision 3).
 *
 * Phase 5 adds the extension→store transport (localhost HTTP endpoint run
 * alongside this process).
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createUigrepServer } from "./server.js";

const server = createUigrepServer();
await server.connect(new StdioServerTransport());
