import React from "react";
import ReactDOM from "react-dom/client";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import {
  getCurrentWindow,
  cursorPosition,
  availableMonitors,
  PhysicalPosition,
} from "@tauri-apps/api/window";
import { Setup } from "./Setup";
import { CaptureOverlay } from "./CaptureOverlay";
import "./styles.css";

const IS_MAC = /Mac/.test(navigator.platform);

type PillState =
  | { kind: "starting" }
  | { kind: "ready" }
  | { kind: "selecting" }
  | { kind: "sending" }
  | { kind: "sent" }
  | { kind: "error"; message?: string }
  | { kind: "paused" };

const labels: Record<
  Exclude<PillState["kind"], "sending" | "sent" | "error">,
  string
> = {
  starting: "Starting…",
  ready: `${IS_MAC ? "⌥⇧G" : "Alt+Shift+G"} · Select UI`,
  selecting: "Drag a region…",
  paused: "uigrep paused",
};

function Pill(): React.JSX.Element {
  const [state, setState] = React.useState<PillState>({ kind: "starting" });

  React.useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const initialize = async (): Promise<void> => {
      unlisten = await listen<PillState>("pill-state", (event) => {
        if (!disposed) setState(event.payload);
      });
      if (disposed) {
        unlisten();
        return;
      }
      const status = await invoke<{ daemonReady: boolean }>("setup_status");
      if (!disposed)
        setState({ kind: status.daemonReady ? "ready" : "starting" });
    };
    void initialize().catch(() => setState({ kind: "error" }));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const label =
    state.kind === "error"
      ? (state.message ?? "Needs attention")
      : state.kind === "sending"
        ? "Capturing…"
        : state.kind === "sent"
          ? "Capture saved"
          : labels[state.kind];

  const dragOrigin = React.useRef<{ x: number; y: number } | null>(null);

  // Follow the user across displays and spaces: when the cursor settles on a
  // different display than the notch, glide the notch there (same relative
  // position, clamped). CanJoinAllSpaces handles spaces; this handles displays.
  React.useEffect(() => {
    if (state.kind === "starting") return;
    const sync = async () => {
      try {
        const win = getCurrentWindow();
        const [cursor, monitors, pos, size] = await Promise.all([
          cursorPosition(),
          availableMonitors(),
          win.outerPosition(),
          win.outerSize(),
        ]);
        const at = (p: { x: number; y: number }) =>
          monitors.find(
            (m) =>
              p.x >= m.position.x &&
              p.x < m.position.x + m.size.width &&
              p.y >= m.position.y &&
              p.y < m.position.y + m.size.height,
          );
        const pillMonitor = at({ x: pos.x, y: pos.y });
        const cursorMonitor = at(cursor);
        if (!pillMonitor || !cursorMonitor || pillMonitor === cursorMonitor)
          return;
        const relX = (pos.x - pillMonitor.position.x) / pillMonitor.size.width;
        const relY = (pos.y - pillMonitor.position.y) / pillMonitor.size.height;
        const x =
          cursorMonitor.position.x +
          Math.round(relX * cursorMonitor.size.width);
        const y =
          cursorMonitor.position.y +
          Math.round(relY * cursorMonitor.size.height);
        await win.setPosition(
          new PhysicalPosition(
            Math.min(
              Math.max(x, cursorMonitor.position.x),
              cursorMonitor.position.x + cursorMonitor.size.width - size.width,
            ),
            Math.min(
              Math.max(y, cursorMonitor.position.y),
              cursorMonitor.position.y +
                cursorMonitor.size.height -
                size.height,
            ),
          ),
        );
      } catch {
        /* poll again */
      }
    };
    const timer = setInterval(() => void sync(), 800);
    return () => clearInterval(timer);
  }, [state.kind]);

  return (
    <button
      className={`pill pill--${state.kind}`}
      type="button"
      aria-label={`${label}. Drag to reposition.`}
      onMouseDown={(event) => {
        if (event.button === 0) {
          dragOrigin.current = { x: event.screenX, y: event.screenY };
          void getCurrentWindow()
            .startDragging()
            .catch(() => undefined);
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        void invoke("reopen_setup").catch(() => setState({ kind: "error" }));
      }}
      onClick={(event) => {
        // Click = capture trigger. A drag that moved >4px is repositioning,
        // not a click.
        const origin = dragOrigin.current;
        dragOrigin.current = null;
        if (
          origin &&
          Math.hypot(event.screenX - origin.x, event.screenY - origin.y) > 4
        )
          return;
        void invoke("start_capture").catch(() => setState({ kind: "error" }));
      }}
    >
      <span className="pill__dot" aria-hidden="true" />
      <span className="pill__label">{label}</span>
    </button>
  );
}

const view = new URLSearchParams(location.search).get("view") ?? "pill";
document.documentElement.dataset.view = view;
const root = ReactDOM.createRoot(document.getElementById("root")!);
if (view === "setup") root.render(<Setup />);
else if (view === "capture") root.render(<CaptureOverlay />);
else root.render(<Pill />);
