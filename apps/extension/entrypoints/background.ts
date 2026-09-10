import { captureSessionSchema, daemonEventSchema } from "@uigrep/schema";
import { z } from "zod";
import type { ContentRequest, DaemonStatus } from "../lib/messages";
import { normalizeWireCapture } from "../lib/wire";

const HTTP_ORIGIN = "http://127.0.0.1:47831";
const WS_ORIGIN = "ws://127.0.0.1:47831";
const SECRET = /^[0-9a-f]{64}$/;
const credentialSchema = z.object({
  token: z.string().regex(SECRET),
  browserId: z.string().uuid(),
});
const pendingSchema = z.object({
  requestId: z.string().uuid(),
  secret: z.string().regex(SECRET),
  expiresAt: z.number(),
});
const pairResponseSchema = z.object({
  requestId: z.string().uuid(),
  expiresInSeconds: z.number().int().min(0).max(300),
});
const claimSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  credentialSchema.extend({ status: z.literal("approved") }),
]);
const requestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("daemon-status") }).strict(),
  z.object({ type: z.literal("connect-browser") }).strict(),
  z.object({ type: z.literal("send-capture"), capture: z.unknown() }).strict(),
]);
let socket: WebSocket | undefined;
let authenticated = false;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
let pairingTimer: ReturnType<typeof setTimeout> | undefined;
let connecting: Promise<void> | undefined;
let pairing: Promise<void> | undefined;
let reconnectDelay = 2_000;
let sending = false;
let status: DaemonStatus = {
  configured: false,
  connected: false,
  phase: "idle",
};

