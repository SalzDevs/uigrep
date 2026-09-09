import type {
  BackgroundRequest,
  ContentRequest,
  DaemonStatus,
} from "../lib/messages";

const HTTP_ORIGIN = "http://127.0.0.1:47831";
const WS_ORIGIN = "ws://127.0.0.1:47831";
let socket: WebSocket | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

async function token(): Promise<string | undefined> {
  const stored = await browser.storage.local.get("pairingToken");
  return typeof stored.pairingToken === "string"
    ? stored.pairingToken
    : undefined;
}

async function activateCurrentTab(): Promise<void> {
  const [tab] = await browser.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (!tab?.id) return;
  await browser.tabs
    .sendMessage(tab.id, { type: "start-capture" } satisfies ContentRequest)
    .catch(() => undefined);
}

async function connect(): Promise<void> {
  const pairingToken = await token();
  if (
    !pairingToken ||
    socket?.readyState === WebSocket.OPEN ||
    socket?.readyState === WebSocket.CONNECTING
  )
    return;
  socket = new WebSocket(
    `${WS_ORIGIN}/v1/events?token=${encodeURIComponent(pairingToken)}`,
  );
  socket.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(String(event.data)) as { type?: string };
      if (message.type === "start_capture") void activateCurrentTab();
    } catch {
      // Ignore malformed daemon events and preserve the connection.
    }
  });
  socket.addEventListener("close", scheduleReconnect);
  socket.addEventListener("error", () => socket?.close());
}

function scheduleReconnect(): void {
  socket = undefined;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => void connect(), 2_000);
}

export default defineBackground(() => {
  browser.commands.onCommand.addListener((command) => {
    if (command === "start-capture") void activateCurrentTab();
  });

  browser.runtime.onMessage.addListener(
    (message: BackgroundRequest, _sender, sendResponse) => {
      if (message.type === "daemon-status") {
        void token().then((pairingToken) => {
          const status: DaemonStatus = {
            configured: Boolean(pairingToken),
            connected: socket?.readyState === WebSocket.OPEN,
          };
          sendResponse(status);
        });
        return true;
      }

      if (message.type === "capture-visible-tab") {
        void browser.tabs
          .captureVisibleTab({ format: "png" })
          .then(sendResponse);
        return true;
      }

      if (message.type === "send-capture") {
        void token()
          .then(async (pairingToken) => {
            if (!pairingToken)
              throw new Error(
                "Open the uigrep extension settings and pair it first.",
              );
            const response = await fetch(`${HTTP_ORIGIN}/v1/captures`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-uigrep-token": pairingToken,
              },
              body: JSON.stringify(message.capture),
            });
            if (!response.ok)
              throw new Error(`uigrep daemon returned ${response.status}.`);
            sendResponse({ ok: true });
          })
          .catch((error: unknown) =>
            sendResponse({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        return true;
      }

      return false;
    },
  );

  browser.storage.onChanged.addListener(() => void connect());
  void connect();
});
