#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { UigrepDaemonClient } from "@uigrep/bridge";
import {
  CONTEXT_BUDGETS,
  contextModeSchema,
  toCaptureManifest,
} from "@uigrep/schema";
import { z } from "zod";

function tokenPath(): string {
  if (process.platform === "win32") {
    return join(
      process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
      "uigrep",
      "token",
    );
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "uigrep", "token");
  }
  return join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "uigrep",
    "token",
  );
}

async function loadToken(): Promise<string> {
  const fromEnvironment = process.env.UIGREP_TOKEN?.trim();
  if (fromEnvironment) return fromEnvironment;
  try {
    return (await readFile(tokenPath(), "utf8")).trim();
  } catch {
    throw new Error(
      "uigrep is not running or has not created its local pairing token.",
    );
  }
}

function asText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

async function main(): Promise<void> {
  const client = new UigrepDaemonClient(
    await loadToken(),
    process.env.UIGREP_DAEMON_ORIGIN,
  );
  const server = new McpServer({ name: "uigrep", version: "0.1.0" });

  server.registerTool(
    "uigrep_list_captures",
    {
      description:
        "List compact pending uigrep capture manifests. Use this before requesting annotation evidence.",
      inputSchema: z.object({}),
    },
    async () => {
      const captures = await client.listCaptures();
      return {
        content: [{ type: "text", text: asText(captures) }],
        structuredContent: { captures },
      };
    },
  );

  server.registerTool(
    "uigrep_get_capture",
    {
      description:
        "Get a compact capture manifest. Search the harness current working directory using its comments and target summaries before requesting deeper evidence.",
      inputSchema: z.object({ sessionId: z.string().uuid() }),
    },
    async ({ sessionId }) => {
      const manifest = toCaptureManifest(await client.getCapture(sessionId));
      return {
        content: [{ type: "text", text: asText(manifest) }],
        structuredContent: manifest,
      };
    },
  );

  server.registerTool(
    "uigrep_get_annotation_context",
    {
      description:
        "Get bounded evidence for one annotation only after the compact manifest and a workspace search are insufficient. Screenshots remain referenced, not embedded.",
      inputSchema: z.object({
        sessionId: z.string().uuid(),
        annotationId: z.string().uuid(),
        mode: contextModeSchema.default("efficient"),
        include: z
          .array(z.enum(["targets", "dom", "styles", "screenshot"]))
          .default(["targets"]),
      }),
    },
    async ({ sessionId, annotationId, mode, include }) => {
      const capture = await client.getCapture(sessionId);
      const annotation = capture.annotations.find(
        (candidate) => candidate.id === annotationId,
      );
      if (!annotation)
        throw new Error(`Annotation ${annotationId} was not found.`);
      const budget = CONTEXT_BUDGETS[mode];
      const context = {
        id: annotation.id,
        order: annotation.order,
        comment: annotation.comment,
        selectionMethod: annotation.selectionMethod,
        viewportRect: annotation.viewportRect,
        pageRect: annotation.pageRect,
        targets: include.includes("targets")
          ? annotation.targets.slice(0, budget.rankedTargets).map((target) => ({
              id: target.id,
              rank: target.rank,
              tag: target.tag,
              text: target.text,
              rect: target.rect,
              selectors: target.selectors,
              attributes: target.attributes,
              score: target.score,
              ...(include.includes("dom")
                ? { domSnippet: target.domSnippet.slice(0, budget.domBytes) }
                : {}),
              ...(include.includes("styles")
                ? {
                    styleFacts: Object.fromEntries(
                      Object.entries(target.styleFacts).slice(
                        0,
                        budget.styleFacts,
                      ),
                    ),
                  }
                : {}),
            }))
          : [],
        ...(include.includes("screenshot")
          ? { screenshot: annotation.screenshot }
          : {}),
        hasMore:
          annotation.targets.length > budget.rankedTargets ||
          annotation.hasMoreTargets,
      };
      return {
        content: [{ type: "text", text: asText(context) }],
        structuredContent: context,
      };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `uigrep MCP failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
