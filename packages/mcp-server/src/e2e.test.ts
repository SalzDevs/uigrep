/**
 * E2E: drive the real server exactly like a harness would — spawn
 * `node src/main.ts`, speak MCP JSON-RPC over stdio, exercise the full
 * loop against the real HTTP bridge. No mocks.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SERVER_PATH = join(import.meta.dirname, "main.ts");
const BRIDGE = "http://127.0.0.1:8743"; // test port, real server code

let proc: ChildProcessWithoutNullStreams;
let workDir: string;
let nextId = 1;

interface RpcResponse {
  id: number;
  result?: Record<string, unknown>;
  error?: { message: string };
}

function send(method: string, params: Record<string, unknown>): number {
  const id = nextId++;
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return id;
}

async function waitResponse(id: number, timeoutMs = 10_000): Promise<RpcResponse> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${id}`)), timeoutMs);
    const onData = (chunk: Buffer): void => {
      for (const line of chunk.toString().split("\n")) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as RpcResponse;
          if (msg.id === id) {
            clearTimeout(timer);
            proc.stdout.off("data", onData);
            resolve(msg);
            return;
          }
        } catch {
          // non-JSON line — ignore
        }
      }
    };
    proc.stdout.on("data", onData);
  });
}

async function rpc(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await waitResponse(send(method, params));
  if (res.error) throw new Error(`RPC error: ${res.error.message}`);
  return res.result ?? {};
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const result = await rpc("tools/call", { name, arguments: args });
  return result as { content: Array<{ type: string; text: string }> };
}

const TS = "2026-01-01T00:00:00.000Z";

const demoSession = {
  id: "e2e-s1",
  url: "http://localhost:5173/pricing",
  viewport: { width: 1280, height: 800, devicePixelRatio: 2 },
  annotations: [
    {
      id: "e2e-a1",
      sessionId: "e2e-s1",
      element: {
        selector: "button.cta-primary",
        xpath: "/html/body/main/section[2]/button",
        bbox: { x: 100, y: 200, width: 180, height: 48 },
        tagName: "button",
        visibleText: "Start free trial",
      },
      comment: "CTA overlaps the pricing card below it",
      computedStyle: { properties: { position: "absolute", zIndex: "10" } },
      screenshot: "data:image/png;base64,AAAA",
      createdAt: TS,
      updatedAt: TS,
    },
    {
      id: "e2e-a2",
      sessionId: "e2e-s1",
      element: {
        selector: "h2.plan-name",
        xpath: "/html/body/main/section[1]/h2",
        bbox: { x: 100, y: 80, width: 200, height: 30 },
        tagName: "h2",
        visibleText: "Pro plan",
      },
      comment: "Wrong color, contrast fails",
      computedStyle: { properties: { color: "rgb(200, 200, 200)" } },
      screenshot: "data:image/png;base64,BBBB",
      createdAt: TS,
      updatedAt: TS,
    },
  ],
  createdAt: TS,
  updatedAt: TS,
};

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "uigrep-e2e-"));
  proc = spawn("node", [SERVER_PATH], {
    env: {
      ...process.env,
      UIGREP_PORT: "8743",
      UIGREP_HOME_DIR: workDir,
      HOME: workDir, // belt and suspenders for homedir() users
    },
  }) as ChildProcessWithoutNullStreams;
  await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "vitest-harness", version: "0.0.0" },
  });
  // notifications need no response
  proc.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
  );
});

afterAll(() => {
  proc?.kill();
  rmSync(workDir, { recursive: true, force: true });
});

describe("e2e: harness ↔ MCP ↔ bridge", () => {
  it("lists get_feedback and mark_fixed tools", async () => {
    const result = await rpc("tools/list", {});
    const names = (result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("get_feedback");
    expect(names).toContain("mark_fixed");
  });

  it("get_feedback is empty before any session arrives", async () => {
    const out = await callTool("get_feedback", {});
    expect(out.content[0].text).toContain("No pending");
  });

  it("full loop: push via bridge → pull → mark_fixed → verify → reopen", async () => {
    // extension pushes session through the real bridge
    const push = await fetch(`${BRIDGE}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(demoSession),
    });
    expect(push.status).toBe(200);

    // agent pulls both annotations
    const out = await callTool("get_feedback", {});
    const sessions = JSON.parse(out.content[0].text);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].annotations.map((a: { id: string }) => a.id)).toEqual([
      "e2e-a1",
      "e2e-a2",
    ]);
    // schema payload intact: selector + bbox + styles + screenshot + comment
    const a1 = sessions[0].annotations[0];
    expect(a1.element.selector).toBe("button.cta-primary");
    expect(a1.element.bbox.width).toBe(180);
    expect(a1.computedStyle.properties.position).toBe("absolute");
    expect(a1.screenshot).toMatch(/^data:image\//);
    expect(a1.comment).toContain("overlaps");

    // agent fixes a1 → claims it
    const fixed = await callTool("mark_fixed", { annotationId: "e2e-a1" });
    expect(fixed.content[0].text).toContain("Awaiting human verification");

    // human side: server sees fixed
    const statuses = (await (await fetch(`${BRIDGE}/statuses`)).json()) as Record<
      string,
      { status: string; iteration: number }
    >;
    expect(statuses["e2e-a1"].status).toBe("fixed");
    expect(statuses["e2e-a1"].iteration).toBe(1);
    expect(statuses["e2e-a2"].status).toBe("open");

    // human reopens a1 (still broken)
    await fetch(`${BRIDGE}/reopen`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ annotationId: "e2e-a1" }),
    });
    const after = (await (await fetch(`${BRIDGE}/statuses`)).json()) as Record<
      string,
      { status: string; iteration: number }
    >;
    expect(after["e2e-a1"].status).toBe("open");
    expect(after["e2e-a1"].iteration).toBe(2);

    // agent sees it again on next pull
    const out2 = await callTool("get_feedback", {});
    const sessions2 = JSON.parse(out2.content[0].text);
    const ids = sessions2[0].annotations.map((a: { id: string }) => a.id);
    expect(ids).toContain("e2e-a1");
    expect(ids).toContain("e2e-a2");
  });

  it("mark_fixed with unknown id reports error without crashing", async () => {
    const out = await callTool("mark_fixed", { annotationId: "ghost" });
    expect(out.content[0].text).toContain("Failed");
  });
});
