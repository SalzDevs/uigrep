import { captureSessionSchema, type CaptureSession } from "@uigrep/schema";

const encoder = new TextEncoder();
/** UTF-8, not JS UTF-16 length: never split a Unicode scalar. */
export function truncateUtf8(text: string, maxBytes: number): string {
  let bytes = 0;
  let result = "";
  for (const scalar of text) {
    const size = encoder.encode(scalar).length;
    if (bytes + size > maxBytes) break;
    bytes += size;
    result += scalar;
  }
  return result;
}
function dictionary(
  input: Record<string, string>,
  maxCount: number,
  maxValue: number,
  maxTotal: number,
): Record<string, string> {
  const entries: [string, string][] = [];
  let bytes = 0;
  for (const [key, raw] of Object.entries(input)) {
    if (encoder.encode(key).length > 256) continue;
    const value = truncateUtf8(raw, maxValue);
    const size = encoder.encode(key + value).length;
    if (bytes + size > maxTotal || entries.length >= maxCount) break;
    bytes += size;
    entries.push([key, value]);
  }
  return Object.fromEntries(entries);
}
/** Tighter daemon wire budgets supplement the general shared schema. */
export function normalizeWireCapture(input: CaptureSession): CaptureSession {
  const capture = structuredClone(input);
  if (encoder.encode(capture.page.url).length > 8192)
    throw new Error("Page URL exceeds the 8192-byte wire budget.");
  if (!/^(https?:|file:)\/\//.test(capture.page.url))
    throw new Error("This page scheme cannot be captured.");
  capture.page.title = truncateUtf8(capture.page.title, 1000);
  const coordinate = (n: number) => {
    if (Math.abs(n) > 1e12)
      throw new Error("Page geometry exceeds the capture budget.");
  };
  for (const n of Object.values(capture.page.scroll)) coordinate(n);
  if (
    capture.page.viewport.width > 100000 ||
    capture.page.viewport.height > 100000
  )
    throw new Error("Viewport exceeds the capture budget.");
  capture.annotations.forEach((annotation, index) => {
    annotation.order = index + 1;
    annotation.comment = truncateUtf8(annotation.comment, 4000);
    for (const rect of [
      annotation.viewportRect,
      annotation.pageRect,
      annotation.scroll,
    ])
      for (const n of Object.values(rect)) coordinate(n);
    if (
      annotation.screenshot &&
      (encoder.encode(annotation.screenshot.resourceUri).length > 2048 ||
        annotation.screenshot.byteLength > 8388608 ||
        annotation.screenshot.width > 100000 ||
        annotation.screenshot.height > 100000)
    )
      throw new Error("Screenshot exceeds the capture budget.");
    annotation.targets.forEach((target, rank) => {
      target.rank = rank + 1;
      target.tag = truncateUtf8(target.tag, 64);
      target.text = truncateUtf8(target.text, 2000);
      target.domSnippet = truncateUtf8(target.domSnippet, 12288);
      for (const n of Object.values(target.rect)) coordinate(n);
      const limits = {
        testId: 256,
        id: 256,
        css: 2048,
        xpath: 2048,
        role: 128,
        accessibleName: 512,
      } as const;
      for (const key of Object.keys(limits) as (keyof typeof limits)[]) {
        const value = target.selectors[key];
        // Truncated selectors might identify the wrong element; omit instead.
        if (value && encoder.encode(value).length > limits[key])
          delete target.selectors[key];
      }
      target.attributes = dictionary(target.attributes, 20, 2000, 40960);
      target.styleFacts = dictionary(target.styleFacts, 100, 1024, 32768);
    });
  });
  const ids = new Set(capture.annotations.map((a) => a.id));
  if (ids.size !== capture.annotations.length)
    throw new Error("Duplicate annotation IDs.");
  for (const relationship of capture.relationships) {
    if (
      !ids.has(relationship.sourceAnnotationId) ||
      !ids.has(relationship.targetAnnotationId)
    )
      throw new Error("Relationship references an unknown annotation.");
    relationship.properties = relationship.properties.map((p) =>
      truncateUtf8(p, 128),
    );
  }
  return captureSessionSchema.parse(capture);
}
