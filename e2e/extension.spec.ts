import { randomBytes, randomUUID } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { chromium, expect, test, type BrowserContext } from "@playwright/test";
import {
  captureSessionSchema,
  type CaptureSession,
} from "../packages/schema/src/index";

// Minimal types for Chromium APIs evaluated in the real extension worker.
// No direct dependency on Chrome typings or the transitive ws package.
type WorkerGlobals = {
  chrome: {
    runtime: { id: string };
    storage: { local: { get(key: string): Promise<Record<string, unknown>> } };
    tabs: {
      query(query: { url: string }): Promise<{ id?: number }[]>;
      sendMessage(tabId: number, message: { type: string }): Promise<unknown>;
    };
  };
};

const daemonOrigin = "http://127.0.0.1:47831";
const extensionOriginPattern = /^chrome-extension:\/\/[a-p]{32}$/;
const secretPattern = /^[0-9a-f]{64}$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(
  request: IncomingMessage,
  limit: number,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const raw of request) {
    const chunk: unknown = raw;
    if (!Buffer.isBuffer(chunk)) throw new Error("Expected request bytes");
    bytes += chunk.length;
    if (bytes > limit) throw new Error("Request exceeds mock body limit");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

async function startMockDaemon() {
  const requestId = randomUUID();
  const browserId = randomUUID();
  const token = randomBytes(32).toString("hex");
  const testId = randomUUID();
  const state = {
    approved: false,
    requestCount: 0,
    pendingClaims: 0,
    approvedClaims: 0,
    pairingOrigin: "",
    captures: [] as CaptureSession[],
    captureOrigins: [] as string[],
    authenticatedCaptures: 0,
  };
  let pairingSecret: string | undefined;

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const origin = request.headers.origin;
    if (origin && !extensionOriginPattern.test(origin)) {
      json(response, 403, {
        error: "Only Chrome extension origins are allowed",
      });
      return;
    }
    if (origin) {
      response.setHeader("access-control-allow-origin", origin);
      response.setHeader("vary", "Origin");
      response.setHeader("access-control-allow-methods", "POST, OPTIONS");
      response.setHeader(
        "access-control-allow-headers",
        "content-type, x-uigrep-token",
      );
    }
    if (request.method === "OPTIONS" && origin) {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method === "GET" && request.url === `/setup/test/${testId}`) {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(`<!doctype html><html><head><title>uigrep mock practice page</title>
        <style>body{margin:0;background:#eef2ff;font-family:system-ui}
        article{box-sizing:border-box;position:absolute;left:160px;top:160px;
        width:300px;height:150px;padding:24px;border:1px solid #94a3b8;
        border-radius:16px;background:white}</style></head><body>
        <article data-testid="practice-card"><h1>Practice card</h1><p>Make the spacing clearer.</p></article>
        </body></html>`);
      return;
    }
    if (request.method !== "POST" || !origin) {
      json(response, 404, { error: "Unknown mock route" });
      return;
    }
    if (!request.headers["content-type"]?.startsWith("application/json")) {
      json(response, 415, { error: "JSON required" });
      return;
    }
    const body = await readJson(
      request,
      request.url === "/v1/captures" ? 8 * 1024 * 1024 : 4096,
    );
    if (request.url === "/v1/pair/request") {
      if (
        !isRecord(body) ||
        typeof body.clientId !== "string" ||
        !uuidPattern.test(body.clientId) ||
        body.name !== "Chrome" ||
        typeof body.secret !== "string" ||
        !secretPattern.test(body.secret)
      ) {
        json(response, 400, { error: "Invalid pairing request" });
        return;
      }
      if (
        pairingSecret &&
        (pairingSecret !== body.secret || state.pairingOrigin !== origin)
      ) {
        json(response, 409, {
          error: "A different pairing is already pending",
        });
        return;
      }
      pairingSecret = body.secret;
      state.pairingOrigin = origin;
      state.requestCount++;
      json(response, 200, { requestId, expiresInSeconds: 300 });
      return;
    }
    if (request.url === "/v1/pair/claim") {
      if (
        !pairingSecret ||
        !isRecord(body) ||
        body.requestId !== requestId ||
        body.secret !== pairingSecret ||
        origin !== state.pairingOrigin
      ) {
        json(response, 403, { error: "Invalid claim" });
        return;
      }
      if (!state.approved) {
        state.pendingClaims++;
        json(response, 200, { status: "pending" });
      } else {
        state.approvedClaims++;
        json(response, 200, { status: "approved", browserId, token });
      }
      return;
    }
    if (request.url === "/v1/captures") {
      if (
        !state.approved ||
        origin !== state.pairingOrigin ||
        request.headers["x-uigrep-token"] !== token
      ) {
        json(response, 401, { error: "Browser approval required" });
        return;
      }
      const parsed = captureSessionSchema.safeParse(body);
      if (!parsed.success) {
        json(response, 400, { error: "Invalid capture schema" });
        return;
      }
      state.authenticatedCaptures++;
      state.captures.push(parsed.data);
      state.captureOrigins.push(origin);
      json(response, 201, { id: parsed.data.id });
      return;
    }
    json(response, 404, { error: "Unknown mock route" });
  };

  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      // Never include request bodies, headers or credentials in diagnostics.
      if (!response.headersSent && !response.destroyed)
        json(response, 400, { error: "Invalid or oversized mock request" });
      else response.destroy();
    });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  // Intentionally no WebSocket emulation: pairing and POST work while events
  // are disconnected. This is not a daemon-push or heartbeat integration test.
  server.on("upgrade", (_request, socket) => {
    socket.end(
      "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    );
  });
  await new Promise<void>((resolveListen, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      reject(
        new Error(
          error.code === "EADDRINUSE"
            ? "Extension test requires free port 127.0.0.1:47831. A daemon or another test is running; stop it manually and retry. No process was killed."
            : `Cannot bind extension mock daemon (${error.code ?? "unknown error"}).`,
        ),
      );
    };
    server.once("error", onError);
    server.listen(47831, "127.0.0.1", () => {
      server.off("error", onError);
      resolveListen();
    });
  });
  return {
    state,
    browserId,
    testUrl: `${daemonOrigin}/setup/test/${testId}`,
    close: () =>
      new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
        server.closeAllConnections();
      }),
  };
}

