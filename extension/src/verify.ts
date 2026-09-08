/**
 * Verify loop (decision 7, C-lite): re-capture the same element the
 * annotation points at and produce before/after evidence.
 */

import { captureElement } from "./capture";

export interface Recapture {
  screenshot: string;
  bbox: { x: number; y: number; width: number; height: number };
}

/** Locate the element via selector, fall back to XPath. */
export function findAnnotatedElement(
  selector: string,
  xpath: string,
): Element | null {
  try {
    const found = document.querySelector(selector);
    if (found) return found;
  } catch {
    // invalid selector → fall through to xpath
  }
  const result = document.evaluate(
    xpath,
    document,
    null,
    XPathResult.FIRST_ORDERED_NODE_TYPE,
    null,
  );
  return (result.singleNodeValue as Element | null) ?? null;
}

export async function recaptureElement(
  selector: string,
  xpath: string,
): Promise<Recapture | null> {
  const el = findAnnotatedElement(selector, xpath);
  if (!el) return null;
  const capture = captureElement(el);
  const screenshot = await requestScreenshot(
    capture.identity.bbox,
    window.devicePixelRatio,
  );
  if (!screenshot) return null;
  return {
    screenshot,
    bbox: capture.identity.bbox,
  };
}

function requestScreenshot(
  bbox: { x: number; y: number; width: number; height: number },
  devicePixelRatio: number,
): Promise<string> {
  return new Promise((resolve) => {
    const request: {
      type: "uigrep:crop-screenshot";
      bbox: typeof bbox;
      devicePixelRatio: number;
    } = { type: "uigrep:crop-screenshot", bbox, devicePixelRatio };
    browser.runtime.sendMessage(request, (response: { dataUrl: string }) => {
      resolve(response?.dataUrl ?? "");
    });
  });
}
