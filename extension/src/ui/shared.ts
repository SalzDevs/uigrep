/**
 * Shared plumbing for all uigrep UI: attach shadow DOM so page CSS never
 * touches our widgets and ours never touches the page.
 */

export interface UiHandle {
  host: HTMLElement;
  root: ShadowRoot;
  destroy(): void;
}

export function attachShadowUi(): UiHandle {
  const host = document.createElement("div");
  host.id = "uigrep-ui";
  Object.assign(host.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "0",
    height: "0",
    zIndex: "2147483647",
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.append(host);
  return {
    host,
    root: host.attachShadow({ mode: "open" }),
    destroy() {
      host.remove();
    },
  };
}

export const UI_STYLES = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, sans-serif; }
  .ug-panel {
    position: fixed;
    bottom: 16px;
    right: 16px;
    width: 320px;
    max-height: 60vh;
    overflow: auto;
    background: #15171c;
    color: #e8e8ea;
    border: 1px solid #2a2d35;
    border-radius: 10px;
    box-shadow: 0 8px 30px rgba(0,0,0,0.4);
    font-size: 13px;
  }
  .ug-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    border-bottom: 1px solid #2a2d35;
    font-weight: 600;
    position: sticky;
    top: 0;
    background: #15171c;
  }
  .ug-list { list-style: none; margin: 0; padding: 8px; }
  .ug-item {
    display: flex;
    gap: 8px;
    padding: 8px;
    border-radius: 6px;
    align-items: flex-start;
  }
  .ug-item:hover { background: #1d2027; }
  .ug-thumb {
    width: 48px;
    height: 36px;
    object-fit: cover;
    border-radius: 4px;
    border: 1px solid #2a2d35;
    flex: none;
    background: #000;
  }
  .ug-body { flex: 1; min-width: 0; }
  .ug-selector {
    font-family: ui-monospace, monospace;
    font-size: 11px;
    color: #9aa0ab;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ug-comment { margin-top: 2px; word-break: break-word; }
  .ug-status {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 999px;
    background: #2a2d35;
    margin-right: 6px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  .ug-status[data-status="sent"] { background: #2b4a68; }
  .ug-status[data-status="fixed"] { background: #2b5a3f; }
  .ug-status[data-status="verified"] { background: #5a4a2b; }
  .ug-del {
    background: none;
    border: none;
    color: #6b7078;
    cursor: pointer;
    font-size: 14px;
    padding: 2px 4px;
    flex: none;
  }
  .ug-del:hover { color: #ff4d6d; }
  .ug-footer {
    padding: 10px 12px;
    border-top: 1px solid #2a2d35;
    display: flex;
    gap: 8px;
  }
  .ug-btn {
    flex: 1;
    padding: 7px 12px;
    border-radius: 6px;
    border: none;
    cursor: pointer;
    font-size: 13px;
    font-weight: 600;
  }
  .ug-btn-primary { background: #ff4d6d; color: #fff; }
  .ug-btn-primary:hover { background: #ff6b86; }
  .ug-btn-ghost { background: #2a2d35; color: #e8e8ea; }
  .ug-empty { padding: 16px 12px; color: #6b7078; text-align: center; }

  .ug-popup {
    position: fixed;
    width: 300px;
    background: #15171c;
    color: #e8e8ea;
    border: 1px solid #2a2d35;
    border-radius: 10px;
    box-shadow: 0 8px 30px rgba(0,0,0,0.4);
    padding: 10px;
    font-size: 13px;
  }
  .ug-popup textarea {
    width: 100%;
    min-height: 60px;
    resize: vertical;
    background: #0e1013;
    color: #e8e8ea;
    border: 1px solid #2a2d35;
    border-radius: 6px;
    padding: 8px;
    font-size: 13px;
  }
  .ug-popup textarea:focus { outline: 1px solid #ff4d6d; }
  .ug-popup-actions {
    display: flex;
    gap: 8px;
    margin-top: 8px;
    justify-content: flex-end;
  }
  .ug-popup img {
    width: 100%;
    border-radius: 6px;
    border: 1px solid #2a2d35;
    margin-bottom: 8px;
    max-height: 120px;
    object-fit: cover;
  }
`;
