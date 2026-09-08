import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { FeedbackSession } from "@uigrep/schema";
import { createBridgeServer, DEFAULT_BRIDGE_PORT } from "./bridge.ts";
import { FileFeedbackStore } from "./file-store.ts";
import { InMemoryFeedbackStore } from "./store.ts";

const validSession: FeedbackSession = {
  id: "s1",
  url: "http://localhost:5173/settings",
  viewport: { width: 1280, height: 800, devicePixelRatio: 2 },
  frameworkHints: { react: true, vue: false, svelte: false, angular: false },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  annotations: [
    {
      id: "a1",
      sessionId: "s1",
      element: {
        selector: "button.btn-primary",
        xpath: "/html/body/main/button[1]",
        bbox: { x: 10, y: 20, width: 100, height: 40 },
        tagName: "button",
      },
      comment: "Overlaps heading",
      computedStyle: { properties: { position: "absolute" } },
      screenshot: "data:image/png;base64,AAAA",
      iteration: 0,
      status: "open",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
};

describe("bridge", () => {
  const store = new InMemoryFeedbackStore();
  const port = DEFAULT_BRIDGE_PORT + 1; // avoid clashing with a running uigrep
  const server = createBridgeServer(store, port);
  const base = `http://127.0.0.1:${port}`;

  afterAll(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );

  it("GET /health responds ok", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("POST /sessions validates and stores", async () => {
    const res = await fetch(`${base}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validSession),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const pending = await store.getPendingSessions();
    expect(pending[0].annotations[0].id).toBe("a1");
  });

  it("POST /sessions rejects invalid payloads", async () => {
    const res = await fetch(`${base}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: true }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).ok).toBe(false);
  });

  it("unknown route → 404", async () => {
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
  });
});

describe("FileFeedbackStore", () => {
  const dir = mkdtempSync(join(tmpdir(), "uigrep-"));
  const filePath = join(dir, "nested", "feedback.json");

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("persists sessions to disk and reloads them", async () => {
    const store1 = new FileFeedbackStore(filePath);
    await store1.putSession(validSession);
    expect(readFileSync(filePath, "utf8")).toContain("s1");

    // fresh instance = server restart
    const store2 = new FileFeedbackStore(filePath);
    await store2.load();
    const pending = await store2.getPendingSessions();
    expect(pending[0].id).toBe("s1");
    expect(pending[0].annotations[0].comment).toBe("Overlaps heading");
  });

  it("handles missing file gracefully", async () => {
    const store = new FileFeedbackStore(join(dir, "missing.json"));
    await store.load();
    expect(await store.getPendingSessions()).toEqual([]);
  });

  it("markFixed persists across restart", async () => {
    const store1 = new FileFeedbackStore(filePath);
    await store1.markFixed("a1", "data:image/png;base64,BBBB");

    const store2 = new FileFeedbackStore(filePath);
    await store2.load();
    const all = (
      store2 as unknown as { sessions: Map<string, FeedbackSession> }
    ).sessions.get("s1")!;
    expect(all.annotations[0].status).toBe("fixed");
    expect(all.annotations[0].iteration).toBe(1);
    expect(all.annotations[0].afterScreenshot).toBe("data:image/png;base64,BBBB");
  });
});
