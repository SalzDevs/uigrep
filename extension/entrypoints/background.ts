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

export default defineBackground(() => {
  browser.commands?.onCommand.addListener((command) => {
    if (command === "toggle-pick") void togglePickInActiveTab();
  });

  browser.action?.onClicked.addListener(() => void togglePickInActiveTab());

  browser.runtime.onMessage.addListener(
    (message: CropRequest, _sender, sendResponse) => {
      if (message?.type === "uigrep:crop-screenshot") {
        void cropScreenshot(message.bbox, message.devicePixelRatio).then(
          (dataUrl) => sendResponse({ dataUrl }),
        );
        return true; // async sendResponse
      }
      return undefined;
    },
  );
});

async function togglePickInActiveTab(): Promise<void> {
  const [tab] = await browser.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (!tab.id) return;
  await browser.tabs.sendMessage(tab.id, { type: "uigrep:toggle-pick" });
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
