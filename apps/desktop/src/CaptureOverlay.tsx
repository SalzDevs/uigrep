import React from "react";
import { invoke } from "@tauri-apps/api/core";

type Region = {
  x: number;
  y: number;
  width: number;
  height: number;
  comment: string;
};

type Draft = { startX: number; startY: number; curX: number; curY: number };

/**
 * Fullscreen transparent overlay for region selection in the native desktop
 * app: drag a region, click the marker to comment, capture sends pixels to
 * the local daemon.
 */
export function CaptureOverlay() {
  const [regions, setRegions] = React.useState<Region[]>([]);
  const [editing, setEditing] = React.useState<number | null>(null);
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const pointerId = React.useRef<number | null>(null);

  const cancel = async () => {
    await invoke("cancel_capture").catch(() => undefined);
  };

  const startPointer = (event: React.PointerEvent) => {
    if (event.button !== 0 || pointerId.current !== null) return;
    if ((event.target as HTMLElement).closest(".capture-ui")) return;
    pointerId.current = event.pointerId;
    setDraft({
      startX: event.clientX,
      startY: event.clientY,
      curX: event.clientX,
      curY: event.clientY,
    });
  };

  const movePointer = (event: React.PointerEvent) => {
    if (pointerId.current !== event.pointerId) return;
    setDraft((prev) =>
      prev ? { ...prev, curX: event.clientX, curY: event.clientY } : prev,
    );
  };

  const endPointer = (event: React.PointerEvent) => {
    if (pointerId.current !== event.pointerId) return;
    pointerId.current = null;
    setDraft((prev) => {
      if (!prev) return null;
      const region = {
        x: Math.min(prev.startX, prev.curX),
        y: Math.min(prev.startY, prev.curY),
        width: Math.abs(prev.curX - prev.startX),
        height: Math.abs(prev.curY - prev.startY),
        comment: "",
      };
      if (region.width >= 8 && region.height >= 8) {
        setRegions((list) => {
          setEditing(list.length);
          return [...list, region];
        });
      }
      return null;
    });
  };

  const updateComment = (index: number, comment: string) => {
    setRegions((list) =>
      list.map((r, i) => (i === index ? { ...r, comment } : r)),
    );
  };

  const removeRegion = (index: number) => {
    setRegions((list) => list.filter((_, i) => i !== index));
    setEditing(null);
  };

  const send = async () => {
    if (busy || regions.length === 0) return;
    setBusy(true);
    setError("");
    try {
      await invoke("submit_capture", { regions });
      // The Rust side hides this window on success.
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  const draftRect = draft && {
    left: Math.min(draft.startX, draft.curX),
    top: Math.min(draft.startY, draft.curY),
    width: Math.abs(draft.curX - draft.startX),
    height: Math.abs(draft.curY - draft.startY),
  };

  return (
    <div
      className="capture-layer"
      onPointerDown={startPointer}
      onPointerMove={movePointer}
      onPointerUp={endPointer}
    >
      {draftRect && <div className="capture-draft" style={draftRect} />}
      {regions.map((region, index) => (
        <div
          key={`${region.x}-${region.y}-${index}`}
          className="capture-outline capture-ui"
          style={{
            left: region.x,
            top: region.y,
            width: region.width,
            height: region.height,
          }}
        >
          <button
            type="button"
            className="capture-marker"
            aria-label={`Comment on selection ${index + 1}`}
            onClick={() => setEditing(editing === index ? null : index)}
          >
            {region.comment ? index + 1 : "+"}
          </button>
          {editing === index && (
            <div className="capture-composer">
              <textarea
                placeholder="What should change?"
                maxLength={4_000}
                value={region.comment}
                onChange={(event) => updateComment(index, event.target.value)}
                autoFocus
              />
              <div className="button-row">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => removeRegion(index)}
                >
                  Delete
                </button>
                <button
                  type="button"
                  className="primary"
                  onClick={() => setEditing(null)}
                >
                  Done
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
      <div className="capture-toolbar capture-ui">
        {error && <span className="capture-error">{error}</span>}
        <span className="capture-count">
          {regions.length} annotation{regions.length === 1 ? "" : "s"}
        </span>
        <button
          type="button"
          className="secondary"
          onClick={() => void cancel()}
        >
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy || regions.length === 0}
          onClick={() => void send()}
        >
          {busy ? "Capturing…" : "Capture"}
        </button>
      </div>
    </div>
  );
}
