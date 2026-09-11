import { z } from "zod";

export const SCHEMA_VERSION = 2;

export const rectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
});
export type Rect = z.infer<typeof rectSchema>;

/** Accessibility element exposed by the OS AX tree under the region. */
export const elementSchema = z.object({
  role: z.string().min(1).max(64),
  label: z.string().max(2_000).optional(),
  identifier: z.string().max(512).optional(),
  value: z.string().max(2_000).optional(),
});
export type Element = z.infer<typeof elementSchema>;

/** Region crop pixels, stored locally. */
export const imageRefSchema = z.object({
  resourceUri: z.string().startsWith("uigrep://"),
  mimeType: z.enum(["image/png", "image/webp"]),
  byteLength: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type ImageRef = z.infer<typeof imageRefSchema>;

/** The app surface the capture was taken from. Web pages are just windows. */
export const appSchema = z.object({
  name: z.string().min(1).max(200),
  bundleId: z.string().max(300),
  windowTitle: z.string().max(500).optional(),
  url: z.string().url().optional(),
});
export type AppSurface = z.infer<typeof appSchema>;

export const annotationSchema = z.object({
  id: z.string().uuid(),
  order: z.number().int().min(1),
  comment: z.string().max(4_000).default(""),
  rect: rectSchema,
  image: imageRefSchema,
  elements: z.array(elementSchema).max(50).default([]),
});
export type Annotation = z.infer<typeof annotationSchema>;

export const captureSessionSchema = z.object({
  schemaVersion: z.literal(2),
  id: z.string().uuid(),
  capturedAt: z.string().datetime(),
  status: z.enum(["pending", "retrieved"]),
  app: appSchema,
  annotations: z.array(annotationSchema).min(1).max(50),
  relationships: z
    .array(
      z.object({
        from: z.string().uuid(),
        to: z.string().uuid(),
        kind: z.enum(["related", "duplicate"]),
      }),
    )
    .max(50)
    .default([]),
});
export type CaptureSession = z.infer<typeof captureSessionSchema>;

export const captureManifestSchema = captureSessionSchema.extend({
  annotations: z
    .array(
      annotationSchema
        .pick({
          id: true,
          order: true,
          comment: true,
          rect: true,
        })
        .strict(),
    )
    .max(50),
});
export type CaptureManifest = z.infer<typeof captureManifestSchema>;

/**
 * Progressive disclosure budgets. Pixel and element evidence is opt-in per
 * annotation; the manifest stays compact by default.
 */
export const CONTEXT_BUDGETS = {
  efficient: { manifestBytes: 2_048, annotationBytes: 1_024, maxElements: 5 },
  balanced: { manifestBytes: 4_096, annotationBytes: 2_048, maxElements: 20 },
  deep: { manifestBytes: 8_192, annotationBytes: 4_096, maxElements: 50 },
} as const;
export type ContextMode = keyof typeof CONTEXT_BUDGETS;

export const contextModeSchema = z.enum(["efficient", "balanced", "deep"]);

export function summarizeElement(element: Element | undefined): string {
  if (!element) return "Selected UI";
  return (
    element.label ??
    element.identifier ??
    (element.value
      ? `${element.role} “${element.value.slice(0, 40)}”`
      : element.role)
  );
}

export function toCaptureManifest(capture: CaptureSession): CaptureManifest {
  return {
    ...capture,
    status: "retrieved",
    annotations: capture.annotations.map((annotation) => ({
      id: annotation.id,
      order: annotation.order,
      comment: annotation.comment,
      rect: annotation.rect,
    })),
  };
}
