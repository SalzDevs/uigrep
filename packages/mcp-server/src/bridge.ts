/**
 * Transport bridge (decision 5): localhost HTTP endpoint the extension
 * pushes sessions into, running in the same process as the stdio MCP
 * server. Agents never see this — they keep using MCP tools.
 */

import { createServer, type Server } from "node:http";
import { feedbackSessionSchema } from "@uigrep/schema";
import type { FeedbackStore } from "./store.ts";

export const DEFAULT_BRIDGE_PORT = 8742;

export function createBridgeServer(store: FeedbackStore, port = DEFAULT_BRIDGE_PORT): Server {
  const server = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "uigrep-bridge" }));
      return;
    }

    if (req.method === "POST" && req.url === "/sessions") {
      try {
        const body = await readBody(req);
        const session = feedbackSessionSchema.parse(JSON.parse(body));
        await store.putSession(session);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            sessionId: session.id,
            annotations: session.annotations.length,
          }),
        );
      } catch (err) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
      return;
    }

    if (req.method === "GET" && req.url === "/statuses") {
      // Extension polls this to sync server-side transitions (sent → fixed).
      const all = await store.allStatuses();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(all));
      return;
    }

    if (req.method === "POST" && req.url === "/verify") {
      try {
        const body = await readBody(req);
        const { annotationId, afterScreenshot } = JSON.parse(body) as {
          annotationId: string;
          afterScreenshot?: string;
        };
        await store.markVerified(annotationId);
        if (afterScreenshot) {
          await store.attachAfterScreenshot(annotationId, afterScreenshot);
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
      return;
    }

    if (req.method === "POST" && req.url === "/reopen") {
      try {
        const body = await readBody(req);
        const { annotationId } = JSON.parse(body) as { annotationId: string };
        await store.reopen(annotationId);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "not found" }));
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      // another uigrep instance owns the bridge — fine, it serves too
      console.error(
        `[uigrep] bridge port ${port} in use; another instance is serving it.`,
      );
      return;
    }
    throw err;
  });

  server.listen(port, "127.0.0.1");
  return server;
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
