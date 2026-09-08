/**
 * Filtered computed styles — read only the whitelist from the schema.
 * Keeps payloads small; the model gets what it needs to reason about layout.
 */

import { FILTERED_COMPUTED_STYLE_PROPERTIES } from "@uigrep/schema";
import type { FilteredComputedStyle } from "@uigrep/schema";

export function captureComputedStyle(
  el: Element,
): FilteredComputedStyle["properties"] {
  const cs = getComputedStyle(el);
  const properties: Record<string, string> = {};
  for (const prop of FILTERED_COMPUTED_STYLE_PROPERTIES) {
    const value = cs.getPropertyValue(
      prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`),
    );
    if (value) properties[prop] = value;
  }
  return properties as FilteredComputedStyle["properties"];
}
