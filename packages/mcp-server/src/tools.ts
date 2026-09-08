/**
 * MCP tool surface (resolves CONTEXT.md open question: one tool vs several).
 *
 * - get_feedback  — agent pulls pending sessions
 * - mark_fixed    — agent reports it addressed an annotation
 *
 * Deliberately NOT tools: verify/dismiss. Those are human judgements made in
 * the extension UI (decision 7) — the agent never self-verifies.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FeedbackStore } from "./store.ts";

export function registerTools(server: McpServer, store: FeedbackStore): void {
  server.tool(
    "get_feedback",
    "Pull pending UI feedback sessions collected with the uigrep browser extension. Each annotation carries the exact CSS selector/XPath, bounding box, filtered computed styles, an element screenshot, and the human's comment.",
    {},
    async () => {
      const sessions = await store.getPendingSessions();
      if (sessions.length === 0) {
        return {
          content: [
            { type: "text" as const, text: "No pending UI feedback." },
          ],
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(sessions) }],
      };
    },
  );

  server.tool(
    "mark_fixed",
    "Report that you (the agent) addressed a uigrep annotation. The human will verify in the browser; do not treat this as approval.",
    { annotationId: z.string().min(1) },
    async ({ annotationId }) => {
      try {
        await store.markFixed(annotationId);
        return {
          content: [
            {
              type: "text" as const,
              text: `Marked ${annotationId} as fixed. Awaiting human verification.`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
