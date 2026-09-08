import { describe, expect, it } from "vitest";
import type { FeedbackSession } from "@uigrep/schema";
import { InMemoryFeedbackStore } from "./store.js";

function makeSession(overrides: Partial<FeedbackSession> = {}): FeedbackSession {
  return {
    id: "s1",
    url: "http://localhost:5173/settings",
    viewport: { width: 1280, height: 800, devicePixelRatio: 2 },
    frameworkHints: { react: false, vue: false, svelte: false, angular: false },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    annotations: [],
    ...overrides,
  };
}

function makeAnnotation(id: string, status: "open" | "sent" | "fixed" | "verified" | "dismissed" = "open") {
  return {
    id,
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
    status,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as const;
}

describe("InMemoryFeedbackStore", () => {
  it("putSession then getPendingSessions returns open annotations", async () => {
    const store = new InMemoryFeedbackStore();
    await store.putSession(
      makeSession({ annotations: [makeAnnotation("a1")] }),
    );
    const pending = await store.getPendingSessions();
    expect(pending).toHaveLength(1);
    expect(pending[0].annotations[0].id).toBe("a1");
  });

  it("filters out fixed/verified/dismissed annotations", async () => {
    const store = new InMemoryFeedbackStore();
    await store.putSession(
      makeSession({
        annotations: [
          makeAnnotation("a1", "open"),
          makeAnnotation("a2", "fixed"),
          makeAnnotation("a3", "verified"),
          makeAnnotation("a4", "dismissed"),
        ],
      }),
    );
    const pending = await store.getPendingSessions();
    expect(pending[0].annotations.map((a) => a.id)).toEqual(["a1"]);
  });

  it("drops sessions with no pending annotations", async () => {
    const store = new InMemoryFeedbackStore();
    await store.putSession(
      makeSession({ annotations: [makeAnnotation("a1", "verified")] }),
    );
    expect(await store.getPendingSessions()).toEqual([]);
  });

  it("markFixed increments iteration and sets afterScreenshot", async () => {
    const store = new InMemoryFeedbackStore();
    await store.putSession(
      makeSession({ annotations: [makeAnnotation("a1")] }),
    );
    await store.markFixed("a1", "data:image/png;base64,BBBB");
    const pending = await store.getPendingSessions();
    expect(pending).toEqual([]); // fixed is not pending

    // verify evidence persisted on the stored session
    const all = (store as unknown as { sessions: Map<string, FeedbackSession> })
      .sessions
      .get("s1")!;
    expect(all.annotations[0].status).toBe("fixed");
    expect(all.annotations[0].iteration).toBe(1);
    expect(all.annotations[0].afterScreenshot).toBe("data:image/png;base64,BBBB");
  });

  it("markVerified and dismiss update status", async () => {
    const store = new InMemoryFeedbackStore();
    await store.putSession(
      makeSession({ annotations: [makeAnnotation("a1"), makeAnnotation("a2")] }),
    );
    await store.markVerified("a1");
    await store.dismiss("a2");
    const all = (store as unknown as { sessions: Map<string, FeedbackSession> })
      .sessions
      .get("s1")!;
    expect(all.annotations[0].status).toBe("verified");
    expect(all.annotations[1].status).toBe("dismissed");
  });

  it("throws on unknown annotation id", async () => {
    const store = new InMemoryFeedbackStore();
    await store.putSession(makeSession({ annotations: [makeAnnotation("a1")] }));
    await expect(store.markFixed("nope")).rejects.toThrow("Unknown annotation");
  });

  it("putSession deep-clones (mutation of input does not leak)", async () => {
    const store = new InMemoryFeedbackStore();
    const session = makeSession({ annotations: [makeAnnotation("a1")] });
    await store.putSession(session);
    (session.annotations[0] as { comment: string }).comment = "tampered";
    const all = (store as unknown as { sessions: Map<string, FeedbackSession> })
      .sessions
      .get("s1")!;
    expect(all.annotations[0].comment).toBe("Overlaps heading");
  });
});
