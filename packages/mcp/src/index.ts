#!/usr/bin/env node
import { loadToken } from "./token.js";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { UigrepDaemonClient } from "@uigrep/bridge";
import {
  CONTEXT_BUDGETS,
  contextModeSchema,
  toCaptureManifest,
  type Annotation,
} from "@uigrep/schema";
import { z } from "zod";

function asText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

async function main(): Promise<void> {
  const client = new UigrepDaemonClient(
    await loadToken(),
    process.env.UIGREP_DAEMON_ORIGIN,
  );
  const server = new McpServer({ name: "uigrep", version: "0.2.0" });

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
        "Get a compact capture manifest: the app surface, the user's comments and the selected regions. Search the harness current working directory using these before requesting deeper evidence.",
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
        "Get bounded evidence for one annotation: the region screenshot (referenced, not embedded) and any accessibility elements the OS exposed inside the region. Only call this after the compact manifest and a workspace search are insufficient.",
      inputSchema: z.object({
        sessionId: z.string().uuid(),
        annotationId: z.string().uuid(),
        mode: contextModeSchema.default("efficient"),
        include: z.array(z.enum(["elements", "image"])).default(["elements"]),
      }),
    },
    async ({ sessionId, annotationId, mode, include }) => {
      const capture = await client.getCapture(sessionId);
      const annotation: Annotation | undefined = capture.annotations.find(
        (candidate) => candidate.id === annotationId,
      );
      if (!annotation)
        throw new Error(`Annotation ${annotationId} was not found.`);
      const budget = CONTEXT_BUDGETS[mode];
      const context = {
        id: annotation.id,
        order: annotation.order,
        comment: annotation.comment,
        rect: annotation.rect,
        app: capture.app,
        elements: include.includes("elements")
          ? annotation.elements.slice(0, budget.maxElements)
          : [],
        ...(include.includes("image") ? { image: annotation.image } : {}),
        hasMoreElements: annotation.elements.length > budget.maxElements,
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
