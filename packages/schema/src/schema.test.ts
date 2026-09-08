import { describe, expect, it } from "vitest";
import {
  annotationSchema,
  elementIdentitySchema,
  feedbackSessionSchema,
} from "./index.ts";

const validAnnotation = {
  id: "a1",
  sessionId: "s1",
  element: {
    selector: "button.btn-primary",
    xpath: "/html/body/main/button[1]",
    bbox: { x: 10, y: 20, width: 100, height: 40 },
    tagName: "button",
    visibleText: "Save",
  },
  comment: "Button overlaps the heading on mobile",
  computedStyle: {
    properties: {
      position: "absolute",
      color: "rgb(0, 0, 0)",
    },
  },
  screenshot: "data:image/png;base64,AAAA",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const validSession = {
  id: "s1",
  url: "http://localhost:5173/settings",
  viewport: { width: 1280, height: 800, devicePixelRatio: 2 },
  annotations: [validAnnotation],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("elementIdentitySchema", () => {
  it("accepts a full element identity", () => {
    expect(() =>
      elementIdentitySchema.parse(validAnnotation.element),
    ).not.toThrow();
  });

  it("rejects empty selector", () => {
    expect(() =>
      elementIdentitySchema.parse({ ...validAnnotation.element, selector: "" }),
    ).toThrow();
  });
});

describe("annotationSchema", () => {
  it("applies defaults: iteration 0, status open", () => {
    const parsed = annotationSchema.parse(validAnnotation);
    expect(parsed.iteration).toBe(0);
    expect(parsed.status).toBe("open");
  });

  it("rejects empty comment", () => {
    expect(() =>
      annotationSchema.parse({ ...validAnnotation, comment: "" }),
    ).toThrow();
  });

  it("rejects non-data-URL screenshot", () => {
    expect(() =>
      annotationSchema.parse({ ...validAnnotation, screenshot: "http://x" }),
    ).toThrow();
  });

  it("rejects unknown computed style property", () => {
    expect(() =>
      annotationSchema.parse({
        ...validAnnotation,
        computedStyle: { properties: { notARealProp: "1" } },
      }),
    ).toThrow();
  });

  it("rejects unknown status", () => {
    expect(() =>
      annotationSchema.parse({ ...validAnnotation, status: "wat" }),
    ).toThrow();
  });
});

describe("feedbackSessionSchema", () => {
  it("accepts a full session and defaults frameworkHints", () => {
    const parsed = feedbackSessionSchema.parse(validSession);
    expect(parsed.frameworkHints.react).toBe(false);
    expect(parsed.annotations).toHaveLength(1);
  });

  it("rejects non-URL page", () => {
    expect(() =>
      feedbackSessionSchema.parse({ ...validSession, url: "not a url" }),
    ).toThrow();
  });

  it("rejects session with zero annotations", () => {
    expect(() =>
      feedbackSessionSchema.parse({ ...validSession, annotations: [] }),
    ).toThrow();
  });

  it("rejects negative bbox", () => {
    expect(() =>
      feedbackSessionSchema.parse({
        ...validSession,
        annotations: [
          {
            ...validAnnotation,
            element: {
              ...validAnnotation.element,
              bbox: { x: 1, y: 1, width: -5, height: 10 },
            },
          },
        ],
      }),
    ).toThrow();
  });
});
