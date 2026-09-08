import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryFeedbackStore, type FeedbackStore } from "./store.ts";
import { registerTools } from "./tools.ts";

export function createUigrepServer(store?: FeedbackStore): McpServer {
  const server = new McpServer({
    name: "uigrep",
    version: "0.0.1",
  });
  registerTools(server, store ?? new InMemoryFeedbackStore());
  return server;
}
