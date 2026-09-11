import React from "react";
import ReactDOM from "react-dom/client";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
          : labels[state.kind as keyof typeof labels];

  return (
    <button
      className={`pill pill--${state.kind}`}
      type="button"
      aria-label={`${label}. Drag to reposition.`}
      onMouseDown={(event) => {
        if (event.button === 0)
          void getCurrentWindow()
            .startDragging()
            .catch(() => undefined);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        void invoke("reopen_setup").catch(() => setState({ kind: "error" }));
      }}
      onClick={() => {
        // Fallback trigger: same path the Chrome command uses (daemon event),
        // so the notch works even if Chrome drops the keyboard shortcut.
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
