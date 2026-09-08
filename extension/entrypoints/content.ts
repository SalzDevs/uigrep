/**
 * Content script: pick mode + element capture. Phase 3 ends at logging the
 * payload; phase 4 adds annotate UI + queue.
 */

import { captureElement } from "@/src/capture";
import { detectFrameworkHints } from "@/src/hints";
import { PickMode } from "@/src/pick-mode";
import type { CropRequest } from "@/entrypoints/background";

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_idle",
  main() {
    const pickMode = new PickMode((el) => void selectElement(el));

    browser.runtime.onMessage.addListener(
      (message: { type: string }) => {
        if (message?.type === "uigrep:toggle-pick") {
          pickMode.toggle();
        }
        return undefined;
      },
    );
  },
});

async function selectElement(el: Element): Promise<void> {
  const capture = captureElement(el);
  const screenshot = await requestScreenshot(
    capture.identity.bbox,
    window.devicePixelRatio,
  );
  const payload = {
    element: capture.identity,
    computedStyle: capture.computedStyle,
    screenshot,
    frameworkHints: detectFrameworkHints(),
    page: {
      url: location.href,
      title: document.title,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
      },
    },
  };
  // Phase 3: log. Phase 4: queue + annotate UI consumes this.
  console.group("uigrep selection");
  console.log(payload);
  console.groupEnd();
}

function requestScreenshot(
  bbox: import("@uigrep/schema").BoundingBox,
  devicePixelRatio: number,
): Promise<string> {
  return new Promise((resolve) => {
    const request: CropRequest = {
      type: "uigrep:crop-screenshot",
      bbox,
      devicePixelRatio,
    };
    browser.runtime.sendMessage(request, (response: { dataUrl: string }) => {
      resolve(response?.dataUrl ?? "");
    });
  });
}
