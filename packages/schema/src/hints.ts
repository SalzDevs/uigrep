/**
 * Framework hints — cheap to detect from the page, high payoff for the agent.
 * Presence booleans only; version strings when the runtime exposes them.
 */

import { z } from "zod";

export const frameworkHintsSchema = z.object({
  react: z.boolean().default(false),
  reactVersion: z.string().optional(),
  vue: z.boolean().default(false),
  vueVersion: z.string().optional(),
  svelte: z.boolean().default(false),
  angular: z.boolean().default(false),
  angularVersion: z.string().optional(),
  /** e.g. Next.js, Nuxt, Remix — from globals like __NEXT_DATA__ */
  metaFramework: z.string().optional(),
});
export type FrameworkHints = z.infer<typeof frameworkHintsSchema>;
