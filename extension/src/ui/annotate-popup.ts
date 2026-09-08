/** Comment popup shown right after element selection. */

import type { Annotation } from "@uigrep/schema";
import { attachShadowUi, UI_STYLES, type UiHandle } from "./shared";

export interface AnnotateRequest {
  selector: string;
  screenshot: string;
  /** Pre-validated annotation fields (comment filled by user) */
  build: (comment: string) => Promise<Annotation>;
}

export function showAnnotatePopup(
  request: AnnotateRequest,
  anchor: { x: number; y: number },
  onSaved: (annotation: Annotation) => void,
): void {
  const ui: UiHandle = attachShadowUi();
  const popup = document.createElement("div");
  popup.className = "ug-popup";
  popup.innerHTML = `
    <img src="${request.screenshot}" alt="">
    <textarea placeholder="What's wrong? (Cmd+Enter to save)"></textarea>
    <div class="ug-popup-actions">
      <button class="ug-btn ug-btn-ghost" data-act="discard">Discard</button>
      <button class="ug-btn ug-btn-primary" data-act="save">Add to review</button>
    </div>
  `;

  const x = Math.min(anchor.x, window.innerWidth - 316);
  const y = Math.min(anchor.y, Math.max(window.innerHeight - 240, 0));
  popup.style.left = `${Math.max(x, 8)}px`;
  popup.style.top = `${Math.max(y, 8)}px`;
  ui.root.append(popup);

  const style = document.createElement("style");
  style.textContent = UI_STYLES;
  ui.root.prepend(style);

  const textarea = popup.querySelector("textarea")!;
  textarea.focus();

  const close = (): void => ui.destroy();

  const save = async (): Promise<void> => {
    const comment = textarea.value.trim();
    if (!comment) return;
    const annotation = await request.build(comment);
    close();
    onSaved(annotation);
  };

  popup.addEventListener("click", (e) => {
    const target = (e.target as HTMLElement).closest("button");
    if (!target) return;
    if (target.getAttribute("data-act") === "save") void save();
    else close();
  });

  popup.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void save();
    }
    if (e.key === "Escape") close();
  });
}
