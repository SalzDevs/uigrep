/**
 * Background: screenshot capture + crop, command routing.
 * captureVisibleTab returns the full viewport at devicePixelRatio scale;
 * crop with canvas using bbox × dpr.
 */

import type { BoundingBox } from "@uigrep/schema";

export interface CropRequest {
  type: "uigrep:crop-screenshot";
  bbox: BoundingBox;
  devicePixelRatio: number;
}

export interface SendSessionRequest {
  type: "uigrep:send-session";
  session: unknown; // validated against schema at the bridge
}

const BRIDGE_URL = "http://127.0.0.1:8742";

export default defineBackground(() => {
  browser.commands?.onCommand.addListener((command) => {
    if (command === "toggle-pick") void sendToActiveTab("uigrep:toggle-pick");
    if (command === "toggle-panel") void sendToActiveTab("uigrep:toggle-panel");
  });

  browser.action?.onClicked.addListener(() => void sendToActiveTab("uigrep:toggle-pick"));

  browser.runtime.onMessage.addListener(
    (message: CropRequest | SendSessionRequest, _sender, sendResponse) => {
      if (message?.type === "uigrep:crop-screenshot") {
        void cropScreenshot(message.bbox, message.devicePixelRatio).then(
          (dataUrl) => sendResponse({ dataUrl }),
        );
        return true; // async sendResponse
      }
      if (message?.type === "uigrep:send-session") {
        void pushSession(message.session).then((result) =>
          sendResponse(result),
        );
        return true;
      }
      return undefined;
    },
  );
});

async function sendToActiveTab(type: string): Promise<void> {
  const [tab] = await browser.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (!tab.id) return;
  await browser.tabs.sendMessage(tab.id, { type });
}

async function pushSession(
  session: unknown,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${BRIDGE_URL}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(session),
    });
    const body = (await res.json()) as { ok: boolean; error?: string };
    if (!res.ok || !body.ok) {
      return { ok: false, error: body.error ?? `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function cropScreenshot(
  bbox: BoundingBox,
  devicePixelRatio: number,
): Promise<string> {
  const dataUrl = (await browser.tabs.captureVisibleTab(
    { format: "png" },
  )) as unknown as string;
  const image = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const canvas = new OffscreenCanvas(
    Math.max(Math.round(bbox.width * devicePixelRatio), 1),
    Math.max(Math.round(bbox.height * devicePixelRatio), 1),
  );
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("OffscreenCanvas 2d context unavailable");
  ctx.drawImage(
    image,
    Math.round(bbox.x * devicePixelRatio),
    Math.round(bbox.y * devicePixelRatio),
    Math.round(bbox.width * devicePixelRatio),
    Math.round(bbox.height * devicePixelRatio),
    0,
    0,
    canvas.width,
    canvas.height,
  );
  const blob = await canvas.convertToBlob({ type: "image/png" });
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:image/png;base64,${btoa(binary)}`;
}
