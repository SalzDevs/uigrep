/**
 * Content script: pick mode + annotate popup + queue panel.
 * Phase 4: full local loop. Transport to MCP server = phase 5.
 */

import { captureElement } from "@/src/capture";
import { detectFrameworkHints } from "@/src/hints";
import { PickMode } from "@/src/pick-mode";
import { addAnnotation, getSession, removeAnnotation } from "@/src/queue";
import { showAnnotatePopup } from "@/src/ui/annotate-popup";
import { QueuePanel } from "@/src/ui/queue-panel";
import type { CropRequest } from "@/entrypoints/background";

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_idle",
  main() {
    const panel = new QueuePanel({
      getSession: () => getSession(location.href),
      onSend: (session) => sendSession(session),
      onDelete: (id) => removeAnnotation(id),
      onHighlight: (annotation) => highlight(annotation),
    });

    let eventCoordinates = { x: 0, y: 0 };

    const pickMode = new PickMode((el) => {
      void selectElement(el, eventCoordinates);
    });

    document.addEventListener(
      "click",
      (e) => {
        if (pickMode.isActive) {
          eventCoordinates = { x: e.clientX, y: e.clientY };
        }
      },
      true,
    );

    browser.runtime.onMessage.addListener((message: { type: string }) => {
      if (message?.type === "uigrep:toggle-pick") pickMode.toggle();
      if (message?.type === "uigrep:toggle-panel") panel.toggle();
      return undefined;
    });

    async function selectElement(
      el: Element,
      getAnchor: { x: number; y: number },
    ): Promise<void> {
      const capture = captureElement(el);
      const screenshot = await requestScreenshot(
        capture.identity.bbox,
        window.devicePixelRatio,
      );
      if (!screenshot) return; // capture failed (e.g. protected page)
      pickMode.stop();

      showAnnotatePopup(
        {
          selector: capture.identity.selector,
          screenshot,
          build: async (comment) =>
            addAnnotation(
              location.href,
              document.title,
              {
                width: window.innerWidth,
                height: window.innerHeight,
                devicePixelRatio: window.devicePixelRatio,
              },
              {
                element: capture.identity,
                comment,
                computedStyle: { properties: capture.computedStyle },
                screenshot,
              },
            ),
        },
        getAnchor,
        () => {
          if (panel.isOpen) void panel.refresh();
          else void panel.open();
        },
      );
    }

    function highlight(annotation: { element: { bbox: { x: number; y: number; width: number; height: number } } }): void {
      const { bbox } = annotation.element;
      const flash = document.createElement("div");
      Object.assign(flash.style, {
        position: "fixed",
        left: `${bbox.x - 2}px`,
        top: `${bbox.y - 2}px`,
        width: `${bbox.width + 4}px`,
        height: `${bbox.height + 4}px`,
        border: "2px solid #4dd0ff",
        borderRadius: "2px",
        pointerEvents: "none",
        zIndex: "2147483646",
        boxSizing: "border-box",
      } satisfies Partial<CSSStyleDeclaration>);
      document.body.append(flash);
      setTimeout(() => flash.remove(), 1500);
    }
  },
});

async function sendSession(session: import("@uigrep/schema").FeedbackSession): Promise<void> {
  // Validate the full session against the contract before anything leaves.
  const { feedbackSessionSchema } = await import("@uigrep/schema");
  const parsed = feedbackSessionSchema.parse(session);
  console.log("[uigrep] session ready for delivery (phase 5 wires the bridge):", parsed);
  alert("uigrep: session validated ✓ — transport bridge lands in phase 5. Payload logged to console.");
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