test("actual companion pairs with a mocked daemon and posts a drag annotation", async (_fixtures, testInfo) => {
  const extensionPath = resolve(
    testInfo.config.rootDir,
    "../apps/extension/.output/chrome-mv3",
  );
  await access(join(extensionPath, "manifest.json")).catch(() => {
    throw new Error(
      "Built Chrome companion missing. Run pnpm --filter @uigrep/extension build before these tests.",
    );
  });
  // Bind before launching Chromium so a real daemon can never receive pairing.
  const daemon = await startMockDaemon();
  let profile: string | undefined;
  let context: BrowserContext | undefined;
  try {
    profile = await mkdtemp(join(tmpdir(), "uigrep-extension-e2e-"));
    context = await chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: true,
      viewport: { width: 1280, height: 900 },
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const extensionId = new URL(worker.url()).hostname;
    expect(extensionId).toMatch(/^[a-p]{32}$/);
    expect(
      await worker.evaluate(
        () => (globalThis as unknown as WorkerGlobals).chrome.runtime.id,
      ),
    ).toBe(extensionId);
    await expect.poll(() => daemon.state.requestCount).toBe(1);
    await expect.poll(() => daemon.state.pendingClaims).toBeGreaterThan(0);
    expect(daemon.state.pairingOrigin).toBe(
      `chrome-extension://${extensionId}`,
    );

    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    await expect(options.locator("#badge")).toHaveText("Approval needed");
    await expect(options.locator("#status")).toContainText(
      "Approve Chrome in the uigrep desktop Setup window.",
    );
    await expect(
      options.getByRole("button", { name: "Waiting for approval…" }),
    ).toBeDisabled();
    expect(
      await worker.evaluate(async () => {
        const { chrome } = globalThis as unknown as WorkerGlobals;
        return Boolean(
          (await chrome.storage.local.get("browserCredential"))
            .browserCredential,
        );
      }),
    ).toBe(false);
    daemon.state.approved = true;
    await expect.poll(() => daemon.state.approvedClaims).toBeGreaterThan(0);
    // Return only booleans from storage: test output must never print tokens.
    await expect
      .poll(() =>
        worker.evaluate(async (expectedBrowserId) => {
          const { chrome } = globalThis as unknown as WorkerGlobals;
          const saved = (await chrome.storage.local.get("browserCredential"))
            .browserCredential;
          if (typeof saved !== "object" || saved === null) return false;
          const credential = saved as Record<string, unknown>;
          return (
            credential.browserId === expectedBrowserId &&
            typeof credential.token === "string" &&
            /^[0-9a-f]{64}$/.test(credential.token)
          );
        }, daemon.browserId),
      )
      .toBe(true);
    await expect
      .poll(() =>
        worker.evaluate(async () => {
          const { chrome } = globalThis as unknown as WorkerGlobals;
          return Boolean(
            (await chrome.storage.local.get("pendingPairing")).pendingPairing,
          );
        }),
      )
      .toBe(false);

    const page = await context.newPage();
    await page.goto(daemon.testUrl);
    await page.bringToFront();
    const card = page.getByTestId("practice-card");
    await expect(card).toBeVisible();
    const box = await card.boundingBox();
    if (!box) throw new Error("Practice card has no bounds");
    expect(box.width).toBe(300);
    expect(box.height).toBe(150);
    // Send a real extension message, retrying only until document_idle has
    // installed the content listener. No synthetic DOM overlay or shortcut.
    await expect
      .poll(() =>
        worker.evaluate(async (url) => {
          const { chrome } = globalThis as unknown as WorkerGlobals;
          const [tab] = await chrome.tabs.query({ url });
          if (tab?.id === undefined) return false;
          try {
            await chrome.tabs.sendMessage(tab.id, { type: "start-capture" });
            return true;
          } catch {
            return false;
          }
        }, daemon.testUrl),
      )
      .toBe(true);
    await expect(page.locator("#uigrep-overlay-host")).toBeAttached();
    expect(
      await page
        .locator("#uigrep-overlay-host")
        .evaluate((host) => host.shadowRoot === null),
    ).toBe(true);
    const selection = {
      x: box.x - 8,
      y: box.y - 8,
      width: box.width + 16,
      height: box.height + 16,
    };
    await page.mouse.move(selection.x, selection.y);
    await page.mouse.down();
    await page.mouse.move(
      selection.x + selection.width,
      selection.y + selection.height,
      { steps: 12 },
    );
    await page.mouse.up();
    // The overlay has a closed shadow root. Click its marker geometrically;
    // the actual composer focuses its textarea, so normal keyboard input works.
    await page.mouse.click(selection.x + selection.width - 2, selection.y + 2);
    const comment = "Increase the practice card spacing.";
    await page.keyboard.insertText(comment);
    await page.screenshot({
      path: testInfo.outputPath("extension-real-overlay-mock-daemon.png"),
    });
    await page.keyboard.press("Control+Enter");
    await expect.poll(() => daemon.state.captures.length).toBe(1);
    await expect(page.locator("#uigrep-overlay-host")).toHaveCount(0);
    const capture = captureSessionSchema.parse(daemon.state.captures[0]);
    expect(capture.page.url).toBe(daemon.testUrl);
    expect(new URL(capture.page.url).origin).toBe(daemonOrigin);
    expect(capture.page.title).toBe("uigrep mock practice page");
    expect(capture.status).toBe("pending");
    expect(capture.annotations).toHaveLength(1);
    const annotation = capture.annotations[0];
    expect(annotation).toBeDefined();
    if (!annotation) throw new Error("Capture omitted its annotation");
    expect(annotation.selectionMethod).toBe("drag");
    expect(annotation.comment).toBe(comment);
    expect(annotation.viewportRect).toEqual(selection);
    expect(
      annotation.targets.some(
        (target) => target.selectors.testId === "practice-card",
      ),
    ).toBe(true);
    expect(daemon.state.captureOrigins).toEqual([
      `chrome-extension://${extensionId}`,
    ]);
    expect(daemon.state.authenticatedCaptures).toBe(1);
  } finally {
    // Nested cleanup still releases our port/profile if Chromium close fails.
    try {
      await context?.close();
    } finally {
      try {
        await daemon.close();
      } finally {
        if (profile)
          await rm(profile, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 200,
          });
      }
    }
  }
});
