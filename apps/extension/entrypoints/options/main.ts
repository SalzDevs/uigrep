import type { BackgroundRequest, DaemonStatus } from "../../lib/messages";

const button = document.querySelector<HTMLButtonElement>("#connect")!;
const statusElement = document.querySelector<HTMLElement>("#status")!;
const badge = document.querySelector<HTMLElement>("#badge")!;
let busy = false;
let timer: ReturnType<typeof setTimeout> | undefined;

async function refresh(connect = false): Promise<void> {
  if (busy) return;
  busy = true;
  if (timer) clearTimeout(timer);
  button.disabled = true;
  try {
    const status: DaemonStatus = await browser.runtime.sendMessage({
      type: connect ? "connect-browser" : "daemon-status",
    } satisfies BackgroundRequest);
    if (!status || typeof status.phase !== "string")
      throw new Error("Companion is restarting. Retry in a moment.");
    badge.textContent = status.connected
      ? "Connected"
      : status.phase === "pending"
        ? "Approval needed"
        : "Not connected";
    badge.dataset.connected = String(status.connected);
    const remaining = Math.max(
      0,
      Math.ceil(((status.expiresAt ?? Date.now()) - Date.now()) / 1000),
    );
    statusElement.textContent =
      status.error ??
      (status.connected
        ? "Browser approved. Return to desktop Setup to configure your agent and capture the test page."
        : status.phase === "pending"
          ? `Approve Chrome in the uigrep desktop Setup window. This request expires in ${remaining} seconds.`
          : status.phase === "connecting"
            ? "Waiting for the desktop app. Reconnecting automatically…"
            : "Open the uigrep desktop app, then click Connect. You will approve this browser there.");
    button.textContent = status.connected
      ? "Connected"
      : status.phase === "pending"
        ? "Waiting for approval…"
        : status.phase === "error"
          ? "Retry"
          : "Connect";
    button.disabled =
      status.connected ||
      status.phase === "pending" ||
      status.phase === "requesting";
  } catch (error) {
    statusElement.textContent =
      error instanceof Error
        ? error.message
        : "Cannot contact the companion. Retry.";
    button.textContent = "Retry";
    button.disabled = false;
  } finally {
    busy = false;
    timer = setTimeout(() => {
      void refresh();
    }, 2_000);
  }
}
button.addEventListener("click", () => {
  void refresh(true);
});
window.addEventListener("pagehide", () => {
  if (timer) clearTimeout(timer);
});
void refresh();
