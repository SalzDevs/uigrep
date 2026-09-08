/** One element → its schema-shaped identity + styles + bbox. Phase 4 adds comments/queue. */

import type { ElementIdentity, FilteredComputedStyle } from "@uigrep/schema";
import { boundingBoxSchema, elementIdentitySchema } from "@uigrep/schema";
import { buildSelector } from "./selector";
import { buildXPath } from "./xpath";
import { captureComputedStyle } from "./styles";

export interface ElementCapture {
  identity: ElementIdentity;
  computedStyle: FilteredComputedStyle["properties"];
}

export function captureElement(el: Element): ElementCapture {
  const rect = el.getBoundingClientRect();
  const identity = elementIdentitySchema.parse({
    selector: buildSelector(el),
    xpath: buildXPath(el),
    bbox: {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    },
    tagName: el.tagName.toLowerCase(),
    accessibleName:
      el.getAttribute("aria-label") ??
      el.getAttribute("aria-labelledby") ??
      el.getAttribute("alt") ??
      undefined,
    visibleText:
      el.textContent?.replace(/\s+/g, " ").trim().slice(0, 500) || undefined,
  });
  boundingBoxSchema.parse(identity.bbox);
  return {
    identity,
    computedStyle: captureComputedStyle(el),
  };
}
