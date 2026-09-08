/**
 * Annotation — one human finding. Keyed by element identity so verify
 * (decision 7) can re-capture the same spot and diff.
 */

import { z } from "zod";
import { elementIdentitySchema } from "./element.js";
import { filteredComputedStyleSchema } from "./styles.js";
import { frameworkHintsSchema } from "./hints.js";

export const annotationStatusSchema = z.enum([
  "open", // reported, not yet addressed
  "sent", // batch delivered to an agent
  "fixed", // agent claims done, awaiting human verify
  "verified", // human confirmed via before/after
  "dismissed", // human decided not an issue
]);
export type AnnotationStatus = z.infer<typeof annotationStatusSchema>;

/** Screenshot as a data URL (PNG) — element crop */
export const screenshotSchema = z.string().startsWith("data:image/");

export const annotationSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  /** Which element this is about — the join key for verify re-capture */
  element: elementIdentitySchema,
  /** The human's finding, in their words */
  comment: z.string().min(1),
  /** Filtered computed styles at capture time */
  computedStyle: filteredComputedStyleSchema,
  /** Element crop at capture time */
  screenshot: screenshotSchema,
  /** How many times this annotation has been through send → verify */
  iteration: z.number().int().nonnegative().default(0),
  status: annotationStatusSchema.default("open"),
  /** Present when status is fixed/verified — re-captured evidence */
  afterScreenshot: screenshotSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Annotation = z.infer<typeof annotationSchema>;
