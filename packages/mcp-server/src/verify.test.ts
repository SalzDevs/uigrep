import { describe, expect, it } from "vitest";
import type { FeedbackSession } from "@uigrep/schema";
import { InMemoryFeedbackStore } from "./store.js";

function makeSession(): FeedbackSession {
  return {
    id: "s1",
    url: "http://localhost:5173/settings",
    viewport: { width: 1280, height: 800, devicePixelRatio: 2 },
    frameworkHints: { react: false, vue: false, svelte: false, angular: false },
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
}

describe("verify-loop store methods", () => {
  it("allStatuses returns status + iteration per annotation", async () => {
    const store = new InMemoryFeedbackStore();
    await store.putSession(makeSession());
    const statuses = await store.allStatuses();
    expect(statuses["a1"]).toEqual({
      status: "open",
      iteration: 0,
    });
  });

  it("attachAfterScreenshot stores evidence without changing status", async () => {
    const store = new InMemoryFeedbackStore();
    await store.putSession(makeSession());
    await store.markFixed("a1");
    await store.attachAfterScreenshot("a1", "data:image/png;base64,BBBB");
    const statuses = await store.allStatuses();
    expect(statuses["a1"].status).toBe("fixed");
    expect(statuses["a1"].afterScreenshot).toBe("data:image/png;base64,BBBB");
  });

  it("reopen → open again, iteration++, evidence cleared", async () => {
    const store = new InMemoryFeedbackStore();
    await store.putSession(makeSession());
    await store.markFixed("a1", "data:image/png;base64,BBBB");
    await store.reopen("a1");
    const statuses = await store.allStatuses();
    expect(statuses["a1"].status).toBe("open");
    expect(statuses["a1"].iteration).toBe(2); // markFixed + reopen
    expect(statuses["a1"].afterScreenshot).toBeUndefined();
    // agent sees it again
    const pending = await store.getPendingSessions();
    expect(pending[0].annotations.map((a) => a.id)).toEqual(["a1"]);
  });

  it("unknown ids throw", async () => {
    const store = new InMemoryFeedbackStore();
    await store.putSession(makeSession());
    await expect(store.reopen("nope")).rejects.toThrow("Unknown annotation");
    await expect(store.attachAfterScreenshot("nope", "x")).rejects.toThrow();
  });
});
