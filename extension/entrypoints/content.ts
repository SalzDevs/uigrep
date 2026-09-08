/**
 * Content script: pick mode + annotate popup + queue panel.
 * Phase 4: full local loop. Transport to MCP server = phase 5.
 */

import { captureElement } from "@/src/capture";
import { detectFrameworkHints } from "@/src/hints";
import { PickMode } from "@/src/pick-mode";
import {
  addAnnotation,
  getSession,
  markSessionSent,
  mergeServerStatuses,
  removeAnnotation,
  updateAnnotationFields,
} from "@/src/queue";
import { recaptureElement } from "@/src/verify";
import { showAnnotatePopup } from "@/src/ui/annotate-popup";
import { QueuePanel } from "@/src/ui/queue-panel";
import type {
  BridgePostRequest,
  CropRequest,
  SendSessionRequest,
} from "@/entrypoints/background";

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_idle",
  main() {
    const panel: QueuePanel = new QueuePanel({
      getSession: () => getSession(location.href),
      onSend: (session) => sendSession(session, panel),
      onDelete: (id) => removeAnnotation(id),
      onHighlight: (annotation) => highlight(annotation),
      syncStatuses: () => syncFromBridge(),
      onVerify: (annotation) => verifyAnnotation(annotation),
      onReopen: (annotation) => reopenAnnotation(annotation),
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

function bridgePost(path: BridgePostRequest["path"], body?: unknown): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const request: BridgePostRequest = { type: "uigrep:bridge-post", path, body };
  return new Promise((resolve) => {
    browser.runtime.sendMessage(request, resolve);
  });
}

async function syncFromBridge(): Promise<void> {
  const result = await bridgePost("/statuses");
  if (result.ok && result.data) {
    await mergeServerStatuses(
      result.data as Record<string, { status: import("@uigrep/schema").AnnotationStatus; afterScreenshot?: string; iteration?: number }>,
    );
  }
  // bridge down → keep local state, panel still usable
}

async function verifyAnnotation(annotation: import("@uigrep/schema").Annotation): Promise<void> {
  const recapture = await recaptureElement(
    annotation.element.selector,
    annotation.element.xpath,
  );
  if (!recapture) {
    alert(
      "uigrep: could not find this element on the page anymore.\nNavigate to the state where it exists, then verify again.",
    );
    return;
  }
  const result = await bridgePost("/verify", {
    annotationId: annotation.id,
    afterScreenshot: recapture.screenshot,
  });
  if (!result.ok) {
    alert(`uigrep: verify failed\n\n${result.error}`);
    return;
  }
  await updateAnnotationFields(annotation.id, {
    status: "verified",
    afterScreenshot: recapture.screenshot,
  });
}

async function reopenAnnotation(annotation: import("@uigrep/schema").Annotation): Promise<void> {
  // fresh screenshot of the still-broken element → agent sees current state
  const recapture = await recaptureElement(
    annotation.element.selector,
    annotation.element.xpath,
  );
  const result = await bridgePost("/reopen", {
    annotationId: annotation.id,
  });
  if (!result.ok) {
    alert(`uigrep: reopen failed\n\n${result.error}`);
    return;
  }
  await updateAnnotationFields(annotation.id, {
    status: "open",
    ...(recapture ? { screenshot: recapture.screenshot } : {}),
  });
}

async function sendSession(
  session: import("@uigrep/schema").FeedbackSession,
  panel: QueuePanel,
): Promise<void> {
  // Validate the full session against the contract before anything leaves.
  const { feedbackSessionSchema } = await import("@uigrep/schema");
  const parsed = feedbackSessionSchema.parse(session);
  const request: SendSessionRequest = {
    type: "uigrep:send-session",
    session: parsed,
  };
  const result = await new Promise<{ ok: boolean; error?: string }>(
    (resolve) => {
      browser.runtime.sendMessage(request, resolve);
    },
  );
  if (result.ok) {
    await markSessionSent(location.href);
    await panel.refresh();
    console.log("[uigrep] session delivered to MCP bridge ✓", parsed.id);
  } else {
    alert(
      `uigrep: could not reach the MCP bridge\n\n${result.error}\n\nStart it with: pnpm --filter @uigrep/mcp-server start`,
    );
  }
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
