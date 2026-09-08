/**
 * Feedback session — one review of one page. The batch unit (decision 6):
 * user selects + annotates many elements, then sends the whole session.
 */

import { z } from "zod";
import { annotationSchema } from "./annotation.js";
import { frameworkHintsSchema } from "./hints.js";

export const viewportSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  devicePixelRatio: z.number().positive(),
});

export const feedbackSessionSchema = z.object({
  id: z.string().min(1),
  /** Full page URL — agent infers the repo from this (decision 9) */
  url: z.string().url(),
  pageTitle: z.string().optional(),
  viewport: viewportSchema,
  frameworkHints: frameworkHintsSchema.default({}),
  annotations: z.array(annotationSchema).min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type FeedbackSession = z.infer<typeof feedbackSessionSchema>;
