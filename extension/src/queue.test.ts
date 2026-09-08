import { beforeEach, describe, expect, it } from "vitest";
import { addAnnotation, getSession, removeAnnotation, updateAnnotationStatus, sessionKeyFor, markSessionSent } from "./queue";

// happy-dom lacks browser.storage — stub W3C-ish local storage on globalThis
type Store = Record<string, unknown>;
const backing: Store = {};
(globalThis as Record<string, unknown>).browser = {
  storage: {
    local: {
      async get(keys: string | string[]): Promise<Record<string, unknown>> {
        const wanted = Array.isArray(keys) ? keys : [keys];
        const out: Record<string, unknown> = {};
        for (const k of wanted) if (k in backing) out[k] = JSON.parse(JSON.stringify(backing[k]));
        return out;
      },
      async set(items: Record<string, unknown>): Promise<void> {
        for (const [k, v] of Object.entries(items)) backing[k] = JSON.parse(JSON.stringify(v));
      },
    },
  },
};

const VIEWPORT = { width: 1280, height: 800, devicePixelRatio: 2 };
const URL_A = "http://localhost:5173/settings";
const identity = {
  selector: "button.btn-primary",
  xpath: "/html/body/main/button[1]",
  bbox: { x: 10, y: 20, width: 100, height: 40 },
  tagName: "button",
  visibleText: "Save",
};

function annotationFields(comment: string) {
  return {
    element: identity,
    comment,
    computedStyle: { properties: { position: "static" } },
    screenshot: "data:image/png;base64,AAAA",
  };
}

describe("queue", () => {
  beforeEach(() => {
    for (const k of Object.keys(backing)) delete backing[k];
  });

  it("sessionKeyFor strips query strings", () => {
    expect(sessionKeyFor("http://x.com/a?b=1")).toBe("http://x.com/a");
  });

  it("addAnnotation creates session lazily", async () => {
    const a = await addAnnotation(URL_A, "Settings", VIEWPORT, annotationFields("broken"));
    expect(a.status).toBe("open");
    const session = await getSession(URL_A);
    expect(session!.annotations).toHaveLength(1);
    expect(session!.annotations[0].comment).toBe("broken");
  });

  it("addAnnotation accumulates into same session", async () => {
    const a1 = await addAnnotation(URL_A, "Settings", VIEWPORT, annotationFields("one"));
    const a2 = await addAnnotation(URL_A, "Settings", VIEWPORT, annotationFields("two"));
    expect(a2.sessionId).toBe(a1.sessionId);
    const session = await getSession(URL_A);
    expect(session!.annotations.map((x) => x.comment)).toEqual(["one", "two"]);
  });

  it("different URLs → different sessions", async () => {
    await addAnnotation(URL_A, "A", VIEWPORT, annotationFields("x"));
    await addAnnotation("http://localhost:5173/home", "B", VIEWPORT, annotationFields("y"));
    expect((await getSession(URL_A))!.annotations).toHaveLength(1);
    expect((await getSession("http://localhost:5173/home"))!.annotations).toHaveLength(1);
  });

  it("removeAnnotation deletes, and drops empty session", async () => {
    const a = await addAnnotation(URL_A, "A", VIEWPORT, annotationFields("x"));
    await removeAnnotation(a.id);
    expect(await getSession(URL_A)).toBeNull();
  });

  it("updateAnnotationStatus transitions", async () => {
    const a = await addAnnotation(URL_A, "A", VIEWPORT, annotationFields("x"));
    await updateAnnotationStatus(a.id, "sent");
    expect((await getSession(URL_A))!.annotations[0].status).toBe("sent");
    await updateAnnotationStatus(a.id, "verified");
    expect((await getSession(URL_A))!.annotations[0].status).toBe("verified");
  });

  it("updateAnnotationStatus unknown id throws", async () => {
    await addAnnotation(URL_A, "A", VIEWPORT, annotationFields("x"));
    await expect(updateAnnotationStatus("nope", "sent")).rejects.toThrow();
  });

  it("markSessionSent flips open → sent, leaves fixed untouched", async () => {
    const a1 = await addAnnotation(URL_A, "A", VIEWPORT, annotationFields("one"));
    await addAnnotation(URL_A, "A", VIEWPORT, annotationFields("two"));
    await updateAnnotationStatus(a1.id, "fixed");
    await markSessionSent(URL_A);
    const statuses = (await getSession(URL_A))!.annotations.map((x) => x.status);
    expect(statuses).toEqual(["fixed", "sent"]);
  });
});
