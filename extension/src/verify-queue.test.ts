import { beforeEach, describe, expect, it } from "vitest";
import {
  addAnnotation,
  markSessionSent,
  mergeServerStatuses,
  getSession,
  sessionKeyFor,
  updateAnnotationFields,
} from "./queue";

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

const URL_A = "http://localhost:5173/settings";
const VIEWPORT = { width: 1280, height: 800, devicePixelRatio: 2 };

function annotationFields(comment: string) {
  return {
    element: {
      selector: "button.btn-primary",
      xpath: "/html/body/main/button[1]",
      bbox: { x: 10, y: 20, width: 100, height: 40 },
      tagName: "button",
    },
    comment,
    computedStyle: { properties: { position: "static" } },
    screenshot: "data:image/png;base64,AAAA",
  };
}

describe("verify loop storage", () => {
  beforeEach(() => {
    for (const k of Object.keys(backing)) delete backing[k];
  });

  it("updateAnnotationFields patches status + evidence", async () => {
    const a = await addAnnotation(URL_A, "A", VIEWPORT, annotationFields("x"));
    await updateAnnotationFields(a.id, {
      status: "verified",
      afterScreenshot: "data:image/png;base64,BBBB",
    });
    const session = await getSession(URL_A);
    expect(session!.annotations[0].status).toBe("verified");
    expect(session!.annotations[0].afterScreenshot).toBe("data:image/png;base64,BBBB");
  });

  it("updateAnnotationFields replaces screenshot (reopen flow)", async () => {
    const a = await addAnnotation(URL_A, "A", VIEWPORT, annotationFields("x"));
    await updateAnnotationFields(a.id, {
      screenshot: "data:image/png;base64,CCCC",
    });
    expect((await getSession(URL_A))!.annotations[0].screenshot).toBe(
      "data:image/png;base64,CCCC",
    );
  });

  it("mergeServerStatuses applies server-side transitions", async () => {
    const a1 = await addAnnotation(URL_A, "A", VIEWPORT, annotationFields("one"));
    const a2 = await addAnnotation(URL_A, "A", VIEWPORT, annotationFields("two"));
    await markSessionSent(URL_A);

    const merged = await mergeServerStatuses({
      [a1.id]: { status: "fixed", iteration: 1 },
      [a2.id]: { status: "sent", iteration: 0 }, // no change
    });

    expect(merged).toBe(1);
    const session = (await getSession(URL_A))!;
    const byId = Object.fromEntries(session.annotations.map((x) => [x.id, x]));
    expect(byId[a1.id].status).toBe("fixed");
    expect(byId[a2.id].status).toBe("sent");
  });

  it("mergeServerStatuses ignores unknown annotation ids", async () => {
    await addAnnotation(URL_A, "A", VIEWPORT, annotationFields("one"));
    await mergeServerStatuses({ "nope-id": { status: "fixed", iteration: 3 } });
    expect((await getSession(URL_A))!.annotations[0].status).toBe("open");
  });

  it("sessionKeyFor still strips query strings", () => {
    expect(sessionKeyFor("http://x.com/a?b=1")).toBe("http://x.com/a");
  });
});
