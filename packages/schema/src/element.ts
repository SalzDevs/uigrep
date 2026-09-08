/**
 * Element identity — the join key between a browser node and the codebase.
 * Selector is what an agent greps for; bbox is where it was on screen.
 */

import { z } from "zod";

export const boundingBoxSchema = z.object({
  /** Viewport-relative, px */
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
});
export type BoundingBox = z.infer<typeof boundingBoxSchema>;

export const elementIdentitySchema = z.object({
  /** Shortest stable CSS selector for the element */
  selector: z.string().min(1),
  /** XPath fallback — survives when CSS selector is ambiguous */
  xpath: z.string().min(1),
  /** Position + size at capture time */
  bbox: boundingBoxSchema,
  /** Tag name, lowercase, e.g. "button" */
  tagName: z.string(),
  /** aria-label / role / visible text when present — cheap intent signal for the agent */
  accessibleName: z.string().optional(),
  visibleText: z.string().max(500).optional(),
});
export type ElementIdentity = z.infer<typeof elementIdentitySchema>;