function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Unable to reach uigrep. Open the desktop app and retry.";
}
async function credential() {
  const stored = await browser.storage.local.get("browserCredential");
  const parsed = credentialSchema.safeParse(stored.browserCredential);
  return parsed.success ? parsed.data : undefined;
}
async function pendingPairing() {
  const stored = await browser.storage.local.get("pendingPairing");
  const parsed = pendingSchema.safeParse(stored.pendingPairing);
  return parsed.success ? parsed.data : undefined;
}
class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
async function post(
  path: string,
  body: unknown,
  token?: string,
): Promise<unknown> {
  const response = await fetch(`${HTTP_ORIGIN}${path}`, {
    method: "POST",
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    headers: {
      "content-type": "application/json",
      ...(token ? { "x-uigrep-token": token } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    if (response.status === 401 && token) await forgetCredential();
    const result: unknown = await response.json().catch(() => undefined);
    const parsed = z.object({ error: z.string().max(1000) }).safeParse(result);
    throw new HttpError(
      response.status,
      parsed.success
        ? parsed.data.error
        : `uigrep returned ${response.status}. Open Setup and retry.`,
    );
  }
  return response.json();
}
function closeSocket(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (heartbeatTimer) clearTimeout(heartbeatTimer);
  const old = socket;
  socket = undefined;
  authenticated = false;
  old?.close();
}
async function forgetCredential(): Promise<void> {
  closeSocket();
  await browser.storage.local.remove("browserCredential");
  status = {
    configured: false,
    connected: false,
    phase: "error",
    error: "Browser approval expired. Requesting approval again automatically.",
  };
}
async function activateCurrentTab(): Promise<void> {
  const [tab] = await browser.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (tab?.id === undefined) {
    reportError(
      new Error(
        "No active browser tab. Focus the page you want to capture and retry.",
      ),
    );
    return;
  }
  try {
    await browser.tabs.sendMessage(tab.id, {
      type: "start-capture",
    } satisfies ContentRequest);
  } catch {
    reportError(
      new Error("This page has no capture script. Reload the page and retry."),
    );
  }
}
function scheduleReconnect(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    void connect().catch(reportError);
  }, reconnectDelay);
  reconnectDelay = Math.min(30_000, reconnectDelay * 2);
}
function reportError(error: unknown): void {
  status = {
    ...status,
    connected: false,
    phase: "error",
    error: errorText(error),
  };
}
function connect(): Promise<void> {
  if (connecting) return connecting;
  connecting = connectOnce().finally(() => {
    connecting = undefined;
  });
  return connecting;
}
async function connectOnce(): Promise<void> {
  const saved = await credential();
  if (
    !saved ||
    socket?.readyState === WebSocket.OPEN ||
    socket?.readyState === WebSocket.CONNECTING
  )
    return;
  status = { configured: true, connected: false, phase: "connecting" };
  const ws = new WebSocket(`${WS_ORIGIN}/v1/events`);
  socket = ws;
  const armWatchdog = (ms: number) => {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(() => {
      if (socket === ws) ws.close();
    }, ms);
  };
  armWatchdog(10_000);
  ws.addEventListener("open", () => {
    if (socket === ws) ws.send(JSON.stringify({ token: saved.token }));
  });
  ws.addEventListener("message", (event) => {
    if (socket !== ws) return;
    try {
      const data: unknown = JSON.parse(String(event.data));
      const control = z
        .object({ type: z.enum(["authenticated", "heartbeat"]) })
        .strict()
        .safeParse(data);
      if (control.success) {
        if (control.data.type === "authenticated") {
          authenticated = true;
          reconnectDelay = 2_000;
          status = { configured: true, connected: true, phase: "connected" };
        } else if (authenticated) ws.send('{"type":"pong"}');
        armWatchdog(50_000);
        return;
      }
      const parsed = daemonEventSchema.safeParse(data);
      if (
        authenticated &&
        parsed.success &&
        parsed.data.type === "start_capture"
      ) {
        void activateCurrentTab().catch(reportError);
      }
    } catch {
      /* Ignore malformed events without extending the heartbeat deadline. */
    }
  });
  ws.addEventListener("close", (event) => {
    if (socket !== ws) return;
    socket = undefined;
    authenticated = false;
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    if (event.code === 1008) {
      // Stale credential (daemon restarted or state reset). Self-heal: clear
      // and immediately re-pair instead of waiting for a manual Connect.
      void (async () => {
        await forgetCredential();
        await pair();
      })().catch(reportError);
      return;
    }
    status = {
      configured: true,
      connected: false,
      phase: "connecting",
      error: "Waiting for the desktop app…",
    };
    scheduleReconnect();
  });
  ws.addEventListener("error", () => ws.close());
}
function pair(): Promise<void> {
  if (pairing) return pairing;
  pairing = pairOnce()
    .catch(reportError)
    .finally(() => {
      pairing = undefined;
    });
  return pairing;
}
async function pairOnce(): Promise<void> {
  if (pairingTimer) clearTimeout(pairingTimer);
  let pending = await pendingPairing();
  if (pending && pending.expiresAt <= Date.now()) {
    await browser.storage.local.remove("pendingPairing");
    throw new Error(
      "Approval expired after five minutes. Click Retry to request approval again.",
    );
  }
  if (!pending) {
    if (await credential()) {
      await connect();
      return;
    }
    status = { configured: false, connected: false, phase: "requesting" };
    const stored = await browser.storage.local.get("clientId");
    const client = z.string().uuid().safeParse(stored.clientId);
    const clientId = client.success ? client.data : crypto.randomUUID();
    await browser.storage.local.set({ clientId });
    const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    const started = Date.now();
    const response = pairResponseSchema.parse(
      await post("/v1/pair/request", { clientId, name: "Chrome", secret }),
    );
    pending = {
      requestId: response.requestId,
      secret,
      expiresAt: started + response.expiresInSeconds * 1000,
    };
    await browser.storage.local.set({ pendingPairing: pending });
  }
  status = {
    configured: false,
    connected: false,
    phase: "pending",
    expiresAt: pending.expiresAt,
  };
  try {
    const result = claimSchema.parse(
      await post("/v1/pair/claim", {
        requestId: pending.requestId,
        secret: pending.secret,
      }),
    );
    if (result.status === "approved") {
      await browser.storage.local.set({
        browserCredential: { token: result.token, browserId: result.browserId },
      });
      await browser.storage.local.remove("pendingPairing");
      closeSocket();
      await connect();
      return;
    }
  } catch (error) {
    if (
      error instanceof HttpError &&
      [400, 401, 403, 404].includes(error.statusCode)
    ) {
      await browser.storage.local.remove("pendingPairing");
      throw error;
    }
    // Preserve the request secret across transient daemon failures until expiry.
    status = { ...status, error: errorText(error) };
  }
  if (Date.now() >= pending.expiresAt) {
    await browser.storage.local.remove("pendingPairing");
    throw new Error("Approval expired after five minutes. Click Retry.");
  }
  pairingTimer = setTimeout(
    () => {
      void pair();
    },
    Math.min(2_000, pending.expiresAt - Date.now()),
  );
}
async function resume(): Promise<void> {
  if (await pendingPairing()) await pair();
  else await connect();
}

export default defineBackground(() => {
  // Never migrate old pasted master credentials into browser credentials.
  void browser.storage.local
    .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
    .catch(reportError);
  void browser.storage.local.remove("pairingToken").catch(reportError);
  browser.commands.onCommand.addListener((command) => {
    if (command === "start-capture")
      void activateCurrentTab().catch(reportError);
  });
  browser.runtime.onMessage.addListener(
    (message: unknown, sender, sendResponse) => {
      if (sender.id !== browser.runtime.id) return false;
      const parsed = requestSchema.safeParse(message);
      if (!parsed.success) return false;
      const request = parsed.data;
      const trustedOptions =
        sender.url === browser.runtime.getURL("/options.html") &&
        (!sender.tab || sender.frameId === 0);
      const isContent = Boolean(
        sender.tab?.id &&
        sender.frameId === 0 &&
        sender.url &&
        /^(https?:|file:)\/\//.test(sender.url),
      );
      if (request.type !== "send-capture") {
        if (!trustedOptions) return false;
        void (request.type === "connect-browser" ? pair() : resume())
          .then(async () => {
            const saved = await credential();
            sendResponse({
              ...status,
              configured: Boolean(saved),
              connected: authenticated,
            } satisfies DaemonStatus);
          })
          .catch((error: unknown) => {
            reportError(error);
            sendResponse(status);
          });
        return true;
      }
      if (!isContent) return false;
      void (async () => {
        if (sending)
          throw new Error(
            "A capture is already being sent. Try again shortly.",
          );
        sending = true;
        try {
          const capture = captureSessionSchema.safeParse(request.capture);
          if (!capture.success)
            throw new Error(
              "Capture failed schema validation. Reselect the region and retry.",
            );
          if (capture.data.page.url !== sender.url)
            throw new Error(
              "Capture page does not match the sending tab. Reselect after navigation.",
            );
          const normalized = normalizeWireCapture(capture.data);
          const saved = await credential();
          if (!saved)
            throw new Error(
              "Open companion options, click Connect, and approve this browser in desktop Setup.",
            );
          if (
            new TextEncoder().encode(JSON.stringify(normalized)).length >
            8 * 1024 * 1024
          )
            throw new Error("Capture exceeds 8 MiB. Select fewer regions.");
          await post("/v1/captures", normalized, saved.token);
          sendResponse({ ok: true });
        } finally {
          sending = false;
        }
      })().catch((error: unknown) =>
        sendResponse({ ok: false, error: errorText(error) }),
      );
      return true;
    },
  );
  browser.runtime.onInstalled.addListener(() => {
    void browser.runtime.openOptionsPage().catch(reportError);
    void pair();
  });
  browser.runtime.onStartup.addListener(() => {
    void resume().catch(reportError);
  });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "uigrep-resume") void resume().catch(reportError);
  });
  void browser.alarms.create("uigrep-resume", { periodInMinutes: 0.5 });
  void resume().catch(reportError);
});
