import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryFeedbackStore, type FeedbackStore } from "./store.js";
import { registerTools } from "./tools.js";

export function createUigrepServer(store?: FeedbackStore): McpServer {
  const server = new McpServer({
    name: "uigrep",
    version: "0.0.1",
  });
  registerTools(server, store ?? new InMemoryFeedbackStore());
  return server;
}
