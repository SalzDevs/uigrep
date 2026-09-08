/**
 * Filtered computed styles — the ~30 properties that describe how an element
 * actually renders. Deliberately NOT the full ~300-property computed dump.
 */

import { z } from "zod";

/** Property whitelist — spacing, size, color, font, position, display */
export const FILTERED_COMPUTED_STYLE_PROPERTIES = [
  "display",
  "position",
  "top",
  "right",
  "bottom",
  "left",
  "zIndex",
  "flexDirection",
  "justifyContent",
  "alignItems",
  "gap",
  "gridTemplateColumns",
  "margin",
  "marginTop",
  "marginBottom",
  "marginLeft",
  "marginRight",
  "padding",
  "paddingTop",
  "paddingBottom",
  "paddingLeft",
  "paddingRight",
  "width",
  "height",
  "maxWidth",
  "maxHeight",
  "overflow",
  "color",
  "backgroundColor",
  "borderRadius",
  "border",
  "borderWidth",
  "borderColor",
  "boxShadow",
  "opacity",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "lineHeight",
  "letterSpacing",
  "textAlign",
  "textDecorationLine",
  "textTransform",
  "whiteSpace",
  "visibility",
  "cursor",
] as const;

export const filteredComputedStyleSchema = z.object({
  properties: z.record(
    z.enum(FILTERED_COMPUTED_STYLE_PROPERTIES),
    z.string(),
  ),
});
export type FilteredComputedStyle = z.infer<typeof filteredComputedStyleSchema>;
