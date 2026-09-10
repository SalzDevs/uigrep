# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: __scratch.spec.ts >> real daemon: full capture flow
- Location: e2e/__scratch.spec.ts:7:5

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: "Connected"
Received: "Approval needed"

Call Log:
- Timeout 15000ms exceeded while waiting on the predicate
```

# Test source

```ts
  1   | import { expect, test, chromium } from "@playwright/test";
  2   | import { mkdtemp } from "node:fs/promises";
  3   | import { createServer } from "node:http";
  4   | import { tmpdir } from "node:os";
  5   | import { join, resolve } from "node:path";
  6   |
  7   | test("real daemon: full capture flow", async ({}, testInfo) => {
  8   |   const extensionPath = resolve(
  9   |     testInfo.config.rootDir,
  10  |     "../apps/extension/.output/chrome-mv3",
  11  |   );
  12  |   // Local page for the content script to act on.
  13  |   const server = createServer(
  14  |     (
  15  |       _req,
  16  |       res,
  17  |     ) => {
  18  |       res.writeHead(200, { "content-type": "text/html" });
  19  |       res.end(
  20  |         `<html><head><title>real daemon scratch page</title></head><body><main><h1>Scratch</h1><button>Do it</button></main></body></html>`,
  21  |       );
  22  |     },
  23  |   );
  24  |   const pagePort = 49199;
  25  |   await new Promise<void>((ok) => server.listen(pagePort, "127.0.0.1", ok));
  26  |   const pageUrl = `http://127.0.0.1:${pagePort}/`;
  27  |
  28  |   const profile = await mkdtemp(join(tmpdir(), "uigrep-real-e2e-"));
  29  |   const context = await chromium.launchPersistentContext(profile, {
  30  |     channel: "chromium",
  31  |     headless: true,
  32  |     args: [
  33  |       `--disable-extensions-except=${extensionPath}`,
  34  |       `--load-extension=${extensionPath}`,
  35  |     ],
  36  |   });
  37  |   try {
  38  |     const worker =
  39  |       context.serviceWorkers()[0] ??
  40  |       (await context.waitForEvent("serviceworker"));
  41  |     const extensionId = new URL(worker.url()).hostname;
  42  |     const options = await context.newPage();
  43  |     await options.goto(`chrome-extension://${extensionId}/options.html`);
  44  |     await expect
  45  |       .poll(async () => options.locator("#badge").textContent(), {
  46  |         timeout: 15_000,
  47  |       })
> 48  |       .toBe("Connected");
      |        ^ Error: expect(received).toBe(expected) // Object.is equality
  49  |
  50  |     const page = await context.newPage();
  51  |     await page.goto(pageUrl);
  52  |     await page.bringToFront();
  53  |     const target = page.locator("button");
  54  |     await expect(target).toBeVisible();
  55  |     const box = (await target.boundingBox())!;
  56  |     const selection = {
  57  |       x: box.x - 10,
  58  |       y: box.y - 10,
  59  |       width: box.width + 20,
  60  |       height: box.height + 20,
  61  |     };
  62  |     // Open the overlay by sending the same message the shortcut sends.
  63  |     await worker.evaluate(async (url) => {
  64  |       const chrome = (
  65  |         globalThis as unknown as {
  66  |           chrome: {
  67  |             tabs: {
  68  |               query: (q: unknown) => Promise<{ id?: number }[]>;
  69  |               sendMessage: (id: number, m: unknown) => Promise<unknown>;
  70  |             };
  71  |           };
  72  |         }
  73  |       ).chrome;
  74  |       const [tab] = await chrome.tabs.query({
  75  |         active: true,
  76  |         lastFocusedWindow: true,
  77  |       });
  78  |       if (tab?.id === undefined) throw new Error("tab not found");
  79  |       await chrome.tabs.sendMessage(tab.id, { type: "start-capture" });
  80  |     }, pageUrl);
  81  |     await expect(page.locator("#uigrep-overlay-host")).toBeAttached();
  82  |     await page.mouse.move(selection.x, selection.y);
  83  |     await page.mouse.down();
  84  |     await page.mouse.move(
  85  |       selection.x + selection.width,
  86  |       selection.y + selection.height,
  87  |       { steps: 10 },
  88  |     );
  89  |     await page.mouse.up();
  90  |     await page.mouse.click(selection.x + selection.width - 2, selection.y + 2);
  91  |     await page.keyboard.insertText("scratch capture comment");
  92  |     await page.keyboard.press("Control+Enter");
  93  |     await expect(page.locator("#uigrep-overlay-host")).toHaveCount(0);
  94  |     await testInfo.attach("scratch-capture-result", {
  95  |       body: "capture accepted by real daemon",
  96  |       contentType: "text/plain",
  97  |     });
  98  |   } finally {
  99  |     await context.close();
  100 |     await new Promise<void>((ok) => server.close(() => ok()));
  101 |   }
  102 | });
  103 |
```
